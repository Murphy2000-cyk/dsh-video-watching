/**
 * render.js —— 把工具返回值渲染成模型看到的内容块。
 *
 * 纯函数，不碰 IO：一个值进去，一段文本 + 若干图片出来。
 *
 * @module dsh-video-watching/render
 */

import { formatClock } from './time.js';
import { densityLine, fmtSeconds } from './util.js';

/**
 * 计划结果里的三行风险提示：没看全、密度被改过、间隔失守。
 *
 * 这三件事只存在于字段里时，模型看到 `batchDone=true` 就会以为"整片看完了"。
 * 所以必须写进正文，并说清后果。
 *
 * @param plan - 返回值里的 `plan`。
 * @returns 文本行数组；没有问题时不产生任何行。
 */
export function budgetLines(plan) {
  if (plan === undefined || plan === null) return [];
  const lines = [];

  if (plan.videoComplete === false) {
    lines.push(
      `<coverage videoComplete="false" to="${formatClock(plan.coveredTo)}" unseen="${Number(plan.unseenSeconds ?? 0).toFixed(1)}s" ` +
        `total="${formatClock(plan.to)}">The approved plan stops here: everything after ${formatClock(plan.coveredTo)} was NOT watched. ` +
        'Say so explicitly and do not describe the unseen part.</coverage>',
    );
  }

  if (plan.thinned) {
    lines.push(
      `<density-changed thinned="true" a="${plan.a}" aEff="${plan.aEff}" t="${plan.t}" scale="${plan.scale}">` +
        'a and t were raised so full coverage fits the budget; coverage is complete but sparser than the mode.</density-changed>',
    );
  }

  if (plan.maxGapBroken) {
    lines.push(
      `<gap broken="true" promised="${plan.maxGap}s" actual="${plan.maxIntervalSeconds}s">` +
        'Some stretch is covered by frames further apart than maxGap; it is not a silent omission.</gap>',
    );
  }

  return lines;
}

/**
 * 预算块：够不够、差多少。
 *
 * @param budget - `value.budget`。
 * @returns 一行文本；没有预算块时返回 null。
 */
export function budgetLine(budget) {
  if (budget === undefined || budget === null) return null;
  return (
    `<budget required="${budget.required}" minimum="${budget.minimum}" max="${budget.max}" feasible="${budget.feasible}" ` +
    `sheets="${budget.sheets}" tokens="${budget.tokens}" coveredTo="${formatClock(budget.coveredTo)}" ` +
    `unseen="${Number(budget.unseenSeconds ?? 0).toFixed(1)}s" batches="${budget.batches}"/>`
  );
}

/**
 * 一条候选方案：数字要能被直接念给用户听。
 *
 * @param option - `value.options` 的项。
 * @returns 一行文本。
 */
export function optionLine(option) {
  const coverage =
    Number(option.unseenSeconds) > 0
      ? `covers to ${formatClock(option.coveredTo)}, ${Number(option.unseenSeconds).toFixed(0)}s unseen`
      : 'full coverage';
  const flag =
    option.recommended === true ? '  [recommended]' : option.feasible === false ? '  [still over budget]' : '';
  return `  ${String(option.id).padEnd(10)} ${String(option.sheets).padStart(4)} sheets  ${coverage}  a=${option.a} t=${option.t}  budget=${option.budget}${flag}`;
}

/**
 * 生效采样口径一行。
 *
 * 采样参数不在工具 schema 里（模型改不了），所以模型只能从这一行知道"这次按什么口径
 * 在跑"：`a` 会被预算抬成 `aEff`，`scale` 是抬了几倍。没有这一行，模型只能看到
 * `mean="13.7/s"` 这种派生量，很容易把 `a` 误读成"每秒几张"。
 *
 * @param plan - 返回值里的 `plan`。
 * @returns 一行文本；字段缺失时返回 null。
 */
export function samplingLine(plan) {
  if (plan === undefined || plan === null || plan.a === undefined) return null;
  return (
    `<sampling a="${plan.a}" aEff="${plan.aEff}" t="${plan.t}" maxGap="${plan.maxGap}" multiCross="${plan.multiCross}" ` +
    `cutPair="${plan.cutPair}" maxSheets="${plan.maxSheets}" mode="${plan.mode}" scale="${plan.scale}">` +
    'Effective sampling for this run, fixed before watching: a = screens of accumulated change per frame (bigger a = fewer frames), ' +
    'aEff = the a actually used when the budget forced a sparser pass, t = window that picks the grid, maxSheets = images per batch ' +
    '(batching only, it does not change the total budget). No tool parameter changes these; a profile setting can.</sampling>'
  );
}

/**
 * `video_watch` 的内容块：一段钉死"第几格 = 第几秒"的文本 + N 张图片。
 *
 * @param value - 工具返回值。
 * @returns 内容块数组。
 */
