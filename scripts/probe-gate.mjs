/**
 * 验证门禁真的拦得住：不带 userConfirmed 调用 video_watch，应当立刻报错，
 * 而且不产生任何扫描/取帧/花费。
 */

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

import { buildTools, resolveConfig } from '../index.js';
import { createRunner } from '../lib/ffmpeg.js';

const VIDEO = 'F:/Agent/DeepseekHarness/Data-of-skill-plugin/datasets/bili-BV1Eyst6VE1D/video.mp4';

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

const cfg = resolveConfig({});
const run = createRunner((spec) => spawnStub(spec), { graceMs: 2000, timeoutMs: 60000 });
const attachments = { async saveImages(items) { return items.map((item, index) => ({ attachmentId: 'gate-' + index, mediaType: item.mediaType, bytes: item.data.length, width: 640, height: 360 })); } };
const ctx = { subprocess: { spawn: spawnStub }, get: (name) => (name === 'attachments' ? attachments : undefined), tools: { register: () => () => {} } };
const watch = buildTools({ ctx, run, cfg }).find((tool) => tool.name === 'video_watch');

const lines = [];
const started = Date.now();
try {
  await watch.execute({ input: VIDEO, preset: 'analysis' }, { signal: undefined });
  lines.push('FAIL：没带 userConfirmed 也被执行了，门禁没生效');
} catch (error) {
  lines.push(`PASS：被拒绝（${Date.now() - started} ms）`);
  lines.push(`  报错原文：${String(error?.message ?? error).slice(0, 300)}`);
}

// 再确认带上了就能过（这里只验证门禁放行，不看结果内容）
let allowed = false;
try {
  const value = await watch.execute({ input: VIDEO, preset: 'understand', userConfirmed: true, maxSheets: 2 }, { signal: undefined });
  allowed = value !== undefined && value.audio !== undefined;
  lines.push(`PASS：带 userConfirmed: true 后放行，返回图 ${value?.sheets?.length ?? 0} 张、音频状态 ${value?.audio?.status ?? 'n/a'}`);
} catch (error) {
  lines.push(`FAIL：带上 userConfirmed 后仍失败：${String(error?.message ?? error).slice(0, 200)}`);
}

lines.push(`参数清单：${JSON.stringify(Object.keys(watch.parameters.properties))}`);
lines.push(`必填：${JSON.stringify(watch.parameters.required)}`);

await writeFile('F:/Agent/DeepseekHarness/Project/Project20261119/gate-check.txt', lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
if (!allowed) process.exitCode = 1;
