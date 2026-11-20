/**
 * ffmpeg.js —— 进程与文件的那一层。
 *
 * 一条硬规矩贯穿全文件：**所有产物都落盘，不靠 stdout 读回二进制**。
 * 三个原因：
 *   1. 长片抽帧的中间产物本来就是文件（拼图要按 `%04d.jpg` 喂给 tile）；
 *   2. 落盘的东西出问题能直接打开看，管道里的东西出问题只能猜；
 *   3. 沙箱环境常常禁止跨进程管道捕获，落盘是唯一到处都能跑的做法。
 *
 * 唯一的例外是 ffprobe 与 `-filters` 的文本输出，它们必须走 collected stdout。
 *
 * @module dsh-video-understanding/ffmpeg
 */

/** 单条 ffmpeg 命令保留多少字节的 stderr 用于报错。 */
const STDERR_BYTES = 64 * 1024;
/** ffprobe 的 JSON 可能很长（多轨、多 side data）。 */
const PROBE_BYTES = 4 * 1024 * 1024;

/**
 * 取一段文本的尾部：ffmpeg 的真正原因总在最后几行，前面全是 banner。
 *
 * @param text - 全文。
 * @param lines - 保留几行。
 * @returns 尾部文本。
 */
function tail(text, lines = 6) {
  const parts = String(text ?? '').trim().split('\n');
  return parts.slice(Math.max(0, parts.length - lines)).join('\n').trim();
}

/**
 * 造一个带超时与取消协同的 runner。
 *
 * @param spawn - `ctx.subprocess.spawn`。
 * @param options - 选项。
 * @param options.graceMs - 终止宽限期。
 * @param options.timeoutMs - 单条命令超时。
 * @returns `run(argv, options)`。
 */
