/**
 * 完整跑一遍四个工具，把交付物落到本地，供人工/模型看图写总结。
 *
 * 用法：node scripts/probe-full.mjs <视频> <输出目录> [preset] [maxSheets]
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildTools, resolveConfig } from '../index.js';
import { createRunner } from '../lib/ffmpeg.js';

const VIDEO = process.argv[2];
const OUT = process.argv[3];
const PRESET = process.argv[4] ?? 'analysis';
const MAX_SHEETS = Number(process.argv[5] ?? 12);
const DSH_SHERPA = 'C:/Users/lenovo/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/sherpa-onnx-node';

if (!VIDEO || !OUT) throw new Error('用法：node scripts/probe-full.mjs <视频> <输出目录>');
await mkdir(OUT, { recursive: true });

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

function jpegSize(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return { width: 0, height: 0 };
}

let counter = 0;
const saved = [];
const attachments = {
  async saveImages(items) {
    return Promise.all(
      items.map(async (item) => {
        counter += 1;
        const name = `img-${String(counter).padStart(2, '0')}.jpg`;
        await writeFile(join(OUT, name), item.data);
        const size = jpegSize(item.data);
        saved.push({ name, bytes: item.data.length, ...size });
        return { attachmentId: name, mediaType: item.mediaType, bytes: item.data.length, ...size };
      }),
    );
  },
};

const ctx = {
  subprocess: { spawn: spawnStub },
  get: (name) => (name === 'attachments' ? attachments : undefined),
  tools: { register: () => () => {} },
};

const cfg = resolveConfig({ sherpaPath: DSH_SHERPA, maxTotalSheets: MAX_SHEETS, record: false });
const run = createRunner((spec) => spawnStub(spec), { graceMs: 2000, timeoutMs: 300000 });
const tools = buildTools({ ctx, run, cfg });
const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

const lines = [];
const say = (text) => lines.push(text);

// ---- 1. video_plan ----
let started = Date.now();
const plan = await byName.video_plan.execute({ input: VIDEO, preset: PRESET, userConfirmed: true }, { signal: undefined });
say(`=== video_plan（${((Date.now() - started) / 1000).toFixed(1)} s）===`);
say(byName.video_plan.output.render({}, plan)[0].text);

// 预算不够时先按"截断"定稿（探针要的是能跑通，不是替用户选方案）。
let planId = plan.planId;
if (typeof planId !== 'string') {
  const committed = await byName.video_plan.execute(
    { input: VIDEO, preset: PRESET, userConfirmed: true, choice: { id: 'truncate' } },
    { signal: undefined },
  );
  planId = committed.planId;
  say(`\n（预算 ${MAX_SHEETS} 张不够全片，已按 truncate 定稿）`);
}

// ---- 2. video_watch ----
started = Date.now();
const watch = await byName.video_watch.execute({ input: VIDEO, planId, batch: 1 }, { signal: undefined });
const watchSeconds = ((Date.now() - started) / 1000).toFixed(1);
say('');
say(`=== video_watch（${watchSeconds} s）===`);
say(byName.video_watch.output.render({}, watch)[0].text);

// ---- 3. video_closeup（挑三个时间点取全分辨率）----
const moments = [3, Math.round(plan.durationSeconds / 2), Math.max(1, Math.round(plan.durationSeconds - 3))];
started = Date.now();
const closeup = await byName.video_closeup.execute({ input: VIDEO, times: moments }, { signal: undefined });
say('');
say(`=== video_closeup（${((Date.now() - started) / 1000).toFixed(1)} s，时刻 ${moments.join('/')}）===`);
say(byName.video_closeup.output.render({}, closeup)[0].text);

say('');
say('=== 落盘的文件 ===');
for (const item of saved) say(`  ${item.name}  ${item.width}x${item.height}  ${(item.bytes / 1024).toFixed(0)} KB`);

await writeFile(join(OUT, 'manifest.txt'), lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
