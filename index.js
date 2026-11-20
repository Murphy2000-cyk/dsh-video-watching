/**
 * dsh-video-understanding —— 先扫全片，再按画面变化决定取帧密度。
 *
 * 它和已有视频插件的分野只有一句话：**采样间隔随画面变化**。
 * 静止的地方拉长到几秒一帧，快剪的地方压到一秒三帧，切点上强制落一帧；
 * 多帧拼进一张小图省 token，看不清的再单独取回原图。
 *
 * 三个工具：
 *   - `video_plan`   只扫描不取图，告诉你这部片子会被怎么切（0 视觉 token）
 *   - `video_watch`  按计划交付宫格图 + 时间码清单 + 字幕
 *   - `video_closeup` 按时间码取回全分辨率单帧
 *
 * @module dsh-video-understanding
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { cacheKey, readCache, writeCache } from './lib/cache.js';
import { buildDrawtext, createRunner, extractFrame, extractFullFrame, extractSubtitles, hasDrawtext, probeVideo, scanToRgb, tileImages } from './lib/ffmpeg.js';
import { planGrid } from './lib/grid.js';
import { buildGroups, groupCost } from './lib/delivery.js';
import { densityMap, planFrames } from './lib/plan.js';
import { analyzeDims, analyzeFromStream, frameBytes } from './lib/scan.js';
import { formatClock, formatShort, parseSeconds, parseTranscript, sliceTranscript } from './lib/time.js';

export const name = 'video-understanding';

/**
 * 依赖的宿主服务。三个都是核心服务，声明它们不会让 fiber 停在 PENDING。
 */
export const inject = ['subprocess', 'tools', 'attachments'];

/** 交付给附件服务的媒体类型。 */
const MEDIA_TYPE = 'image/jpeg';

/** 单帧提取的并发度：再高只是在抢同一个解码器的 IO。 */
const EXTRACT_CONCURRENCY = 4;

/**
 * 插件入口。
 *
 * @param ctx - 宿主上下文。
 * @param config - 插件配置，全部可缺省。
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const run = createRunner((spec) => ctx.subprocess.spawn(spec), { graceMs: cfg.graceMs, timeoutMs: cfg.timeoutMs });
  const disposers = buildTools({ ctx, run, cfg }).map((definition) => ctx.tools.register(definition));
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* 卸载期的清理失败不该再抛出去 */
        }
      }
    });
  }
}

/**
 * 构造三个工具定义（导出是为了让测试在没有宿主的情况下也能拿到同一份契约）。
 *
 * @param deps - 依赖。
 * @returns 工具定义数组。
 */
