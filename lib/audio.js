/**
 * audio.js —— 音频分析：本地语音识别 + 云端 BGM/音效描述。
 *
 * 两条线各管一件事，互不依赖：
 *   - **语音**：本地 sherpa-onnx 跑 SenseVoice int8（CPU、0 显存、词级时间戳）。
 *     依赖找不到就如实说 unavailable，不静默降级成"没有台词"。
 *   - **BGM / 音效**：云端 qwen3.8-omni-flash，只描述风格与特征，不需要时间戳。
 *     时间轴由插件切片决定；"风格有没有变"由相邻片枚举比对得出，不问模型。
 *
 * 密钥只从环境变量读（默认 `DASHSCOPE_AUDIO_API_KEY`），本模块不写盘、不打印。
 *
 * 所有外部依赖（ffmpeg 命令、fetch、识别器）都可注入，纯函数部分可离线断言。
 *
 * @module dsh-video-understanding/audio
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 音乐有无的三档。 */
export const MUSIC_LEVELS = ['none', 'light', 'prominent'];
/** 曲风枚举：只认这几类，避免自由发挥导致"同一风格两个说法"。 */
export const MUSIC_STYLES = ['电子', '钢琴', '管弦', '民乐', '流行', '摇滚', '氛围', '其他'];
/** 速度枚举。 */
export const MUSIC_TEMPOS = ['慢', '中', '快'];
/** 情绪枚举。 */
export const MUSIC_MOODS = ['温暖', '冷静', '紧张', '欢快', '宏大', '怀旧', '其他'];

/** 送模型的分片长度（秒）。片长就是 BGM 变化点的时间精度。 */
export const DEFAULT_BGM_CHUNK_SECONDS = 30;
/** 单次分析最多送几片：超了就均匀抽样，并在结果里标注 sampled。 */
export const DEFAULT_BGM_MAX_CHUNKS = 24;
/** 本地语音的分片长度（秒）：太长显存/内存都会涨。 */
export const SPEECH_CHUNK_SECONDS = 60;
/** 送模型的提示词。要求只吐 JSON，枚举值写死。 */
export const BGM_PROMPT =
  '你只分析这段音频里的背景音乐与音效，不要描述人声内容。用 JSON 回答，不要多余文字：\n' +
  '{"music":"none|light|prominent","style":"电子|钢琴|管弦|民乐|流行|摇滚|氛围|其他",' +
  '"tempo":"慢|中|快","musicMood":"温暖|冷静|紧张|欢快|宏大|怀旧|其他",' +
  '"instruments":["听到的主要乐器，没有就空数组"],' +
  '"characteristics":"一句话描述听感特征",' +
  '"searchWords":["用来在素材库找相似 BGM 的检索词，3 到 5 个"],' +
  '"sfx":["听到的音效，没有就空数组"]}';

/* ------------------------------------------------------------------ *
 * 纯函数：分片计划
 * ------------------------------------------------------------------ */

/**
 * 把时间窗口切成若干片。
 *
 * 窗口内片数不超上限时连续切；超了就在整个窗口上均匀抽样，
 * 并返回被跳过的区间，让结果能如实说明"这几段没听"。
 *
 * @param params - 参数。
 * @param params.from - 起点（秒）。
 * @param params.to - 终点（秒）。
 * @param params.chunkSeconds - 片长（秒）。
 * @param params.maxChunks - 片数上限。
 * @returns `{ chunks, sampled, skipped }`。
 */
export function chunkPlan(params) {
  const from = Math.max(0, Number(params?.from) || 0);
  const to = Math.max(from, Number(params?.to) || from);
  const chunkSeconds = Math.max(1, Number(params?.chunkSeconds) || DEFAULT_BGM_CHUNK_SECONDS);
  const maxChunks = Math.max(1, Math.floor(Number(params?.maxChunks) || DEFAULT_BGM_MAX_CHUNKS));
  const total = to - from;
  if (total <= 0) return { chunks: [], sampled: false, skipped: [] };

  const needed = Math.max(1, Math.ceil(total / chunkSeconds));
  if (needed <= maxChunks) {
    const chunks = [];
    for (let start = from; start < to - 1e-9; start += chunkSeconds) {
      chunks.push({ from: round(start, 3), to: round(Math.min(to, start + chunkSeconds), 3) });
    }
    return { chunks, sampled: false, skipped: [] };
  }

  const step = total / maxChunks;
  const chunks = [];
  for (let index = 0; index < maxChunks; index += 1) {
    const start = from + index * step;
    chunks.push({ from: round(start, 3), to: round(Math.min(to, start + chunkSeconds), 3) });
  }
  const skipped = [];
  for (let index = 1; index < chunks.length; index += 1) {
    const gapFrom = chunks[index - 1].to;
    const gapTo = chunks[index].from;
    if (gapTo - gapFrom > 0.5) skipped.push({ from: round(gapFrom, 3), to: round(gapTo, 3) });
  }
  return { chunks, sampled: true, skipped };
}

