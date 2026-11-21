/**
 * 诊断：为什么 analysis 模式下会出现 7–8 秒空洞（maxGap 明明是 5）。
 *
 * 不去猜缓存键：直接扫缓存目录，按 duration 找出这支片子的那份打分。
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PRESETS, resolveConfig } from '../index.js';
import { planFrames } from '../lib/plan.js';

const TARGET_DURATION = 64.85;
const cfg = resolveConfig({});
const dir = cfg.cacheDir;

const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
let hit = null;
for (const name of files) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, name), 'utf8'));
    if (typeof parsed.duration === 'number' && Math.abs(parsed.duration - TARGET_DURATION) < 1.2) {
      hit = { name, area: parsed.area, duration: parsed.duration };
      break;
    }
  } catch {
    /* 跳过坏文件 */
  }
}
if (hit === null) throw new Error(`缓存目录里没有 ${TARGET_DURATION} 秒左右的记录`);

const lines = [`缓存文件：${hit.name}（duration=${hit.duration}）`];
const show = (label, options) => {
  const { budget = 100, overflow = 'thin', sampling = {} } = options;
  const plan = planFrames({
    duration: hit.duration,
    scanFps: 10,
    area: hit.area,
    ...PRESETS.analysis,
    ...sampling,
    maxTotalSheets: budget,
    overflow,
  });
  const starts = plan.groups.map((group) => group.start);
  const gaps = [];
  for (let index = 1; index < starts.length; index += 1) gaps.push(+(starts[index] - starts[index - 1]).toFixed(2));
  lines.push(`\n=== ${label}`);
  lines.push(`  图数=${plan.stats.sheets}  子图数=${plan.stats.count}  maxGap=${plan.stats.maxGap}  aEff=${plan.stats.aEff.toFixed(1)}  scale=${plan.stats.scale.toFixed(1)}  预算被抬高=${plan.stats.budgetRaised}`);
  lines.push(`  分组起点：${starts.map((t) => t.toFixed(1)).join(', ')}`);
  lines.push(`  组间间隔：${gaps.join(', ')}`);
  lines.push(`  最大间隔=${plan.stats.maxInterval.toFixed(2)} s  maxGap 失守=${plan.stats.maxGapBroken}`);
};

show('A. 整片预算 12', { budget: 12 });
show('B. 预算不设限', { budget: 500 });
show('C. 预算 12 + stop 截断', { budget: 12, overflow: 'stop' });
show('D. 预算不设限 + maxGap=2.5', { budget: 500, sampling: { maxGap: 2.5 } });

lines.push('');
lines.push(`预设现值：analysis maxGap=${PRESETS.analysis.maxGap}，understand maxGap=${PRESETS.understand.maxGap}`);

await mkdir('F:/Agent/DeepseekHarness/Project/Project20261121', { recursive: true });
await writeFile('F:/Agent/DeepseekHarness/Project/Project20261121/gap-diag.txt', lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