export function buildTools(deps) {
  return [watchTool(deps), planTool(deps), closeupTool(deps)];
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

/**
 * 归一化配置。
 *
 * @param config - 原始配置。
 * @returns 归一化后的配置。
 */
export function resolveConfig(config) {
  const raw = config ?? {};
  const home = (() => {
    try {
      return homedir();
    } catch {
      return '.';
    }
  })();
  const scanFps = clampNumber(raw.scanFps, 1, 30, 10);
  const exe = process.platform === 'win32' ? '.exe' : '';
  const binDir = join(home, '.dsh', 'bin', 'ffmpeg');
  const wingetLinks =
    typeof process.env.LOCALAPPDATA === 'string' ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : '';
  const known = (name) => [join(binDir, `${name}${exe}`), ...(wingetLinks === '' ? [] : [join(wingetLinks, `${name}${exe}`)])];
  return {
    ffmpegPath: resolveExecutable(raw.ffmpegPath, ['DSH_FFMPEG_PATH', 'FFMPEG_PATH'], 'ffmpeg', known('ffmpeg')),
    ffprobePath: resolveExecutable(raw.ffprobePath, ['DSH_FFPROBE_PATH', 'FFPROBE_PATH'], 'ffprobe', known('ffprobe')),
    scanFps,
    // 积分法：攒够 a 个满屏变化落一帧；每 t 秒数密度定网格
    a: clampNumber(raw.a, 0.01, 100, 0.3),
    t: clampNumber(raw.t, 0.2, 10, 1),
    maxGap: clampNumber(raw.maxGap, 0, 120, 5),
    multiCross: raw.multiCross !== false,
    cutPair: raw.cutPair === true,
    longSide: clampInt(raw.longSide, 32, 480, 120),
    block: clampInt(raw.block, 2, 16, 4),
    blockThreshold: clampInt(raw.blockThreshold, 1, 64, 8),
    // 预算按交付单元（图片张数）算：一张图约 384 token，与里面几格无关。
    maxSheets: clampInt(raw.maxSheets, 1, 200, 5),
    // 超预算时：thin = 全局变稀（默认）；stop = 看到上限就停，后面的内容不看。
    overflow: raw.overflow === 'stop' ? 'stop' : 'thin',

    quality: clampInt(raw.quality, 2, 31, 3),
    burn: ['none', 'index', 'time'].includes(raw.burn) ? raw.burn : 'time',
    fontFile: typeof raw.fontFile === 'string' && raw.fontFile !== '' ? raw.fontFile : defaultFont(),
    transcriptCommand: normalizeCommand(raw.transcriptCommand),
    cacheDir: typeof raw.cacheDir === 'string' && raw.cacheDir !== '' ? raw.cacheDir : join(home, '.dsh', 'cache', 'video-understanding'),
    timeoutMs: clampInt(raw.timeoutMs, 1000, 3600000, 180000),
    toolTimeoutMs: clampInt(raw.toolTimeoutMs, 1000, 3600000, 900000),
    graceMs: clampInt(raw.graceMs, 100, 30000, 2000),

  };
}

/**
 * 解析可执行文件路径：配置 > 环境变量 > 已知位置 > PATH 上的默认名。
 *
 * "已知位置"这一层是 Windows 上的实际需要：往用户 PATH 里加目录要**重启宿主**
 * 才生效，而插件装完往往当场就想跑。先看一眼自己的 bin 目录和 winget 的链接目录，
 * 命中就用绝对路径，省掉一次"为什么说找不到 ffmpeg"。
 *
 * @param configured - 配置里的值。
 * @param envNames - 依次尝试的环境变量。
 * @param fallback - 兜底命令名。
 * @param candidates - 已知的绝对路径候选。
 * @returns 命令或路径。
 */
function resolveExecutable(configured, envNames, fallback, candidates = []) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  for (const key of envNames) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* 探测失败就当不存在 */
    }
  }
  return fallback;
}

/**
 * 猜一个等宽字体给 drawtext 用。
 *
 * @returns 字体路径；猜不到返回空串（调用方会因此关掉烧字）。
 */
function defaultFont() {
  if (process.platform === 'win32') return 'C:/Windows/Fonts/consolab.ttf';
  if (process.platform === 'darwin') return '/System/Library/Fonts/Menlo.ttc';
  return '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

/**
 * 归一化外部转写命令。
 *
 * 只收**数组**，不收字符串：一条带占位符的字符串要交给 shell 才能用，
 * 而路径里的空格、引号、`&` 在 shell 里各有各的坏法。数组由调用方直接交给
 * 子进程服务，不经过任何 shell，`{input}` / `{output}` 在元素级别替换。
 *
 * @param value - 配置里的值。
 * @returns 字符串数组；配置无效时为空数组（等于不启用）。
 */
function normalizeCommand(value) {
  if (!Array.isArray(value)) return [];
  const items = value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
  if (items.length === 0) return [];
  // 两个占位符都要出现，否则命令拿不到视频、也交不出字幕。
  const joined = items.join(' ');
  if (!joined.includes('{input}') || !joined.includes('{output}')) return [];
  return items;
}

/**
 * 把占位符换成实际路径。纯函数，单测钉住。
 *
 * @param argv - 命令模板。
 * @param params - 替换值。
 * @returns 展开后的 argv。
 */
export function expandCommand(argv, params) {
  if (!Array.isArray(argv)) return [];
  return argv.map((item) =>
    String(item).replaceAll('{input}', params.input ?? '').replaceAll('{output}', params.output ?? ''),
  );
}

function clampInt(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback));
}

/* ------------------------------------------------------------------ *
 * 工具定义
 * ------------------------------------------------------------------ */

/** 一张图在返回值里的形状（必须与 schema 逐字段对应）。 */
const IMAGE_VALUE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
  },
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
};