/* ------------------------------------------------------------------ *
 * 纯函数：解析与聚合
 * ------------------------------------------------------------------ */

/**
 * 从模型回答里取 JSON。
 *
 * 模型常把 JSON 包在 ```json 围栏里，或在前后加一句解释；
 * 这里按顺序尝试：整体解析 → 去围栏 → 截取第一个大括号段。
 *
 * @param text - 模型回答。
 * @returns 解析出的对象；实在解析不出返回 null。
 */
export function parseModelJson(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return null;
  const attempts = [raw];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fenced !== null) attempts.push(fenced[1]);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) attempts.push(raw.slice(start, end + 1));
  for (const candidate of attempts) {
    try {
      const value = JSON.parse(candidate.trim());
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      /* 换下一种 */
    }
  }
  return null;
}

/**
 * 把一片的模型输出收成规范形状：枚举值收敛、缺字段补空。
 *
 * @param value - 解析出来的对象。
 * @returns 规范化后的片结果。
 */
export function normalizeChunk(value) {
  const pick = (allowed, raw, fallback) => {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '') return fallback;
    const hit = allowed.find((item) => item === text) ?? allowed.find((item) => text.includes(item));
    return hit ?? fallback;
  };
  const list = (raw) =>
    Array.isArray(raw)
      ? [...new Set(raw.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()))].slice(0, 12)
      : [];

  const music = pick(MUSIC_LEVELS, value?.music, 'none');
  const silent = music === 'none';
  return {
    music,
    style: silent ? '' : pick(MUSIC_STYLES, value?.style, '其他'),
    tempo: silent ? '' : pick(MUSIC_TEMPOS, value?.tempo, '中'),
    musicMood: pick(MUSIC_MOODS, value?.musicMood, silent ? '' : '其他'),
    instruments: silent ? [] : list(value?.instruments),
    characteristics: typeof value?.characteristics === 'string' ? value.characteristics.trim().slice(0, 120) : '',
    searchWords: list(value?.searchWords),
    sfx: list(value?.sfx),
  };
}

/**
 * 把逐片结果聚合成"整段 + 变化点"。
 *
 * 变化点不看模型怎么说，只看相邻片的枚举值有没有变：
 * `music`、`style`、`tempo` 任一不同就算变，并给出变到哪儿、从第几秒起。
 *
 * @param chunks - 逐片结果（含 from/to）。
 * @returns 聚合结果。
 */
