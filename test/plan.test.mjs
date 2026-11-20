/**
 * plan.test.mjs —— 积分法采样计划的断言。
 *
 * 造数据的原则：`area[i]` 描述第 i-1 帧到第 i 帧之间的变化（0~1），
 * 所以"第 2 秒发生一次跳变"就是把下标 `2*fps` 处写成大值。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_A,
  densityMap,
  detectHardCuts,
  gridFor,
  integrateMoments,
  noiseFloor,
  percentile,
  planFrames,
  windowsOf,
} from '../lib/plan.js';

const FPS = 10;

/** 全长 `seconds` 秒、逐帧值都是 `value` 的序列。 */
function flat(seconds, value, fps = FPS) {
  return new Array(Math.round(seconds * fps)).fill(value);
}

/** 全长 `seconds` 秒、只在 `at` 秒处放一个宽 `width` 帧、值 `value` 的尖峰。 */
function spike(seconds, at, value, width = 1, fps = FPS) {
  const series = flat(seconds, 0, fps);
  for (let offset = 0; offset < width; offset += 1) series[Math.round(at * fps) + offset] = value;
  return series;
}

test('percentile 取到端点与中位', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(percentile([1, 2, 3, 4, 5], 1), 5);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([], 0.5), 0);
});

test('noiseFloor 取低分位，静止片不会被噪声抬高', () => {
  const series = [...flat(9, 0.001), ...flat(1, 0.5)];
  assert.ok(noiseFloor(series) < 0.002, `噪声底 ${noiseFloor(series)}`);
});

test('integrateMoments 的不变量：抽帧数 × 阈值 ≤ 累积变化量', () => {
  const series = flat(20, 0.05);
  const a = 0.3;
  const moments = integrateMoments({ area: series, scanFps: FPS, a, floor: 0, multiCross: true });
  const total = series.reduce((sum, value) => sum + value, 0);
  assert.ok(moments.length * a <= total + 1e-6, `${moments.length} × ${a} 超过总变化量 ${total}`);
  assert.ok(moments.length >= Math.floor(total / a) - 1);
});

test('integrateMoments 允许一个间隔内多个时刻（4x4 才可能达到）', () => {
  const series = spike(2, 1, 1.0); // 一个 0.1 秒内画面全变
  const multi = integrateMoments({ area: series, scanFps: FPS, a: 0.3, floor: 0, multiCross: true });
  const single = integrateMoments({ area: series, scanFps: FPS, a: 0.3, floor: 0, multiCross: false });
  assert.equal(single.length, 1, '禁止时一个间隔最多一个时刻');
  assert.ok(multi.length >= 3, `允许时应在一个间隔内插出多个时刻，实际 ${multi.length}`);
  for (const time of multi) assert.ok(time >= 0.9 && time <= 1.01, `时刻 ${time} 应落在跳变所在间隔内`);
});

test('integrateMoments 的时刻严格递增且落在时长内', () => {
  const series = [...flat(5, 0.02), ...flat(5, 0.4), ...flat(5, 0.02)];
  const moments = integrateMoments({ area: series, scanFps: FPS, a: 0.3, floor: 0, multiCross: true });
  let last = -1;
  for (const time of moments) {
    assert.ok(time > last, '时刻必须严格递增');
    assert.ok(time >= 0 && time <= 15.001, `时刻 ${time} 越界`);
    last = time;
  }
});

test('gridFor 按密度选网格，超过 16 仍封顶 4x4', () => {
  const table = [
    [0, 1],
    [1, 1],
    [2, 2],
    [4, 2],
    [5, 3],
    [9, 3],
    [10, 4],
    [16, 4],
    [26, 4],
  ];
  for (const [count, expected] of table) assert.equal(gridFor(count), expected, `n=${count}`);
  assert.equal(gridFor(26), 4, '超过 16 仍封顶 4x4');
});

test('windowsOf 按 t 秒分桶且不随起点漂移', () => {
  const windows = windowsOf([0.2, 0.8, 1.1, 2.9], 1, 0, 5);
  assert.equal(windows.length, 3);
  assert.deepEqual(windows.map((window) => window.moments.length), [2, 1, 1]);
  assert.equal(windows[1].start, 1);
});

test('detectHardCuts 只认孤立尖峰，不认渐变转场', () => {
  const isolated = spike(10, 5, 1.0);
  const cuts = detectHardCuts(isolated, FPS);
  assert.equal(cuts.length, 1);
  assert.ok(Math.abs(cuts[0].before - 4.9) < 1e-6);
  assert.ok(Math.abs(cuts[0].after - 5.0) < 1e-6);

  // 连续两个间隔都高 = 渐变转场，不能当成硬切取前后两帧。
  const gradual = flat(10, 0);
  gradual[50] = 1.0;
  gradual[51] = 1.0;
  assert.equal(detectHardCuts(gradual, FPS).length, 0, '渐变转场不该被判成硬切');

  // 一段持续运动（平台）里的第一帧也不是硬切。
  const plateau = flat(10, 0);
  for (let index = 30; index < 40; index += 1) plateau[index] = 0.8;
  assert.equal(detectHardCuts(plateau, FPS).length, 0);
});