/** 计划部分在返回值里的形状。 */
const PLAN_VALUE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    count: { type: 'integer' },
    moments: { type: 'integer' },
    fillers: { type: 'integer' },
    cuts: { type: 'integer' },
    cutHits: { type: 'integer' },
    tiles: { type: 'integer' },
    singles: { type: 'integer' },
    cutPairs: { type: 'integer' },
    a: { type: 'number' },
    aEff: { type: 'number' },
    t: { type: 'number' },
    maxGap: { type: 'number' },
    multiCross: { type: 'boolean' },
    cutPair: { type: 'boolean' },
    preset: { type: 'string' },
    maxSheets: { type: 'integer' },
    sheets: { type: 'integer' },
    overflow: { type: 'string' },
    truncated: { type: 'boolean' },
    coveredTo: { type: 'number' },
    budgetRaised: { type: 'boolean' },
    noiseFloor: { type: 'number' },
    totalChange: { type: 'number' },
    meanIntervalSeconds: { type: 'number' },
    minIntervalSeconds: { type: 'number' },
    maxIntervalSeconds: { type: 'number' },
    scale: { type: 'number' },
    from: { type: 'number' },
    to: { type: 'number' },
  },
  required: ['count', 'cuts', 'cutHits', 'meanIntervalSeconds', 'minIntervalSeconds', 'maxIntervalSeconds', 'scale', 'from', 'to'],
};

/** 共同的头字段。 */
const HEAD_PROPERTIES = {
  path: { type: 'string' },
  durationSeconds: { type: 'number' },
  sourceWidth: { type: 'integer' },
  sourceHeight: { type: 'integer' },
  fps: { type: 'number' },
  hasAudio: { type: 'boolean' },
  subtitleTracks: { type: 'integer' },
  scan: {
    type: 'object',
    additionalProperties: false,
    properties: {
      fps: { type: 'number' },
      frames: { type: 'integer' },
      seconds: { type: 'number' },
      cached: { type: 'boolean' },
    },
    required: ['fps', 'frames', 'seconds', 'cached'],
  },
  plan: PLAN_VALUE,
  density: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        label: { type: 'string' },
        from: { type: 'number' },
        to: { type: 'number' },
        count: { type: 'integer' },
        intervalSeconds: { type: 'number' },
      },
      required: ['label', 'from', 'to', 'count', 'intervalSeconds'],
    },
  },
  estimate: {
    type: 'object',
    additionalProperties: false,
    // 三个键必须与 headOf() 返回的 estimate 逐字段对齐：宿主按这个 schema
    // 校验工具返回值，多一个没声明的键就整次调用失败（INVALID_TOOL_OUTPUT）。
    properties: { sheets: { type: 'integer' }, tokens: { type: 'integer' }, singles: { type: 'integer' } },
    required: ['sheets', 'tokens'],
  },
};

const HEAD_REQUIRED = ['path', 'durationSeconds', 'sourceWidth', 'sourceHeight', 'fps', 'hasAudio', 'subtitleTracks', 'scan', 'plan', 'density', 'estimate'];

/**
 * 主工具：按自适应计划交付画面。
 *
 * @param deps - 依赖。
 * @returns 工具定义。
 */
