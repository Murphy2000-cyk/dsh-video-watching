/**
 * 用 Agent 自己的校验器验**真实调用产出**，而不是手写样例。
 *
 * `verify-agent-contract.mjs` 验的是"schema 本身合法 + 手写样例过校验"；
 * 手写样例漏一个键是不会报的（`INVALID_TOOL_OUTPUT` 就是这么漏过去的）。
 * 这份脚本走另一条：真造一部片子 → 真跑三个工具的 execute → 拿**真实返回值**
 * 喂给 Agent 的 `validateJsonSchemaValue` → 再喂给各自的 render。
 *
 * 跑法：`node scripts/verify-real-output.mjs [视频]`
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildTools, resolveConfig } from '../index.js';
import { createRunner } from '../lib/ffmpeg.js';

const DSH_TOOLS = 'C:/Users/lenovo/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js';
const { validateJsonSchemaValue } = await import(pathToFileURL(DSH_TOOLS).href);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'smoke-out', '_real');
// 本机 DSH 安装里自带 sherpa-onnx-node 与 SenseVoice 的 ONNX 模型，直接借用，免装原生包。
const DSH_SHERPA = 'C:/Users/lenovo/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/sherpa-onnx-node';
const cfg = resolveConfig({ sherpaPath: DSH_SHERPA });
const FFMPEG = cfg.ffmpegPath;

const failures = [];
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  ${detail}`}`);
  if (!ok) failures.push(name);
};

/** subprocess 服务替身（与 smoke.mjs 同形，被验的是生产代码本身）。 */
function spawnStub(spec) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const buf = { stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk) => {
    buf.stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk) => {
    buf.stderr += chunk.toString('utf8');
  });
  const done = new Promise((resolve, reject) => {
    child.on('close', (code, signal) => resolve({ exitCode: code, signal }));
    child.on('error', (error) => reject(error));
  });
  const reader = (name) => ({ readFrom: () => ({ text: buf[name], nextOffset: buf[name].length, lossy: false }) });
  return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } };
}

/** 从 JPEG 里读宽高（SOF0/1/2 段），附件服务真实返回值就是这个口径。 */
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

let saved = 0;
const attachments = {
  async saveImages(items) {
    return Promise.all(
      items.map(async (item) => {
        saved += 1;
        await mkdir(OUT, { recursive: true });
        await writeFile(join(OUT, `saved-${saved}.jpg`), item.data);
        const size = jpegSize(item.data);
        return { attachmentId: `real-${saved}`, mediaType: item.mediaType, bytes: item.data.length, ...size };
      }),
    );
  },
};

const ctx = {
  subprocess: { spawn: spawnStub },
  get: (name) => (name === 'attachments' ? attachments : undefined),
  tools: { register: () => () => {} },
};

const run = createRunner((spec) => spawnStub(spec), { graceMs: 2000, timeoutMs: 180000 });

