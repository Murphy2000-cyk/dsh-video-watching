import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parseFfmpegProbe } from '../lib/ffmpeg.js';

const fixture = readFileSync(new URL('./fixtures/probe-stderr.txt', import.meta.url), 'utf8');

test('解析真实的 ffmpeg -i 输出', () => {
  const info = parseFfmpegProbe(fixture);
  assert.equal(info.duration, 3);
  assert.equal(info.width, 640);
  assert.equal(info.height, 360);
  assert.equal(info.fps, 25);
  assert.equal(info.hasAudio, true);
  assert.equal(info.subtitleTracks.length, 0);
});

test('displaymatrix 旋转 90 度要交换宽高', () => {
  const text = [
    '  Duration: 00:00:10.50, start: 0.000000, bitrate: 800 kb/s',
    '  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 800 kb/s, 30 fps',
    '      displaymatrix: rotation of -90.00 degrees',
  ].join('\n');
  const info = parseFfmpegProbe(text);
  assert.equal(info.duration, 10.5);
  assert.equal(info.width, 1080);
  assert.equal(info.height, 1920);
  assert.equal(info.fps, 30);
});

test('metadata 里的 rotate 标签也认', () => {
  const text = [
    '  Duration: 00:00:02.00, start: 0',
    '  Stream #0:0: Video: h264, yuv420p, 720x1280',
    '      rotate          : 180',
  ].join('\n');
  const info = parseFfmpegProbe(text);
  assert.equal(info.width, 720, '180 度不交换宽高');
  assert.equal(info.height, 1280);
});

test('字幕轨带语言', () => {
  const text = [
    '  Duration: 00:00:05.00, start: 0',
    '  Stream #0:0: Video: h264, yuv420p, 1280x720, 30 fps',
    '  Stream #0:1(eng): Subtitle: subrip',
    '  Stream #0:2(jpn): Subtitle: ass',
  ].join('\n');
  const info = parseFfmpegProbe(text);
  assert.equal(info.subtitleTracks.length, 2);
  assert.equal(info.subtitleTracks[0].index, 1);
  assert.equal(info.subtitleTracks[0].language, 'eng');
  assert.equal(info.subtitleTracks[1].language, 'jpn');
});

test('没有 Duration 就返回 null，不编造', () => {
  assert.equal(parseFfmpegProbe(''), null);
  assert.equal(parseFfmpegProbe('some random text'), null);
});

test('十六进制码流标签不会被误认成画面尺寸', () => {
  const text = [
    '  Duration: 00:00:01.00',
    '  Stream #0:0[0x1]: Video: h264 (avc1 / 0x31637661), yuv420p, 320x240, 25 fps',
  ].join('\n');
  const info = parseFfmpegProbe(text);
  assert.equal(info.width, 320);
  assert.equal(info.height, 240);
});
