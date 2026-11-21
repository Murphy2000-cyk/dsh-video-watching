import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateBgm,
  chunkPlan,
  normalizeChunk,
  parseModelJson,
  sentencesFromTokens,
} from '../lib/audio.js';

test('分片：窗口装得下就连续切，不抽样', () => {
  const plan = chunkPlan({ from: 0, to: 90, chunkSeconds: 30, maxChunks: 10 });
  assert.equal(plan.sampled, false);
  assert.deepEqual(plan.chunks, [
    { from: 0, to: 30 },
    { from: 30, to: 60 },
    { from: 60, to: 90 },
  ]);
  assert.deepEqual(plan.skipped, []);
});

test('分片：窗口装不下就均匀抽样，并报出被跳过的区间', () => {
  const plan = chunkPlan({ from: 0, to: 300, chunkSeconds: 30, maxChunks: 4 });
  assert.equal(plan.sampled, true);
  assert.equal(plan.chunks.length, 4);
  assert.equal(plan.chunks[0].from, 0);
  // 每片 30 秒、间隔 75 秒 => 片与片之间必然有空隙
  assert.equal(plan.skipped.length, 3);
  assert.ok(plan.skipped[0].from < plan.skipped[0].to);
  assert.ok(plan.skipped[0].from >= plan.chunks[0].to - 1e-9);
});

test('分片：空窗口返回空计划', () => {
  assert.deepEqual(chunkPlan({ from: 5, to: 5 }).chunks, []);
});

test('解析模型回答：整体 JSON、带围栏、前后有解释文字三种都能取到', () => {
  assert.deepEqual(parseModelJson('{"music":"none"}'), { music: 'none' });
  assert.deepEqual(parseModelJson('```json\n{"music":"light"}\n```'), { music: 'light' });
  assert.deepEqual(parseModelJson('好的，结果是 {"music":"none"} 以上。'), { music: 'none' });
  assert.equal(parseModelJson('没有 JSON'), null);
  assert.equal(parseModelJson(''), null);
});

test('规范化：枚举外的取值收敛到"其他"，none 时清空风格相关字段', () => {
  const light = normalizeChunk({
    music: 'light',
    style: '轻音乐',
    tempo: '缓慢',
    mood: '治愈',
    instruments: ['钢琴', '钢琴', ' '],
    characteristics: '  单音钢琴  ',
    searchWords: ['钢琴', '温暖', '钢琴'],
    sfx: [],
  });
  assert.equal(light.music, 'light');
  assert.equal(light.style, '其他');
  assert.equal(light.tempo, '慢');   // '缓慢' 里含 '慢'，按子串收敛
  assert.equal(light.mood, '其他');
  assert.deepEqual(light.instruments, ['钢琴']);
  assert.equal(light.characteristics, '单音钢琴');
  assert.deepEqual(light.searchWords, ['钢琴', '温暖']);

  const none = normalizeChunk({ music: 'none', style: '电子', tempo: '快', instruments: ['鼓'] });
  assert.equal(none.style, '');
  assert.equal(none.tempo, '');
  assert.deepEqual(none.instruments, []);
});

test('聚合：相邻片枚举不同才算变化点，并给出"从第几秒起"', () => {
  const chunks = [
    { from: 0, to: 30, music: 'light', style: '钢琴', tempo: '慢', mood: '温暖', instruments: ['钢琴'], characteristics: '稀疏', searchWords: ['钢琴', '温暖'], sfx: [] },
    { from: 30, to: 60, music: 'light', style: '钢琴', tempo: '慢', mood: '温暖', instruments: ['钢琴'], characteristics: '继续', searchWords: ['钢琴'], sfx: [] },
    { from: 60, to: 90, music: 'prominent', style: '电子', tempo: '快', mood: '紧张', instruments: ['合成器鼓机'], characteristics: '加入鼓点', searchWords: ['电子'], sfx: ['重击声'] },
  ];
  const result = aggregateBgm(chunks);
  assert.equal(result.style, '钢琴');
  assert.equal(result.tempo, '慢');
  assert.equal(result.mood, '温暖');
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].at, 60);
  assert.equal(result.changes[0].from, '钢琴/慢');
  assert.equal(result.changes[0].to, '电子/快');
  assert.deepEqual(result.searchWords, ['钢琴', '温暖', '电子']);
  assert.deepEqual(result.sfx, ['重击声']);
});

test('聚合：全片无音乐时不报风格', () => {
  const result = aggregateBgm([
    { from: 0, to: 30, music: 'none', style: '', tempo: '', mood: '', instruments: [], characteristics: '', searchWords: [], sfx: [] },
  ]);
  assert.equal(result.music, 'none');
  assert.equal(result.style, '');
  assert.deepEqual(result.changes, []);
});

test('拼句：按句末标点断句，并加上片偏移', () => {
  const sentences = sentencesFromTokens({
    tokens: ['这', '是', '一', '句', '。', '再', '来', '一', '句', '！'],
    timestamps: [0.1, 0.3, 0.5, 0.7, 0.9, 1.2, 1.4, 1.6, 1.8, 2.0],
    offset: 10,
  });
  assert.equal(sentences.length, 2);
  assert.equal(sentences[0].text, '这是一句。');
  assert.equal(sentences[0].start, 10.1);
  assert.equal(sentences[0].end, 10.9);
  assert.equal(sentences[1].text, '再来一句！');
  assert.equal(sentences[1].start, 11.2);
});

test('拼句：没有句末标点也要收尾，不能丢尾巴', () => {
  const sentences = sentencesFromTokens({ tokens: ['没', '有', '句', '号'], timestamps: [0, 0.2, 0.4, 0.6] });
  assert.equal(sentences.length, 1);
  assert.equal(sentences[0].text, '没有句号');
  assert.equal(sentences[0].end, 0.6);
});

test('聚合：多数片没音乐时整体判为 none，且不采纳无音乐片的检索词', () => {
  const none = (from) => ({ from, to: from + 30, music: 'none', style: '', tempo: '', mood: '', instruments: [], characteristics: '无背景音乐', searchWords: ['纯人声', '无BGM'], sfx: [] });
  const music = { from: 210, to: 240, music: 'light', style: '氛围', tempo: '慢', mood: '冷静', instruments: ['合成器'], characteristics: '长音铺垫', searchWords: ['ambient', 'calm'], sfx: [] };
  const result = aggregateBgm([none(0), none(30), none(60), none(90), none(120), none(150), none(180), music]);
  assert.equal(result.music, 'none');
  assert.equal(result.style, '氛围');
  assert.deepEqual(result.searchWords, ['ambient', 'calm']);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].at, 210);
  assert.equal(result.changes[0].to, '氛围/慢');
});