/**
 * cache.test.mjs —— 扫描缓存的键与读回。
 *
 * 两个曾经真实发生过的坑，各钉一条：
 *   1. 键里漏掉分析尺寸/块参数 → 改了 `longSide` 却读到旧结果；
 *   2. `readCache` 不返回 `area` → 写了缓存但永远读不回来，"缓存"形同虚设。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { cacheKey, readCache, writeCache } from '../lib/cache.js';

const BASE = { input: 'C:/media/a.mp4', size: 1234, mtimeMs: 1700000000000, scanFps: 10, width: 120, height: 68, block: 4, threshold: 8 };

test('缓存键带上了全部分析口径', () => {
  const base = cacheKey(BASE);
  assert.notEqual(cacheKey({ ...BASE, width: 160, height: 90 }), base, '改分析尺寸必须变键');
  assert.notEqual(cacheKey({ ...BASE, block: 8 }), base, '改方块边长必须变键');
  assert.notEqual(cacheKey({ ...BASE, threshold: 12 }), base, '改块阈值必须变键');
  assert.notEqual(cacheKey({ ...BASE, scanFps: 20 }), cacheKey(BASE), '改分析帧率必须变键');
  assert.equal(cacheKey({ ...BASE }), base, '同样的输入必须给同样的键');
});

test('写进去的 area 能原样读回来（否则缓存永不命中）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vu-cache-'));
  try {
    const key = cacheKey(BASE);
    const area = [0, 0.1, 0.2, 0.3];
    await writeCache(dir, key, { area, scores: [0, 1, 2, 3], luma: [10, 20, 30, 40], scanFps: 10, duration: 0.4 });
    const hit = await readCache(dir, key);
    assert.ok(hit !== null, '应当命中');
    assert.deepEqual(hit.area, area);
    assert.equal(hit.scanFps, 10);

    const miss = await readCache(dir, cacheKey({ ...BASE, width: 160, height: 90 }));
    assert.equal(miss, null, '改了分析尺寸就不该命中');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('没有 area 的旧缓存不会被当成命中', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vu-cache2-'));
  try {
    const key = cacheKey(BASE);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, `${key}.json`), JSON.stringify({ v: 2, scores: [0, 1, 2], scanFps: 10 }), 'utf8');
    assert.equal(await readCache(dir, key), null, '只有 scores 没有 area 的老格式必须重算');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