test('planFrames 的时刻严格递增且落在窗口内', () => {
  const area = [...flat(5, 0.02), ...flat(5, 0.5), ...flat(5, 0.02)];
  const plan = planFrames({ duration: 15, scanFps: FPS, area, a: 0.3, t: 1, maxGap: 0, maxSheets: 200 });
  assert.ok(plan.frames.length > 0);
  let last = -1;
  for (const frame of plan.frames) {
    assert.ok(frame.time > last, '时刻必须严格递增');
    assert.ok(frame.time >= 0 && frame.time <= 15.001);
    last = frame.time;
  }
});

test('planFrames 给静止片补帧，间隔不超过 maxGap', () => {
  const area = flat(60, 0);
  const plan = planFrames({ duration: 60, scanFps: FPS, area, a: 0.3, t: 1, maxGap: 5, maxSheets: 200 });
  const times = plan.frames.map((frame) => frame.time);
  assert.ok(times.length >= 11, `60 秒 / 5 秒至少 11 帧，实际 ${times.length}`);
  let previous = 0;
  for (const time of times) {
    assert.ok(time - previous <= 5 + 1e-6, `空隙 ${(time - previous).toFixed(2)}s 超过 maxGap`);
    previous = time;
  }
});

test('planFrames 严格遵守"图片张数"上限（不是格子数）', () => {
  // 每 0.1 秒 0.6 个满屏、a=0.3 → 每秒 ~2 帧，密秒会拼成 2x2，格子多但图少。
  for (const maxSheets of [1, 2, 5, 12]) {
    const area = flat(60, 0.6);
    const plan = planFrames({ duration: 60, scanFps: FPS, area, a: 0.3, maxGap: 0, maxSheets });
    assert.ok(plan.stats.sheets <= maxSheets, `maxSheets=${maxSheets} 却给了 ${plan.stats.sheets} 张图`);
    // 装箱只会把多个单帧合并，所以"图数"永远不超过计划分组数。
    assert.ok(plan.stats.sheets <= plan.groups.length, `图数 ${plan.stats.sheets} 不该多于分组 ${plan.groups.length}`);
    assert.ok(plan.frames.length >= 1);
  }
});

test('一张 2x2 只花一张图的预算（四格不各算一张）', () => {
  const area = spike(60, 10, 0.9);
  const plan = planFrames({ duration: 60, scanFps: FPS, area, a: 0.3, t: 1, maxGap: 0, maxSheets: 5 });
  assert.ok(plan.stats.sheets <= 5, `张数 ${plan.stats.sheets}`);
  const tile = plan.groups.find((group) => group.kind === 'grid');
  assert.ok(tile !== undefined, '应有一个拼图');
  assert.ok(tile.cells.length > 1, '拼图里有多格');
  assert.ok(plan.frames.length > plan.stats.sheets, '格子数应当多于图数');
});

test('overflow: stop —— 看到上限就停，不抬阈值也不覆盖全片', () => {
  const area = flat(60, 0.6);
  const thin = planFrames({ duration: 60, scanFps: FPS, area, a: 0.3, maxGap: 0, maxSheets: 3, overflow: 'thin' });
  const stop = planFrames({ duration: 60, scanFps: FPS, area, a: 0.3, maxGap: 0, maxSheets: 3, overflow: 'stop' });

  assert.ok(stop.stats.sheets <= 3, `stop 模式张数 ${stop.stats.sheets}`);
  assert.ok(thin.stats.sheets <= 3, `thin 模式张数 ${thin.stats.sheets}`);
  assert.equal(stop.stats.truncated, true, 'stop 应标 truncated');
  assert.ok(stop.stats.coveredTo < 60 - 1, `stop 应提前结束，实际覆盖到 ${stop.stats.coveredTo}`);
  // thin 覆盖全片：它把密度摊薄，而不是砍掉后半段。
  assert.equal(thin.stats.truncated, false);
  assert.ok(thin.stats.coveredTo > stop.stats.coveredTo, `thin 应比 stop 看得更远：${thin.stats.coveredTo} vs ${stop.stats.coveredTo}`);
  // stop 模式下阈值不动。
  assert.equal(stop.stats.scale, 1, 'stop 不该抬阈值');
});

test('maxGap 比 maxSheets 更硬时如实标注预算被抬高', () => {
  // 100 秒 / 每 5 秒补一帧 = 20 张单帧（装箱后 1 张），预算 1 张图会被补帧下限顶破
  const plan = planFrames({ duration: 100, scanFps: FPS, area: flat(100, 0), a: 0.3, maxGap: 5, maxSheets: 1,  });
  assert.equal(plan.stats.budgetRaised, true);
  assert.ok(plan.stats.sheets >= 1, '补帧下限优先于预算');
});

