/**
 * grid.js —— 拼图几何与 token 估算的纯函数层。
 *
 * 这里只有算术，没有 IO。之所以单独成文件：格子尺寸算错不会报错，
 * 只会安静地浪费 token（格子太大）或让画面糊成色块（格子太小）。
 *
 * @module dsh-video-watching/grid
 */

/** 视觉计量的 token 网格步长（像素）。 */
const TOKEN_PX = 42;
/** 单图 token 的地板：低于约 296k 像素也按 544² 计费。 */
const TOKEN_FLOOR = 192;
/** 单图 token 的天花板。 */
const TOKEN_CAP = 384;
/** 地板对应的像素量。 */
const FLOOR_PIXELS = 544 * 544;
/**
 * 单张图的像素预算：按档位定死。
 *
 * 单帧 1080p、拼图 1440p —— 这样 2×2 的每张子图恰好是 720p、3×3 是 480p、4×4 是 360p。
 * 四档整图都超过单图 token 天花板（384），所以升档不增加成本。
 */
export const PIXELS_1080P = 1920 * 1080;
export const PIXELS_1440P = 2560 * 1440;
/** 兼容旧名：默认档（拼图）就是 1440p。 */
export const DEFAULT_BUDGET_PIXELS = PIXELS_1440P;

/**
 * 估算一张图会花多少 vision token。
 *
 * 公式来自视觉计量的 42px 网格：`rows * (cols + 1) + 2`，
 * 再按地板 192 与天花板 384 收口。
 *
 * @param width - 图宽（像素）。
 * @param height - 图高（像素）。
 * @returns 估算的 token 数。
 */
export function imageTokens(width, height) {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const cols = Math.ceil(w / TOKEN_PX);
  const rows = Math.ceil(h / TOKEN_PX);
  const raw = rows * (cols + 1) + 2;
  const floored = w * h <= FLOOR_PIXELS ? Math.min(raw, TOKEN_FLOOR) : raw;
  return Math.min(TOKEN_CAP, Math.max(TOKEN_FLOOR, floored));
}

/**
 * 取偶数：`scale`/`pad` 对奇数边长会把画面拉歪半个像素。
 *
 * @param value - 任意数。
 * @param min - 下限。
 * @returns 不小于 `min` 的偶数。
 */
function even(value, min = 2) {
  const rounded = Math.round(value);
  if (rounded <= min) return min % 2 === 0 ? min : min + 1;
  return rounded - (rounded % 2);
}

/**
 * 给 N 帧挑一个网格与格子尺寸。
 *
 * 分辨率档位是**按档定死**的，不靠预算逼近：
 *
 *   | 形态 | 单张子图 | 整张图片 |
 *   | 1×1  | 1920×1080 | 1920×1080（1080p） |
 *   | 2×2  | 1280×720  | 2560×1440（1440p） |
 *   | 3×3  | 854×480   | 2562×1440（约 1440p） |
 *   | 4×4  | 640×360   | 2560×1440（1440p） |
 *
 * 这四档的整图都顶到单图 token 天花板 384，所以**升档不额外花钱**。
 *
 * @param count - 帧数。
 * @param aspect - 单帧的宽高比（源视频）。
 * @param budgetPixels - 覆盖用：给了就按它算，不给按档位表。
 * @returns 网格方案。
 */
export function planGrid(count, aspect, budgetPixels) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const fallbackPixels = n <= 1 ? PIXELS_1080P : PIXELS_1440P;
  const budget = Math.max(64000, Math.floor(Number(budgetPixels) || fallbackPixels));

  let best = null;
  for (let cols = 1; cols <= n; cols += 1) {
    const rows = Math.ceil(n / cols);
    const cellPixels = budget / (cols * rows);
    const rawW = Math.sqrt(cellPixels * ratio);
    const cellW = even(Math.min(Math.max(rawW, 48), 1920), 48);
    const cellH = even(Math.min(Math.max(cellW / ratio, 27), 1080), 28);
    const width = cols * cellW;
    const height = rows * cellH;
    if (width > 4096 || height > 4096) continue;
    // 主目标是格子面积大；长宽比作为温和的惩罚项，避免排出 1×20 这种竖条。
    const aspectPenalty = Math.abs(width / height - 1.6) * 60000;
    const score = cellW * cellH - aspectPenalty;
    if (best === null || score > best.score) {
      best = { cols, rows, cellW, cellH, width, height, score };
    }
  }

  // 兜底：预算被压到连一个合法格子都排不出时，给一个最小可用的方阵。
  if (best === null) {
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    best = { cols, rows, cellW: 48, cellH: even(48 / ratio, 28), width: cols * 48, height: rows * 48, score: 0 };
    best.width = cols * best.cellW;
    best.height = rows * best.cellH;
  }

  return {
    cols: best.cols,
    rows: best.rows,
    cellWidth: best.cellW,
    cellHeight: best.cellH,
    width: best.width,
    height: best.height,
    capacity: best.cols * best.rows,
    fill: n / (best.cols * best.rows),
    tokens: imageTokens(best.width, best.height),
  };
}

/**
 * 把帧按下标切成每张图一组。
 *
 * @param count - 帧数。
 * @param perSheet - 每张图最多几帧。
 * @returns 每组的帧数数组。
 */
export function chunkSizes(count, perSheet) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  const size = Math.max(1, Math.floor(Number(perSheet) || 1));
  const chunks = [];
  let left = total;
  while (left > 0) {
    const take = Math.min(size, left);
    chunks.push(take);
    left -= take;
  }
  return chunks;
}

/**
 * 估算整次交付的图片张数与 token。
 *
 * @param count - 帧数。
 * @param aspect - 单帧宽高比。
 * @param perSheet - 每张图最多几帧。
 * @param budgetPixels - 单图像素预算。
 * @returns `{ sheets, tokens, grids }`。
 */
export function estimateDelivery(count, aspect, perSheet = 20, budgetPixels = 360000) {
  const sizes = chunkSizes(count, perSheet);
  const grids = sizes.map((size) => planGrid(size, aspect, budgetPixels));
  const tokens = grids.reduce((sum, grid) => sum + grid.tokens, 0);
  return { sheets: sizes.length, tokens, grids };
}
