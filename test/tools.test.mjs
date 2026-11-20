import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTools, effectiveArgs, expandCommand, PRESETS, resolveConfig } from '../index.js';
import { sampleHead } from './fixture.mjs';

const cfg = resolveConfig({});
const tools = buildTools({ ctx: {}, run: async () => ({ code: 0, stdout: '', stderr: '' }), cfg });
const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

test('三个工具名固定且互不冲突', () => {
  assert.deepEqual(Object.keys(byName).sort(), ['video_closeup', 'video_plan', 'video_watch']);
});

test('每个工具的参数根都是 object 且禁得住空入参校验', () => {
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object');
    assert.ok(Array.isArray(tool.parameters.required) && tool.parameters.required.length > 0);
    assert.equal(tool.parameters.additionalProperties, false);
  }
});

test('输出 schema 都是 additionalProperties:false 的对象', () => {
  for (const tool of tools) {
    assert.equal(tool.output.schema.type, 'object');
    assert.equal(tool.output.schema.additionalProperties, false);
  }
});

/**
 * 递归检查"值里出现的每个键都在 schema 里声明过"。
 *
 * Agent 就是按这个规则判 INVALID_TOOL_OUTPUT 的：`additionalProperties: false`
 * 之下多一个键，整次调用失败。这条断言放在单测里，是因为手写样例天然会漏键
 * （`estimate.singles` 就是这么漏出去、到真机上才炸的）。
 *
 * @param value - 真实产出。
 * @param schema - 对应的 schema 片段。
 * @param path - 报错用的路径。
 */
function assertDeclared(value, schema, path = 'value') {
  if (value === null || value === undefined || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    const items = schema?.items;
    assert.ok(items !== undefined, `${path}: schema 没声明 items`);
    value.forEach((item, index) => assertDeclared(item, items, `${path}[${index}]`));
    return;
  }
  if (schema?.additionalProperties === false) {
    const properties = schema.properties ?? {};
    for (const key of Object.keys(value)) {
      assert.ok(properties[key] !== undefined, `${path}.${key} 未在 schema 里声明`);
      assertDeclared(value[key], properties[key], `${path}.${key}`);
    }
  }
}

test('headOf 的每个键都在 output schema 里声明过（防止 INVALID_TOOL_OUTPUT）', () => {
  const head = sampleHead();
  assertDeclared(head, byName.video_plan.output.schema);
  assertDeclared(head, byName.video_watch.output.schema);
  // estimate 只留 sheets / tokens：单帧图片数由 plan.singles 给，
  // 两个字段指同一件事，模型会当成两个不同的数。
  assert.deepEqual(Object.keys(head.estimate).sort(), ['sheets', 'tokens']);
});

test('renderWatch 把"第几格 = 第几秒"写进正文', () => {
  const value = {
    ...sampleHead(),
    frames: [
      { index: 1, time: 0, label: '0:00.000', sheet: 1, cell: 1 },
      { index: 2, time: 1.5, label: '0:01.500', sheet: 1, cell: 2 },
    ],
    sheets: [
      { sheet: 1, cols: 2, rows: 1, width: 800, height: 450, tokens: 233, image: { attachmentId: 'x', mediaType: 'image/jpeg', bytes: 1, width: 800, height: 450 } },
    ],
    transcript: { source: 'demo.srt', count: 1, lines: [{ start: 0.5, text: '开场' }] },
    skipped: 0,
  };
  const blocks = byName.video_watch.output.render({}, value);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /cell 1 = 0:00\.000/);
  assert.match(blocks[0].text, /cell 2 = 0:01\.500/);
  assert.match(blocks[0].text, /\[0:00\.500\] 开场/);
  assert.equal(blocks.filter((block) => block.type === 'image').length, 1);
});

test('renderPlan 不产出任何图片', () => {
  const blocks = byName.video_plan.output.render({}, sampleHead());
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /video-plan/);
});