test('密秒用 2x2 并让四格时间间隔严格相等', () => {
  const area = spike(3, 1.5, 0.9); // 0.1 秒内变了 0.9 个满屏 → 3 个时刻
  const plan = planFrames({ duration: 3, scanFps: FPS, area, a: 0.3, t: 1, maxGap: 0, maxSheets: 50 });
  const tile = plan.groups.find((group) => group.kind === 'grid');
  assert.ok(tile !== undefined, '应有一个拼图分组');
  assert.equal(tile.k, 2);
  assert.equal(tile.cells.length, 4);
  const steps = [];
  for (let index = 1; index < tile.cells.length; index += 1) {
    steps.push(tile.cells[index].time - tile.cells[index - 1].time);
  }
  for (const step of steps) assert.ok(Math.abs(step - steps[0]) < 1e-9, '格间距必须相等');
  assert.ok(Math.abs(steps[0] - 0.25) < 1e-9, '2x2 覆盖 1 秒，间距应为 0.25 秒');
  for (const cell of tile.cells) assert.ok(cell.time >= 1 && cell.time < 2, `格子 ${cell.time} 应落在密度窗口内`);
});

test('multiCross 关闭后每秒时刻数不超过分析帧率', () => {
  // 每 0.1 秒变化 0.88，a=0.05：一个间隔里攒得下 17 个 a。
  const area = flat(6, 0.9);
  const off = planFrames({ duration: 6, scanFps: FPS, area, a: 0.05, t: 1, maxGap: 0, multiCross: false, maxSheets: 900 });
  const on = planFrames({ duration: 6, scanFps: FPS, area, a: 0.05, t: 1, maxGap: 0, multiCross: true, maxSheets: 900 });
  assert.ok(off.stats.moments <= 6 * FPS, `关闭时时刻数 ${off.stats.moments} 不该超过 ${6 * FPS}`);
  assert.ok(on.stats.moments > 6 * FPS, `打开时一个间隔能落多个，实际 ${on.stats.moments}`);
});

test('cutPair 打开时硬切取前后两帧，关闭时按密度取', () => {
  const area = spike(6, 3, 1.0);
  const withPair = planFrames({ duration: 6, scanFps: FPS, area, a: 0.3, t: 1, maxGap: 0, cutPair: true, maxSheets: 50 });
  const cutGroup = withPair.groups.find((group) => group.kind === 'cut');
  assert.ok(cutGroup !== undefined, '应有一个切点分组');
  assert.equal(cutGroup.cells.length, 2);
  assert.ok(Math.abs(cutGroup.cells[0].time - 2.9) < 1e-6, '前一格是出镜头最后一帧');
  assert.ok(Math.abs(cutGroup.cells[1].time - 3.0) < 1e-6, '后一格是入镜头第一帧');

  const withoutPair = planFrames({ duration: 6, scanFps: FPS, area, a: 0.3, t: 1, maxGap: 0, cutPair: false, maxSheets: 50 });
  assert.equal(withoutPair.groups.filter((group) => group.kind === 'cut').length, 0);
});

test('planFrames 在没有变化数据时仍给出一串可用时刻', () => {
  const plan = planFrames({ duration: 12, scanFps: FPS, area: [], a: 0.3, maxGap: 5, maxSheets: 20 });
  assert.ok(plan.frames.length >= 1);
  assert.ok(plan.frames.every((frame) => frame.time >= 0 && frame.time <= 12));
});

test('全程都在动的片子不会被噪声底吃光', () => {
  // 每帧 3% 面积变化：p10 也是 3%，扣完就什么都不剩。噪声底必须封顶。
  const area = flat(20, 0.03);
  const plan = planFrames({ duration: 20, scanFps: FPS, area, a: 0.3, t: 1, maxGap: 5, maxSheets: 200 });
  assert.ok(plan.stats.noiseFloor <= 0.02, `噪声底 ${plan.stats.noiseFloor} 超过天花板`);
  // 每 0.1 秒 0.03 → 每秒 0.3 → 每秒正好一帧，20 秒应有 20 帧左右。
  assert.ok(plan.frames.length >= 15, `应能抽出足够多的帧，实际 ${plan.frames.length}`);
});

test('planFrames 尊重 from/to 窗口', () => {
  const area = flat(30, 0.5);
  const plan = planFrames({ duration: 30, scanFps: FPS, area, a: 0.3, maxGap: 5, from: 10, to: 14, maxSheets: 100 });
  assert.ok(plan.frames.length > 0);
  for (const frame of plan.frames) assert.ok(frame.time >= 10 && frame.time <= 14, `帧 ${frame.time} 越界`);
});

test('默认阈值是 0.3', () => {
  assert.equal(DEFAULT_A, 0.3);
});

test('densityMap 覆盖所有格子并遵守段数上限', () => {
  const area = [...flat(6, 0.02), ...flat(6, 0.6), ...flat(6, 0.02)];
  const plan = planFrames({ duration: 18, scanFps: FPS, area, a: 0.3, maxGap: 5, maxSheets: 200 });
  const runs = densityMap(plan.groups);
  assert.ok(runs.length >= 2);
  const total = runs.reduce((sum, run) => sum + run.count, 0);
  assert.equal(total, plan.frames.length, '分段计数必须正好覆盖所有格子');
  assert.ok(densityMap(plan.groups, { maxRuns: 2 }).length <= 2);
});
