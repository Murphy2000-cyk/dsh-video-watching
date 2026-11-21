/**
 * render.js —— 把工具返回值渲染成模型看到的内容块。
 *
 * 纯函数，不碰 IO：一个值进去，一段文本 + 若干图片出来。
 *
 * @module dsh-video-understanding/render
 */

import { formatClock } from './time.js';
import { densityLine, fmtSeconds } from './util.js';

/**
 * `video_watch` 的内容块：一段钉死"第几格 = 第几秒"的文本 + N 张图片。
 *
 * @param value - 工具返回值。
 * @returns 内容块数组。
 */
export function renderWatch(value) {
  const lines = [
    `<path>${value.path}</path>`,
    '<type>video</type>',
    `<content>${value.durationSeconds} s, source ${value.sourceWidth}x${value.sourceHeight} px, ` +
      `${value.plan.count} frames sampled over ${value.plan.from.toFixed(1)}-${value.plan.to.toFixed(1)} s, ` +
      `${value.plan.cuts} cuts, audio ${value.hasAudio ? 'present' : 'none'}, transcript ${value.transcript.source}</content>`,
    '<density>',
    ...value.density.map(densityLine),
    '</density>',
  ];

  for (const sheet of value.sheets) {
    const cells = value.frames.filter((frame) => frame.sheet === sheet.sheet);
    lines.push(`<sheet index="${sheet.sheet}" grid="${sheet.cols}x${sheet.rows}">`);
    lines.push('  Cells read left to right, then top to bottom. Empty trailing cells are padding, not video.');
    for (const cell of cells) lines.push(`  cell ${cell.cell} = ${cell.label}`);
    lines.push('</sheet>');
  }

  if (value.transcript.lines.length > 0) {
    lines.push(`<transcript source="${value.transcript.source}">`);
    for (const line of value.transcript.lines) lines.push(`  [${formatClock(line.start)}] ${line.text}`);
    lines.push('</transcript>');
  }

  lines.push(...renderAudio(value.audio));

  const tokens = value.sheets.reduce((sum, sheet) => sum + sheet.tokens, 0);
  lines.push(`<cost>${value.sheets.length} image(s) over ${value.plan.count} frames ≈ ${tokens} vision tokens. ` +
    'A cell too small to read: call video_closeup with that timestamp.</cost>');
  if (value.skipped > 0) lines.push(`<skipped>${value.skipped} frame(s) could not be extracted and are absent from the sheets.</skipped>`);

  const blocks = [{ type: 'text', text: lines.join('\n') }];
  for (const sheet of value.sheets) blocks.push({ type: 'image', attachment: { ...sheet.image } });
  return blocks;
}

/**
 * 把音频分析结果渲染成文本行。
 *
 * 三个原则：
 *   - 状态与原因必须写出来，不能因为"没分析"就让模型误以为"没有声音"；
 *   - 语音只给前若干句（时间码 + 文本），完整清单在返回值里；
 *   - BGM 给逐片标签 + 变化点 + 检索词，`searchWords` 就是"找相似 BGM"的查询词。
 *
 * @param audio - `value.audio`。
 * @returns 文本行数组。
 */