export function aggregateBgm(chunks) {
  const list = Array.isArray(chunks) ? chunks : [];
  if (list.length === 0) {
    return {
      music: 'none',
      style: '',
      tempo: '',
      musicMood: '',
      instruments: [],
      characteristics: '',
      searchWords: [],
      changes: [],
      sfx: [],
    };
  }

  const counts = new Map();
  for (const chunk of list) {
    if (chunk.music === 'none') continue;
    const key = `${chunk.style}|${chunk.tempo}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const dominant = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? '';
  const [style = '', tempo = ''] = dominant === '' ? [] : dominant.split('|');

  const withMusic = list.filter((chunk) => chunk.music !== 'none');
  const changes = [];
  for (let index = 1; index < list.length; index += 1) {
    const before = list[index - 1];
    const after = list[index];
    const signature = (chunk) => `${chunk.music}|${chunk.style}|${chunk.tempo}`;
    if (signature(before) !== signature(after)) {
      changes.push({
        at: after.from,
        from: describeLabel(before),
        to: describeLabel(after),
      });
    }
  }

  // 只有"真的有音乐"的片才有资格提供检索词：无音乐片常吐出"纯人声/无 BGM"这种词，
  // 拿去搜素材库只会搜出一堆没用的东西。
  const collect = (key, from = list) => [...new Set(from.flatMap((chunk) => chunk[key] ?? []))].slice(0, 16);
  const levelCounts = new Map();
  for (const chunk of list) levelCounts.set(chunk.music, (levelCounts.get(chunk.music) ?? 0) + 1);
  const dominantLevel = [...levelCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 'none';
  const moodCounts = new Map();
  for (const chunk of withMusic) {
    if (chunk.musicMood !== '') moodCounts.set(chunk.musicMood, (moodCounts.get(chunk.musicMood) ?? 0) + 1);
  }
  const musicMood = [...moodCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? '';
  const characteristics = withMusic
    .map((chunk) => chunk.characteristics)
    .filter((text) => text !== '')
    .slice(0, 3)
    .join('；');

  return {
    music: dominantLevel,
    style,
    tempo,
    musicMood,
    instruments: collect('instruments'),
    characteristics,
    searchWords: collect('searchWords', withMusic),
    changes,
    sfx: collect('sfx'),
  };
}

/**
 * 片结果的简短标签，给变化点用。
 *
 * @param chunk - 片结果。
 * @returns 标签文本。
 */
function describeLabel(chunk) {
  if (chunk.music === 'none') return '无音乐';
  const parts = [chunk.style, chunk.tempo].filter((item) => item !== '');
  return parts.length === 0 ? '有音乐' : parts.join('/');
}

/* ------------------------------------------------------------------ *
 * 外部动作：抽音频、调云端、跑本地识别
 * ------------------------------------------------------------------ */

/**
 * 从视频里抽一段音频成 16k 单声道 WAV。
 *
 * `-ss` 放在 `-i` 之前是输入定位，现代 ffmpeg 会精确解码到该点，不会偏到关键帧；
 * 这是时间戳能被信任的前提。
 *
 * @param params - 参数。
 * @returns 输出文件路径。
 */
export async function extractWav(params) {
  const { run, ffmpegPath, input, from, to, outPath, signal, timeoutMs } = params;
  const start = Math.max(0, Number(from) || 0);
  const duration = Math.max(0.1, (Number(to) || 0) - start);
  await run(
    [
      ffmpegPath,
      '-v', 'error',
      '-nostdin',
      '-ss', String(start),
      '-t', String(duration),
      '-i', input,
      '-vn', '-sn', '-dn',
      '-ac', '1', '-ar', '16000',
      '-c:a', 'pcm_s16le',
      '-y',
      outPath,
    ],
    { signal, timeoutMs },
  );
  return outPath;
}

/**
 * 问云端模型：这一片的 BGM 与音效是什么。
 *
 * @param params - 参数。
 * @returns 规范化后的片结果；失败抛错（由调用方决定怎么降级）。
 */
export async function describeChunk(params) {
  const { key, model, prompt, wavPath, fetchImpl, signal, timeoutMs = 120000 } = params;
  const audio = await readFile(wavPath);
  const dataUri = `data:audio/wav;base64,${audio.toString('base64')}`;
  const fetchFn = fetchImpl ?? fetch;
  const response = await fetchFn('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'qwen3.8-omni-flash',
      // 思考模式默认是开的，开了输出 token 会翻几倍，这里明确关掉。
      reasoning_effort: 'none',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_audio', input_audio: { data: dataUri, format: 'wav' } },
            { type: 'text', text: prompt || BGM_PROMPT },
          ],
        },
      ],
    }),
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    const reason = text.replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`bgm model returned ${response.status}: ${reason}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('bgm model returned something that is not JSON');
  }
  const content = parsed?.choices?.[0]?.message?.content;
  const answer = Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : String(content ?? '');
  const value = parseModelJson(answer);
  if (value === null) throw new Error(`bgm model answer had no JSON: ${answer.slice(0, 120)}`);
  return normalizeChunk(value);
}

/**
 * BGM / 音效的整体流程：切片 → 逐片问 → 聚合。
 *
 * 任何一片失败都不让整次分析崩：记下失败片数，状态降为 partial。
 *
 * @param params - 参数。
 * @returns `{ status, notes, bgm, chunks }`。
 */
