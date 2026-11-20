import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatClock,
  formatShort,
  formatTranscriptLines,
  parseSeconds,
  parseTranscript,
  sliceTranscript,
} from '../lib/time.js';

test('parseSeconds 认得数字、秒、分秒、时分秒', () => {
  assert.equal(parseSeconds(12.5), 12.5);
  assert.equal(parseSeconds('12.5'), 12.5);
  assert.equal(parseSeconds('01:30'), 90);
  assert.equal(parseSeconds('1:02:03.5'), 3723.5);
});

test('parseSeconds 认不出来就返回 null，不猜', () => {
  for (const bad of ['', 'abc', '1:2:3:4', '00:xx', null, undefined, {}, '  ']) {
    assert.equal(parseSeconds(bad), null, `${String(bad)} 不该被解析成时间`);
  }
});

test('formatClock 在毫秒进位时不写出非法串', () => {
  assert.equal(formatClock(65.5), '1:05.500');
  assert.equal(formatClock(0), '0:00.000');
  assert.equal(formatClock(59.9996), '1:00.001');
  assert.equal(formatClock(-3), '0:00.000');
});

test('formatShort 给烧字用，两位分两位秒', () => {
  assert.equal(formatShort(65.9), '01:05');
  assert.equal(formatShort(9), '00:09');
});

test('parseTranscript 解析 SRT', () => {
  const srt = [
    '1',
    '00:00:01,000 --> 00:00:04,000',
    '你好',
    '',
    '2',
    '00:00:05,500 --> 00:00:06,250',
    '<i>世界</i>',
    '',
  ].join('\n');
  const cues = parseTranscript(srt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 4);
  assert.equal(cues[1].text, '世界');
  assert.equal(cues[1].start, 5.5);
});

test('parseTranscript 解析 WebVTT 并忽略 cue 设置', () => {
  const vtt = ['WEBVTT', '', '00:00:01.000 --> 00:00:02.500 align:start position:0%', 'Hi there', ''].join('\n');
  const cues = parseTranscript(vtt);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 2.5);
  assert.equal(cues[0].text, 'Hi there');
});

test('parseTranscript 既认数组也认 whisper 的 segments', () => {
  const arrayForm = JSON.stringify([{ start: 1.2, end: 3.4, text: 'a' }]);
  assert.equal(parseTranscript(arrayForm)[0].text, 'a');
  const segments = JSON.stringify({ segments: [{ start: 0, end: 1, text: 'b' }] });
  assert.equal(parseTranscript(segments)[0].text, 'b');
});

test('parseTranscript 对无法识别的输入返回 null', () => {
  assert.equal(parseTranscript(''), null);
  assert.equal(parseTranscript('just some prose'), null);
  assert.equal(parseTranscript('{ broken json'), null);
});

test('parseTranscript 会把乱序的字幕排成时间线', () => {
  const scrambled = ['1', '00:00:09,000 --> 00:00:10,000', '第三句', '', '2', '00:00:01,000 --> 00:00:02,000', '第一句', ''].join(
    '\n',
  );
  const cues = parseTranscript(scrambled);
  assert.deepEqual(cues.map((cue) => cue.text), ['第一句', '第三句']);
});

test('sliceTranscript 按重叠取，不按起点取', () => {
  const cues = [
    { start: 0, end: 5, text: '跨过窗口起点' },
    { start: 6, end: 7, text: '窗口内' },
    { start: 20, end: 21, text: '窗口外' },
  ];
  const picked = sliceTranscript(cues, 3, 10);
  assert.deepEqual(picked.map((cue) => cue.text), ['跨过窗口起点', '窗口内']);
});

test('formatTranscriptLines 有行数上限', () => {
  const cues = Array.from({ length: 100 }, (_, index) => ({ start: index, end: index + 0.5, text: `第${index}句` }));
  const lines = formatTranscriptLines(cues, { maxLines: 10 });
  assert.ok(lines.length <= 10);
  assert.ok(lines[0].startsWith('[0:00.000]'));
});
