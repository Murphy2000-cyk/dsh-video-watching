/**
 * 用 profile 里那条 cacheDir 原样跑一次，确认缓存真的写到新路径。
 *
 * 这一步模拟的是重启后服务端会做的事：拿配置里的绝对路径当缓存根。
 */

import { spawn } from 'node:child_process';
import { stat, writeFile } from 'node:fs/promises';

import { buildTools, resolveConfig } from '../index.js';
import { createRunner } from '../lib/ffmpeg.js';

const CACHE = 'F:/Agent/DeepseekHarness/Data-of-skill-plugin/agent-data/cache/video-understanding';
const VIDEO = process.argv[2] ?? 'F:/Agent/DeepseekHarness/Interaction/20261104_litsearch_v220_视频/literature-search_2.2.0_介绍.mp4';

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

const cfg = resolveConfig({ cacheDir: CACHE, bgmMode: 'off', speechMode: 'off' });
const run = createRunner((spec) => spawnStub(spec), { graceMs: 2000, timeoutMs: 180000 });
const ctx = { subprocess: { spawn: spawnStub }, get: () => undefined, tools: { register: () => () => {} } };
const plan = buildTools({ ctx, run, cfg }).find((tool) => tool.name === 'video_plan');

const started = Date.now();
const value = await plan.execute({ input: VIDEO, preset: 'understand', userConfirmed: true }, { signal: undefined });
const seconds = ((Date.now() - started) / 1000).toFixed(1);

const info = await stat(`${CACHE}/${value.scan.frames > 0 ? '' : ''}`.replace(/\/$/, ''));
const files = await import('node:fs/promises').then((fs) => fs.readdir(CACHE));

const lines = [
  `cacheDir 用的是：${cfg.cacheDir}`,
  `扫描 ${value.scan.frames} 帧，用时 ${seconds} s，cached=${value.scan.cached}`,
  `缓存目录现在有 ${files.filter((name) => name.endsWith('.json')).length} 个 json`,
  `目录 mtime：${info.mtime.toISOString()}`,
];
await writeFile('F:/Agent/DeepseekHarness/Project/Project20261119/cache-path-check.txt', lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
