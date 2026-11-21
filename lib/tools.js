/**
 * tools.js —— 四个工具的定义（schema、render 引用、execute 引用）。
 *
 * 这里是模型**唯一**读得到的东西：工具描述与参数名决定它会不会调、怎么调，
 * 所以描述改动要当成对外接口改动来看。
 *
 * @module dsh-video-watching/tools
 */

import { basename } from 'node:path';

import { executeCloseup, executeNote, executePlan, executeWatch } from './orchestrate.js';
import { renderCloseup, renderNote, renderPlan, renderWatch } from './render.js';

/**
 * 构造四个工具定义（导出是为了让测试在没有 Agent 的情况下也能拿到同一份契约）。
 *
 * @param deps - 依赖。
 * @returns 工具定义数组。
 */
export function buildTools(deps) {
  return [watchTool(deps), planTool(deps), noteTool(deps), closeupTool(deps)];
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
    mode: {
      type: 'string',
    },
    maxSheets: { type: 'integer' },
    maxTotalSheets: { type: 'integer' },
    batches: { type: 'integer' },
    sheets: { type: 'integer' },
    overflow: { type: 'string' },
    truncated: { type: 'boolean' },
    videoComplete: { type: 'boolean' },
    coveredTo: { type: 'number' },
    unseenSeconds: { type: 'number' },
    budgetRaised: { type: 'boolean' },
    thinned: { type: 'boolean' },
    maxGapBroken: { type: 'boolean' },
    floorSheets: { type: 'integer' },
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

/** 预算块：这段窗口按现在的密度够不够、差多少。 */
const BUDGET_VALUE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    required: { type: 'integer' },
    minimum: { type: 'integer' },
    max: { type: 'integer' },
    feasible: { type: 'boolean' },
    sheets: { type: 'integer' },
    tokens: { type: 'integer' },
    coveredTo: { type: 'number' },
    unseenSeconds: { type: 'number' },
    batches: { type: 'integer' },
    a: { type: 'number' },
    t: { type: 'number' },
  },
  required: ['required', 'minimum', 'max', 'feasible', 'sheets', 'tokens', 'coveredTo', 'unseenSeconds', 'batches', 'a', 't'],
};

/** 一个候选方案：带数字，用户可以直接选。 */
const OPTION_VALUE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    sheets: { type: 'integer' },
    tokens: { type: 'integer' },
    coveredTo: { type: 'number' },
    unseenSeconds: { type: 'number' },
    batches: { type: 'integer' },
    a: { type: 'number' },
    t: { type: 'number' },
    maxGap: { type: 'number' },
    multiCross: { type: 'boolean' },
    cutPair: { type: 'boolean' },
    maxSheets: { type: 'integer' },
    budget: { type: 'integer' },
    feasible: { type: 'boolean' },
    recommended: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['id', 'sheets', 'tokens', 'coveredTo', 'unseenSeconds', 'batches', 'a', 't', 'maxGap', 'multiCross', 'cutPair', 'maxSheets', 'budget', 'feasible', 'recommended', 'note'],
};

