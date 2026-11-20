import assert from 'node:assert/strict';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { analyzeFromStream, frameBytes, lumaOf, scorePair, scoresFromRgb, scoresFromStream } from '../lib/scan.js';

test('frameBytes 按 64×36 RGB 算', () => {
  assert.equal(frameBytes(64, 36), 64 * 36 * 3);
});

test('scorePair 对相同帧给 0，对黑白切换给高分', () => {
  const black = Buffer.alloc(64 * 36 * 3, 0);
  const white = Buffer.alloc(64 * 36 * 3, 255);
  assert.equal(scorePair(black, black), 0);
  assert.ok(scorePair(black, white) > 200);
});

test('scorePair 对长度不一致的输入给 0 而不是崩', () => {
  assert.equal(scorePair(Buffer.alloc(30), Buffer.alloc(60)), 0);
  assert.equal(scorePair(null, Buffer.alloc(30)), 0);
});

test('scoresFromRgb 首帧记 0，之后逐帧比对', () => {
  const stride = 9;
  const rgb = Buffer.concat([Buffer.alloc(stride, 0), Buffer.alloc(stride, 255), Buffer.alloc(stride, 255)]);
  const scores = scoresFromRgb(rgb, stride);
  assert.equal(scores.length, 3);
  assert.equal(scores[0], 0);
  assert.ok(scores[1] > 200);
  assert.equal(scores[2], 0);
});

test('lumaOf 对纯黑与纯白给出端点', () => {
  assert.equal(lumaOf(Buffer.alloc(90, 0)), 0);
  assert.equal(Math.round(lumaOf(Buffer.alloc(90, 255))), 255);
});

test('analyzeFromStream 同时给出差异分与亮度', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'understanding-luma-'));
  try {
    const stride = 90;
    const frames = 4;
    const rgb = Buffer.alloc(stride * frames, 0);
    rgb.fill(255, stride * 2, stride * 3); // 第 3 帧纯白
    const path = join(dir, 'luma.rgb');
    await writeFile(path, rgb);
    const handle = await open(path, 'r');
    try {
      const { scores, luma } = await analyzeFromStream(handle, stride, { framesPerChunk: 1 });
      assert.deepEqual(scores, scoresFromRgb(rgb, stride));
      assert.equal(luma.length, frames);
      assert.equal(Math.round(luma[0]), 0);
      assert.equal(Math.round(luma[2]), 255);
      assert.equal(Math.round(luma[3]), 0);
    } finally {
      await handle.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scoresFromStream 与一次性算的结果一致，且与分块大小无关', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'understanding-scan-'));
  try {
    const stride = 64 * 36 * 3;
    const frames = 7;
    const rgb = Buffer.alloc(stride * frames, 0);
    // 让每一帧都不同，且差异有梯度：块边界处最容易暴露 carry 写错。
    for (let index = 0; index < frames; index += 1) {
      rgb.fill(index * 30, index * stride, (index + 1) * stride);
    }
    const path = join(dir, 'scan.rgb');
    await writeFile(path, rgb);
    const expected = scoresFromRgb(rgb, stride);

    for (const perChunk of [1, 2, 3, 100]) {
      const handle = await open(path, 'r');
      try {
        const scores = await scoresFromStream(handle, stride, { framesPerChunk: perChunk });
        assert.deepEqual(scores, expected, `framesPerChunk=${perChunk} 时结果变了`);
      } finally {
        await handle.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
