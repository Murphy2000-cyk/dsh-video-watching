/**
 * delivery.test.mjs —— 计划分组与交付分组一一对应。
 *
 * 这一层现在只做两件事：把 `cells` 折成 `frames`、按时间排序。装箱已经取消，
 * 因为"密窗口一张图、单帧一张图"就是最终形态，再拼一层会让每张图覆盖哪几秒说不清。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGroups, groupCost } from '../lib/delivery.js';
import { DEFAULT_BUDGET_PIXELS, planGrid } from '../lib/grid.js';

/** 造一个单帧计划分组。 */
function singleGroup(time) {
  return { kind: 'single', k: 1, label: '单帧', start: time, end: time, cells: [{ time, role: 'single' }] };
}

/** 造一个 k×k 的拼图计划分组。 */
function gridGroup(time, k) {
  const cells = Array.from({ length: k * k }, (_item, index) => ({
    time: Number((time + (index + 0.5) / (k * k)).toFixed(4)),
    role: 'grid',
  }));
  return { kind: 'grid', k, label: `${k}x${k}`, start: time, end: time + 1, cells };
}

test('一个计划分组对应一张图，不装箱也不拆开', () => {
  const plan = [gridGroup(0, 2), singleGroup(5), singleGroup(8), gridGroup(10, 4)];
  const groups = buildGroups({ groups: plan });
  assert.equal(groups.length, plan.length);
  assert.deepEqual(groups.map((group) => group.frames.length), [4, 1, 1, 16]);
});

test('分组按时间排序，帧顺序与格号一致', () => {
  const plan = [gridGroup(10, 2), singleGroup(0), singleGroup(5)];
  const groups = buildGroups({ groups: plan });
  assert.deepEqual(groups.map((group) => group.start), [0, 5, 10]);
  for (const group of groups) {
    const times = group.frames.map((frame) => frame.time);
    assert.deepEqual(times, [...times].sort((a, b) => a - b), '同一组内时间必须递增');
  }
});

test('切点分组保留两格和切点时刻', () => {
  const cut = {
    kind: 'cut',
    k: 0,
    label: '切点×2',
    start: 2.9,
    end: 3,
    cutTime: 2.95,
    cells: [
      { time: 2.9, role: 'before' },
      { time: 3, role: 'after' },
    ],
  };
  const [group] = buildGroups({ groups: [cut] });
  assert.equal(group.frames.length, 2);
  assert.equal(group.cutTime, 2.95);
  assert.deepEqual(group.frames.map((frame) => frame.role), ['before', 'after']);
});

test('每张图按 1080p 预算计价：一张 ≈ 384 token', () => {
  const plan = [gridGroup(0, 4), gridGroup(2, 2), singleGroup(5)];
  const cost = groupCost(buildGroups({ groups: plan }), 16 / 9);
  assert.equal(cost.sheets, 3);
  assert.equal(cost.singles, 1);
  const per = planGrid(16, 16 / 9, DEFAULT_BUDGET_PIXELS).tokens;
  assert.equal(cost.tokens, per * 3, '三张图应该同价');
  assert.equal(per, 384);
});

test('空输入不炸', () => {
  assert.deepEqual(buildGroups({ groups: [] }), []);
  assert.deepEqual(buildGroups({}), []);
  assert.equal(groupCost([], 16 / 9).sheets, 0);
});
