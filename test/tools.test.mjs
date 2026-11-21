import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTools, effectiveArgs, expandCommand, MODES, resolveConfig } from '../index.js';
import { sampleHead } from './fixture.mjs';

const cfg = resolveConfig({});
const tools = buildTools({ ctx: {}, run: async () => ({ code: 0, stdout: '', stderr: '' }), cfg });
const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

test('四个工具名固定且互不冲突', () => {
  assert.deepEqual(Object.keys(byName).sort(), ['video_closeup', 'video_note', 'video_plan', 'video_watch']);
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
      { sheet: 1, global: 1, from: 0, to: 1.5, cols: 2, rows: 1, width: 800, height: 450, tokens: 233, image: { attachmentId: 'x', mediaType: 'image/jpeg', bytes: 1, width: 800, height: 450 } },
    ],
    transcript: { source: 'demo.srt', count: 1, lines: [{ start: 0.5, text: '开场' }] },
    skipped: 0,
  };
  const blocks = byName.video_watch.output.render({}, value);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /cell 1 = 0:00\.000/);
  assert.match(blocks[0].text, /cell 2 = 0:01\.500/);
  assert.match(blocks[0].text, /\[0:00\.500\] 开场/);
  assert.match(blocks[0].text, /<sampling /);
  assert.equal(blocks.filter((block) => block.type === 'image').length, 1);
});

test('renderPlan 不产出任何图片', () => {
  const blocks = byName.video_plan.output.render({}, sampleHead());
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /video-plan/);
  // 采样口径不在工具参数里，只能靠这一行让模型知道这次按什么在跑
  assert.match(blocks[0].text, /<sampling a="0\.3"/);
  assert.match(blocks[0].text, /maxSheets="10"/);
  assert.match(blocks[0].text, /mode="analysis"/);
});

test('截断写进正文：模型不会把 batchDone=true 读成"整片看完了"', () => {
  const head = sampleHead();
  const truncated = {
    ...head,
    plan: { ...head.plan, truncated: true, videoComplete: false, coveredTo: 12, unseenSeconds: 78, sheets: 3 },
  };
  const text = byName.video_plan.output.render({}, truncated)[0].text;
  assert.match(text, /<coverage videoComplete="false"/);
  assert.match(text, /was NOT watched/);
  // 没截断时不该出现这行（避免吓唬人）
  assert.doesNotMatch(byName.video_plan.output.render({}, head)[0].text, /<coverage/);
});

test('密度被调过时写进正文：说清是预算压的，不是模式自带的密度', () => {
  const head = sampleHead();
  const thinned = { ...head, plan: { ...head.plan, thinned: true, aEff: 2.4, scale: 8, sheets: 9 } };
  const text = byName.video_plan.output.render({}, thinned)[0].text;
  assert.match(text, /<density-changed thinned="true"/);
  assert.match(text, /sparser than the mode/);
  assert.doesNotMatch(byName.video_plan.output.render({}, head)[0].text, /<density-changed/);
});

test('maxGap 失守单独成行，不和"没变化"混为一谈', () => {
  const head = sampleHead();
  const broken = { ...head, plan: { ...head.plan, maxGapBroken: true, maxIntervalSeconds: 8.2 } };
  const text = byName.video_plan.output.render({}, broken)[0].text;
  assert.match(text, /<gap broken="true" promised="5s" actual="8.2s">/);
});

test('预算不够时：正文给选项、给数字，并明确禁止先 watch', () => {
  const head = sampleHead();
  const blocked = {
    ...head,
    budget: { required: 128, minimum: 96, max: 100, feasible: false, sheets: 128, tokens: 49152, coveredTo: 90, unseenSeconds: 0, batches: 13, a: 0.3, t: 1 },
    options: [
      { id: 'raise', sheets: 128, tokens: 49152, coveredTo: 90, unseenSeconds: 0, batches: 13, a: 0.3, t: 1, maxGap: 5, multiCross: true, cutPair: false, maxSheets: 10, budget: 128, feasible: true, recommended: false, note: 'full' },
      { id: 'truncate', sheets: 100, tokens: 38400, coveredTo: 62, unseenSeconds: 28, batches: 10, a: 0.3, t: 1, maxGap: 5, multiCross: true, cutPair: false, maxSheets: 10, budget: 100, feasible: true, recommended: true, note: 'stop early' },
    ],
  };
  const text = byName.video_plan.output.render({}, blocked)[0].text;
  assert.match(text, /<budget required="128" minimum="96" max="100" feasible="false"/);
  assert.match(text, /<options>/);
  assert.match(text, /raise\s+128 sheets/);
  assert.match(text, /truncate\s+100 sheets/);
  assert.match(text, /Do NOT call video_watch yet/);
  assert.doesNotMatch(text, /<plan-id>/);
});

