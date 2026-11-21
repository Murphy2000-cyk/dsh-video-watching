/**
 * cache.js —— 把"整段解码算出来的逐帧变化分"存下来。
 *
 * 扫描是整条链路里唯一必需做全片解码的一步（90 分钟的片子要跑几分钟），
 * 而同一部片子通常会被问好几次，所以缓存不是优化而是必需。
 *
 * 失效判据用 路径 + 大小 + 修改时间 + 分析帧率：改了文件就自动重算，
 * 不需要用户手动清缓存。
 *
 * @module dsh-video-watching/cache
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 缓存格式版本：改了打分算法就把它加一，老缓存自动失效。 */
const CACHE_VERSION = 2;

/**
 * 算缓存键。
 *
 * @param params - 参数。
 * @returns 十六进制键。
 */
export function cacheKey(params) {
  const { input, size, mtimeMs, scanFps, width, height, block, threshold } = params;
  // 键里必须带上**全部分析口径**：只改分析尺寸或块阈值时，旧分数不能复用，
  // 否则会出现"改了 longSide 但结果一点没变"的假象。
  return createHash('sha1')
    .update(`${CACHE_VERSION}|${input}|${size}|${Math.round(mtimeMs)}|${scanFps}|${width ?? ''}x${height ?? ''}|${block ?? ''}|${threshold ?? ''}`)
    .digest('hex');
}

/**
 * 读缓存。
 *
 * 任何异常都当成"没有缓存"：缓存坏了最多重算一次，不该让整次调用失败。
 *
 * @param cacheDir - 缓存目录。
 * @param key - 键。
 * @returns `{ scores, scanFps, duration }` 或 `null`。
 */
export async function readCache(cacheDir, key) {
  try {
    const raw = await readFile(join(cacheDir, `${key}.json`), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.v !== CACHE_VERSION) return null;
    // `area` 是当前算法真正要用的量；只写不读就等于缓存永远不命中。
    const area = Array.isArray(parsed.area) ? parsed.area : null;
    if (area === null || area.length === 0) return null;
    return {
      area,
      scores: Array.isArray(parsed.scores) ? parsed.scores : [],
      luma: Array.isArray(parsed.luma) ? parsed.luma : [],
      scanFps: parsed.scanFps,
      duration: parsed.duration,
    };
  } catch {
    return null;
  }
}

/**
 * 写缓存。写失败不算错：下次重算而已。
 *
 * @param cacheDir - 缓存目录。
 * @param key - 键。
 * @param payload - 内容。
 */
export async function writeCache(cacheDir, key, payload, options = {}) {
  try {
    const path = join(cacheDir, `${key}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ v: CACHE_VERSION, ...payload }), 'utf8');
    const max = Number(options.maxEntries);
    if (Number.isFinite(max) && max > 0) await pruneCache(cacheDir, max);
    return path;
  } catch {
    return null;
  }
}

/**
 * 把缓存目录压到最多 `maxEntries` 个文件，超出时按"最久没被用过"淘汰。
 *
 * 为什么要有上限：一个片子的缓存是 6–95 KB，看着小，但它是**只增不减**的
 * （没有 TTL、指纹不变就永远留着）。跑几十上百支片子之后会无声地堆起来。
 *
 * 淘汰只看 mtime：读缓存不会刷新 mtime（`readFile` 不动它），
 * 所以这里其实是"最久没写过的先走"，对一次性片子足够；真按热度淘汰要额外记账，不值。
 *
 * @param cacheDir - 缓存目录。
 * @param maxEntries - 最多保留几个文件。
 * @returns 被删掉的文件名数组（失败时为空数组）。
 */
export async function pruneCache(cacheDir, maxEntries) {
  const limit = Math.max(1, Math.floor(Number(maxEntries) || 0));
  try {
    const names = (await readdir(cacheDir)).filter((name) => name.endsWith('.json'));
    if (names.length <= limit) return [];
    const entries = [];
    for (const name of names) {
      try {
        const info = await stat(join(cacheDir, name));
        entries.push({ name, mtimeMs: info.mtimeMs });
      } catch {
        /* 拿不到时间的先不动它 */
      }
    }
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
    const victims = entries.slice(0, Math.max(0, entries.length - limit));
    const removed = [];
    for (const victim of victims) {
      try {
        await unlink(join(cacheDir, victim.name));
        removed.push(victim.name);
      } catch {
        /* 删不掉就算了，下次再试 */
      }
    }
    return removed;
  } catch {
    return [];
  }
}
