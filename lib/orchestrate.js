/**
 * orchestrate.js —— 四个工具的执行主体：探测、扫描、预算初判与定稿、取帧、拼图、交附件。
 *
 * 职责切成两段：`executePlan` 只管"能不能看完、要几张图"，`executeWatch` 只认 planId
 * 并按快照执行。预算（`maxTotalSheets`）只在前者出现。
 *
 * @module dsh-video-watching/orchestrate
 */

import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { analyzeAudio } from './audio.js';
import { cacheKey, readCache, writeCache } from './cache.js';
import { buildGroups, groupCost } from './delivery.js';
import { feasibilityOf, planFor, resolveChoice } from './feasibility.js';
import { buildDrawtext, extractFrame, extractFullFrame, probeVideo, scanToRgb, tileImages } from './ffmpeg.js';
import { planGrid } from './grid.js';
import { batchOf, densityMap } from './plan.js';
import { readPlan, savePlan, verifyPlan } from './plans.js';
import { PRESETS, effectiveArgs } from './presets.js';
import { appendBatch, recordPathOf, writeAnalysis } from './record.js';
import { analyzeDims, analyzeFromStream, frameBytes } from './scan.js';
import { formatClock, formatShort } from './time.js';
import { assertImageCapableRoute, buildCellFilter, canBurnText, compactSequence, loadTranscript, mapLimit, normalizeTimes, requireInput, round, toImageValue } from './util.js';

export { PRESETS, effectiveArgs };


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

  const workDir = await mkdtemp(join(tmpdir(), 'dsh-video-watching-scan-'));
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
    }, { maxEntries: cfg.cacheMaxEntries });
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
 * 探测 + 扫描，四个工具的公共前半段。
 *
 * 扫描会进缓存，所以 plan 与 watch 各调一次不会重复解码。
 *
 * @param params - 参数。
 * @returns `{ probe, aspect, scan, info }`。
 */
async function probeAndScan(params) {
  const { run, cfg, input, signal } = params;
  const probe = await probeVideo({ run, ffmpegPath: cfg.ffmpegPath, ffprobePath: cfg.ffprobePath, input, signal });
  if (!(probe.duration > 0)) throw new Error(`"${input}" reports no duration; it may not be a complete video file`);
  const aspect = probe.height > 0 ? probe.width / probe.height : 16 / 9;
  const scan = await ensureScores({ run, cfg, input, signal, aspect });
  let info;
  try {
    info = await stat(input);
  } catch {
    throw new Error(`cannot read "${input}": no such file`);
  }
  return { probe, aspect, scan, info };
}

/**
 * 把计划折成头字段 + 密度地图 + 成本估算。
 *
 * @param params - 参数。
 * @returns `{ head, density, estimate, groups }`。
 */
function packPlan(params) {
  const { input, probe, scan, plan, aspect, preset } = params;
  const density = densityMap(plan.groups, { maxRuns: 14 });
  const groups = buildGroups({ groups: plan.groups });
  const estimate = groupCost(groups, aspect);
  return { head: headOf({ input, probe, scan, plan, density, estimate, preset }), density, estimate, groups };
}

/**
 * 计划快照：定稿之后 watch 只认它，不再看配置里的预算。
 *
 * @param params - 参数。
 * @returns 快照对象。
 */
function snapshotOf(params) {
  const { input, info, probe, cfg, preset, sampling, mode, limit, plan } = params;
  return {
    input,
    size: info.size,
    mtimeMs: Math.round(info.mtimeMs),
    duration: round(probe.duration, 3),
    from: round(plan.stats.from, 3),
    to: round(plan.stats.to, 3),
    preset,
    a: sampling.a,
    t: sampling.t,
    maxGap: sampling.maxGap,
    multiCross: sampling.multiCross,
    cutPair: sampling.cutPair,
    maxSheets: sampling.maxSheets,
    scanFps: cfg.scanFps,
    longSide: cfg.longSide,
    block: cfg.block,
    blockThreshold: cfg.blockThreshold,
    mode,
    limit,
    sheets: plan.stats.sheets,
    coveredTo: round(plan.stats.coveredTo, 3),
    createdAt: Date.now(),
  };
}