export async function analyzeBgm(params) {
  const { run, cfg, input, from, to, workDir, signal, key, fetchImpl, describe = describeChunk } = params;
  const plan = chunkPlan({
    from,
    to,
    chunkSeconds: cfg.bgmChunkSeconds,
    maxChunks: cfg.bgmMaxChunks,
  });
  if (plan.chunks.length === 0) return { status: 'unavailable', notes: ['时间窗口为空，未分析 BGM'], bgm: null, chunks: [] };
  if (typeof key !== 'string' || key.trim() === '') {
    return {
      status: 'unavailable',
      notes: [`未找到 ${cfg.bgmKeyEnv}，BGM/音效未分析（密钥只从环境变量读，不写进插件）`],
      bgm: null,
      chunks: [],
    };
  }

  const results = [];
  let failed = 0;
  for (let index = 0; index < plan.chunks.length; index += 1) {
    const chunk = plan.chunks[index];
    const wavPath = join(workDir, `bgm-${String(index + 1).padStart(3, '0')}.wav`);
    try {
      await extractWav({
        run,
        ffmpegPath: cfg.ffmpegPath,
        input,
        from: chunk.from,
        to: chunk.to,
        outPath: wavPath,
        signal,
        timeoutMs: cfg.timeoutMs,
      });
      const described = await describe({
        key,
        model: cfg.bgmModel,
        wavPath,
        fetchImpl,
        signal,
      });
      results.push({ ...chunk, ...described });
    } catch (error) {
      failed += 1;
      if (failed === 1) results.push({ ...chunk, music: 'none', style: '', tempo: '', musicMood: '', instruments: [], characteristics: '', searchWords: [], sfx: [], error: String(error?.message ?? error).slice(0, 120) });
    }
  }

  const notes = [];
  if (plan.sampled) {
    notes.push(
      `窗口 ${round(from, 1)}-${round(to, 1)} 秒超过 ${cfg.bgmMaxChunks} 片上限，已均匀抽样 ${plan.chunks.length} 片，` +
        `未听到的区间共 ${plan.skipped.length} 段（风格突变可能漏掉）`,
    );
  }
  if (failed > 0) notes.push(`${failed} 片分析失败，结果按"无音乐"占位，不代表真的没有`);
  const usable = results.filter((item) => item.error === undefined);
  const bgm = aggregateBgm(usable);
  return {
    status: usable.length === 0 ? 'unavailable' : failed > 0 ? 'partial' : 'ok',
    notes,
    bgm: {
      ...bgm,
      model: cfg.bgmModel,
      chunks: usable.length,
      sampled: plan.sampled,
      segments: usable.map((item) => ({
        from: item.from,
        to: item.to,
        music: item.music,
        style: item.style,
        tempo: item.tempo,
        musicMood: item.musicMood,
        characteristics: item.characteristics,
      })),
    },
    sampled: plan.sampled,
    failed,
  };
}

/**
 * 语音 + BGM 的完整流程，供 `video_watch` 调用。
 *
 * 两条线互不影响：一条不可用只把整体状态降级，并写进 notes，
 * 不会因为本地模型缺失就把"没有台词"当成结论。
 *
 * @param params - 参数。
 * @returns `{ status, notes, speech, bgm }`。
 */
