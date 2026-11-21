/**
 * record.js —— 把"看过的东西"落成一份 Markdown 文档。
 *
 * 为什么要落盘：分批评测是逐批进行的，模型每看一批就总结一次，但总结只留在会话里，
 * 片长一过就散了。这里把**可测量的事实**（批次时间、每张图的组成、子图时间码、
 * 语音、BGM）由插件自己写进文档，模型的分析（内容、剪辑手法、风格、动画做法）
 * 由 `video_note` 补进去 —— 两类信息都不经过模型转述，所以不会失真。
 *
 * 文档按视频命名（`<文件名>.观看记录.md`），默认放桌面；同一部片子换计划再跑时
 * 追加"新一轮分析"，不覆盖旧记录。
 *
 * @module dsh-video-watching/record
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { formatClock } from './time.js';

/** 模式的中文名：写进文档给人看，工具参数里仍然是 analysis / understand。 */
const MODE_LABEL = { analysis: '视频解析', understand: '视频理解' };

/**
 * 记录文档的路径：`<记录目录>/<视频名>.观看记录.md`。
 *
 * @param cfg - 归一化配置（只用 recordDir）。
 * @param input - 视频路径。
 * @returns 绝对路径。
 */
export function recordPathOf(cfg, input) {
  const stem = basename(String(input ?? ''), extname(String(input ?? '')));
  return join(cfg.recordDir, `${stem === '' ? 'video' : stem}.观看记录.md`);
}

/**
 * 本批分析在文档里的占位标记。
 *
 * 带 `planId`：同一部片子跑过两轮时，两轮的"批次 1"不会互相覆盖。
 *
 * @param planId - 计划 id。
 * @param batch - 批次号。
 * @returns 唯一的占位串。
 */
export function analysisMarker(planId, batch) {
  return `<!-- 待补分析 ${planId} 批次 ${batch} -->`;
}

/**
 * 写/接续文档头：视频规格、计划、预算、批次总数。
 *
 * 不单独调：第一次 `appendBatch` 时按 `planId` 惰性补。计划定稿后如果没看就放弃，
 * 桌面上不会留下一个只有表头的空文件；真正看过之后表头才出现。
 *
 * 已经存在（上一轮分析留下的）就追加"新一轮分析"，不覆盖旧内容。
 *
 * @param params - 参数。
 * @returns 文档路径；`record: false` 时返回 null。
 */
export async function ensureHeader(params) {
  const { cfg, input, probe, plan, planId, snapshot } = params;
  if (cfg.record !== true) return null;
  const path = recordPathOf(cfg, input);
  await mkdir(cfg.recordDir, { recursive: true });

  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    /* 首次分析，文件还不存在 */
  }
  if (existing.includes(`\`${planId}\``)) return path;

  const header = headerBlock({ input, probe, plan, planId, snapshot });
  if (existing.trim() === '') {
    await writeFile(path, header, 'utf8');
  } else {
    await appendFile(path, `\n---\n\n${header.replace(/^# .*\n\n/, `## 新一轮分析 · ${stamp()}\n\n`)}`, 'utf8');
  }
  return path;
}

/**
 * 文档头正文。
 *
 * @param params - 参数。
 * @returns Markdown 片段。
 */
function headerBlock(params) {
  const { input, probe, plan, planId, snapshot } = params;
  const stats = plan.stats;
  return [
    `# ${basename(String(input))} · 观看记录`,
    '',
    `- 视频：\`${input}\``,
    `- 规格：${Number(probe.duration).toFixed(2)} 秒 · ${probe.width}×${probe.height} · ${Number(probe.fps).toFixed(0)} fps · ` +
      `${probe.hasAudio ? '有音轨' : '无音轨'} · ${probe.subtitleTracks.length} 条字幕轨`,
    `- 计划：\`${planId}\` · 模式 ${MODE_LABEL[snapshot.mode] ?? snapshot.mode} · a=${snapshot.a} t=${snapshot.t}s · ` +
      `每批最多 ${snapshot.maxSheets} 张`,
    `- 预算：${stats.sheets} 张图 ≈ ${stats.sheets * 384} tokens · 覆盖 ${formatClock(stats.from)}–${formatClock(stats.to)} · ` +
      `共 ${stats.batches} 批`,
    `- 记录时间：${stamp()}`,
    '',
  ].join('\n');
}

/**
 * 追加一个批次的记录。
 *
 * 结构固定：时间与图片组成（可测量）→ 语音 → BGM → 本批分析占位。
 *
 * @param params - 参数。
 * @returns 文档路径；`record: false` 时返回 null。
 */