/** 共同的头字段。 */
const HEAD_PROPERTIES = {
  path: { type: 'string' },
  planId: { type: 'string' },
  /** 观看记录（Markdown）的落盘路径；record: false 时不出现。 */
  record: { type: 'string' },
  budget: BUDGET_VALUE,
  options: { type: 'array', items: OPTION_VALUE },
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
      'Watch a video that has already been planned. Call video_plan first: it asks for the mode, checks whether the budget covers the whole ' +
      'video, and returns a planId. This tool only executes that approved plan, one batch at a time; it never changes the budget or the density. ' +
      'Each batch is also appended to a markdown viewing record on disk (frames, time codes, speech, BGM); call video_note after each batch to fill ' +
      'in your own reading of it. That per-batch entry is enforced: while it is missing, the next batch is refused (config requireNote can turn the gate off). ' +
      'Not for audio-only transcription, single images, or metadata (size, duration, fps).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: { type: 'string', description: 'Path to the video file. Must be the same file the plan was made for.' },
        planId: {
          type: 'string',
          description:
            'The planId returned by video_plan. Required: without it the call is refused, because the budget and the density were never agreed.',
        },
        batch: {
          type: 'integer',
          description:
            'Which delivery batch to return (1-based). Omit for the first. The reply carries batch.total and batch.next; keep calling with the next index in the same conversation so the context stays continuous.',
        },
        burn: {
          type: 'string',
          enum: ['time', 'index', 'none'],
          description: 'What to burn into each cell: time (default, mm:ss), index (cell number), or none.',
        },
        transcriptFile: { type: 'string', description: 'Optional SRT/VTT/JSON transcript to align with the frames. Without it the embedded subtitle track is used when present.' },
      },
      required: ['input', 'planId'],
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
                title: { type: 'string' },
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
                title: { type: 'string' },
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
                  properties: {
                    start: { type: 'number' },
                    end: { type: 'number' },
                    text: { type: 'string' },
                  },
                  required: ['start', 'end', 'text'],
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
              batchDone: { type: 'boolean' },
            },
            required: ['index', 'total', 'size', 'sheets', 'from', 'to', 'next', 'batchDone'],
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
      'Plan how a video would be sampled, and decide whether maxTotalSheets is enough to watch ALL of it: duration, cut count, density map, ' +
      'required sheets, and the budget verdict. Costs zero vision tokens. If the budget is short, it returns the concrete options (raise the budget / ' +
      'stop early / switch mode / raise a and t) and NO planId - ask the user, then call again with choice. When it fits, it returns the planId that ' +
      'video_watch needs and names the markdown viewing record for this run. The reply also carries a <sampling> line with the effective a / t / maxGap / ' +
      'multiCross / cutPair / maxSheets: those are mode + profile values, not tool parameters, so that line is the only place to see what the run uses. ' +
      'Not for audio-only files, single images, or questions about size / duration / fps.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: { type: 'string', description: 'Path to the video file.' },
        mode: {
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
        choice: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: {
              type: 'string',
              enum: ['raise', 'truncate', 'understand', 'density'],
              description:
                'Which option the user picked: raise = spend more sheets for full coverage; truncate = keep the budget and stop early; ' +
                'understand = switch to the looser mode; density = raise a and t to fit the budget with full coverage.',
            },
            budget: {
              type: 'integer',
              description: 'One-off budget for this plan only, in sheets. Does not change the profile; omit to use the option default.',
            },
            a: { type: 'number', description: 'Optional density override for the density option; omit to use the computed value.' },
            t: { type: 'number', description: 'Optional window override for the density option; omit to use the computed value.' },
          },
          required: ['id'],
        },
      },
      required: ['input', 'mode', 'userConfirmed'],
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
 * `video_note` 的工具定义：把模型对这一批的分析写进观看记录。
 *
 * 为什么单独一个工具：`video_watch` 能把"量得到的东西"写进文档（时间码、网格、
 * 语音、BGM），但"这段在讲什么、怎么剪的、是什么风格、动画怎么做的"只有看过图
 * 的模型知道。分成两个入口，记录里既有事实也有判断，谁也不冒充谁。
 *
 * @param deps - 依赖。
 * @returns 工具定义。
 */
export function noteTool(deps) {
  const { cfg } = deps;
  return {
    name: 'video_note',
    description:
      'Store your record of one delivery batch in the markdown viewing record. Call it right after every video_watch batch, including the last one: ' +
      'pass the batch index and your analysis. Write to one standard - the entry must be complete enough that someone who has never seen the video ' +
      'can REPRODUCE this batch from your text alone: what is on screen and in what order, which technique is used, how the effect or animation is ' +
      'made, the edit rhythm with its time codes, and what the speech or BGM does at that moment. Costs nothing and returns no image.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: { type: 'string', description: 'Path to the video file. Must be the same file the plan was made for.' },
        planId: { type: 'string', description: 'The planId from video_plan; it keys the record so two runs of the same file do not overwrite each other.' },
        batch: { type: 'integer', description: 'Which delivery unit this analysis is about (the batch index returned by video_watch).' },
        note: {
          type: 'string',
          description:
            'Your reading of that batch, as markdown, in three parts. (1) Open with 观看情况: which stretch this batch covers, how far along the whole ' +
            'video you are (batch i of n), and whether the frames were clear enough to read. (2) Then the detail, time-coded so every claim can be ' +
            'located: what is on screen, how it is edited (pace, cuts, transitions, camera work), the visual style, how the animation or effects are ' +
            'made, and what the speech or BGM adds - written so a reader could cut the same sequence again. (3) Close with 总结: a few sentences of ' +
            'conclusions for this batch, and on the final batch the conclusions for the whole video. Say what you could not see instead of smoothing it over.',
        },
      },
      required: ['input', 'planId', 'batch', 'note'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          batch: { type: 'integer' },
          bytes: { type: 'integer' },
          appended: { type: 'boolean' },
        },
        required: ['path', 'batch', 'bytes', 'appended'],
      },
      render: (_args, value) => renderNote(value),
      presentationMeta: (_args, value) => ({ path: value.path, frames: 0 }),
    },
    timeoutMs: cfg.toolTimeoutMs,
    isConcurrencySafe: () => true,
    presentCall(args) {
      return { card: 'generic', title: `Note batch ${args?.batch ?? '?'} of ${basename(String(args?.input ?? ''))}`, kind: 'read', locations: [{ path: String(args?.input ?? '') }] };
    },
    async execute(args) {
      return executeNote({ args, cfg });
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