export function createRunner(spawn, options = {}) {
  const graceMs = Math.max(100, Math.floor(options.graceMs ?? 2000));
  const defaultTimeout = Math.max(1000, Math.floor(options.timeoutMs ?? 120000));

  return async function run(argv, runOptions = {}) {
    const timeoutMs = Math.max(1000, Math.floor(runOptions.timeoutMs ?? defaultTimeout));
    const controller = new AbortController();
    const outer = runOptions.signal;
    const forward = () => controller.abort();
    if (outer !== undefined) {
      if (outer.aborted) controller.abort();
      else outer.addEventListener('abort', forward, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const spec = {
      argv,
      cwd: runOptions.cwd ?? process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: runOptions.collectStdout === true ? { maxBytes: PROBE_BYTES } : 'ignore',
        stderr: { maxBytes: STDERR_BYTES },
      },
      graceMs,
      signal: controller.signal,
    };

    try {
      const handle = spawn(spec);
      let outcome;
      try {
        outcome = await handle.done;
      } catch (error) {
        throw new Error(`${argv[0]} could not run: ${error?.message ?? error}`);
      }
      const stderr = safeRead(handle, 'stderr');
      const stdout = runOptions.collectStdout === true ? safeRead(handle, 'stdout') : '';
      const code = outcome?.exitCode ?? null;
      // `allowFailure` 是给 `ffmpeg -i` 用的：它只打印元数据然后以 1 退出，
      // 那次"失败"正是我们要的输出。
      if (code !== 0 && runOptions.allowFailure !== true) {
        const why = outer?.aborted === true ? 'cancelled' : controller.signal.aborted ? `timed out after ${timeoutMs} ms` : `exited with ${code === null ? outcome?.signal ?? 'unknown' : code}`;
        throw new Error(`${argv[0]} ${why}${stderr === '' ? '' : `: ${tail(stderr)}`}`);
      }
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener?.('abort', forward);
    }
  };
}

/**
 * 读一条已收集的输出流。
 *
 * @param handle - 进程句柄。
 * @param name - `stdout` / `stderr`。
 * @returns 文本；读不到就是空串。
 */
function safeRead(handle, name) {
  try {
    const reader = handle?.collected?.[name];
    if (reader === undefined) return '';
    return String(reader.readFrom(0)?.text ?? '');
  } catch {
    return '';
  }
}

/**
 * 解析 `30000/1001` 这类帧率表达式。
 *
 * @param text - 表达式。
 * @returns 帧率；认不出返回 0。
 */
function parseRate(text) {
  const value = String(text ?? '');
  const [num, den] = value.split('/');
  const n = Number(num);
  const d = Number(den ?? 1);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
}

/**
 * 探测视频容器。只读头部，不解码画面。
 *
 * 优先用 ffprobe（结构化 JSON，最准）。**没有 ffprobe 时退回 `ffmpeg -i` 解析 stderr**：
 * 只装 `pip install imageio-ffmpeg` 的环境就属于这种情况 —— 有 ffmpeg、没有 ffprobe。
 * 这也顺带说明了为什么这条链路一律落盘、不读二进制 stdout：能退化，才好活。
 *
 * @param params - 参数。
 * @returns 元数据。
 */
export async function probeVideo(params) {
  const { run, ffprobePath, input } = params;
  if (typeof ffprobePath === 'string' && ffprobePath !== '') {
    try {
      return await probeWithFfprobe({ ...params, run });
    } catch (error) {
      // 只有"二进制根本没跑起来"才退化：Agent 报 could not run，
      // 子进程 never-started 报负的退出码。文件本身坏了要把真实原因抛出去。
      const message = String(error?.message ?? '');
      if (!/could not run|exited with -\d+/i.test(message)) throw error;
    }
  }
  return probeWithFfmpeg(params);
}

/**
 * 用 ffprobe 探测。
 *
 * @param params - 参数。
 * @returns 元数据。
 */
async function probeWithFfprobe(params) {
  const { run, ffprobePath, input, signal } = params;
  const { stdout } = await run(
    [ffprobePath, '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', input],
    { collectStdout: true, signal },
  );
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`ffprobe returned something that is not JSON for "${input}"; is it a video file?`);
  }
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream?.codec_type === 'video');
  if (video === undefined) throw new Error(`"${input}" has no video stream`);

  const duration = Number(parsed?.format?.duration ?? video?.duration ?? 0);
  const fps = parseRate(video?.avg_frame_rate) || parseRate(video?.r_frame_rate) || 25;

  // 手机竖拍常是"编码 1920×1080 + 旋转 90°"：ffmpeg 解码时会自动转正，
  // 而 ffprobe 报的是编码尺寸。拿编码尺寸去算缩放会把画面拉扁。
  const rotation = readRotation(video);
  const codedWidth = Number(video?.width ?? 0) || 0;
  const codedHeight = Number(video?.height ?? 0) || 0;
  const swap = rotation === 90 || rotation === 270;

  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    fps,
    width: swap ? codedHeight : codedWidth,
    height: swap ? codedWidth : codedHeight,
    hasAudio: streams.some((stream) => stream?.codec_type === 'audio'),
    subtitleTracks: streams
      .map((stream, index) => ({ stream, index }))
      .filter((item) => item.stream?.codec_type === 'subtitle')
      .map((item) => ({ index: item.index, language: String(item.stream?.tags?.language ?? '') })),
    via: 'ffprobe',
  };
}

/**
 * 用 `ffmpeg -i` 打印的元数据探测。
 *
 * @param params - 参数。
 * @returns 元数据。
 */
async function probeWithFfmpeg(params) {
  const { run, ffmpegPath, input, signal } = params;
  const { stderr } = await run([ffmpegPath, '-hide_banner', '-i', input], { allowFailure: true, signal, timeoutMs: 30000 });
  const parsed = parseFfmpegProbe(stderr);
  if (parsed === null) {
    throw new Error(`could not read a duration from "${input}"; is it a video file? ffmpeg said: ${tail(stderr, 3)}`);
  }
  if (parsed.width === 0 || parsed.height === 0) throw new Error(`"${input}" has no video stream`);
  return { ...parsed, via: 'ffmpeg' };
}

/**
 * 解析 `ffmpeg -i` 的 stderr。纯函数，单测钉住。
 *
 * @param stderr - ffmpeg 打印的元数据。
 * @returns 元数据，或 `null`（没有时长）。
 */