/** 真造一部 6 秒片子：3 秒静止 + 3 秒运动，保证有硬切也有变化。 */
async function buildVideo() {
  const work = join(OUT, '_fixture');
  await mkdir(work, { recursive: true });
  const build = async (args) => {
    const handle = spawnStub({ argv: [FFMPEG, ...args], cwd: ROOT });
    const outcome = await handle.done;
    if (outcome.exitCode !== 0) throw new Error(`ffmpeg 失败：${handle.collected.stderr.readFrom().text.slice(-500)}`);
  };
  const still = join(work, 'still.mp4');
  const motion = join(work, 'motion.mp4');
  await build(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=25:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', still]);
  await build(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', motion]);
  const list = join(work, 'list.txt');
  await writeFile(list, [still, motion].map((path) => `file '${path.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
  const out = join(work, 'real.mp4');
  await build(['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]);
  return out;
}

const given = process.argv[2];
const video = typeof given === 'string' && given !== '' ? given : existsSync(join(ROOT, 'smoke-out', '_fixture', 'fixture.mp4'))
  ? join(ROOT, 'smoke-out', '_fixture', 'fixture.mp4')
  : await buildVideo();

const tools = buildTools({ ctx, run, cfg });
const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

/** 跑一个工具，并用 Agent 校验器验它的**真实返回值**。 */
async function verify(toolName, args) {
  const tool = byName[toolName];
  let value;
  try {
    value = await tool.execute(args, { signal: undefined });
  } catch (error) {
    check(`${toolName} 执行`, false, String(error?.message ?? error).slice(0, 160));
    return null;
  }
  check(`${toolName} 执行`, true);
  const problems = validateJsonSchemaValue(tool.output.schema, value);
  check(`${toolName} 真实返回值过 Agent 校验`, problems.length === 0, problems.slice(0, 3).join('；'));
  let blocks = [];
  try {
    blocks = tool.output.render(args, value);
  } catch (error) {
    check(`${toolName} render`, false, String(error?.message ?? error).slice(0, 160));
    return value;
  }
  const images = blocks.filter((block) => block.type === 'image').length;
  const expected = toolName === 'video_plan' ? 0 : toolName === 'video_closeup' ? value.frames.length : value.sheets.length;
  check(`${toolName} render 出图数`, images === expected, `${images} / 期望 ${expected}`);
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  check(`${toolName} 清单里没有 undefined/NaN`, !/undefined|NaN/.test(text), text.match(/undefined|NaN/g)?.slice(0, 3).join(',') ?? '');
  return value;
}

const plan = await verify('video_plan', { input: video, preset: 'understand', userConfirmed: true });
let planId = plan?.planId;
let committedPlan = plan;
if (plan !== null && typeof planId !== 'string') {
  // 预算不够时 plan 只给选项；这里走"截断"这条定稿路径，顺带验它。
  committedPlan = await verify('video_plan', { input: video, preset: 'understand', userConfirmed: true, choice: { id: 'truncate' } });
  planId = committedPlan?.planId;
  check('预算不够时 choice=truncate 能定稿', typeof planId === 'string');
}
const watch = await verify('video_watch', { input: video, planId, batch: 1 });
const closeup = await verify('video_closeup', { input: video, times: [1.5, '00:04'] });

// 语义不变量：每张图片都顶到 384 token 天花板，所以总 token 必须等于张数 × 384。
if (watch !== null) {
  check('estimate.token == 图片张数 × 384', watch.estimate.tokens === watch.estimate.sheets * 384, `${watch.estimate.tokens} vs ${watch.estimate.sheets}×384`);
  check('estimate.sheets == 实际交付图片数', watch.estimate.sheets === watch.sheets.length, `${watch.estimate.sheets} / ${watch.sheets.length}`);
  check('每张图 token 都是 384', watch.sheets.every((sheet) => sheet.tokens === 384), watch.sheets.map((sheet) => sheet.tokens).join(','));
  check('子图都能归到某张图片的格位', watch.frames.every((frame) => frame.sheet >= 1 && frame.sheet <= watch.sheets.length && frame.cell >= 1));
}
if (committedPlan !== null) {
  check('plan 与 watch 的图片张数一致', committedPlan.estimate.sheets === (watch?.estimate.sheets ?? -1), `${committedPlan.estimate.sheets} / ${watch?.estimate.sheets}`);
  check('plan 带预算块', committedPlan.budget !== undefined && typeof committedPlan.budget.required === 'number', `required=${committedPlan.budget?.required}`);
}
if (closeup !== null) {
  check('closeup 取回两帧', closeup.frames.length === 2, `${closeup.frames.length}`);
}

// 工具描述里不该出现渲染失败的痕迹（删配置键后常见）。
for (const tool of tools) {
  check(`${tool.name} 描述无 undefined/NaN`, !/undefined|NaN/.test(tool.description));
}

await writeFile(join(OUT, 'report.txt'), `${checks.join('\n')}\n\n视频：${video}\n`, 'utf8');
console.log(checks.join('\n'));
console.log(`\n视频：${video}`);
console.log(`合计 ${checks.length} 项，失败 ${failures.length} 项。`);
if (failures.length > 0) process.exitCode = 1;