export function renderWatch(value) {
  const range = value.batch;
  const runs =
    range === undefined
      ? value.density
      : value.density.filter((run) => run.to > range.from - 1e-9 && run.from < range.to + 1e-9);
  const lines = [
    `<path>${value.path}</path>`,
    '<type>video</type>',
    `<content>${value.durationSeconds} s, source ${value.sourceWidth}x${value.sourceHeight} px, ` +
      `${value.plan.count} frames sampled over ${value.plan.from.toFixed(1)}-${value.plan.to.toFixed(1)} s, ` +
      `${value.plan.cuts} cuts, audio ${value.hasAudio ? 'present' : 'none'}, transcript ${value.transcript.source}</content>`,
    '<density>',
    ...(runs.length === 0 ? ['  (this batch has no density runs)'] : runs.map(densityLine)),
    '</density>',
    ...budgetLines(value.plan),
    samplingLine(value.plan),
  ].filter((line) => line !== null && line !== undefined);

  for (const sheet of value.sheets) {
    const cells = value.frames.filter((frame) => frame.sheet === sheet.sheet);
    const title = sheet.title === undefined ? '' : ` title="${sheet.title}"`;
    lines.push(
      `<sheet index="${sheet.sheet}" global="${sheet.global}" from="${formatClock(sheet.from)}" to="${formatClock(sheet.to)}"${title} grid="${sheet.cols}x${sheet.rows}">`,
    );
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

  if (value.batch !== undefined) {
    const b = value.batch;
    const complete = value.plan.videoComplete !== false;
    lines.push(
      `<batch index="${b.index}" total="${b.total}" size="${b.size}" sheets="${b.sheets}" ` +
        `from="${formatClock(b.from)}" to="${formatClock(b.to)}" next="${b.next}" batchDone="${b.batchDone}" videoComplete="${complete}"/>`,
    );
    if (typeof value.record === 'string' && value.record !== '') lines.push(`<record path="${value.record}"/>`);
    if (!b.batchDone) {
      lines.push(
        `<next>This is batch ${b.index} of ${b.total}. Write its record entry now with video_note (planId="${value.planId}", batch=${b.index}): ` +
          'open with 观看情况, give the time-coded detail that a reader could cut the same sequence from, close with 总结. ' +
          'The next batch is refused until this entry exists. Then call video_watch again with ' +
          `planId="${value.planId}" and batch=${b.next} in this same conversation so the context stays continuous; do not fetch every batch at once.</next>`,
      );
    } else if (!complete) {
      lines.push(
        `<next>This was the last planned batch, but the video was NOT watched to the end (see <coverage>). Call video_note for batch ${b.index}, ` +
          'say so explicitly in both 观看情况 and 总结, and do not describe the unseen part.</next>',
      );
    } else {
      lines.push(
        `<next>This was the last batch. Call video_note for batch ${b.index}: this entry closes with 总结 for the whole video, not just the batch. ` +
          'Then deliver the summary.</next>',
      );
    }
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
    samplingLine(value.plan),
    ...budgetLines(value.plan),
    '<density>',
    ...value.density.map(densityLine),
    '</density>',
  ].filter((line) => line !== null && line !== undefined);

  const budget = budgetLine(value.budget);
  if (budget !== null) lines.push(budget);

  if (Array.isArray(value.options) && value.options.length > 0) {
    lines.push('<options>');
    for (const option of value.options) lines.push(optionLine(option));
    lines.push('</options>');
  }

  if (typeof value.planId === 'string' && value.planId !== '') {
    lines.push(`<plan-id>${value.planId}</plan-id>`);
    if (typeof value.record === 'string' && value.record !== '') lines.push(`<record path="${value.record}"/>`);
    lines.push(
      `<next>Plan is fixed: call video_watch with planId="${value.planId}" and batch=1, then batch.next. ` +
        'The budget and the density are already decided - watch will not change them.</next>',
    );
  } else if (value.budget !== undefined) {
    lines.push(
      `<next>This budget is NOT enough to watch all of it: ${value.budget.required} sheets are needed, the max is ${value.budget.max}. ` +
        'Tell the user the options above with their numbers and ask which one to take, then call video_plan again with ' +
        'choice={"id":"<option>"} (add "budget" for a one-off number). Do NOT call video_watch yet: it has no planId.</next>',
    );
  }

  lines.push(`<cost>${value.estimate.sheets} image(s) ≈ ${value.estimate.tokens} vision tokens. Nothing was returned as an image here.</cost>`);
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * `video_note` 的内容块：只是一段确认，没有图片。
 *
 * @param value - 工具返回值。
 * @returns 内容块数组。
 */
export function renderNote(value) {
  const lines = [
    `<path>${value.path}</path>`,
    `<type>video-note</type>`,
    `<record batch="${value.batch}" bytes="${value.bytes}" mode="${value.appended ? 'appended' : 'filled'}"/>`,
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