function watchTool(deps) {
  const { ctx, run, cfg } = deps;
  return {
    name: 'video_watch',
    description:
      'Watch a video in one of two modes. "analysis" samples densely to read animation, camera moves and effects (a=0.3); ' +
      '"understand" is a cheaper pass for what the video is about (a=1.5). If the user has not said which mode they want, ' +
      'ask them first - never guess. Returns timestamped contact sheets. ' +
      'Not for audio-only transcription, single images, or metadata (size, duration, fps).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: { type: 'string', description: 'Path to the video file. Any container ffmpeg can decode.' },
        preset: {
          type: 'string',
          enum: ['analysis', 'understand'],
          description:
            'Required. "analysis" for studying animation / camera moves / effects; "understand" for what the video is about. ' +
            'Ask the user which one when it is not stated; do not pick silently.',
        },
        from: { type: 'number', description: 'Window start in seconds (default 0).' },
        to: { type: 'number', description: 'Window end in seconds (default: end of file).' },
        maxSheets: { type: 'integer', description: `Budget as delivery units: the most images to return (default ${cfg.maxSheets}). A mosaic of 4/9/16 cells counts as ONE image (~384 tokens), so this caps cost directly.` },
        overflow: { type: 'string', enum: ['thin', 'stop'], description: `What to do over budget: 'thin' (default) raises the change threshold so the whole video gets sparser; 'stop' keeps the first maxSheets images and skips the rest of the video, reporting how far it covered.` },
        a: { type: 'number', description: 'Change threshold: one frame per this many full-screen changes. analysis=0.3 (dense), understand=1.5 (cheap). Overrides the preset.' },
        t: { type: 'number', description: `Density window in seconds (default ${cfg.t}). Samples inside one window decide the grid: 1 single, 2-4 -> 2x2, 5-9 -> 3x3, 10+ -> 4x4.` },
        maxGap: { type: 'number', description: 'Force a frame whenever this many seconds pass with nothing sampled. analysis=5, understand=8; 0 disables. Overrides the preset.' },
        multiCross: { type: 'boolean', description: `Allow several samples inside a single analysis interval (default ${cfg.multiCross}). Turn it off to cap density at the analysis frame rate.` },
        cutPair: { type: 'boolean', description: `On an instantaneous cut, return the last frame before it and the first after (default ${cfg.cutPair}). Only fires on single-interval jumps, never on gradual transitions.` },
        burn: {
          type: 'string',
          enum: ['time', 'index', 'none'],
          description: 'What to burn into each cell: time (default, mm:ss), index (cell number), or none.',
        },
        transcriptFile: { type: 'string', description: 'Optional SRT/VTT/JSON transcript to align with the frames. Without it the embedded subtitle track is used when present.' },
      },
      required: ['input', 'preset'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...HEAD_PROPERTIES,
          frames: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer' },
                time: { type: 'number' },
                label: { type: 'string' },
                sheet: { type: 'integer' },
                cell: { type: 'integer' },
              },
              required: ['index', 'time', 'label', 'sheet', 'cell'],
            },
          },
          sheets: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sheet: { type: 'integer' },
                cols: { type: 'integer' },
                rows: { type: 'integer' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                tokens: { type: 'integer' },
                image: IMAGE_VALUE,
              },
              required: ['sheet', 'cols', 'rows', 'width', 'height', 'tokens', 'image'],
            },
          },
          transcript: {
            type: 'object',
            additionalProperties: false,
            properties: {
              source: { type: 'string' },
              count: { type: 'integer' },
              lines: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { start: { type: 'number' }, text: { type: 'string' } },
                  required: ['start', 'text'],
                },
              },
            },
            required: ['source', 'count', 'lines'],
          },
          skipped: { type: 'integer' },
        },
        required: [...HEAD_REQUIRED, 'frames', 'sheets', 'transcript', 'skipped'],
      },
      render: (_args, value) => renderWatch(value),
      presentationMeta: (_args, value) => ({ path: value.path, frames: value.frames.length, sheets: value.sheets.length }),
    },
    timeoutMs: cfg.toolTimeoutMs,
    isConcurrencySafe: () => true,
    presentCall(args) {
      return { card: 'generic', title: `Watch ${basename(String(args?.input ?? ''))}`, kind: 'read', locations: [{ path: String(args?.input ?? '') }] };
    },
    async execute(args, exec) {
      return executeWatch({ args, exec, ctx, run, cfg });
    },
  };
}

/**
 * `video_plan` 的工具定义：同一个扫描，但不出图。
 *
 * @param deps - 依赖。
 * @returns 工具定义。
 */
