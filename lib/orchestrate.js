/**
 * orchestrate.js —— 三个工具的执行主体：扫描、算计划、取帧、拼图、交附件。
 *
 * 预算与预设也在这里（`PRESETS` / `effectiveArgs`），因为密度和钱是同一件事的两面。
 *
 * @module dsh-video-understanding/orchestrate
 */

import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { analyzeAudio } from './audio.js';
import { cacheKey, readCache, writeCache } from './cache.js';
import { buildGroups, groupCost } from './delivery.js';
import { buildDrawtext, extractFrame, extractFullFrame, probeVideo, scanToRgb, tileImages } from './ffmpeg.js';
import { planGrid } from './grid.js';
import { densityMap, planFrames } from './plan.js';
import { analyzeDims, analyzeFromStream, frameBytes } from './scan.js';
import { formatClock, formatShort } from './time.js';
import { assertImageCapableRoute, buildCellFilter, canBurnText, compactSequence, loadTranscript, mapLimit, normalizeTimes, requireInput, round, toImageValue } from './util.js';

/** 交付给附件服务的媒体类型。 */
const MEDIA_TYPE = 'image/jpeg';

/** 单帧提取的并发度：再高只是在抢同一个解码器的 IO。 */
const EXTRACT_CONCURRENCY = 4;

/**
 * 扫描（带缓存）。
 *
 * @param params - 参数。
 * @returns `{ scores, fps, seconds, cached }`。
 */