/**
 * 定稿：按解析好的采样与模式算计划、落快照、返回 planId。
 *
 * @param params - 参数。
 * @returns `{ head, plan, planId }`。
 */
async function commitPlan(params) {
  const { cfg, input, info, probe, scan, aspect, preset, sampling, mode, limit, from, to } = params;
  const plan = planFor({ duration: probe.duration, scanFps: scan.fps, area: scan.area, from, to, sampling, mode, limit });
  if (mode !== 'truncate' && plan.stats.sheets > limit) {
    throw new Error(`still does not fit: ${plan.stats.sheets} sheets needed, the limit is ${limit}`);
  }
  const { head } = packPlan({ input, probe, scan, plan, aspect, preset });
  const snapshot = snapshotOf({ input, info, probe, cfg, preset, sampling, mode, limit, plan });
  const planId = await savePlan(cfg.cacheDir, snapshot);
  if (planId === null) {
    throw new Error(`the plan could not be stored under "${cfg.cacheDir}"; nothing was charged, fix cacheDir and plan again`);
  }
  // 记录文档的落点：只在真看过之后才由 appendBatch 建文件（见 record.js）。
  const record = cfg.record === true ? recordPathOf(cfg, input) : undefined;
  return { head, plan, planId, record };
}

/**
 * 把选项压成一行，给"选择仍然不够"的报错用。
 *
 * @param options - 候选方案。
 * @returns 一行说明。
 */
function describeOptions(options) {
  return options.map((option) => `${option.id} (${option.sheets} sheets, covers to ${Math.round(option.coveredTo)}s)`).join('; ');
}

/**
 * 把记录路径折成可选的返回值字段（没有就一个键都不加）。
 *
 * @param record - 文档路径。
 * @returns `{ record }` 或 `{}`。
 */
function recordField(record) {
  return typeof record === 'string' && record !== '' ? { record } : {};
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
      maxTotalSheets: plan.stats.maxTotalSheets,
      batches: plan.stats.batches,
      sheets: plan.stats.sheets,
      overflow: plan.stats.overflow,
      truncated: plan.stats.truncated,
      videoComplete: plan.stats.videoComplete,
      coveredTo: round(plan.stats.coveredTo, 3),
      unseenSeconds: round(plan.stats.unseenSeconds, 3),
      budgetRaised: plan.stats.budgetRaised,
      thinned: plan.stats.thinned,
      maxGapBroken: plan.stats.maxGapBroken,
      floorSheets: plan.stats.floorSheets,
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

  // 与 watch 同一道检查：模式是插件开始工作前的第一个决定，plan 也要过。
  // 这一步没有确认过模式，就一步都不走 —— 不扫描、不出图、不花钱。
  if (args?.userConfirmed !== true) {
    throw new Error(
      'mode not confirmed: ask the user which mode to use - analysis (看剪辑手法与画面变化，密度高) or ' +
        'understand (只看内容，更省) - then call again with the chosen preset and userConfirmed: true. ' +
        'Nothing was scanned and nothing was charged.',
    );
  }

  const input = requireInput(args);
  const preset = args?.preset === 'understand' ? 'understand' : 'analysis';
  const sampling = effectiveArgs({ preset }, cfg);
  const alternate = effectiveArgs({ preset: preset === 'understand' ? 'analysis' : 'understand' }, cfg);
  const { probe, aspect, scan, info } = await probeAndScan({ run, cfg, input, signal: exec?.signal });
  const window = { from: args?.from, to: args?.to };
  const base = { duration: probe.duration, scanFps: scan.fps, area: scan.area, ...window };

  // ① 初判：按预设密度完整铺满这段窗口要几张，够不够。
  const feasibility = feasibilityOf({
    ...base,
    aspect,
    sampling,
    maxTotalSheets: cfg.maxTotalSheets,
    alternate,
    prefer: cfg.overflow,
  });

  // ② 没有 choice：够就定稿；不够就把选项交出去，等用户选完再来。
  if (args?.choice === undefined) {
    if (feasibility.budget.feasible) {
      const committed = await commitPlan({
        cfg,
        input,
        info,
        probe,
        scan,
        aspect,
        preset,
        sampling,
        mode: 'full',
        limit: feasibility.required,
        ...window,
      });
      return { ...committed.head, budget: feasibility.budget, options: [], planId: committed.planId, ...recordField(committed.record) };
    }
    const { head } = packPlan({ input, probe, scan, plan: feasibility.plan, aspect, preset });
    return { ...head, budget: feasibility.budget, options: feasibility.options };
  }

  // ③ 带 choice：解析成具体采样与上限，再定稿。仍然不够就报错并列出还剩下的路。
  const resolved = resolveChoice({ choice: args.choice, sampling, alternate, feasibility });
  if (resolved.error !== undefined) throw new Error(resolved.error);
  try {
    const committed = await commitPlan({
      cfg,
      input,
      info,
      probe,
      scan,
      aspect,
      preset: resolved.mode === 'understand' ? 'understand' : preset,
      sampling: resolved.sampling,
      mode: resolved.mode,
      limit: resolved.limit,
      ...window,
    });
    return { ...committed.head, budget: feasibility.budget, options: [], planId: committed.planId, ...recordField(committed.record) };
  } catch (error) {
    const message = String(error?.message ?? error);
    if (message.startsWith('still does not fit')) {
      throw new Error(`${message}. Remaining options: ${describeOptions(feasibility.options)}`);
    }
    throw error;
  }
}

