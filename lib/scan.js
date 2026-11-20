/**
 * scan.js —— 把逐帧的原始 RGB 变成"这一帧比上一帧变了多少"。
 *
 * 两种口径，用途不同：
 *
 *   - `scorePair`：全画面平均色差，0~255。早期版本用它配分位曲线，量纲好对齐、
 *     但对"小面积剧烈变化"极不敏感 —— 一个占屏 5% 的角色走动，均值差几乎不动。
 *   - `areaScorePair`：把画面切成 `block x block` 的方块，**色差超阈值的块占比**，
 *     0~1。这是当前的口径：d=0.12 直接读作"12% 的画面变了"，和"累计变化量"
 *     这个积分量同一个量纲。
 *
 * 纯计算放在导出的函数里，可以离线断言；读文件的部分只为长片服务，分块推进，
 * 绝不把整段 rawvideo 一次读进内存（90 分钟能到几百 MB）。
 *
 * @module dsh-video-understanding/scan
 */

/** 默认分析用的缩略图尺寸（旧版，保留给只算 0~255 均值的调用方）。 */
export const ANALYZE_WIDTH = 120;
export const ANALYZE_HEIGHT = 68;
/** 默认方块边长（像素）。 */
export const DEFAULT_BLOCK = 4;
/** 默认块级判定阈值（0~255 均值色差）。 */
export const DEFAULT_BLOCK_THRESHOLD = 8;

/**
 * 一帧分析图占多少字节。
 *
 * @param width - 宽。
 * @param height - 高。
 * @returns 字节数。
 */
export function frameBytes(width = ANALYZE_WIDTH, height = ANALYZE_HEIGHT) {
  return Math.max(1, Math.floor(width) * Math.floor(height) * 3);
}

/**
 * 按长边与宽高比算分析图尺寸（两边都取偶数，避免缩放的半像素错位）。
 *
 * @param longSide - 长边像素。
 * @param aspect - 源宽高比。
 * @returns `{ width, height }`。
 */
export function analyzeDims(longSide, aspect) {
  const side = Math.max(32, Math.round(Number(longSide) || ANALYZE_WIDTH) || ANALYZE_WIDTH);
  const ratio = Number.isFinite(Number(aspect)) && Number(aspect) > 0 ? Number(aspect) : 16 / 9;
  const even = (value) => Math.max(2, Math.round(value / 2) * 2);
  return ratio >= 1
    ? { width: even(side), height: even(side / ratio) }
    : { width: even(side * ratio), height: even(side) };
}

/**
 * 两帧之间的平均差异分（0~255）。
 *
 * 亮度差与色度差分开算再加权：纯亮度差会把"同一画面换了色调"判轻，
 * 纯色度差会被噪声放大。
 *
 * @param previous - 上一帧的 RGB 字节。
 * @param current - 当前帧的 RGB 字节。
 * @returns 0 到 255 的差异分。
 */
export function scorePair(previous, current) {
  if (!previous || !current || previous.length !== current.length || previous.length < 3) return 0;
  const pixels = Math.floor(previous.length / 3);
  let total = 0;
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 3;
    const dl = Math.abs(
      0.299 * (current[offset] - previous[offset]) +
        0.587 * (current[offset + 1] - previous[offset + 1]) +
        0.114 * (current[offset + 2] - previous[offset + 2]),
    );
    const dc =
      (Math.abs(current[offset] - previous[offset]) +
        Math.abs(current[offset + 1] - previous[offset + 1]) +
        Math.abs(current[offset + 2] - previous[offset + 2])) /
      3;
    total += dl * 0.6 + dc * 0.4;
  }
  return Math.min(255, total / pixels);
}

/**
 * 两帧之间的**面积变化分**：变化超过阈值的方块占全部方块的比例（0~1）。
 *
 * 这是当前采样算法的输入。方块之内先求平均再比阈值，所以：
 *   - 压缩噪声、单像素抖动会被块内平均压掉；
 *   - 小面积但强对比的变化（字幕跳出、UI 弹窗）只要占满一个方块就能被记上。
 *
 * @param previous - 上一帧的 RGB 字节。
 * @param current - 当前帧的 RGB 字节。
 * @param width - 分析图宽。
 * @param height - 分析图高。
 * @param block - 方块边长，默认 4。
 * @param threshold - 块级阈值（0~255），默认 8。
 * @returns 0 到 1 的比例。
 */
export function areaScorePair(previous, current, width, height, block = DEFAULT_BLOCK, threshold = DEFAULT_BLOCK_THRESHOLD) {
  const w = Math.floor(Number(width) || 0);
  const h = Math.floor(Number(height) || 0);
  if (!previous || !current || w <= 0 || h <= 0) return 0;
  if (previous.length < w * h * 3 || current.length < w * h * 3) return 0;
  const side = Math.max(1, Math.floor(Number(block) || DEFAULT_BLOCK));
  const bw = Math.floor(w / side);
  const bh = Math.floor(h / side);
  if (bw <= 0 || bh <= 0) return 0;
  const limit = Math.max(0, Number(threshold) || 0);
  const perBlock = side * side;
  let changed = 0;

  for (let by = 0; by < bh; by += 1) {
    for (let bx = 0; bx < bw; bx += 1) {
      let total = 0;
      for (let y = 0; y < side; y += 1) {
        let offset = ((by * side + y) * w + bx * side) * 3;
        for (let x = 0; x < side; x += 1) {
          const dl = Math.abs(
            0.299 * (current[offset] - previous[offset]) +
              0.587 * (current[offset + 1] - previous[offset + 1]) +
              0.114 * (current[offset + 2] - previous[offset + 2]),
          );
          const dc =
            (Math.abs(current[offset] - previous[offset]) +
              Math.abs(current[offset + 1] - previous[offset + 1]) +
              Math.abs(current[offset + 2] - previous[offset + 2])) /
            3;
          total += dl * 0.6 + dc * 0.4;
          offset += 3;
        }
      }
      if (total / perBlock > limit) changed += 1;
    }
  }
  return changed / (bw * bh);
}