export function renderAudio(audio) {
  if (audio === undefined || audio === null) return [];
  const lines = [];
  const notes = Array.isArray(audio.notes) ? audio.notes : [];
  lines.push(`<audio status="${audio.status}">`);

  const speech = audio.speech ?? { status: 'off', source: '', count: 0, lines: [] };
  lines.push(`  <speech status="${speech.status}" source="${speech.source}" lines="${speech.count}">`);
  if (speech.status === 'unavailable') lines.push('    Local transcription is unavailable; absence of speech below is NOT evidence of silence.');
  for (const line of (speech.lines ?? []).slice(0, 40)) {
    lines.push(`    [${formatClock(line.start)}-${formatClock(line.end)}] ${line.text}`);
  }
  if ((speech.lines ?? []).length > 40) lines.push(`    ... ${speech.lines.length - 40} more line(s) in the result value`);
  lines.push('  </speech>');

  const bgm = audio.bgm ?? null;
  if (bgm === null) {
    lines.push('  <bgm status="off" />');
  } else {
    lines.push(`  <bgm status="${bgm.status}" model="${bgm.model}" chunks="${bgm.chunks}" sampled="${bgm.sampled}">`);
    if (bgm.status === 'unavailable') lines.push('    BGM was NOT analysed; do not read this as "no music".');
    for (const segment of (bgm.segments ?? []).slice(0, 12)) {
      const tag = segment.music === 'none' ? 'no music' : `${segment.music} / ${segment.style} / ${segment.tempo}${segment.musicMood === '' ? '' : ` / ${segment.musicMood}`}`;
      const extra = segment.characteristics === '' ? '' : `  — ${segment.characteristics}`;
      lines.push(`    ${formatClock(segment.from)}-${formatClock(segment.to)}  ${tag}${extra}`);
    }
    if ((bgm.segments ?? []).length > 12) lines.push(`    ... ${bgm.segments.length - 12} more segment(s) in the result value`);
    for (const change of (bgm.changes ?? []).slice(0, 6)) {
      lines.push(`    change at ${formatClock(change.at)}: ${change.from} → ${change.to}`);
    }
    if ((bgm.searchWords ?? []).length > 0) lines.push(`    search words for a similar track: ${bgm.searchWords.join(', ')}`);
    if ((bgm.sfx ?? []).length > 0) lines.push(`    sound effects: ${bgm.sfx.join(', ')}`);
    lines.push('  </bgm>');
  }

  for (const note of notes.slice(0, 6)) lines.push(`  <note>${note}</note>`);
  lines.push('</audio>');
  return lines;
}

/**
 * `video_plan` 的内容块：纯文本，零图片。
 *
 * @param value - 工具返回值。
 * @returns 内容块数组。
 */
export function renderPlan(value) {
  const lines = [
    `<path>${value.path}</path>`,
    '<type>video-plan</type>',
    `<content>${value.durationSeconds} s, ${value.sourceWidth}x${value.sourceHeight} px @ ${value.fps} fps, ` +
      `audio ${value.hasAudio ? 'present' : 'none'}, ${value.subtitleTracks} subtitle track(s)</content>`,
    `<scan frames="${value.scan.frames}" fps="${value.scan.fps}" seconds="${value.scan.seconds}" cached="${value.scan.cached}"/>`,
    `<plan frames="${value.plan.count}" cuts="${value.plan.cuts}" snapped="${value.plan.cutHits}" ` +
      `mean="${fmtSeconds(value.plan.meanIntervalSeconds)}" min="${fmtSeconds(value.plan.minIntervalSeconds)}" ` +
      `max="${fmtSeconds(value.plan.maxIntervalSeconds)}" scale="${value.plan.scale}"/>`,
    '<density>',
    ...value.density.map(densityLine),
    '</density>',
    `<cost>${value.estimate.sheets} image(s) ≈ ${value.estimate.tokens} vision tokens. Nothing was returned as an image here.</cost>`,
  ];
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * `video_closeup` 的内容块。
 *
 * @param value - 工具返回值。
 * @returns 内容块数组。
 */
export function renderCloseup(value) {
  const lines = [
    `<path>${value.path}</path>`,
    '<type>video-closeup</type>',
    `<content>${value.durationSeconds} s, source ${value.sourceWidth}x${value.sourceHeight} px</content>`,
    '<frames>',
    ...value.frames.map((frame, index) => `  image ${index + 1} = ${frame.label} (${frame.width}x${frame.height})`),
    '</frames>',
  ];
  const blocks = [{ type: 'text', text: lines.join('\n') }];
  for (const frame of value.frames) blocks.push({ type: 'image', attachment: { ...frame.image } });
  return blocks;
}
