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

  const tokens = value.sheets.reduce((sum, sheet) => sum + sheet.tokens, 0);
  lines.push(`<cost>${value.sheets.length} image(s) over ${value.plan.count} frames ≈ ${tokens} vision tokens. ` +
    'A cell too small to read: call video_closeup with that timestamp.</cost>');
  if (value.skipped > 0) lines.push(`<skipped>${value.skipped} frame(s) could not be extracted and are absent from the sheets.</skipped>`);

  const blocks = [{ type: 'text', text: lines.join('\n') }];
  for (const sheet of value.sheets) blocks.push({ type: 'image', attachment: { ...sheet.image } });
  return blocks;
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
