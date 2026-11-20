/**
 * util.js —— 执行与渲染共用的小工具。
 *
 * 只有被两个以上模块用到的东西才放这里；一次性逻辑留在调用方。
 *
 * @module dsh-video-understanding/util
 */

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { buildDrawtext, extractSubtitles, hasDrawtext } from './ffmpeg.js';
import { formatClock, parseSeconds, parseTranscript, sliceTranscript } from './time.js';

/**
 * 校验并取出 `input`。
 *
 * @param args - 调用参数。
 * @returns 路径。
 */
export function requireInput(args) {
  const input = typeof args?.input === 'string' ? args.input.trim() : '';
  if (input === '') throw new Error('input must be a non-empty path to a video file');
  return input;
}

/**
 * 解析 `times`：数字与时钟串都收，认不出来的丢掉。
 *
 * @param value - 参数值。
 * @returns 秒数数组。
 */
export function normalizeTimes(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const seconds = parseSeconds(item);
    if (seconds !== null && Number.isFinite(seconds) && seconds >= 0) out.push(seconds);
  }
  return out;
}

/**
 * 拼"缩放 + 补边 + 烧字"的过滤器链。
 *
 * 补边是必需的：子图必须是统一尺寸，否则 `tile` 会直接失败。
 *
 * @param params - 参数。
 * @returns 过滤器字符串。
 */