export async function appendBatch(params) {
  const { cfg, input, planId, batch, sheets, cellsBySheet, transcript, audio, skipped, frames, probe, plan, snapshot } = params;
  if (cfg.record !== true) return null;
  const path = await ensureHeader({ cfg, input, probe, plan, planId, snapshot });

  const lines = [
    '',
    `## 批次 ${batch.index} / ${batch.total} · ${formatClock(batch.from)}–${formatClock(batch.to)}`,
    '',
    `- 图片：${sheets.length} 张 · 画面 ${frames} 幅 · 抽取失败 ${skipped} 幅`,
    '',
    '### 时间与图片组成',
    '',
  ];

  for (let index = 0; index < sheets.length; index += 1) {
    const sheet = sheets[index];
    lines.push(
      `- **图 ${sheet.sheet}**（全局 ${sheet.global}）${formatClock(sheet.start)}–${formatClock(sheet.end)} · ` +
        `${sheet.cols}×${sheet.rows} · ${sheet.cols * sheet.rows} 格 · ${sheet.tokens} tokens`,
    );
    const cells = cellsBySheet[index] ?? [];
    if (cells.length > 0) lines.push(`  - 子图时间：${cells.join('、')}`);
    if (typeof sheet.title === 'string' && sheet.title !== '') lines.push(`  - 台词：${sheet.title}`);
  }
  lines.push('');

  lines.push(...speechLines(audio));
  lines.push(...bgmLines(audio));

  if (Array.isArray(transcript?.lines) && transcript.lines.length > 0) {
    lines.push('### 字幕', '');
    for (const line of transcript.lines) lines.push(`- [${formatClock(line.start)}–${formatClock(line.end)}] ${line.text}`);
    lines.push('');
  }

  lines.push('### 内容 / 剪辑手法 / 风格 / 动画', '', analysisMarker(planId, batch.index), '');

  await appendFile(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

/**
 * 填一个占位：优先替换 `appendBatch` 留的标记，找不到就补一段"补记"。
 *
 * @param params - 参数。
 * @returns `{ path, bytes, appended }`。
 */
export async function writeAnalysis(params) {
  const { cfg, input, planId, batch, note } = params;
  if (cfg.record !== true) {
    throw new Error('recording is off (config record: false), so there is no markdown document to write to');
  }
  const body = String(note ?? '').trim();
  if (body === '') throw new Error('note must not be empty: pass your analysis of this batch');

  const path = recordPathOf(cfg, input);
  const marker = analysisMarker(planId, batch);
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`no record for this video at "${path}"; watch at least one batch before writing notes`);
  }

  const bytes = Buffer.byteLength(body, 'utf8');
  if (text.includes(marker)) {
    await writeFile(path, text.replace(marker, body), 'utf8');
    return { path, bytes, appended: false };
  }

  await appendFile(path, `\n## 批次 ${batch} 分析（补记）\n\n${body}\n`, 'utf8');
  return { path, bytes, appended: true };
}

/**
 * 语音段：状态要先说清，"没识别到"与"识别不可用"不能混。
 *
 * @param audio - `video_watch` 的 audio 值。
 * @returns 文本行。
 */
function speechLines(audio) {
  const speech = audio?.speech ?? { status: 'off', source: '', count: 0, lines: [] };
  const lines = ['### 语音', ''];
  if (speech.status === 'unavailable') {
    lines.push('- 本地语音识别不可用：本批是否有说话，**不能**从这一行推断。', '');
    return lines;
  }
  if (!Array.isArray(speech.lines) || speech.lines.length === 0) {
    lines.push('- 本批没有识别到人声。', '');
    return lines;
  }
  // 逐句识别偶尔会吐出一个孤零零的标点（实测有一个 "."），它不是台词。
  const spoken = speech.lines.filter((line) => /[\p{L}\p{N}]/u.test(String(line.text ?? '')));
  if (spoken.length === 0) {
    lines.push('- 本批没有识别到人声。', '');
    return lines;
  }
  for (const line of spoken) lines.push(`- [${formatClock(line.start)}–${formatClock(line.end)}] ${line.text}`);
  lines.push('');
  return lines;
}

/**
 * BGM 段：逐片标签、变化点、检索词、音效。
 *
 * @param audio - `video_watch` 的 audio 值。
 * @returns 文本行。
 */
function bgmLines(audio) {
  const bgm = audio?.bgm ?? null;
  const lines = ['### BGM', ''];
  if (bgm === null || bgm === undefined) {
    lines.push('- 未做音乐分析（`bgmMode: off` 或没有配置云端密钥）。', '');
    return lines;
  }
  if (bgm.status === 'unavailable') {
    lines.push('- BGM 未分析：本批有没有音乐，**不能**从这一行推断。', '');
    return lines;
  }
  for (const segment of bgm.segments ?? []) {
    const tag =
      segment.music === 'none'
        ? '无音乐'
        : `${segment.music} / ${segment.style} / ${segment.tempo}${segment.musicMood === '' ? '' : ` / ${segment.musicMood}`}`;
    const extra = segment.characteristics === '' ? '' : ` — ${segment.characteristics}`;
    lines.push(`- ${formatClock(segment.from)}–${formatClock(segment.to)} · ${tag}${extra}`);
  }
  for (const change of bgm.changes ?? []) lines.push(`- 变化点 ${formatClock(change.at)}：${change.from} → ${change.to}`);
  if ((bgm.sfx ?? []).length > 0) lines.push(`- 音效：${bgm.sfx.join('、')}`);
  if ((bgm.searchWords ?? []).length > 0) lines.push(`- 找相似曲目的检索词：${bgm.searchWords.join('、')}`);
  lines.push('');
  return lines;
}

/**
 * 本地时间戳（`2026-11-21 18:47`），用于文档头与"补记"。
 *
 * @param date - 时间，默认现在。
 * @returns 字符串。
 */
function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