export function parseFfmpegProbe(stderr) {
  const text = String(stderr ?? '');
  const durationMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (durationMatch === null) return null;
  const duration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);

  let width = 0;
  let height = 0;
  let fps = 0;
  let hasAudio = false;
  let rotation = 0;
  const subtitleTracks = [];

  for (const line of text.split('\n')) {
    const stream = /Stream\s+#0:(\d+)/.exec(line);
    if (stream === null) {
      const matrix = /displaymatrix:\s*rotation of\s*(-?\d+(?:\.\d+)?)\s*degrees/.exec(line);
      if (matrix !== null) rotation = ((Math.round(Number(matrix[1])) % 360) + 360) % 360;
      const tag = /^\s*rotate\s*:\s*(-?\d+)\s*$/.exec(line);
      if (tag !== null) rotation = ((Math.round(Number(tag[1])) % 360) + 360) % 360;
      continue;
    }
    const index = Number(stream[1]);
    if (/\bVideo:/.test(line)) {
      const size = /(\d{2,5})x(\d{2,5})\b/.exec(line);
      if (size !== null && width === 0) {
        width = Number(size[1]);
        height = Number(size[2]);
      }
      const rate = /(\d+(?:\.\d+)?)\s*fps/.exec(line) ?? /(\d+(?:\.\d+)?)\s*tbr/.exec(line);
      if (rate !== null && fps === 0) fps = Number(rate[1]);
    } else if (/\bAudio:/.test(line)) {
      hasAudio = true;
    } else if (/\bSubtitle:/.test(line)) {
      const language = /\(([a-z]{2,3})\)/.exec(line);
      subtitleTracks.push({ index, language: language === null ? '' : language[1] });
    }
  }

  const swap = rotation === 90 || rotation === 270;
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    fps: fps > 0 ? fps : 25,
    width: swap ? height : width,
    height: swap ? width : height,
    hasAudio,
    subtitleTracks,
  };
}

/**
 * 从 ffprobe 的 side data 或 tags 里读旋转角。
 *
 * @param video - 视频流对象。
 * @returns 0 / 90 / 180 / 270。
 */
function readRotation(video) {
  const side = Array.isArray(video?.side_data_list) ? video.side_data_list : [];
  for (const item of side) {
    const value = Number(item?.rotation);
    if (Number.isFinite(value)) return ((Math.round(value) % 360) + 360) % 360;
  }
  const tag = Number(video?.tags?.rotate);
  if (Number.isFinite(tag)) return ((Math.round(tag) % 360) + 360) % 360;
  return 0;
}

/**
 * 把整条视频按固定帧率抽成小尺寸 raw RGB，供分析用。
 *
 * 分析图尺寸由**长边**决定（默认 120 像素）。实测把长边从 96 扫到 200，
 * 面积变化分的总量几乎不变（168.4 / 170.8 / 168.8 / 168.9），所以尺寸不是
 * 精度的旋钮，只是"能不能看见小目标"和"解码花多久"的折中。
 *
 * 这一步会解码全长，是整条链路里最慢的一环；所以它只在 `video_plan`
 * 和第一次 `video_watch` 时跑，结果按 文件大小+修改时间+分析帧率+尺寸+块参数 缓存。
 *
 * @param params - 参数。
 * @param params.width - 分析宽。
 * @param params.height - 分析高。
 * @returns 输出文件路径。
 */
export async function scanToRgb(params) {
  const { run, ffmpegPath, input, fps, outPath, signal, timeoutMs } = params;
  const width = Math.max(16, Math.round(Number(params.width) || 120));
  const height = Math.max(16, Math.round(Number(params.height) || 68));
  await run(
    [
      ffmpegPath,
      '-v', 'error',
      '-nostdin',
      '-i', input,
      '-an',
      '-sn',
      // area 比 bilinear 更适合缩小：块内先平均再取样，高频噪声不会被抽成假变化。
      '-vf', `fps=${fps},scale=${width}:${height}:flags=area,format=rgb24`,
      '-f', 'rawvideo',
      '-y',
      outPath,
    ],
    { signal, timeoutMs },
  );
  return outPath;
}

/**
 * 抽一帧到一个 JPEG 文件。
 *
 * @param params - 参数。
 * @returns 输出文件路径。
 */