export function buildCellFilter(params) {
  const { width, height, text, fontFile } = params;
  const base = `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
  if (text === '') return base;
  const size = Math.max(12, Math.min(28, Math.round(height / 6)));
  return `${base},${buildDrawtext({ text, fontFile, fontSize: size })}`;
}

/**
 * 把有空洞的帧序列压成连续文件名。
 *
 * `tile` 按 `%04d.jpg` 从 1 连续读，中间缺一个就会少一张子图并错位。
 *
 * @param jobs - 已经成功的帧任务。
 * @returns 重排后的任务（含新路径）。
 */
export async function compactSequence(jobs) {
  if (jobs.length === 0) return [];
  const out = [];
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const want = job.outPath.replace(/\d{4}\.jpg$/, `${String(index + 1).padStart(4, '0')}.jpg`);
    if (want !== job.outPath) {
      try {
        await rename(job.outPath, want);
      } catch {
        /* 重命名失败就跳过这一帧 */
        continue;
      }
    }
    out.push({ ...job, outPath: want });
  }
  return out;
}

/**
 * 这份 ffmpeg 能不能烧字，以及字体文件在不在。
 *
 * @param params - 参数。
 * @returns 能否烧字。
 */
export async function canBurnText(params) {
  const { run, cfg, signal } = params;
  if (cfg.fontFile === '') return false;
  try {
    await stat(cfg.fontFile);
  } catch {
    return false;
  }
  return hasDrawtext({ run, ffmpegPath: cfg.ffmpegPath, signal });
}

/**
 * 取字幕：优先用调用方给的文件，其次用内嵌字幕轨。
 *
 * @param params - 参数。
 * @returns `{ source, count, lines }`。
 */
export async function loadTranscript(params) {
  const { run, cfg, input, probe, from, to, transcriptFile, workDir, signal } = params;
  const empty = { source: 'none', count: 0, lines: [] };

  /**
   * 把字幕条目裁到窗口内并抽稀成清单行。
   *
   * 直接产出 `{start, text}` 而不是先拼字符串再正则拆回来：
   * 走一遍格式化再解析会丢掉毫秒精度，而时间码的精度正是这个插件的卖点之一。
   */
  const build = (cues, source) => {
    const picked = sliceTranscript(cues, from, to);
    if (picked.length === 0) return { source, count: 0, lines: [] };
    const stride = Math.max(1, Math.ceil(picked.length / 30));
    const lines = [];
    for (let index = 0; index < picked.length; index += stride) {
      const cue = picked[index];
      const text = cue.text.length > 100 ? `${cue.text.slice(0, 99)}…` : cue.text;
      lines.push({ start: round(cue.start, 3), text });
    }
    return { source, count: picked.length, lines };
  };

  const parseAndBuild = (text, source) => {
    const cues = parseTranscript(text);
    if (cues === null || cues.length === 0) return empty;
    return build(cues, source);
  };

  if (typeof transcriptFile === 'string' && transcriptFile.trim() !== '') {
    try {
      const text = await readFile(transcriptFile.trim(), 'utf8');
      const result = parseAndBuild(text, basename(transcriptFile.trim()));
      if (result.count > 0) return result;
    } catch {
      /* 读不到就当没给 */
    }
  }

  if (probe.subtitleTracks.length > 0) {
    const outPath = join(workDir, 'subs.srt');
    try {
      await extractSubtitles({
        run,
        ffmpegPath: cfg.ffmpegPath,
        input,
        streamIndex: probe.subtitleTracks[0].index,
        outPath,
        signal,
        timeoutMs: cfg.timeoutMs,
      });
      const text = await readFile(outPath, 'utf8');
      const result = parseAndBuild(text, 'embedded subtitle track');
      if (result.count > 0) return result;
    } catch {
      /* 字幕轨导不出来就算了 */
    }
  }

  // 最后才走外部的转写命令：它最贵，而且需要用户先配好。
  if (Array.isArray(cfg.transcriptCommand) && cfg.transcriptCommand.length > 0) {
    const outPath = join(workDir, 'asr.srt');
    try {
      const argv = expandCommand(cfg.transcriptCommand, { input, output: outPath });
      await run(argv, { signal, timeoutMs: cfg.timeoutMs });
      const text = await readFile(outPath, 'utf8');
      const result = parseAndBuild(text, 'external transcript command');
      if (result.count > 0) return result;
      return { source: 'none (transcript command produced no subtitle lines)', count: 0, lines: [] };
    } catch (error) {
      // 命令失败不能瞒着：模型如果以为"本来就没台词"，就会编。
      // 把原因塞进 source 字段，它会一路透传到 <content> 那行。
      const reason = String(error?.message ?? error).split('\n')[0].slice(0, 140);
      return { source: `none (transcript command failed: ${reason})`, count: 0, lines: [] };
    }
  }

  return empty;
}

/**
 * 有限并发的 map。
 *
 * @param items - 输入。
 * @param limit - 并发上限。
 * @param worker - 处理函数。
 * @returns 与输入等长的结果数组。
 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 把附件引用裁成 schema 允许的字段。
 *
 * 不能直接展开 `ref`：`additionalProperties: false` 之下多带一个键就是违约。
 *
 * @param ref - 附件引用。
 * @returns 值。
 */
export function toImageValue(ref) {
  return {
    attachmentId: String(ref?.attachmentId ?? ''),
    mediaType: String(ref?.mediaType ?? ''),
    bytes: Math.round(Number(ref?.bytes) || 0),
    width: Math.round(Number(ref?.width) || 0),
    height: Math.round(Number(ref?.height) || 0),
  };
}

/**
 * 在动 ffmpeg 之前确认调用方模型收得了图。
 *
 * 只在拿到**明确否定**时拒绝：取不到路由信息的场景（子代理、headless）很常见，
 * 一律拒绝会让工具在那里直接不可用。
 *
 * @param ctx - Agent 上下文。
 * @param exec - 执行上下文。
 */
export async function assertImageCapableRoute(ctx, exec) {
  let llm;
  try {
    llm = ctx.get('llm');
  } catch {
    return;
  }
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return;

  const routed = exec?.agent?.session?.requestHeader?.()?.config;
  const provider = routed?.provider ?? exec?.agent?.options?.provider;
  const model = routed?.model ?? exec?.agent?.options?.model;
  if (provider === undefined || model === undefined) return;

  let active;
  try {
    active = await llm.resolveModelInfo(provider, model, exec?.signal);
  } catch {
    return;
  }
  const modalities = active?.inputModalities;
  if (modalities === undefined) return;
  if (!modalities.includes('image')) {
    throw new Error(
      `cannot watch video for model "${model}": it does not declare image input, and video_watch returns frames as images. ` +
        'Switch to an image-capable model, or use video_plan for the text-only plan.',
    );
  }
}

/**
 * 间隔的可读写法：小于一秒写分数，大于一秒写秒。
 *
 * @param seconds - 间隔。
 * @returns 文本。
 */
export function fmtSeconds(seconds) {
  const value = Number(seconds) || 0;
  if (value < 1) return `${(1 / Math.max(0.01, value)).toFixed(value < 0.5 ? 1 : 0).replace(/\.0$/, '')}/s`;
  return `${value.toFixed(1).replace(/\.0$/, '')}s`;
}

export function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

/**
 * 单复数：`1 frame` / `3 frames`。
 *
 * @param count - 数量。
 * @param word - 词。
 * @returns 文本。
 */
export function plural(count, word) {
  return `${count} ${word}${Number(count) === 1 ? '' : 's'}`;
}

/**
 * 密度地图的一行：从几点到几点、多密、几帧。
 *
 * 只有一张子图的分组不能写"每 X 秒一帧"—— x 会是 0，印出来是 `every 100/s`，
 * 既没意义又误导。单格直接写 `single`。
 *
 * @param run - 密度段。
 * @returns 文本。
 */
export function densityLine(run) {
  const clock = run.to > run.from + 1e-9 ? `${formatClock(run.from)}-${formatClock(run.to)}` : formatClock(run.from);
  const rate = run.count > 1 ? `every ${fmtSeconds(run.intervalSeconds)}` : 'single';
  return `  ${clock}  ${rate}  ${plural(run.count, 'frame')}`;
}