/**
 * 从整段 rawvideo 里算出逐帧差异分。
 *
 * 第一帧没有前驱，记 0（"从黑场开始"不是一次切点）。
 *
 * @param rgb - 连续的 RGB 字节。
 * @param bytesPerFrame - 每帧字节数。
 * @returns 差异分数组。
 */
export function scoresFromRgb(rgb, bytesPerFrame) {
  const stride = Math.max(3, Math.floor(bytesPerFrame));
  if (!rgb || rgb.length < stride) return [];
  const count = Math.floor(rgb.length / stride);
  const scores = new Array(count);
  scores[0] = 0;
  for (let index = 1; index < count; index += 1) {
    const previous = rgb.subarray((index - 1) * stride, index * stride);
    const current = rgb.subarray(index * stride, index * stride + stride);
    scores[index] = scorePair(previous, current);
  }
  return scores;
}

/**
 * 一帧分析图的平均亮度（0 到 255）。
 *
 * 与差异分一起算，几乎不额外花钱，但它解决一个真问题：淡入淡出会让
 * "切点后半个分析帧"正好落在全黑的过渡里，取出来的格子是黑的。
 *
 * @param frame - 一帧 RGB 字节。
 * @returns 平均亮度。
 */
export function lumaOf(frame) {
  if (!frame || frame.length < 3) return 0;
  const pixels = Math.floor(frame.length / 3);
  let total = 0;
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 3;
    total += 0.299 * frame[offset] + 0.587 * frame[offset + 1] + 0.114 * frame[offset + 2];
  }
  return total / pixels;
}

/**
 * 以流式方式读一段 rawvideo，算出逐帧差异分、亮度，以及（给了尺寸时）面积变化分。
 *
 * 分块对齐到帧边界，所以块大小不影响结果 —— 这一点有单测钉住。
 *
 * @param handle - 已打开的 `node:fs/promises` FileHandle。
 * @param bytesPerFrame - 每帧字节数。
 * @param options - 选项。
 * @param options.framesPerChunk - 每块几帧，默认 512。
 * @param options.width - 分析图宽；给了才算面积分。
 * @param options.height - 分析图高。
 * @param options.block - 方块边长，默认 4。
 * @param options.threshold - 块级阈值，默认 8。
 * @returns `{ scores, luma, area }`，`area` 在没给尺寸时为空数组。
 */
export async function analyzeFromStream(handle, bytesPerFrame, options = {}) {
  const stride = Math.max(3, Math.floor(bytesPerFrame));
  const perChunk = Math.max(1, Math.floor(options.framesPerChunk ?? 512));
  const chunkBytes = stride * perChunk;
  const width = Math.floor(Number(options.width) || 0);
  const height = Math.floor(Number(options.height) || 0);
  const wantArea = width > 0 && height > 0 && width * height * 3 <= stride;
  const block = Math.floor(Number(options.block) || DEFAULT_BLOCK);
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : DEFAULT_BLOCK_THRESHOLD;

  const scores = [];
  const luma = [];
  const area = [];
  let pending = Buffer.alloc(0);
  let previous = null;
  let position = 0;

  for (;;) {
    const buffer = Buffer.allocUnsafe(chunkBytes);
    const { bytesRead } = await handle.read(buffer, 0, chunkBytes, position);
    if (bytesRead <= 0) break;
    position += bytesRead;

    pending = pending.length === 0 ? buffer.subarray(0, bytesRead) : Buffer.concat([pending, buffer.subarray(0, bytesRead)]);

    let offset = 0;
    while (pending.length - offset >= stride) {
      const frame = pending.subarray(offset, offset + stride);
      if (previous === null) {
        scores.push(0);
        area.push(0);
      } else {
        scores.push(scorePair(previous, frame));
        if (wantArea) area.push(areaScorePair(previous, frame, width, height, block, threshold));
      }
      luma.push(lumaOf(frame));
      // 必须拷一份：下一轮 `pending` 会被整体替换，切片会跟着失效。
      previous = Buffer.from(frame);
      offset += stride;
    }
    pending = Buffer.from(pending.subarray(offset));
    if (bytesRead < chunkBytes) break;
  }

  return { scores, luma, area };
}

/**
 * 只要差异分（保留这个入口是为了让不关心亮度的调用方少解构一层）。
 *
 * @param handle - 文件句柄。
 * @param bytesPerFrame - 每帧字节数。
 * @param options - 选项。
 * @returns 差异分数组。
 */
export async function scoresFromStream(handle, bytesPerFrame, options = {}) {
  const { scores } = await analyzeFromStream(handle, bytesPerFrame, options);
  return scores;
}
