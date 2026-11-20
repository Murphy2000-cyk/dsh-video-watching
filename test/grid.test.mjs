import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chunkSizes, estimateDelivery, imageTokens, planGrid } from '../lib/grid.js';

test('imageTokens 复现 800×450 约 233 的口径', () => {
  assert.equal(imageTokens(800, 450), 233);
});

test('imageTokens 有小图地板与大图天花板', () => {
  assert.equal(imageTokens(100, 100), 192, '小图按地板计费');
  assert.equal(imageTokens(1600, 1600), 384, '大图封顶');
});

test('画质按档定死：单帧 1080p，拼图 1440p，单格 720/480/360', () => {
  const cases = [
    { count: 1, cols: 1, rows: 1, whole: [1920, 1080], cell: [1920, 1080] },
    { count: 4, cols: 2, rows: 2, whole: [2560, 1440], cell: [1280, 720] },
    { count: 9, cols: 3, rows: 3, whole: [2556, 1434], cell: [852, 478] },
    { count: 16, cols: 4, rows: 4, whole: [2560, 1440], cell: [640, 360] },
  ];
  for (const item of cases) {
    const grid = planGrid(item.count, 16 / 9);
    assert.deepEqual([grid.cols, grid.rows], [item.cols, item.rows], `${item.count} 帧的网格`);
    assert.deepEqual([grid.width, grid.height], item.whole, `${item.count} 帧的整图尺寸`);
    assert.deepEqual([grid.cellWidth, grid.cellHeight], item.cell, `${item.count} 帧的单格尺寸`);
    assert.equal(grid.tokens, 384, '四档整图都顶到 token 天花板，画质升级不加钱');
  }
});

test('planGrid 给任意帧数都能排下并守住边界', () => {
  for (const count of [1, 2, 3, 4, 5, 7, 9, 12, 20, 24, 33, 48]) {
    const grid = planGrid(count, 16 / 9, 360000);
    assert.ok(grid.capacity >= count, `${count} 帧排不下：容量 ${grid.capacity}`);
    assert.ok(grid.cellWidth % 2 === 0, '格宽必须是偶数');
    assert.ok(grid.cellHeight % 2 === 0, '格高必须是偶数');
    assert.equal(grid.width, grid.cols * grid.cellWidth);
    assert.equal(grid.height, grid.rows * grid.cellHeight);
    assert.ok(grid.tokens <= 384, `token 越界：${grid.tokens}`);
    assert.ok(grid.tokens >= 192);
    assert.ok(grid.fill > 0 && grid.fill <= 1);
  }
});

test('planGrid 在竖屏素材上保住格子长宽比', () => {
  const aspect = 9 / 16;
  const grid = planGrid(9, aspect, 360000);
  assert.ok(grid.capacity >= 9);
  const cellAspect = grid.cellWidth / grid.cellHeight;
  assert.ok(
    Math.abs(cellAspect - aspect) / aspect < 0.15,
    `格子被拉歪：${cellAspect.toFixed(3)} vs 源 ${aspect.toFixed(3)}`,
  );
});

test('chunkSizes 恰好切完且每组不超限', () => {
  assert.deepEqual(chunkSizes(0, 20), []);
  assert.deepEqual(chunkSizes(20, 20), [20]);
  assert.deepEqual(chunkSizes(21, 20), [20, 1]);
  const sizes = chunkSizes(73, 20);
  assert.equal(sizes.reduce((sum, value) => sum + value, 0), 73);
  for (const size of sizes) assert.ok(size <= 20);
});

test('estimateDelivery 的 token 随张数线性增长', () => {
  const small = estimateDelivery(10, 16 / 9, 20, 360000);
  const big = estimateDelivery(40, 16 / 9, 20, 360000);
  assert.equal(small.sheets, 1);
  assert.equal(big.sheets, 2);
  assert.ok(big.tokens > small.tokens);
});