export function planTool(deps) {
  const { run, cfg } = deps;
  return {
    name: 'video_plan',
    description:
      'Show how a video would be sampled, without returning any image: duration, cut count, density map, sheets and cost. Costs zero tokens, ' +
      'so call it before video_watch when the clip is long. Takes the same two modes: "analysis" or "understand"; ask the user which one ' +
      'when it is not stated. Not for audio-only files, single images, or questions about size / duration / fps.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: { type: 'string', description: 'Path to the video file.' },
        preset: {
          type: 'string',
          enum: ['analysis', 'understand'],
          description:
            'Required. "analysis" for animation / camera moves / effects; "understand" for what the video is about. Ask the user; do not guess.',
        },
        from: { type: 'number', description: 'Window start in seconds (default 0).' },
        to: { type: 'number', description: 'Window end in seconds (default: end of file).' },
        maxSheets: { type: 'integer', description: `Budget as delivery units: the most images (default ${cfg.maxSheets}), ~384 tokens each; a mosaic counts as one image. Over budget, 'thin' thins the whole plan, 'stop' truncates.` },
        overflow: { type: 'string', enum: ['thin', 'stop'], description: `Over budget: 'thin' (default) thins the whole plan, 'stop' keeps the first maxSheets images and reports the covered range.` },
        a: { type: 'number', description: `Change threshold: one frame per this many full-screen changes (default ${cfg.a}).` },
        t: { type: 'number', description: `Density window in seconds (default ${cfg.t}).` },
        maxGap: { type: 'number', description: `Force a frame when this many seconds pass with nothing sampled (default ${cfg.maxGap}).` },
        multiCross: { type: 'boolean', description: `Allow several samples inside one analysis interval (default ${cfg.multiCross}).` },
        cutPair: { type: 'boolean', description: `Return the frame before and after an instantaneous cut (default ${cfg.cutPair}).` },
      },
      required: ['input', 'preset'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: HEAD_PROPERTIES,
        required: HEAD_REQUIRED,
      },
      render: (_args, value) => renderPlan(value),
      presentationMeta: (_args, value) => ({ path: value.path, frames: value.plan.count }),
    },
    timeoutMs: cfg.toolTimeoutMs,
    isConcurrencySafe: () => true,
    presentCall(args) {
      return { card: 'generic', title: `Plan ${basename(String(args?.input ?? ''))}`, kind: 'read', locations: [{ path: String(args?.input ?? '') }] };
    },
    async execute(args, exec) {
      return executePlan({ args, exec, run, cfg });
    },
  };
}

/**
 * `video_closeup` 的工具定义：按时间码取回原分辨率单帧。
 *
 * @param deps - 依赖。
 * @returns 工具定义。
 */
export function closeupTool(deps) {
  const { ctx, run, cfg } = deps;
  return {
    name: 'video_closeup',
    description:
      'Pull one moment out of a video at full resolution, as a real image. Use it when a contact-sheet cell is too small to read a caption, ' +
      'recognise a face, or see detail; pass the exact timestamp reported by video_watch. Not for pulling many frames at once - ' +
      'video_watch is the cheaper way to watch a stretch of video.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: { type: 'string', description: 'Path to the video file.' },
        times: {
          type: 'array',
          items: { oneOf: [{ type: 'number' }, { type: 'string' }] },
          description: 'Moments to grab, as seconds (12.5) or clock strings ("01:30").',
        },
        burn: { type: 'string', enum: ['time', 'none'], description: 'Burn mm:ss into the frame (default time).' },
      },
      required: ['input', 'times'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          sourceWidth: { type: 'integer' },
          sourceHeight: { type: 'integer' },
          durationSeconds: { type: 'number' },
          frames: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                time: { type: 'number' },
                label: { type: 'string' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                image: IMAGE_VALUE,
              },
              required: ['time', 'label', 'width', 'height', 'image'],
            },
          },
        },
        required: ['path', 'sourceWidth', 'sourceHeight', 'durationSeconds', 'frames'],
      },
      render: (_args, value) => renderCloseup(value),
      presentationMeta: (_args, value) => ({ path: value.path, frames: value.frames.length }),
    },
    timeoutMs: cfg.toolTimeoutMs,
    isConcurrencySafe: () => true,
    presentCall(args) {
      return { card: 'generic', title: `Close-up ${basename(String(args?.input ?? ''))}`, kind: 'read', locations: [{ path: String(args?.input ?? '') }] };
    },
    async execute(args, exec) {
      return executeCloseup({ args, exec, ctx, run, cfg });
    },
  };
}

/* ------------------------------------------------------------------ *
 * 执行
 * ------------------------------------------------------------------ */

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
 *   - `understand`：只认视频讲了什么。密度按"看懂内容"给（a=1.5），
 *     每个静止段容忍更长的间隔，不关心切点前后差一帧。
 *
 * 判定顺序：**显式单参 > preset > 配置文件**。所以 preset 决定一组默认值，
 * 想微调仍然可以直接传 `a`、`maxGap` 这些。
 */