export async function analyzeAudio(params) {
  const { run, cfg, input, from, to, workDir, signal, hasAudio, env = process.env, fetchImpl, importImpl, describe } = params;
  const notes = [];

  // 没有音频流时直接收工：送一段空音轨给模型只会得到一堆无意义的回答。
  if (hasAudio === false) {
    return {
      status: 'off',
      notes: ['这条视频没有音频流，语音与 BGM 都未分析'],
      speech: { status: 'off', source: 'no audio stream', count: 0, lines: [] },
      bgm: {
        status: 'off', model: cfg.bgmModel, chunks: 0, sampled: false, music: 'none', style: '', tempo: '',
        musicMood: '', instruments: [], characteristics: '', searchWords: [], changes: [], sfx: [], segments: [],
      },
    };
  }

  let speech = { status: 'off', source: 'disabled by speechMode=off', count: 0, lines: [] };
  if (cfg.speechMode !== 'off') {
    const loaded = await loadRecognizer({ modelDir: cfg.speechModelDir, sherpaPath: cfg.sherpaPath, importImpl });
    if (loaded.error !== undefined) {
      speech = { status: 'unavailable', source: 'local asr unavailable', count: 0, lines: [] };
      notes.push(`本地语音识别不可用（${loaded.error}）；BGM 仍会分析`);
    } else {
      try {
        const result = await transcribeLocal({ recognizer: loaded.recognizer, run, cfg, input, from, to, workDir, signal });
        speech = { status: result.status, source: result.source, count: result.count, lines: result.lines };
        notes.push(...result.notes);
      } catch (error) {
        speech = { status: 'unavailable', source: 'local asr failed', count: 0, lines: [] };
        notes.push(`本地语音识别失败：${String(error?.message ?? error).slice(0, 120)}`);
      }
    }
  }

  let bgm = {
    status: 'off',
    model: cfg.bgmModel,
    chunks: 0,
    sampled: false,
    music: 'none',
    style: '',
    tempo: '',
    musicMood: '',
    instruments: [],
    characteristics: '',
    searchWords: [],
    changes: [],
    sfx: [],
    segments: [],
  };
  if (cfg.bgmMode !== 'off') {
    const key = typeof env[cfg.bgmKeyEnv] === 'string' ? env[cfg.bgmKeyEnv] : '';
    const result = await analyzeBgm({ run, cfg, input, from, to, workDir, signal, key, fetchImpl, describe });
    notes.push(...result.notes);
    if (result.bgm === null) {
      bgm = { ...bgm, status: result.status };
    } else {
      bgm = { ...result.bgm, status: result.status };
    }
  }

  const order = ['unavailable', 'partial', 'ok', 'off'];
  const worst = order.find((candidate) => speech.status === candidate || bgm.status === candidate) ?? 'off';
  const status = bgm.status === 'off' && speech.status === 'off' ? 'off' : worst;
  return { status, notes, speech, bgm };
}


/* ------------------------------------------------------------------ *
 * 本地语音：sherpa-onnx + SenseVoice int8
 * ------------------------------------------------------------------ */

/**
 * 载入本地识别器。
 *
 * `sherpa-onnx-node` 是原生包，不作为插件的硬依赖：找不到就返回 null，
 * 由调用方如实标注 unavailable。两处找：本包 node_modules、本机 DSH 安装。
 *
 * @param params - 参数。
 * @returns `{ recognizer }` 或 `{ error }`。
 */
export async function loadRecognizer(params) {
  const { modelDir, sherpaPath, importImpl } = params;
  const model = join(modelDir, 'model.int8.onnx');
  const tokens = join(modelDir, 'tokens.txt');
  const candidates = [];
  // 显式给了目录就从目录 import（本机已有 DSH 装的那份时最省事）
  if (typeof sherpaPath === 'string' && sherpaPath !== '') {
    candidates.push(pathToFileURL(join(sherpaPath, 'non-streaming-asr.js')).href);
  }
  candidates.push('sherpa-onnx-node/non-streaming-asr.js');
  const doImport = importImpl ?? ((specifier) => import(specifier));
  let lastError = '';
  for (const candidate of candidates) {
    try {
      const module = await doImport(candidate);
      const Recognizer = module?.OfflineRecognizer;
      if (typeof Recognizer !== 'function') {
        lastError = `${candidate} 没有导出 OfflineRecognizer`;
        continue;
      }
      const recognizer = new Recognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          senseVoice: { model, useInverseTextNormalization: 1, language: 'auto' },
          tokens,
          numThreads: 4,
          provider: 'cpu',
          debug: 0,
        },
      });
      return { recognizer, modelDir };
    } catch (error) {
      lastError = String(error?.message ?? error);
    }
  }
  return { error: lastError === '' ? 'sherpa-onnx-node 未安装' : lastError };
}

/**
 * 读 16k 单声道 WAV 成 Float32 采样。
 *
 * @param path - 文件路径。
 * @returns `{ samples, sampleRate }`。
 */