test('预算够时：给 planId 并指向 watch', () => {
  const head = sampleHead();
  const ready = {
    ...head,
    planId: '0123456789abcdef',
    budget: { required: 12, minimum: 12, max: 100, feasible: true, sheets: 12, tokens: 4608, coveredTo: 90, unseenSeconds: 0, batches: 2, a: 0.3, t: 1 },
  };
  const text = byName.video_plan.output.render({}, ready)[0].text;
  assert.match(text, /<plan-id>0123456789abcdef<\/plan-id>/);
  assert.match(text, /call video_watch with planId="0123456789abcdef"/);
  assert.doesNotMatch(text, /Do NOT call video_watch/);
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
  // 采样口径允许在配置里覆盖，但默认必须是 null（= 跟随模式），不能被静默写死
  for (const key of ['a', 't', 'maxGap', 'multiCross', 'cutPair', 'maxSheets']) {
    assert.equal(defaults[key], null, key + ' 默认应为 null（跟随模式）');
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


test('两种模式：解析更密、理解更省，显式参数压过模式', () => {
  const cfg = resolveConfig({});
  const analysis = effectiveArgs({ mode: 'analysis' }, cfg);
  const understand = effectiveArgs({ mode: 'understand' }, cfg);
  assert.equal(analysis.a, 0.3);
  assert.equal(understand.a, 1);
  assert.equal(understand.t, 1.5);
  assert.equal(understand.maxGap, 6);
  assert.equal(analysis.maxSheets, 10, '解析模式每批 10 张');
  assert.equal(understand.maxSheets, 20, '理解模式每批 20 张');
  assert.ok(understand.maxGap > analysis.maxGap, '理解模式容忍更长的间隔');
  assert.equal(analysis.cutPair, false);
  assert.equal(understand.cutPair, false);

  // 配置能覆盖模式（用户改配置 = 用户改参数）
  const configured = effectiveArgs({ mode: 'understand' }, { ...cfg, a: 0.3, maxSheets: 4 });
  assert.equal(configured.a, 0.3, '配置里的 a 覆盖模式');
  assert.equal(configured.maxSheets, 4, '配置里的 maxSheets 覆盖模式');
  assert.equal(configured.maxGap, 6, '配置没写的仍走模式');

  // 工具参数不再能覆盖采样口径（模型没有这个口子）
  const viaArgs = effectiveArgs({ mode: 'understand', a: 0.05, maxSheets: 99, maxGap: 0 }, cfg);
  assert.equal(viaArgs.a, 1, 'args 里的 a 被忽略');
  assert.equal(viaArgs.maxSheets, 20, 'args 里的 maxSheets 被忽略');
  assert.equal(viaArgs.maxGap, 6, 'args 里的 maxGap 被忽略');

  // 非法 mode 退回解析（不报错，但也绝不该由模型瞎传）
  assert.equal(effectiveArgs({ mode: 'nonsense' }, cfg).a, MODES.analysis.a);
});

test('mode 只在 plan 上是必填（模式在 plan 那一步定），watch 要的是 planId', () => {
  assert.ok(byName.video_plan.parameters.required.includes('mode'), 'plan 应当要求 mode');
  assert.ok(byName.video_plan.parameters.required.includes('userConfirmed'), 'plan 应当要求 userConfirmed');
  assert.deepEqual(byName.video_plan.parameters.properties.mode.enum, ['analysis', 'understand']);
  assert.ok(byName.video_watch.parameters.required.includes('planId'), 'watch 必须带 planId');
  assert.equal(byName.video_watch.parameters.properties.mode, undefined, 'watch 不再决定模式');
  assert.equal(byName.video_watch.parameters.properties.userConfirmed, undefined, '确认发生在 plan 那一步');
  assert.equal(byName.video_closeup.parameters.properties.mode, undefined, 'closeup 不需要模式');
});

test('video_note 是纯本地记录：必填四项，输出只有落盘信息', () => {
  const note = byName.video_note;
  assert.deepEqual([...note.parameters.required].sort(), ['batch', 'input', 'note', 'planId']);
  assert.equal(note.parameters.properties.batch.type, 'integer');
  assert.equal(note.parameters.properties.note.type, 'string');
  // 取值形状逐字段对齐 schema：多一个键就是 INVALID_TOOL_OUTPUT
  const schema = note.output.schema;
  assert.deepEqual(schema.required.sort(), ['appended', 'batch', 'bytes', 'path']);
  assert.equal(schema.additionalProperties, false);
  // 它不该出图，也不该要求视频真的存在（只写 Markdown）
  const blocks = note.output.render({}, { path: 'C:/x/video.观看记录.md', batch: 2, bytes: 120, appended: false });
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /video-note/);
  assert.match(blocks[0].text, /batch="2"/);
});

test('video_note 的提示词给的是"可复现"标准和三段结构，不是主题清单', () => {
  const note = byName.video_note;
  const full = `${note.description}\n${note.parameters.properties.note.description}`;
  // 标准：没看过的人只看文字也能重剪一遍
  assert.match(full, /REPRODUCE/);
  assert.match(full, /never seen the video/);
  // 三段：观看情况 → 详细 → 总结
  assert.match(full, /观看情况/);
  assert.match(full, /总结/);
  assert.match(full, /whole video/);
});

test('观看记录默认开、默认写桌面，也可以整体关掉', () => {
  const defaults = resolveConfig({});
  assert.equal(defaults.record, true);
  assert.match(defaults.recordDir, /Desktop$/);
  // 默认要求逐批写：下一批要等上一批的分析落盘
  assert.equal(defaults.requireNote, true);
  assert.equal(resolveConfig({ requireNote: false }).requireNote, false);
  assert.equal(resolveConfig({ record: false }).record, false);
  assert.equal(resolveConfig({ record: 'false' }).record, true, '只认真正的 false，字符串不关');
  assert.equal(resolveConfig({ recordDir: 'F:/记录' }).recordDir, 'F:/记录');
  assert.equal(resolveConfig({ recordDir: 'desktop' }).recordDir, defaults.recordDir);
});