export const PRESETS = {
  analysis: { a: 0.3, t: 1, maxGap: 5, multiCross: true, cutPair: false, maxSheets: 5, overflow: 'thin' },
  understand: { a: 1.5, t: 1, maxGap: 8, multiCross: true, cutPair: false, maxSheets: 5, overflow: 'thin' },
};

/** 预设名单，供 schema 的 enum 使用。 */
export const PRESET_NAMES = Object.keys(PRESETS);

/**
 * 把 preset 与显式参数合成一份生效的采样参数。
 *
 * @param args - 工具入参。
 * @param cfg - 归一化后的配置。
 * @returns `{ a, t, maxGap, multiCross, cutPair, maxSheets, overflow }`。
 */
export function effectiveArgs(args, cfg) {
  const preset = PRESETS[args?.preset] ?? PRESETS.analysis;
  const merged = { ...cfg, ...preset };
  return {
    a: args?.a ?? merged.a,
    t: args?.t ?? merged.t,
    maxGap: args?.maxGap ?? merged.maxGap,
    multiCross: args?.multiCross ?? merged.multiCross,
    cutPair: args?.cutPair ?? merged.cutPair,
    maxSheets: args?.maxSheets ?? merged.maxSheets,
    overflow: args?.overflow ?? merged.overflow,
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
 * 宿主就在运行时报 `INVALID_TOOL_OUTPUT`（`estimate.singles` 就是这么漏的）。
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
    estimate: { sheets: estimate.sheets, tokens: estimate.tokens, singles: estimate.singles ?? 0 },
  };
}

/**
 * `video_plan` 主体。
 *
 * @param params - 参数。
 * @returns 工具返回值。
 */
