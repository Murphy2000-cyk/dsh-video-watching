/**
 * 用 Agent**自己的**校验器验一遍三个工具的契约。
 *
 * 单测里的 schema 校验是"我按文档写的"，这份脚本拿的是 Agent 安装里的真货：
 * 一个不支持的关键字不是"工具不太好用"，而是 `ctx.tools.register()` 在 apply
 * 期间直接抛错 —— 插件整个装不上，而且报错完全看不出是这个原因。
 *
 * 跑法：`node scripts/verify-agent-contract.mjs`
 * 依赖本机 DSH 安装路径，所以不放进 `npm test`。
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const DSH_TOOLS = 'C:/Users/lenovo/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js';

const { assertSupportedJsonSchema, assertObjectJsonSchema, validateJsonSchemaValue } = await import(
  pathToFileURL(DSH_TOOLS).href
);

const { buildTools, resolveConfig } = await import('../index.js');
const { sampleHead, sampleAudio } = await import('../test/fixture.mjs');

const cfg = resolveConfig({});
const tools = buildTools({ ctx: {}, run: async () => ({ code: 0, stdout: '', stderr: '' }), cfg });

assert.equal(tools.length, 3, '应当注册三个工具');
assert.deepEqual(
  tools.map((tool) => tool.name),
  ['video_watch', 'video_plan', 'video_closeup'],
);

const failures = [];

for (const tool of tools) {
  try {
    assert.equal(tool.parameters.type, 'object', `${tool.name}: parameters 必须以 object 为根`);
    assertSupportedJsonSchema(tool.parameters);
    assertObjectJsonSchema(tool.output.schema);
    if (typeof tool.output.render !== 'function') throw new Error('缺少 render');
    if (typeof tool.execute !== 'function') throw new Error('缺少 execute');
    if (tool.description.length < 80) throw new Error('description 太短，模型可能不知道何时该调它');
  } catch (error) {
    failures.push(`${tool.name}: ${error.message}`);
  }
}

/** 造一份与 execute 返回值同形的样例，用来验输出 schema。 */
const SAMPLE_IMAGE = { attachmentId: 'a1b2', mediaType: 'image/jpeg', bytes: 12345, width: 800, height: 450 };

// 头字段用**真实链路**算出来（合成序列 → planFrames → delivery → headOf），
// 不手写：手写样例漏过 `estimate.singles`，单测全绿而真机每次调用都报错。
const SAMPLE_HEAD = sampleHead();

const samples = {
  video_plan: SAMPLE_HEAD,
  video_watch: {
    ...SAMPLE_HEAD,
    frames: [{ index: 1, time: 0, label: '0:00.000', sheet: 1, cell: 1 }],
    sheets: [{ sheet: 1, global: 1, from: 0, to: 0.9, cols: 4, rows: 5, width: 800, height: 450, tokens: 233, image: SAMPLE_IMAGE }],
    transcript: { source: 'demo.srt', count: 1, lines: [{ start: 0.5, end: 2, text: '开场' }] },
    skipped: 0,
    batch: { index: 1, total: 3, size: 10, sheets: 28, from: 0, to: 24, next: 2, done: false },
    audio: sampleAudio(),
  },
  video_closeup: {
    path: 'C:/media/demo.mp4',
    sourceWidth: 1920,
    sourceHeight: 1080,
    durationSeconds: 90,
    frames: [{ time: 12.5, label: '0:12.500', width: 1280, height: 720, image: { ...SAMPLE_IMAGE, width: 1280, height: 720 } }],
  },
};

for (const tool of tools) {
  const sample = samples[tool.name];
  if (sample === undefined) {
    failures.push(`${tool.name}: 没有样例值`);
    continue;
  }
  const problems = validateJsonSchemaValue(tool.output.schema, sample);
  if (problems.length > 0) failures.push(`${tool.name}: 输出与 schema 不符 → ${problems.join('；')}`);

  // render 必须能吃下合法值，并产出至少一块文本。
  const blocks = tool.output.render({}, sample);
  if (!Array.isArray(blocks) || blocks.length === 0) failures.push(`${tool.name}: render 返回空`);
  else if (blocks[0].type !== 'text') failures.push(`${tool.name}: 首块不是 text`);
  const images = blocks.filter((block) => block.type === 'image').length;
  const expectedImages = tool.name === 'video_plan' ? 0 : sample.frames.length > 0 && tool.name === 'video_closeup' ? sample.frames.length : sample.sheets.length;
  if (images !== expectedImages) failures.push(`${tool.name}: 期望 ${expectedImages} 张图，render 给了 ${images} 张`);
}

if (failures.length > 0) {
  console.error('契约校验失败：');
  for (const line of failures) console.error(`  - ${line}`);
  process.exitCode = 1;
} else {
  console.log(`契约校验通过：${tools.length} 个工具的 parameters 与 output 都被 Agent 校验器接受，样例值也过校验。`);
}
