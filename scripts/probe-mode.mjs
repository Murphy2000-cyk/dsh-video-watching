/**
 * 验证"模式选择"真的拦得住：不带 userConfirmed 调用 video_plan，应当立刻报错，
 * 而且不产生任何扫描/取帧/花费；没有 planId 的 watch 同样被拒。
 *
 * 跑法：`node scripts/probe-mode.mjs`（输出写到 Project20261121/mode-check.txt）
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

import { buildTools, resolveConfig } from '../index.js';
import { createRunner } from '../lib/ffmpeg.js';

const VIDEO = 'F:/Agent/DeepseekHarness/Data-of-skill-plugin/datasets/bili-BV1Eyst6VE1D/video.mp4';
const OUT = 'F:/Agent/DeepseekHarness/Project/Project20261121';

function spawnStub(spec) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const buf = { stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk) => (buf.stdout += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk) => (buf.stderr += chunk.toString('utf8')));
  const done = new Promise((resolve, reject) => {
    child.on('close', (code, signal) => resolve({ exitCode: code, signal }));
    child.on('error', reject);
  });
  const reader = (name) => ({ readFrom: () => ({ text: buf[name], nextOffset: buf[name].length, lossy: false }) });
  return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } };
}

// 探针不放桌面：记录写到临时目录，不污染真实观看记录。
const cfg = resolveConfig({ recordDir: `${OUT}/probe-record` });
const run = createRunner((spec) => spawnStub(spec), { graceMs: 2000, timeoutMs: 60000 });
const attachments = { async saveImages(items) { return items.map((item, index) => ({ attachmentId: 'mode-' + index, mediaType: item.mediaType, bytes: item.data.length, width: 640, height: 360 })); } };
const ctx = { subprocess: { spawn: spawnStub }, get: (name) => (name === 'attachments' ? attachments : undefined), tools: { register: () => () => {} } };
const tools = buildTools({ ctx, run, cfg });
const planTool = tools.find((tool) => tool.name === 'video_plan');
const watch = tools.find((tool) => tool.name === 'video_watch');

const lines = [];

// 检查 1：plan 没带 userConfirmed，一步都不该走。
let started = Date.now();
try {
  await planTool.execute({ input: VIDEO, mode: 'analysis' }, { signal: undefined });
  lines.push('FAIL：plan 没带 userConfirmed 也被执行了，模式选择没生效');
} catch (error) {
  lines.push(`PASS：plan 缺 userConfirmed 被拒绝（${Date.now() - started} ms）`);
  lines.push(`  报错原文：${String(error?.message ?? error).slice(0, 300)}`);
}

// 检查 2：watch 没有 planId，等于没问过模式、没论证过预算。
started = Date.now();
try {
  await watch.execute({ input: VIDEO }, { signal: undefined });
  lines.push('FAIL：watch 没有 planId 也被执行了');
} catch (error) {
  lines.push(`PASS：watch 缺 planId 被拒绝（${Date.now() - started} ms）`);
}

// 放行路径：先定稿（预算不够时按截断），再执行。
const planned = await planTool.execute({ input: VIDEO, mode: 'understand', userConfirmed: true }, { signal: undefined });
let planId = planned.planId;
if (typeof planId !== 'string') {
  const committed = await planTool.execute(
    { input: VIDEO, mode: 'understand', userConfirmed: true, choice: { id: 'truncate' } },
    { signal: undefined },
  );
  planId = committed.planId;
  lines.push('（预算不够全片，放行路径按 truncate 定稿）');
}

let allowed = false;
try {
  const value = await watch.execute({ input: VIDEO, planId, batch: 1 }, { signal: undefined });
  allowed = value !== undefined && value.audio !== undefined;
  lines.push(`PASS：带 planId 后放行，返回图 ${value?.sheets?.length ?? 0} 张、音频状态 ${value?.audio?.status ?? 'n/a'}`);
  lines.push(`  观看记录：${value?.record ?? '(未写)'}`);
} catch (error) {
  lines.push(`FAIL：带 planId 后仍失败：${String(error?.message ?? error).slice(0, 200)}`);
}

lines.push(`plan 参数：${JSON.stringify(Object.keys(planTool.parameters.properties))}`);
lines.push(`plan 必填：${JSON.stringify(planTool.parameters.required)}`);
lines.push(`watch 参数：${JSON.stringify(Object.keys(watch.parameters.properties))}`);
lines.push(`watch 必填：${JSON.stringify(watch.parameters.required)}`);

await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/mode-check.txt`, lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
if (!allowed) process.exitCode = 1;