export async function readWav(path) {
  const buffer = await readFile(path);
  let offset = 12;
  let dataOffset = -1;
  let dataLength = 0;
  let sampleRate = 16000;
  let channels = 1;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
    }
    if (id === 'data') {
      dataOffset = offset + 8;
      dataLength = Math.min(size, buffer.length - dataOffset);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error('wav 里没有 data 块');
  const total = Math.floor(dataLength / 2 / channels);
  const samples = new Float32Array(total);
  for (let index = 0; index < total; index += 1) {
    samples[index] = buffer.readInt16LE(dataOffset + index * 2 * channels) / 32768;
  }
  return { samples, sampleRate };
}

/** 句末标点：遇到就断句。 */
const SENTENCE_END = /[。！？!?；;]$/;

/**
 * 把逐字结果拼成句子。
 *
 * SenseVoice 给的是每个字的相对时间，这里按句末标点断句，
 * 并加上片偏移，得到片内的绝对时间。
 *
 * @param params - 参数。
 * @returns 句子数组 `{ start, end, text }`。
 */
export function sentencesFromTokens(params) {
  const { tokens, timestamps, offset = 0, maxChars = 60 } = params;
  const list = Array.isArray(tokens) ? tokens : [];
  const times = Array.isArray(timestamps) ? timestamps : [];
  const sentences = [];
  let buffer = '';
  let start = null;
  let end = null;
  for (let index = 0; index < list.length; index += 1) {
    const token = String(list[index] ?? '');
    const time = Number(times[index]);
    if (start === null && Number.isFinite(time)) start = time;
    if (Number.isFinite(time)) end = time;
    buffer += token;
    const finished = SENTENCE_END.test(token) || buffer.length >= maxChars;
    if (finished) {
      sentences.push({
        start: round(offset + (start ?? 0), 3),
        end: round(offset + (end ?? start ?? 0), 3),
        text: buffer.trim(),
      });
      buffer = '';
      start = null;
      end = null;
    }
  }
  if (buffer.trim() !== '') {
    sentences.push({
      start: round(offset + (start ?? 0), 3),
      end: round(offset + (end ?? start ?? 0), 3),
      text: buffer.trim(),
    });
  }
  return sentences;
}

/**
 * 本地语音识别：抽片 → 逐片解码 → 拼句 → 加偏移。
 *
 * @param params - 参数。
 * @returns `{ status, notes, source, lines, count }`。
 */
export async function transcribeLocal(params) {
  const { recognizer, run, cfg, input, from, to, workDir, signal } = params;
  const plan = chunkPlan({ from, to, chunkSeconds: SPEECH_CHUNK_SECONDS, maxChunks: 999 });
  const lines = [];
  let failed = 0;
  for (let index = 0; index < plan.chunks.length; index += 1) {
    const chunk = plan.chunks[index];
    const wavPath = join(workDir, `speech-${String(index + 1).padStart(3, '0')}.wav`);
    try {
      await extractWav({
        run,
        ffmpegPath: cfg.ffmpegPath,
        input,
        from: chunk.from,
        to: chunk.to,
        outPath: wavPath,
        signal,
        timeoutMs: cfg.timeoutMs,
      });
      const { samples, sampleRate } = await readWav(wavPath);
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate, samples });
      recognizer.decode(stream);
      const result = recognizer.getResult(stream);
      for (const sentence of sentencesFromTokens({
        tokens: result?.tokens,
        timestamps: result?.timestamps,
        offset: chunk.from,
      })) {
        if (sentence.text.replace(/[\s，。！？!?；;、]/g, '') === '') continue;
        lines.push(sentence);
      }
    } catch (error) {
      failed += 1;
      if (failed === 1) lines.push({ start: round(chunk.from, 3), end: round(chunk.from, 3), text: `（这一段本地识别失败：${String(error?.message ?? error).slice(0, 80)}）` });
    }
  }
  return {
    status: lines.length === 0 ? 'unavailable' : failed > 0 ? 'partial' : 'ok',
    notes: failed > 0 ? [`${failed} 片本地语音识别失败`] : [],
    source: 'local asr (sherpa-onnx / SenseVoice int8)',
    count: lines.length,
    lines: lines.slice(0, 400),
  };
}

/**
 * 四舍五入到指定小数位。
 *
 * @param value - 数值。
 * @param digits - 小数位。
 * @returns 结果。
 */
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}
