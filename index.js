/**
 * dsh-video-understanding —— 先扫全片，再按画面变化决定取帧密度。
 *
 * 它和已有视频插件的分野只有一句话：**采样间隔随画面变化**。
 * 静止的地方拉长到几秒一帧，快剪的地方压到一秒三帧，切点上强制落一帧；
 * 多帧拼进一张小图省 token，看不清的再单独取回原图。
 *
 * 三个工具：
 *   - `video_plan`   只扫描不取图，告诉你这部片子会被怎么切（0 视觉 token）
 *   - `video_watch`  按计划交付拼图 + 时间码清单 + 字幕
 *   - `video_closeup` 按时间码取回全分辨率单帧
 *
 * 代码分五块，各自一个文件：
 *   - `lib/config.js`       配置归一化
 *   - `lib/tools.js`        三个工具的定义（模型读到的描述与参数在这里）
 *   - `lib/orchestrate.js`  扫描、计划、取帧、拼图、交附件
 *   - `lib/render.js`       返回值 → 内容块
 *   - `lib/util.js`         共用小工具
 *
 * 这个文件只留入口，并把上面几块的对外符号原样再导出：测试与脚本按
 * `index.js` 的名字取用，搬文件不该动它们的 import。
 *
 * @module dsh-video-understanding
 */

import { createRunner } from './lib/ffmpeg.js';
import { resolveConfig } from './lib/config.js';
import { buildTools } from './lib/tools.js';

export const name = 'video-understanding';

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
export { buildTools, closeupTool, planTool } from './lib/tools.js';
export { PRESETS, effectiveArgs, headOf } from './lib/orchestrate.js';
export { renderCloseup, renderPlan, renderWatch } from './lib/render.js';