/**
 * `video_watch` 主体：抽帧、拼图、提交附件。
 *
 * @param params - 参数。
 * @returns 工具返回值。
 */
export async function executeWatch(params) {
  const { args, exec, ctx, run, cfg } = params;

  // 检查在 plan 那一步：没有 planId 就等于"还没问过用户、也没论证过预算"。
  // 这里不读 maxTotalSheets，也不做任何预算判断 —— 钱在 plan 时就定死了。
  const input = requireInput(args);
  const planId = typeof args?.planId === 'string' ? args.planId.trim() : '';
  if (planId === '') {
    throw new Error(
      'video_watch needs a planId from video_plan: plan first (it decides the mode, the density and whether the budget is enough), ' +
        'then call video_watch with the returned planId. Nothing was scanned, no image was produced.',
    );
  }
  const snapshot = await readPlan(cfg.cacheDir, planId);
  if (snapshot === null) {
    throw new Error(`plan "${planId}" is not on disk (the plan cache may have been pruned); call video_plan again`);
  }
  let info;
  try {
    info = await stat(input);
  } catch {
    throw new Error(`cannot read "${input}": no such file`);
  }
  const stale = verifyPlan(snapshot, { input, size: info.size, mtimeMs: info.mtimeMs, cfg });
  if (stale !== null) throw new Error(`this plan is stale: ${stale}. Call video_plan again.`);

  await assertImageCapableRoute(ctx, exec);

  const signal = exec?.signal;
  const { probe, aspect, scan } = await probeAndScan({ run, cfg, input, signal });

  // 按快照重算同一份计划。算出来必须与定稿时一致，否则宁可失败，
  // 也不要交一份"没人批准过"的计划。
  const plan = planFor({
    duration: snapshot.duration,
    scanFps: scan.fps,
    area: scan.area,
    from: snapshot.from,
    to: snapshot.to,
    sampling: snapshot,
    mode: snapshot.mode,
    limit: snapshot.limit,
  });
  if (plan.stats.sheets !== snapshot.sheets || Math.abs(plan.stats.coveredTo - snapshot.coveredTo) > 0.01) {
    throw new Error(
      `the recomputed plan no longer matches the approved one (${plan.stats.sheets} vs ${snapshot.sheets} sheets); call video_plan again`,
    );
  }

  const preset = snapshot.preset;
  const frames = plan.frames;
  if (frames.length === 0) throw new Error(`no frame could be planned for "${input}"`);

  const { head, groups } = packPlan({ input, probe, scan, plan, aspect, preset });

  const attachments = ctx.get('attachments');
  if (attachments === undefined) throw new Error('no attachment service is mounted, so frames cannot be handed back as images');

  const burn = ['none', 'index', 'time'].includes(args?.burn) ? args.burn : cfg.burn;
  const canBurn = burn !== 'none' && (await canBurnText({ run, cfg, signal }));

  const workDir = await mkdtemp(join(tmpdir(), 'dsh-video-watching-'));
  try {
    // 每批几张由快照里的 maxSheets 决定：它只影响切批，不影响预算。
    const batchSize = plan.stats.maxSheets;
    const { slice, meta: batch } = batchOf(groups, batchSize, args?.batch ?? 1);
    const deliveryGroups = slice;
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
        global: (batch.index - 1) * batch.size + sheets.length + 1,
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
      from: batch.from,
      to: batch.to,
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
      from: batch.from,
      to: batch.to,
      workDir,
      signal,
      hasAudio: probe.hasAudio,
    });

    // 语音不画在图上（会挡住画面），而是给每张图起个"名字"：取覆盖这张图那段时间的一两句话。
    // 来源有两条：本地识别出来的口播（audio.speech.lines）与外部字幕文件（transcript.lines）。
    const saidLines = [...(audio?.speech?.lines ?? []), ...transcript.lines].sort((left, right) => left.start - right.start);
    if (saidLines.length > 0) {
      for (const sheet of sheets) {
        const said = saidLines.filter((line) => line.end > sheet.start - 1e-9 && line.start < sheet.end + 1e-9);
        if (said.length > 0) {
          const joined = said.map((line) => line.text).join(' / ');
          sheet.title = joined.length > 42 ? `${joined.slice(0, 41)}…` : joined;
        }
      }
    }

    // 落记录：这一批的组成、时间码、语音、BGM 由插件自己写进 Markdown；
    // 模型对内容/剪辑手法/风格/动画的判断，由 video_note 补进同一段的占位处。
    const cellsBySheet = sheets.map((sheet) =>
      placed.filter((item) => item.sheet === sheet.sheet).map((item) => formatClock(item.frame.time)),
    );
    let record;
    try {
      record = await appendBatch({
        cfg,
        input,
        planId,
        batch,
        sheets,
        cellsBySheet,
        transcript,
        audio,
        skipped: skipped.length,
        frames: placed.length,
        probe,
        plan,
        snapshot,
      });
    } catch {
      record = undefined;
    }

    const images = refs.map(toImageValue);
    return {
      ...head,
      planId,
      ...recordField(record),
      frames: placed.map((item, index) => ({
        index: index + 1,
        time: round(item.frame.time, 3),
        label: formatClock(item.frame.time),
        sheet: item.sheet,
        cell: item.cell,
      })),
      sheets: sheets.map((sheet, index) => ({
        sheet: sheet.sheet,
        global: sheet.global,
        from: sheet.start,
        to: sheet.end,
        ...(sheet.title === undefined ? {} : { title: sheet.title }),
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
      batch,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * `video_note` 主体：把模型对某一批的分析写进观看记录。
 *
 * 只碰本地 Markdown，不取帧、不上传、不花钱。
 *
 * @param params - 参数。
 * @returns 工具返回值。
 */
export async function executeNote(params) {
  const { args, cfg } = params;
  const input = requireInput(args);
  const planId = typeof args?.planId === 'string' ? args.planId.trim() : '';
  if (planId === '') {
    throw new Error('video_note needs the planId from video_plan: the record is keyed by plan, so a note without one would land in the wrong place');
  }
  const batch = Number(args?.batch);
  if (!Number.isInteger(batch) || batch < 1) {
    throw new Error('batch must be a positive integer: it says which delivery unit this analysis belongs to');
  }
  const written = await writeAnalysis({ cfg, input, planId, batch, note: args?.note });
  return { path: written.path, batch, bytes: written.bytes, appended: written.appended };
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

  const workDir = await mkdtemp(join(tmpdir(), 'dsh-video-watching-close-'));
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
