/**
 * tools.js —— 三个工具的定义（schema、render 引用、execute 引用）。
 *
 * 这里是模型**唯一**读得到的东西：工具描述与参数名决定它会不会调、怎么调，
 * 所以描述改动要当成对外接口改动来看。
 *
 * @module dsh-video-understanding/tools
 */

import { basename } from 'node:path';

import { executeCloseup, executePlan, executeWatch } from './orchestrate.js';
import { renderCloseup, renderPlan, renderWatch } from './render.js';

/**
 * 构造三个工具定义（导出是为了让测试在没有 Agent 的情况下也能拿到同一份契约）。
 *
 * @param deps - 依赖。
 * @returns 工具定义数组。
 */
export function buildTools(deps) {
  return [watchTool(deps), planTool(deps), closeupTool(deps)];
}

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
    maxTotalSheets: { type: 'integer' },
    batches: { type: 'integer' },
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
    // 两个键必须与 headOf() 返回的 estimate 逐字段对齐：Agent 按这个 schema
    // 校验工具返回值，多一个没声明的键就整次调用失败（INVALID_TOOL_OUTPUT）。
    // 这里刻意不放 `singles`：单帧图片数由 `plan.singles` 给，两个字段指同一件事会被读成两个数。
    properties: { sheets: { type: 'integer' }, tokens: { type: 'integer' } },
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
      'Watch a video in one of two modes. "analysis" samples densely for animation, camera moves and effects (a=0.3); ' +
      '"understand" is a looser pass for what the video is about (a=1, up to 10 images). If the user has not said which mode they want, ' +
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
        userConfirmed: {
          type: 'boolean',
          description:
            'Set true ONLY after the user has answered which mode to use. Never guess it: without it the call is refused and nothing is scanned or charged.',
        },
        batch: {
          type: 'integer',
          description:
            'Which delivery batch to return (1-based). Omit for the first. The reply carries batch.total and batch.next; keep calling with the next index in the same conversation so the context stays continuous.',
        },
        from: { type: 'number', description: 'Window start in seconds (default 0).' },
        to: { type: 'number', description: 'Window end in seconds (default: end of file).' },
        maxSheets: { type: 'integer', description: `Delivery unit: at most this many images in one call (analysis 5 / understand 10). A mosaic of 4/9/16 sub-frames counts as ONE image (~384 tokens), so this caps cost directly.` },
        overflow: { type: 'string', enum: ['thin', 'stop'], description: `What to do over budget: 'thin' (default) raises the change threshold so the whole video gets sparser; 'stop' keeps the first maxSheets images and skips the rest of the video, reporting how far it covered.` },
        a: { type: 'number', description: 'Change threshold: one frame per this many full-screen changes. analysis=0.3 (dense), understand=1 (looser). Overrides the preset.' },
        t: { type: 'number', description: `Density window in seconds (analysis 1 / understand 1.5). Samples inside one window decide the grid: 1 single, 2-4 -> 2x2, 5-9 -> 3x3, 10+ -> 4x4.` },
        maxGap: { type: 'number', description: 'Force a frame whenever this many seconds pass with nothing sampled. analysis=5, understand=6; 0 disables. Overrides the preset.' },
        multiCross: { type: 'boolean', description: `Allow several samples inside a single analysis interval (default true). Turn it off to cap density at the analysis frame rate.` },
        cutPair: { type: 'boolean', description: `On an instantaneous cut, return the last frame before it and the first after (default false). Only fires on single-interval jumps, never on gradual transitions.` },
        burn: {
          type: 'string',
          enum: ['time', 'index', 'none'],
          description: 'What to burn into each cell: time (default, mm:ss), index (cell number), or none.',
        },
        transcriptFile: { type: 'string', description: 'Optional SRT/VTT/JSON transcript to align with the frames. Without it the embedded subtitle track is used when present.' },
      },
      required: ['input', 'preset', 'userConfirmed'],
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
                global: { type: 'integer' },
                from: { type: 'number' },
                to: { type: 'number' },
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
                global: { type: 'integer' },
                from: { type: 'number' },
                to: { type: 'number' },
                cols: { type: 'integer' },
                rows: { type: 'integer' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                tokens: { type: 'integer' },
                image: IMAGE_VALUE,
              },
              required: ['sheet', 'global', 'from', 'to', 'cols', 'rows', 'width', 'height', 'tokens', 'image'],
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
          batch: {
            type: 'object',
            additionalProperties: false,
            properties: {
              index: { type: 'integer' },
              total: { type: 'integer' },
              size: { type: 'integer' },
              sheets: { type: 'integer' },
              from: { type: 'number' },
              to: { type: 'number' },
              next: { type: 'integer' },
              done: { type: 'boolean' },
            },
            required: ['index', 'total', 'size', 'sheets', 'from', 'to', 'next', 'done'],
          },
          audio: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string' },
              notes: { type: 'array', items: { type: 'string' } },
              speech: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  status: { type: 'string' },
                  source: { type: 'string' },
                  count: { type: 'integer' },
                  lines: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: { start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' } },
                      required: ['start', 'end', 'text'],
                    },
                  },
                },
                required: ['status', 'source', 'count', 'lines'],
              },
              bgm: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  status: { type: 'string' },
                  model: { type: 'string' },
                  chunks: { type: 'integer' },
                  sampled: { type: 'boolean' },
                  music: { type: 'string' },
                  style: { type: 'string' },
                  tempo: { type: 'string' },
                  musicMood: { type: 'string' },
                  instruments: { type: 'array', items: { type: 'string' } },
                  characteristics: { type: 'string' },
                  searchWords: { type: 'array', items: { type: 'string' } },
                  changes: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: { at: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } },
                      required: ['at', 'from', 'to'],
                    },
                  },
                  sfx: { type: 'array', items: { type: 'string' } },
                  segments: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        from: { type: 'number' },
                        to: { type: 'number' },
                        music: { type: 'string' },
                        style: { type: 'string' },
                        tempo: { type: 'string' },
                        musicMood: { type: 'string' },
                        characteristics: { type: 'string' },
                      },
                      required: ['from', 'to', 'music', 'style', 'tempo', 'musicMood', 'characteristics'],
                    },
                  },
                },
                required: ['status', 'model', 'chunks', 'sampled', 'music', 'style', 'tempo', 'musicMood', 'instruments', 'characteristics', 'searchWords', 'changes', 'sfx', 'segments'],
              },
            },
            required: ['status', 'notes', 'speech', 'bgm'],
          },
        },
        required: [...HEAD_REQUIRED, 'frames', 'sheets', 'transcript', 'skipped', 'audio', 'batch'],
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
        userConfirmed: {
          type: 'boolean',
          description:
            'Set true ONLY after the user has answered which mode to use. Never guess it. This is the first decision of the whole plugin, and without it nothing runs.',
        },
        from: { type: 'number', description: 'Window start in seconds (default 0).' },
        to: { type: 'number', description: 'Window end in seconds (default: end of file).' },
        maxSheets: { type: 'integer', description: `Delivery unit: at most this many images in one call (analysis 5 / understand 10), ~384 tokens each; a mosaic counts as one image. Over budget, 'thin' thins the whole plan, 'stop' truncates.` },
        overflow: { type: 'string', enum: ['thin', 'stop'], description: `Over budget: 'thin' (default) thins the whole plan, 'stop' keeps the first maxSheets images and reports the covered range.` },
        a: { type: 'number', description: `Change threshold: one frame per this many full-screen changes (analysis 0.3 / understand 1).` },
        t: { type: 'number', description: `Density window in seconds (analysis 1 / understand 1.5).` },
        maxGap: { type: 'number', description: `Force a frame when this many seconds pass with nothing sampled (analysis 5 / understand 6).` },
        multiCross: { type: 'boolean', description: `Allow several samples inside one analysis interval (default true).` },
        cutPair: { type: 'boolean', description: `Return the frame before and after an instantaneous cut (default false).` },
      },
      required: ['input', 'preset', 'userConfirmed'],
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