export async function extractFrame(params) {
  const { run, ffmpegPath, input, time, outPath, filter, quality, signal, timeoutMs } = params;
  await run(
    [
      ffmpegPath,
      '-v', 'error',
      '-nostdin',
      '-ss', String(Math.max(0, Number(time) || 0)),
      '-i', input,
      '-frames:v', '1',
      '-an',
      '-sn',
      ...(filter === '' ? [] : ['-vf', filter]),
      '-q:v', String(quality),
      '-y',
      outPath,
    ],
    { signal, timeoutMs },
  );
  return outPath;
}

/**
 * 抽一帧并保留原始分辨率（只在给 `maxWidth` 时缩小，不放大）。
 *
 * @param params - 参数。
 * @returns 输出文件路径。
 */
export async function extractFullFrame(params) {
  const { run, ffmpegPath, input, time, outPath, maxWidth, sourceWidth, filter, quality, signal, timeoutMs } = params;
  const target = Math.min(Number(maxWidth) || sourceWidth, sourceWidth);
  const chain = target > 0 && target < sourceWidth ? `scale=${target}:-2:flags=lanczos` : '';
  const merged = [chain, filter].filter((item) => item !== '' && item !== undefined).join(',');
  return extractFrame({ run, ffmpegPath, input, time, outPath, filter: merged, quality, signal, timeoutMs });
}

/**
 * 把一串等尺寸的 JPEG 拼成一张宫格图。
 *
 * 用 `tile` 而不是 `xstack`：`tile` 的输入是文件序列，不需要为每一帧拼一条
 * filter 链，帧数上到几十也只是参数变长。
 *
 * @param params - 参数。
 * @returns 输出文件路径。
 */
export async function tileImages(params) {
  const { run, ffmpegPath, pattern, cols, rows, padding, outPath, quality, signal, timeoutMs } = params;
  await run(
    [
      ffmpegPath,
      '-v', 'error',
      '-nostdin',
      '-framerate', '1',
      '-start_number', '1',
      '-i', pattern,
      '-frames:v', '1',
      ...(cols === 0 || rows === 0 ? [] : ['-vf', `tile=${cols}x${rows}:padding=${padding}:margin=0:color=0x0b0f14`]),
      '-q:v', String(quality),
      '-y',
      outPath,
    ],
    { signal, timeoutMs },
  );
  return outPath;
}

/**
 * 把内嵌字幕轨导成 SRT。
 *
 * @param params - 参数。
 * @returns 输出文件路径。
 */
export async function extractSubtitles(params) {
  const { run, ffmpegPath, input, streamIndex, outPath, signal, timeoutMs } = params;
  await run(
    [ffmpegPath, '-v', 'error', '-nostdin', '-i', input, '-map', `0:${streamIndex}`, '-c:s', 'srt', '-y', outPath],
    { signal, timeoutMs },
  );
  return outPath;
}

/**
 * 探测这份 ffmpeg 有没有 drawtext（决定能不能把时间码烧进画面）。
 *
 * `-filters` 的输出走 collected stdout；结果由调用方缓存，每条视频至多一次。
 *
 * @param params - 参数。
 * @returns 是否支持 drawtext。
 */
export async function hasDrawtext(params) {
  const { run, ffmpegPath, signal } = params;
  try {
    const { stdout } = await run([ffmpegPath, '-hide_banner', '-filters'], { collectStdout: true, signal, timeoutMs: 20000 });
    return /\bdrawtext\b/.test(stdout);
  } catch {
    return false;
  }
}

/**
 * 拼一条 drawtext 过滤器。
 *
 * Windows 字体路径里的盘符冒号必须转义，否则 ffmpeg 会把 `C:` 当成参数分隔符。
 *
 * @param params - 参数。
 * @returns 过滤器字符串。
 */
export function buildDrawtext(params) {
  const { text, fontFile, fontSize } = params;
  const safePath = String(fontFile ?? '')
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:');
  const safeText = String(text ?? '')
    .replace(/\\/g, '\\\\\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\\\'");
  return (
    `drawtext=fontfile='${safePath}':text='${safeText}':` +
    `x=6:y=h-th-10:fontsize=${fontSize}:fontcolor=white:` +
    'box=1:boxcolor=black@0.55:boxborderw=4'
  );
}
