/**
 * delivery.js —— 把计划分组变成可交付的分组。
 *
 * 交付形态现在只有三种，和计划分组**一一对应**，不再做二次装箱：
 *
 *   - `grid`   密窗口：一张图片里 k×k 张子图（2×2 / 3×3 / 4×4）
 *   - `single` 稀疏帧：一张图片里一张子图
 *   - `cut`    硬切：一张图片里两张子图（切前 + 切后）
 *
 * 为什么不再把连续单帧打包：密窗口那一步已经在拼图了，单帧再拼一层会让
 * "这张图覆盖哪一秒"变得说不清；而且一张图现在就是 1080p（约 384 token），
 * 把 20 个不同秒的画面塞进一张，等于用一张 1080p 的清晰度换 20 张模糊子图。
 *
 * 纯函数，无 IO，可离线断言。
 *
 * @module dsh-video-understanding/delivery
 */

import { DEFAULT_BUDGET_PIXELS, estimateDelivery } from './grid.js';

/**
 * 把计划分组转成交付分组。
 *
 * @param params - 参数。
 * @param params.groups - `planFrames` 的分组（每项有 `kind` / `cells` / `start` / `end`）。
 * @returns 交付分组数组，每项 `{ kind, k, label, start, end, frames }`。
 */
export function buildGroups(params) {
  const planGroups = Array.isArray(params?.groups) ? params.groups : [];
  return planGroups
    .map((group) => ({
      kind: group.kind,
      k: group.k,
      label: group.label,
      start: group.start,
      end: group.end,
      cutTime: group.cutTime,
      frames: group.cells.map((cell) => ({ time: cell.time, role: cell.role })),
    }))
    .sort((left, right) => left.start - right.start);
}

/**
 * 估算一组交付要几张图、多少 token。
 *
 * @param groups - `buildGroups` 的输出。
 * @param aspect - 单帧宽高比。
 * @param budgetPixels - 单图像素预算。
 * @returns `{ sheets, tokens, singles, detail }`；`detail` 是逐组明细（不是分组本身）。
 */
export function groupCost(groups, aspect, budgetPixels = DEFAULT_BUDGET_PIXELS) {
  let sheets = 0;
  let tokens = 0;
  let singles = 0;
  const detail = [];
  for (const group of groups) {
    const count = Math.max(1, group.frames.length);
    const estimate = estimateDelivery(count, aspect, count, budgetPixels);
    sheets += 1;
    tokens += estimate.tokens;
    if (group.kind === 'single') singles += 1;
    detail.push({ kind: group.kind, count, tokens: estimate.tokens });
  }
  return { sheets, tokens, singles, detail };
}