test('renderCloseup 一帧一图', () => {
  const value = {
    path: 'demo.mp4',
    sourceWidth: 1920,
    sourceHeight: 1080,
    durationSeconds: 90,
    frames: [
      { time: 12.5, label: '0:12.500', width: 1280, height: 720, image: { attachmentId: 'y', mediaType: 'image/jpeg', bytes: 1, width: 1280, height: 720 } },
    ],
  };
  const blocks = byName.video_closeup.output.render({}, value);
  assert.equal(blocks.filter((block) => block.type === 'image').length, 1);
  assert.match(blocks[0].text, /0:12\.500/);
});

test('配置能整体缺省，也有边界收口', () => {
  const defaults = resolveConfig({});
  assert.equal(defaults.scanFps, 10);
  assert.equal(defaults.longSide, 120);
  assert.equal(defaults.block, 4);
  // 采样参数由 preset 唯一决定，配置里不该再有这些键
  for (const key of ['a', 't', 'maxGap', 'multiCross', 'cutPair', 'maxSheets']) {
    assert.equal(defaults[key], undefined, key + ' 不应出现在配置里');
  }
  const wild = resolveConfig({ scanFps: 999, quality: 99, longSide: 9999, block: 999 });
  assert.ok(wild.scanFps <= 30);
  assert.ok(wild.longSide <= 480);
  assert.ok(wild.block <= 16);
  assert.ok(wild.quality <= 31);
});

test('外部转写命令只收数组，且必须同时带 {input} 与 {output}', () => {
  assert.deepEqual(resolveConfig({}).transcriptCommand, []);
  assert.deepEqual(
    resolveConfig({ transcriptCommand: 'python asr.py {input} {output}' }).transcriptCommand,
    [],
    '字符串要走 shell，路径里有空格就废了，所以不收',
  );
  assert.equal(resolveConfig({ transcriptCommand: ['py', 'asr.py', '{input}', '{output}'] }).transcriptCommand.length, 4);
  assert.deepEqual(
    resolveConfig({ transcriptCommand: ['py', 'asr.py', '{input}'] }).transcriptCommand,
    [],
    '缺 {output} 就拿不到字幕',
  );
});

test('expandCommand 在元素级别替换，带空格的路径不被拆开', () => {
  const argv = expandCommand(['py', 'run.py', '{input}', '--out', '{output}', '--lang', 'zh'], {
    input: 'C:/素材 a/视频 1.mp4',
    output: 'C:/tmp/asr.srt',
  });
  assert.deepEqual(argv, ['py', 'run.py', 'C:/素材 a/视频 1.mp4', '--out', 'C:/tmp/asr.srt', '--lang', 'zh']);
});


test('两种预设：解析更密、理解更省，显式参数压过预设', () => {
  const cfg = resolveConfig({});
  const analysis = effectiveArgs({ preset: 'analysis' }, cfg);
  const understand = effectiveArgs({ preset: 'understand' }, cfg);
  assert.equal(analysis.a, 0.3);
  assert.equal(understand.a, 1);
  assert.equal(understand.t, 1.5);
  assert.equal(understand.maxGap, 6);
  assert.equal(understand.maxSheets, 10);
  assert.ok(understand.maxGap > analysis.maxGap, '理解模式容忍更长的间隔');
  assert.equal(analysis.cutPair, false);
  assert.equal(understand.cutPair, false);

  // 显式传参压过预设
  const overridden = effectiveArgs({ preset: 'understand', a: 0.3 }, cfg);
  assert.equal(overridden.a, 0.3);
  assert.equal(overridden.maxGap, 6, '没传的项仍走预设');

  // 非法 preset 退回解析（不报错，但也绝不该由模型瞎传）
  assert.equal(effectiveArgs({ preset: 'nonsense' }, cfg).a, PRESETS.analysis.a);
});

test('preset 是必填参数（模型必须先问用户）', () => {
  for (const name of ['video_watch', 'video_plan']) {
    assert.ok(byName[name].parameters.required.includes('preset'), name + ' 应当要求 preset');
    assert.deepEqual(byName[name].parameters.properties.preset.enum, ['analysis', 'understand']);
  }
  assert.equal(byName.video_closeup.parameters.properties.preset, undefined, 'closeup 不需要模式');
});