async function executePlan(params) {
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
async function executeWatch(params) {
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
    // 每张图装哪些格由 buildGroups 定好：密窗口拼图、切点取前后两帧、单帧装箱
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
async function executeCloseup(params) {
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

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

/**
 * `video_watch` 的内容块：一段钉死"第几格 = 第几秒"的文本 + N 张图。
 *
 * @param value - 工具返回值。
 * @returns 内容块数组。
 */
export function renderWatch(value) {
  const lines = [
    `<path>${value.path}</path>`,
    '<type>video</type>',
    `<content>${value.durationSeconds} s, source ${value.sourceWidth}x${value.sourceHeight} px, ` +
      `${value.plan.count} frames sampled over ${value.plan.from.toFixed(1)}-${value.plan.to.toFixed(1)} s, ` +
      `${value.plan.cuts} cuts, audio ${value.hasAudio ? 'present' : 'none'}, transcript ${value.transcript.source}</content>`,
    '<density>',
    ...value.density.map(densityLine),
    '</density>',
  ];

  for (const sheet of value.sheets) {
    const cells = value.frames.filter((frame) => frame.sheet === sheet.sheet);
    lines.push(`<sheet index="${sheet.sheet}" grid="${sheet.cols}x${sheet.rows}">`);
    lines.push('  Cells read left to right, then top to bottom. Empty trailing cells are padding, not video.');
    for (const cell of cells) lines.push(`  cell ${cell.cell} = ${cell.label}`);
    lines.push('</sheet>');
  }

  if (value.transcript.lines.length > 0) {
    lines.push(`<transcript source="${value.transcript.source}">`);
    for (const line of value.transcript.lines) lines.push(`  [${formatClock(line.start)}] ${line.text}`);
    lines.push('</transcript>');
  }

  const tokens = value.sheets.reduce((sum, sheet) => sum + sheet.tokens, 0);
  lines.push(`<cost>${value.sheets.length} image(s) over ${value.plan.count} frames ≈ ${tokens} vision tokens. ` +
    'A cell too small to read: call video_closeup with that timestamp.</cost>');
  if (value.skipped > 0) lines.push(`<skipped>${value.skipped} frame(s) could not be extracted and are absent from the sheets.</skipped>`);

  const blocks = [{ type: 'text', text: lines.join('\n') }];
  for (const sheet of value.sheets) blocks.push({ type: 'image', attachment: { ...sheet.image } });
  return blocks;
}

/**
 * `video_plan` 的内容块：纯文本，零图片。
 *
 * @param value - 工具返回值。
 * @returns 内容块数组。
 */
export function renderPlan(value) {
  const lines = [
    `<path>${value.path}</path>`,
    '<type>video-plan</type>',
    `<content>${value.durationSeconds} s, ${value.sourceWidth}x${value.sourceHeight} px @ ${value.fps} fps, ` +
      `audio ${value.hasAudio ? 'present' : 'none'}, ${value.subtitleTracks} subtitle track(s)</content>`,
    `<scan frames="${value.scan.frames}" fps="${value.scan.fps}" seconds="${value.scan.seconds}" cached="${value.scan.cached}"/>`,
    `<plan frames="${value.plan.count}" cuts="${value.plan.cuts}" snapped="${value.plan.cutHits}" ` +
      `mean="${fmtSeconds(value.plan.meanIntervalSeconds)}" min="${fmtSeconds(value.plan.minIntervalSeconds)}" ` +
      `max="${fmtSeconds(value.plan.maxIntervalSeconds)}" scale="${value.plan.scale}"/>`,
    '<density>',
    ...value.density.map(densityLine),
    '</density>',
    `<cost>${value.estimate.sheets} image(s) ≈ ${value.estimate.tokens} vision tokens. Nothing was returned as an image here.</cost>`,
  ];
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * `video_closeup` 的内容块。
 *
 * @param value - 工具返回值。
 * @returns 内容块数组。
 */
export function renderCloseup(value) {
  const lines = [
    `<path>${value.path}</path>`,
    '<type>video-closeup</type>',
    `<content>${value.durationSeconds} s, source ${value.sourceWidth}x${value.sourceHeight} px</content>`,
    '<frames>',
    ...value.frames.map((frame, index) => `  image ${index + 1} = ${frame.label} (${frame.width}x${frame.height})`),
    '</frames>',
  ];
  const blocks = [{ type: 'text', text: lines.join('\n') }];
  for (const frame of value.frames) blocks.push({ type: 'image', attachment: { ...frame.image } });
  return blocks;
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/**
 * 校验并取出 `input`。
 *
 * @param args - 调用参数。
 * @returns 路径。
 */
function requireInput(args) {
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
function normalizeTimes(value) {
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
 * 补边是必需的：格子必须是统一尺寸，否则 `tile` 会直接失败。
 *
 * @param params - 参数。
 * @returns 过滤器字符串。
 */
function buildCellFilter(params) {
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
 * `tile` 按 `%04d.jpg` 从 1 连续读，中间缺一个就会少拼一格并错位。
 *
 * @param jobs - 已经成功的帧任务。
 * @returns 重排后的任务（含新路径）。
 */
async function compactSequence(jobs) {
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
async function canBurnText(params) {
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
async function loadTranscript(params) {
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
async function mapLimit(items, limit, worker) {
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
function toImageValue(ref) {
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
 * @param ctx - 宿主上下文。
 * @param exec - 执行上下文。
 */
async function assertImageCapableRoute(ctx, exec) {
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
function fmtSeconds(seconds) {
  const value = Number(seconds) || 0;
  if (value < 1) return `${(1 / Math.max(0.01, value)).toFixed(value < 0.5 ? 1 : 0).replace(/\.0$/, '')}/s`;
  return `${value.toFixed(1).replace(/\.0$/, '')}s`;
}

function round(value, digits) {
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
function plural(count, word) {
  return `${count} ${word}${Number(count) === 1 ? '' : 's'}`;
}

/**
 * 密度地图的一行：从几点到几点、多密、几帧。
 *
 * 只有一格的分组不能写"每 X 秒一帧"—— x 会是 0，印出来是 `every 100/s`，
 * 既没意义又误导。单格直接写 `single`。
 *
 * @param run - 密度段。
 * @returns 文本。
 */
function densityLine(run) {
  const clock = run.to > run.from + 1e-9 ? `${formatClock(run.from)}-${formatClock(run.to)}` : formatClock(run.from);
  const rate = run.count > 1 ? `every ${fmtSeconds(run.intervalSeconds)}` : 'single';
  return `  ${clock}  ${rate}  ${plural(run.count, 'frame')}`;
}
