/**
 * plans.js —— 计划快照的落盘与校验。
 *
 * 为什么要快照：预算（`maxTotalSheets`）只在 `video_plan` 一步参与决策。定稿之后
 * `video_watch` 只执行，不再读预算配置。要守住这条界线，就得有一份"当时定下来的
 * 参数"作为凭据，而不是让 watch 拿当前配置重算一遍（配置在两步之间被改，计划就会漂移）。
 *
 * 快照小、可抛弃：放在扫描缓存旁边的 `plans/` 目录里，按 mtime 淘汰。
 * 文件被删也不致命，watch 会要求重新 plan。
 *
 * @module dsh-video-watching/plans
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** 快照格式版本：字段变了就加一，老快照自动失效。 */
export const PLAN_VERSION = 2;

/**
 * 参与哈希的字段，顺序固定。
 *
 * 只放"影响计划结果"的东西：文件指纹、采样口径、预算、方案、结果摘要。
 * `burn` / `transcriptFile` / 音频配置都不进来 —— 它们不影响计划，watch 每次可以换。
 */
const FIELDS = [
  'input',
  'size',
  'mtimeMs',
  'duration',
  'mode',
  'a',
  't',
  'maxGap',
  'multiCross',
  'cutPair',
  'maxSheets',
  'scanFps',
  'longSide',
  'block',
  'blockThreshold',
  'mode',
  'resolution',
  'limit',
  'sheets',
  'coveredTo',
  'createdAt',
];

/** 计划文件最多留几个，超了按 mtime 淘汰。 */
const PLAN_MAX_ENTRIES = 200;

/**
 * 把数值收成稳定的写法：浮点尾差不能进哈希，否则同一个计划会得到两个 id。
 *
 * @param value - 任意值。
 * @returns 稳定字符串。
 */
function stableValue(value) {
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : 'nan';
  return String(value ?? '');
}

/**
 * 算计划的 id。
 *
 * @param snapshot - 快照。
 * @returns 16 位十六进制 id。
 */
export function planIdOf(snapshot) {
  const parts = FIELDS.map((key) => stableValue(snapshot?.[key]));
  return createHash('sha1').update(`v${PLAN_VERSION}|${parts.join('|')}`).digest('hex').slice(0, 16);
}

/**
 * 路径比较：Windows 上大小写与分隔符都不敏感。
 *
 * @param left - 路径。
 * @param right - 路径。
 * @returns 是否同一个文件。
 */
function samePath(left, right) {
  const normalize = (value) => {
    const absolute = resolve(String(value ?? '')).replace(/\\/g, '/');
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  return normalize(left) === normalize(right);
}

/**
 * 校验一个 id 形状，防止拿它拼出目录穿越。
 *
 * @param id - 计划 id。
 * @returns 是否合法。
 */
function isPlanId(id) {
  return typeof id === 'string' && /^[0-9a-f]{16}$/.test(id);
}

/**
 * 保存快照，返回 id。
 *
 * 写失败不抛错：计划存不下来时 watch 会要求重新 plan，比整次调用失败温和。
 *
 * @param cacheDir - 缓存根目录。
 * @param snapshot - 快照。
 * @returns id；写失败返回 null。
 */
export async function savePlan(cacheDir, snapshot) {
  try {
    const id = planIdOf(snapshot);
    const dir = join(cacheDir, 'plans');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${id}.json`), JSON.stringify({ v: PLAN_VERSION, id, snapshot }), 'utf8');
    await prunePlans(dir);
    return id;
  } catch {
    return null;
  }
}

/**
 * 读回快照；不存在、版本不符、内容被改过都返回 null。
 *
 * @param cacheDir - 缓存根目录。
 * @param id - 计划 id。
 * @returns 快照或 null。
 */
export async function readPlan(cacheDir, id) {
  if (!isPlanId(id)) return null;
  try {
    const raw = await readFile(join(cacheDir, 'plans', `${id}.json`), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.v !== PLAN_VERSION) return null;
    if (parsed?.id !== id) return null;
    const snapshot = parsed?.snapshot;
    // 内容与 id 必须自洽：手改过的快照一律不认。
    if (planIdOf(snapshot) !== id) return null;
    return snapshot;
  } catch {
    return null;
  }
}

/**
 * 校验快照是否仍然适用于这次调用。
 *
 * 三类失效：换了一个文件、文件被改过、扫描口径被改过。
 * 预算与密度**不在**校验范围 —— 那是快照自己定的。
 *
 * @param snapshot - 快照。
 * @param params - 当前的输入与配置。
 * @returns 错误说明；没问题返回 null。
 */
export function verifyPlan(snapshot, params) {
  const { input, size, mtimeMs, cfg } = params;
  if (!samePath(snapshot?.input, input)) return `this plan is for "${snapshot?.input}", not "${input}"`;
  if (Math.round(Number(size)) !== Math.round(Number(snapshot?.size))) return 'the video file size changed since it was planned';
  if (Math.round(Number(mtimeMs)) !== Math.round(Number(snapshot?.mtimeMs))) return 'the video file was modified since it was planned';
  for (const key of ['scanFps', 'longSide', 'block', 'blockThreshold']) {
    if (Number(cfg?.[key]) !== Number(snapshot?.[key])) {
      return `scan setting "${key}" changed from ${snapshot?.[key]} to ${cfg?.[key]} since the plan was made`;
    }
  }
  return null;
}

/**
 * 按 mtime 淘汰旧计划。
 *
 * @param dir - `plans/` 目录。
 * @returns 删掉的文件名。
 */
export async function prunePlans(dir, maxEntries = PLAN_MAX_ENTRIES) {
  const limit = Math.max(1, Math.floor(Number(maxEntries) || PLAN_MAX_ENTRIES));
  try {
    const names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    if (names.length <= limit) return [];
    const entries = [];
    for (const name of names) {
      try {
        const info = await stat(join(dir, name));
        entries.push({ name, mtimeMs: info.mtimeMs });
      } catch {
        /* 拿不到时间的先不动 */
      }
    }
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
    const removed = [];
    for (const victim of entries.slice(0, Math.max(0, entries.length - limit))) {
      try {
        await unlink(join(dir, victim.name));
        removed.push(victim.name);
      } catch {
        /* 删不掉下次再试 */
      }
    }
    return removed;
  } catch {
    return [];
  }
}
