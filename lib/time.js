/**
 * time.js —— 时间码与字幕的纯函数层。
 *
 * 这一层不碰文件、不碰进程：所有"算错了也不报错、只会安静给出错时间"的地方都在这里，
 * 所以它能被单测钉死。
 *
 * @module dsh-video-watching/time
 */

/** 一帧在时间轴上的呈现精度：毫秒。 */
const MS = 1000;

/**
 * 把 `12` / `"12.5"` / `"01:30"` / `"1:02:03.5"` 解析成秒。
 * 认不出来一律返回 `null`，绝不猜。
 *
 * @param value - 待解析的值。
 * @returns 秒数，或 `null`。
 */
export function parseSeconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  let total = 0;
  for (const part of parts) {
    if (!/^\d+(\.\d+)?$/.test(part.trim())) return null;
    total = total * 60 + Number(part);
  }
  return total;
}

/**
 * 格式化成 `M:SS.mmm`，给清单用。
 *
 * @param seconds - 秒数（负数按 0 处理）。
 * @returns 形如 `1:05.500` 的字符串。
 */
export function formatClock(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  const whole = Math.floor(rest);
  const millis = Math.round((rest - whole) * MS);
  // 四舍五入到 1000ms 时要进位，否则会写出 `1:05.1000` 这种不合法的串。
  if (millis >= MS) return formatClock(safe + 0.001);
  return `${minutes}:${String(whole).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/**
 * 格式化成 `MM:SS`，给烧进画面的小字用（短、易懂、格子小也读得清）。
 *
 * @param seconds - 秒数。
 * @returns 形如 `01:05` 的字符串。
 */
export function formatShort(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const rest = Math.floor(safe - minutes * 60);
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * 把 `00:00:01,200` 这类字幕时间戳解析成秒。
 *
 * @param text - 时间戳。
 * @returns 秒数，或 `null`。
 */
function parseStamp(text) {
  const cleaned = String(text ?? '').trim().replace(',', '.');
  if (cleaned === '') return null;
  const parts = cleaned.split(':');
  if (parts.length < 1 || parts.length > 3) return null;
  let total = 0;
  for (const part of parts) {
    const number = Number(part.trim());
    if (!Number.isFinite(number)) return null;
    total = total * 60 + number;
  }
  return Number.isFinite(total) ? total : null;
}

/**
 * 去掉字幕里的排版标签：`<i>`、`{\an8}`、`<c.yellow>` 等。
 *
 * @param text - 原始行。
 * @returns 纯文本。
 */
function stripTags(text) {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * 解析 SRT / WebVTT 正文。
 *
 * @param text - 字幕全文。
 * @returns 字幕条目数组，每条 `{ start, end, text }`。
 */
function parseCueBlocks(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const cues = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.includes('-->')) {
      index += 1;
      continue;
    }
    const [left, right] = line.split('-->');
    const start = parseStamp(left);
    // 右侧可能带 `align:start position:0%` 之类的设置，取第一个空白前的部分。
    const end = parseStamp((right ?? '').trim().split(/\s+/)[0] ?? '');
    if (start === null || end === null) {
      index += 1;
      continue;
    }
    const body = [];
    index += 1;
    while (index < lines.length && lines[index].trim() !== '') {
      body.push(lines[index]);
      index += 1;
    }
    const content = stripTags(body.join(' ').replace(/\s+/g, ' '));
    if (content !== '') cues.push({ start, end: Math.max(start, end), text: content });
    index += 1;
  }
  return cues;
}

/**
 * 解析 JSON 形态的逐字稿：既认 `[{start,end,text}]`，也认 whisper 的 `{segments:[...]}`。
 *
 * @param text - JSON 全文。
 * @returns 字幕条目数组，或 `null`（不是可识别结构）。
 */
function parseJsonTranscript(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.segments)
      ? parsed.segments
      : Array.isArray(parsed?.cues)
        ? parsed.cues
        : null;
  if (list === null) return null;
  const cues = [];
  for (const item of list) {
    const start = parseStamp(item?.start ?? item?.begin ?? item?.s ?? '');
    const end = parseStamp(item?.end ?? item?.e ?? '');
    const content = stripTags(String(item?.text ?? item?.line ?? ''));
    if (start === null || content === '') continue;
    cues.push({ start, end: end === null ? start : Math.max(start, end), text: content });
  }
  return cues;
}

/**
 * 解析一份字幕文件的内容。格式按内容判定，不按扩展名。
 *
 * @param text - 文件全文。
 * @returns 字幕条目数组（可能为空），或 `null`（无法识别）。
 */
export function parseTranscript(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const head = text.trimStart();
  let cues = null;
  if (head.startsWith('[') || head.startsWith('{')) cues = parseJsonTranscript(text);
  if (cues === null && text.includes('-->')) cues = parseCueBlocks(text);
  if (cues === null) return null;
  // 时间轴必须按时间排。多路合一的字幕、手工改过的 SRT、部分 ASR 输出都不保证顺序，
  // 而模型读的是"时间线"：顺序错了会把先后说反，还看不出来。
  return cues.sort((left, right) => left.start - right.start);
}

/**
 * 取与 `[from, to]` 有交集的字幕条目。
 *
 * 判定用"重叠"而不是"起点落在区间内"：一句话常常从上一段末尾开始，
 * 按起点判会把它的前半段整条丢掉。
 *
 * @param cues - 字幕条目。
 * @param from - 区间起点（秒）。
 * @param to - 区间终点（秒）。
 * @returns 交集条目。
 */
export function sliceTranscript(cues, from, to) {
  if (!Array.isArray(cues) || cues.length === 0) return [];
  const start = Math.max(0, Number(from) || 0);
  const end = Number.isFinite(to) ? to : Number.POSITIVE_INFINITY;
  return cues.filter((cue) => cue.end >= start && cue.start <= end);
}

/**
 * 把字幕压成清单行。
 *
 * @param cues - 字幕条目。
 * @param options - 选项。
 * @param options.maxLines - 最多几行，默认 40。
 * @param options.maxChars - 每行最多几个字，默认 120。
 * @returns 文本行数组。
 */
export function formatTranscriptLines(cues, options = {}) {
  const maxLines = Math.max(1, Math.floor(options.maxLines ?? 40));
  const maxChars = Math.max(20, Math.floor(options.maxChars ?? 120));
  if (!Array.isArray(cues) || cues.length === 0) return [];
  const stride = Math.max(1, Math.ceil(cues.length / maxLines));
  const lines = [];
  for (let index = 0; index < cues.length; index += stride) {
    const cue = cues[index];
    const head = `[${formatClock(cue.start)}]`;
    let body = cue.text;
    if (body.length > maxChars) body = `${body.slice(0, maxChars - 1)}…`;
    lines.push(`${head} ${body}`);
  }
  return lines;
}
