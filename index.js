/**
 * dsh-video-watching —— 先扫全片，再按画面变化决定取帧密度。
 *
 * 它和已有视频插件的分野只有一句话：**采样间隔随画面变化**。
 * 静止的地方拉长到几秒一帧，快剪的地方压到一秒三帧，切点上强制落一帧；
 * 多帧拼进一张小图省 token，看不清的再单独取回原图。
 *
 * 四个工具：
 *   - `video_plan`   扫描 + 判预算：完整看完够不够、要几张图；够了给 planId（0 视觉 token）
 *   - `video_watch`  凭 planId 执行已批准的计划，按批交付拼图 + 时间码清单 + 字幕 + 音频
 *   - `video_note`   把某一批的分析写进观看记录（Markdown，0 视觉 token）
 *   - `video_closeup` 按时间码取回全分辨率单帧
 *
 * 代码分几块，各自一个文件：
 *   - `lib/config.js`       配置归一化
 *   - `lib/modes.js`        两套模式与 effectiveArgs
 *   - `lib/tools.js`        四个工具的定义（模型读到的描述与参数在这里）
 *   - `lib/feasibility.js`  预算检查：required / minimum / 四个候选方案
 *   - `lib/plans.js`        计划快照：哈希、落盘、校验
 *   - `lib/record.js`       观看记录：Markdown 落盘、批次追加、分析补写
 *   - `lib/orchestrate.js`  探测、扫描、plan 初判与定稿、watch 执行、note 落盘
 *   - `lib/render.js`       返回值 → 内容块
 *   - `lib/util.js`         共用小工具
 *
 * 这个文件只留入口，并把上面几块的对外符号原样再导出：测试与脚本按
 * `index.js` 的名字取用，搬文件不该动它们的 import。
 *
 * @module dsh-video-watching
 */

import { createRunner } from './lib/ffmpeg.js';
import { resolveConfig } from './lib/config.js';
import { buildTools } from './lib/tools.js';

export const name = 'video-watching';

/**
 * 依赖的 Agent 服务。三个都是核心服务，声明它们不会让 fiber 停在 PENDING。
 */
export const inject = ['subprocess', 'tools', 'attachments'];

/**
 * 插件入口。
 *
 * @param ctx - Agent 上下文。
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

export { expandCommand, resolveConfig } from './lib/config.js';
export { buildTools, closeupTool, noteTool, planTool } from './lib/tools.js';
export { MODES, effectiveArgs, executeNote, headOf } from './lib/orchestrate.js';
export { appendBatch, analysisMarker, ensureHeader, pendingNotes, recordPathOf, writeAnalysis } from './lib/record.js';
export { renderCloseup, renderNote, renderPlan, renderWatch } from './lib/render.js';