async function ensureScores(params) {
  const { run, cfg, input, signal, aspect } = params;
  let info;
  try {
    info = await stat(input);
  } catch {
    throw new Error(`cannot read "${input}": no such file`);
  }
  const dims = analyzeDims(cfg.longSide, aspect);
  // 缓存键必须带上全部分析口径：只改分析尺寸或块阈值时，旧的分数不能复用。
  const key = cacheKey({
    input,
    size: info.size,
    mtimeMs: info.mtimeMs,
    scanFps: cfg.scanFps,
    width: dims.width,
    height: dims.height,
    block: cfg.block,
    threshold: cfg.blockThreshold,
  });
  const cached = await readCache(cfg.cacheDir, key);
  if (cached !== null && Array.isArray(cached.area) && cached.area.length > 0) {
    return {
      area: cached.area,
      scores: cached.scores ?? [],
      luma: cached.luma ?? [],
      fps: cached.scanFps ?? cfg.scanFps,
      seconds: 0,
      cached: true,
      dims,
    };
  }

  const workDir = await mkdtemp(join(tmpdir(), 'dsh-video-understanding-scan-'));
  const started = Date.now();
  try {
    const rgbPath = join(workDir, 'scan.rgb');
    await scanToRgb({
      run,
      ffmpegPath: cfg.ffmpegPath,
      input,
      fps: cfg.scanFps,
      width: dims.width,
      height: dims.height,
      outPath: rgbPath,
      signal,
      timeoutMs: cfg.timeoutMs,
    });
    const handle = await open(rgbPath, 'r');
    let analysis;
    try {
      analysis = await analyzeFromStream(handle, frameBytes(dims.width, dims.height), {
        framesPerChunk: 256,
        width: dims.width,
        height: dims.height,
        block: cfg.block,
        threshold: cfg.blockThreshold,
      });
    } finally {
      await handle.close();
    }
    if (analysis.area.length === 0) throw new Error(`scan of "${input}" produced no frames`);
    await writeCache(cfg.cacheDir, key, {
      area: analysis.area,
      scores: analysis.scores,
      luma: analysis.luma,
      scanFps: cfg.scanFps,
      duration: analysis.area.length / cfg.scanFps,
    });
    return {
      area: analysis.area,
      scores: analysis.scores,
      luma: analysis.luma,
      fps: cfg.scanFps,
      seconds: (Date.now() - started) / 1000,
      cached: false,
      dims,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * 两套参数预设。**必须由调用方明确选择**，代码不替用户猜。
 *
 *   - `analysis`：识别动画、运镜、特效。密度按"看清手法"给（a=0.3），
 *     硬切可以取前后两帧，预算也留得宽一点。
 *   - `understand`：只认视频讲了什么。密度按"看懂内容"给（a=1），窗口放宽到 1.5 秒、
 *     静止段容忍 6 秒间隔，交付预算也更大（10 张），不关心切点前后差一帧。
 *
 * 判定顺序：**显式单参 > preset**。采样参数只有这两个来源，配置文件里不再设
 * a / t / maxGap / maxSheets / overflow 这一组 —— 它们由 preset 唯一决定，
 * 免得出现「配置写了却没生效」的假象。
 */
export const PRESETS = {
  analysis: { a: 0.3, t: 1, maxGap: 5, multiCross: true, cutPair: false, maxSheets: 5 },
  understand: { a: 1, t: 1.5, maxGap: 6, multiCross: true, cutPair: false, maxSheets: 10 },
};

/**
 * 把 preset 与显式参数合成一份生效的采样参数。
 *
 * @param args - 工具入参。
 * @param cfg - 归一化后的配置。
 * @returns `{ a, t, maxGap, multiCross, cutPair, maxSheets, overflow }`。
 */
export function effectiveArgs(args, cfg = {}) {
  const preset = PRESETS[args?.preset] ?? PRESETS.analysis;
  const merged = { ...preset };
  return {
    a: args?.a ?? merged.a,
    t: args?.t ?? merged.t,
    maxGap: args?.maxGap ?? merged.maxGap,
    multiCross: args?.multiCross ?? merged.multiCross,
    cutPair: args?.cutPair ?? merged.cutPair,
    maxSheets: args?.maxSheets ?? merged.maxSheets,
    overflow: args?.overflow ?? (cfg.overflow === 'stop' ? 'stop' : 'thin'),
  };
}

/**
 * 探测 + 扫描 + 算计划，三个工具的公共前半段。
 *
 * @param params - 参数。
 * @returns `{ probe, scan, plan, density, estimate, aspect }`。
 */
async function analyse(params) {
  const { run, cfg, input, args, signal } = params;
  const probe = await probeVideo({ run, ffmpegPath: cfg.ffmpegPath, ffprobePath: cfg.ffprobePath, input, signal });
  if (!(probe.duration > 0)) throw new Error(`"${input}" reports no duration; it may not be a complete video file`);
  const aspect = probe.height > 0 ? probe.width / probe.height : 16 / 9;
  const scan = await ensureScores({ run, cfg, input, signal, aspect });
  const plan = planFrames({
    duration: probe.duration,
    scanFps: scan.fps,
    area: scan.area,
    ...effectiveArgs(args, cfg),
    from: args?.from,
    to: args?.to,
  });
  const density = densityMap(plan.groups, { maxRuns: 14 });
  const groups = buildGroups({
    groups: plan.groups,
  });
  const estimate = groupCost(groups, aspect);
  const preset = args?.preset ?? 'analysis';
  return { probe, scan, plan, density, estimate, groups, aspect, preset };
}

/**
 * 把计划、扫描、探测拼成返回值里那一段共同的头。
 *
 * 导出是为了让契约校验用**真实的**产出而不是手写样例：手写样例漏过一个键，
 * Agent 就在运行时报 `INVALID_TOOL_OUTPUT`（`estimate.singles` 就是这么漏的）。
 *
 * @param params - 参数。
 * @returns 头字段对象。
 */
export function headOf(params) {
  const { input, probe, scan, plan, density, estimate, preset } = params;
  return {
    path: input,
    durationSeconds: round(probe.duration, 3),
    sourceWidth: probe.width,
    sourceHeight: probe.height,
    fps: round(probe.fps, 3),
    hasAudio: probe.hasAudio,
    subtitleTracks: probe.subtitleTracks.length,
    scan: { fps: round(scan.fps, 3), frames: scan.scores.length, seconds: round(scan.seconds, 2), cached: scan.cached },
    plan: {
      preset: preset ?? 'analysis',
      count: plan.stats.count,
      moments: plan.stats.moments,
      fillers: plan.stats.fillers,
      cuts: plan.stats.cuts,
      cutHits: plan.stats.cutHits,
      tiles: plan.stats.tiles,
      singles: plan.stats.singles,
      cutPairs: plan.stats.cutPairs,
      a: round(plan.stats.a, 4),
      aEff: round(plan.stats.aEff, 4),
      t: round(plan.stats.t, 3),
      maxGap: round(plan.stats.maxGap, 3),
      multiCross: plan.stats.multiCross,
      cutPair: plan.stats.cutPair,
      maxSheets: plan.stats.maxSheets,
      sheets: plan.stats.sheets,
      overflow: plan.stats.overflow,
      truncated: plan.stats.truncated,
      coveredTo: round(plan.stats.coveredTo, 3),
      budgetRaised: plan.stats.budgetRaised,
      noiseFloor: round(plan.stats.noiseFloor, 5),
      totalChange: round(plan.stats.totalChange, 3),
      meanIntervalSeconds: round(plan.stats.meanInterval, 3),
      minIntervalSeconds: round(plan.stats.minInterval, 3),
      maxIntervalSeconds: round(plan.stats.maxInterval, 3),
      scale: round(plan.stats.scale, 3),
      from: round(plan.stats.from, 3),
      to: round(plan.stats.to, 3),
    },
    density: density.map((run) => ({
      label: run.label,
      from: round(run.from, 3),
      to: round(run.to, 3),
      count: run.count,
      intervalSeconds: round(run.interval, 3),
    })),
    estimate: { sheets: estimate.sheets, tokens: estimate.tokens },
  };
}

/**
 * `video_plan` 主体。
 *
 * @param params - 参数。
 * @returns 工具返回值。
 */
export async function executePlan(params) {
  const { args, exec, run, cfg } = params;
  const input = requireInput(args);
  const result = await analyse({ run, cfg, input, args, signal: exec?.signal });
  return headOf({ input, ...result });
}

/**
 * `video_watch` 主体：抽帧、拼图、提交附件。
 *
 * @param params - 参数。
 * @returns 工具返回值。
 */
export async function executeWatch(params) {
  const { args, exec, ctx, run, cfg } = params;
  const input = requireInput(args);
  await assertImageCapableRoute(ctx, exec);

  const signal = exec?.signal;
  const analysis = await analyse({ run, cfg, input, args, signal });
  const { probe, plan, aspect } = analysis;
  const frames = plan.frames;
  if (frames.length === 0) throw new Error(`no frame could be planned for "${input}"`);

  const attachments = ctx.get('attachments');
  if (attachments === undefined) throw new Error('no attachment service is mounted, so frames cannot be handed back as images');

  const burn = ['none', 'index', 'time'].includes(args?.burn) ? args.burn : cfg.burn;
  const canBurn = burn !== 'none' && (await canBurnText({ run, cfg, signal }));

  const workDir = await mkdtemp(join(tmpdir(), 'dsh-video-understanding-'));
  try {
    // 每张图片装哪些子图由 buildGroups 定好：密窗口拼图、切点取前后两帧、单帧单独一张
    const deliveryGroups = analysis.groups ?? [];
    const sheets = [];
    const placed = [];
    const skipped = [];

    for (let sheetIndex = 0; sheetIndex < deliveryGroups.length; sheetIndex += 1) {
      const group = deliveryGroups[sheetIndex].frames;
      const size = group.length;
      const grid = planGrid(size, aspect);
      const frameDir = join(workDir, `sheet-${sheetIndex + 1}`);
      await mkdir(frameDir, { recursive: true });
      const jobs = group.map((frame, cellIndex) => ({
        frame,
        cell: cellIndex + 1,
        cellWidth: grid.cellWidth,
        cellHeight: grid.cellHeight,
        outPath: join(frameDir, `${String(cellIndex + 1).padStart(4, '0')}.jpg`),
      }));

      const done = await mapLimit(jobs, EXTRACT_CONCURRENCY, async (job) => {
        const label = burn === 'index' ? String(job.cell) : formatShort(job.frame.time);
        const filter = buildCellFilter({
          width: job.cellWidth,
          height: job.cellHeight,
          text: canBurn ? label : '',
          fontFile: cfg.fontFile,
        });
        try {
          await extractFrame({
            run,
            ffmpegPath: cfg.ffmpegPath,
            input,
            time: job.frame.time,
            outPath: job.outPath,
            filter,
            quality: cfg.quality,
            signal,
            timeoutMs: cfg.timeoutMs,
          });
          return true;
        } catch {
          // 单帧取不到（比如刚好在边界）不该让整次调用失败。
          skipped.push(round(job.frame.time, 3));
          return false;
        }
      });

      const kept = jobs.filter((_job, index) => done[index] === true);
      if (kept.length === 0) continue;

      // 取不到的帧会在序列里留空洞，`tile` 只能按连续文件名读，
      // 所以重命名成从 1 开始连续的一段。
      const ordered = await compactSequence(kept);
      const actualGrid = planGrid(ordered.length, aspect);
      const sheetPath = join(workDir, `sheet-${sheetIndex + 1}.jpg`);
      await tileImages({
        run,
        ffmpegPath: cfg.ffmpegPath,
        pattern: join(frameDir, '%04d.jpg'),
        cols: actualGrid.cols,
        rows: actualGrid.rows,
        padding: 4,
        outPath: sheetPath,
        quality: cfg.quality,
        signal,
        timeoutMs: cfg.timeoutMs,
      });

      sheets.push({
        sheet: sheets.length + 1,
        kind: deliveryGroups[sheetIndex]?.kind ?? 'grid',
        label: deliveryGroups[sheetIndex]?.label ?? '',
        start: round(deliveryGroups[sheetIndex]?.start ?? 0, 3),
        end: round(deliveryGroups[sheetIndex]?.end ?? 0, 3),
        cols: actualGrid.cols,
        rows: actualGrid.rows,
        width: actualGrid.width,
        height: actualGrid.height,
        tokens: actualGrid.tokens,
        path: sheetPath,
      });
      for (let index = 0; index < ordered.length; index += 1) {
        placed.push({ frame: ordered[index].frame, sheet: sheets.length, cell: index + 1 });
      }
    }

    if (sheets.length === 0) throw new Error(`no frame could be extracted from "${input}"`);

    const refs = await attachments.saveImages(
      await Promise.all(
        sheets.map(async (sheet) => ({ data: await readFile(sheet.path), mediaType: MEDIA_TYPE, name: basename(sheet.path) })),
      ),
    );
    if (refs.length !== sheets.length) {
      throw new Error(`attachment service returned ${refs.length} references for ${sheets.length} sheets; refusing a partial result`);
    }

    const transcript = await loadTranscript({
      run,
      cfg,
      input,
      probe,
      from: plan.stats.from,
      to: plan.stats.to,
      transcriptFile: args?.transcriptFile,
      workDir,
      signal,
    });

    // 音频：语音走本地识别，BGM/音效走云端。两条线各自决定成功或失败，
    // 失败只降级状态并写进 notes，绝不让"没分析"看起来像"没有声音"。
    const audio = await analyzeAudio({
      run,
      cfg,
      input,
      from: plan.stats.from,
      to: plan.stats.to,
      workDir,
      signal,
      hasAudio: probe.hasAudio,
    });

    const head = headOf({ input, ...analysis });
    const images = refs.map(toImageValue);
    return {
      ...head,
      frames: placed.map((item, index) => ({
        index: index + 1,
        time: round(item.frame.time, 3),
        label: formatClock(item.frame.time),
        sheet: item.sheet,
        cell: item.cell,
      })),
      sheets: sheets.map((sheet, index) => ({
        sheet: sheet.sheet,
        cols: sheet.cols,
        rows: sheet.rows,
        width: sheet.width,
        height: sheet.height,
        tokens: sheet.tokens,
        image: images[index],
      })),
      transcript,
      skipped: skipped.length,
      audio,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * `video_closeup` 主体。
 *
 * @param params - 参数。
 * @returns 工具返回值。
 */
export async function executeCloseup(params) {
  const { args, exec, ctx, run, cfg } = params;
  const input = requireInput(args);
  await assertImageCapableRoute(ctx, exec);

  const times = normalizeTimes(args?.times);
  if (times.length === 0) throw new Error('times must list at least one moment as seconds (12.5) or clock string ("01:30")');

  const signal = exec?.signal;
  const probe = await probeVideo({ run, ffmpegPath: cfg.ffmpegPath, ffprobePath: cfg.ffprobePath, input, signal });

  const burn = args?.burn === 'none' ? 'none' : 'time';
  const canBurn = burn !== 'none' && (await canBurnText({ run, cfg, signal }));

  const attachments = ctx.get('attachments');
  if (attachments === undefined) throw new Error('no attachment service is mounted, so frames cannot be handed back as images');

  const workDir = await mkdtemp(join(tmpdir(), 'dsh-video-understanding-close-'));
  try {
    const outputs = [];
    for (let index = 0; index < times.length; index += 1) {
      const time = Math.min(times[index], Math.max(0, probe.duration - 0.05));
      const outPath = join(workDir, `close-${String(index + 1).padStart(3, '0')}.jpg`);
      const text = canBurn ? formatShort(time) : '';
      const filter = text === '' ? '' : buildDrawtext({ text, fontFile: cfg.fontFile, fontSize: 22 });
      try {
        await extractFullFrame({
          run,
          ffmpegPath: cfg.ffmpegPath,
          input,
          time,
          outPath,
          // 不再限制宽度：原图多宽就取多宽（不放大）。一张 1080p 的图也是 384 token，
          // 限制宽度只会白丢细节。
          maxWidth: probe.width,
          sourceWidth: probe.width,
          filter,
          quality: 2,
          signal,
          timeoutMs: cfg.timeoutMs,
        });
        outputs.push({ time, path: outPath });
      } catch {
        /* 单帧失败就跳过，下面的长度检查会兜底 */
      }
    }
    if (outputs.length === 0) throw new Error(`no frame could be extracted from "${input}" at ${times.join(', ')}`);

    const refs = await attachments.saveImages(
      await Promise.all(outputs.map(async (item) => ({ data: await readFile(item.path), mediaType: MEDIA_TYPE, name: basename(item.path) }))),
    );
    const images = refs.map(toImageValue);
    return {
      path: input,
      sourceWidth: probe.width,
      sourceHeight: probe.height,
      durationSeconds: round(probe.duration, 3),
      frames: outputs.map((item, index) => ({
        time: round(item.time, 3),
        label: formatClock(item.time),
        width: images[index].width,
        height: images[index].height,
        image: images[index],
      })),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
