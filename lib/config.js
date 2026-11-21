/**
 * config.js —— 配置归一化。
 *
 * 插件配置全部可缺省：这里把每个键夹到合法范围、解析外部命令、猜字体、定缓存目录，
 * 让下游拿到的 cfg 可以直接用，不必各自再判空。
 *
 * @module dsh-video-understanding/config
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 归一化配置。
 *
 * @param config - 原始配置。
 * @returns 归一化后的配置。
 */
export function resolveConfig(config) {
  const raw = config ?? {};
  const home = (() => {
    try {
      return homedir();
    } catch {
      return '.';
    }
  })();
  const scanFps = clampNumber(raw.scanFps, 1, 30, 10);
  const exe = process.platform === 'win32' ? '.exe' : '';
  const binDir = join(home, '.dsh', 'bin', 'ffmpeg');
  const wingetLinks =
    typeof process.env.LOCALAPPDATA === 'string' ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : '';
  const known = (name) => [join(binDir, `${name}${exe}`), ...(wingetLinks === '' ? [] : [join(wingetLinks, `${name}${exe}`)])];
  return {
    ffmpegPath: resolveExecutable(raw.ffmpegPath, ['DSH_FFMPEG_PATH', 'FFMPEG_PATH'], 'ffmpeg', known('ffmpeg')),
    ffprobePath: resolveExecutable(raw.ffprobePath, ['DSH_FFPROBE_PATH', 'FFPROBE_PATH'], 'ffprobe', known('ffprobe')),
    scanFps,
    // 积分法：攒够 a 个满屏变化落一帧；每 t 秒数密度定网格
    longSide: clampInt(raw.longSide, 32, 480, 120),
    block: clampInt(raw.block, 2, 16, 4),
    blockThreshold: clampInt(raw.blockThreshold, 1, 64, 8),
    // 预算按交付单元里的**图片张数**算：一张图约 384 token，与里面几张子图无关。
    // 超预算时：thin = 全局变稀（默认）；stop = 看到上限就停，后面的内容不看。

    quality: clampInt(raw.quality, 2, 31, 3),
    burn: ['none', 'index', 'time'].includes(raw.burn) ? raw.burn : 'time',
    fontFile: typeof raw.fontFile === 'string' && raw.fontFile !== '' ? raw.fontFile : defaultFont(),
    transcriptCommand: normalizeCommand(raw.transcriptCommand),
    cacheDir: typeof raw.cacheDir === 'string' && raw.cacheDir !== '' ? raw.cacheDir : join(home, '.dsh', 'cache', 'video-understanding'),
    timeoutMs: clampInt(raw.timeoutMs, 1000, 3600000, 180000),
    toolTimeoutMs: clampInt(raw.toolTimeoutMs, 1000, 3600000, 900000),
    graceMs: clampInt(raw.graceMs, 100, 30000, 2000),
    // 交付策略：超预算时变稀还是停。属于长期偏好，留在配置里，也可单次覆盖。
    overflow: raw.overflow === 'thin' ? 'thin' : 'stop',

    // 音频。语音走本地 sherpa-onnx（CPU、免费），BGM/音效走云端。
    // 密钥只从环境变量读：配置里存的是**变量名**，不是密钥本身。
    speechMode: ['off', 'auto'].includes(raw.speechMode) ? raw.speechMode : 'auto',
    speechModelDir:
      typeof raw.speechModelDir === 'string' && raw.speechModelDir !== ''
        ? raw.speechModelDir
        : join(home, '.dsh', 'speech-to-text', 'sensevoice', 'models', 'sensevoice-onnx'),
    bgmMode: ['off', 'auto'].includes(raw.bgmMode) ? raw.bgmMode : 'auto',
    bgmModel: typeof raw.bgmModel === 'string' && raw.bgmModel !== '' ? raw.bgmModel : 'qwen3.8-omni-flash',
    bgmKeyEnv: typeof raw.bgmKeyEnv === 'string' && raw.bgmKeyEnv !== '' ? raw.bgmKeyEnv : 'DASHSCOPE_AUDIO_API_KEY',
    // sherpa-onnx-node 是原生包，可选：给了绝对目录就从那里 import，否则按包名找。
    sherpaPath: typeof raw.sherpaPath === 'string' ? raw.sherpaPath.trim() : '',
    bgmChunkSeconds: clampInt(raw.bgmChunkSeconds, 5, 120, 30),
    bgmMaxChunks: clampInt(raw.bgmMaxChunks, 1, 200, 24),
    // 整片最多交付多少张图（跨所有批次）：这是真正的花钱上限。
    maxTotalSheets: clampInt(raw.maxTotalSheets, 1, 5000, 100),
    // 缓存只增不减会慢慢堆起来，给一个条数上限（按 mtime 淘汰最旧的）。
    cacheMaxEntries: clampInt(raw.cacheMaxEntries, 10, 100000, 200),
  };
}

/**
 * 解析可执行文件路径：配置 > 环境变量 > 已知位置 > PATH 上的默认名。
 *
 * "已知位置"这一层是 Windows 上的实际需要：往用户 PATH 里加目录要**重启 Agent**
 * 才生效，而插件装完往往当场就想跑。先看一眼自己的 bin 目录和 winget 的链接目录，
 * 命中就用绝对路径，省掉一次"为什么说找不到 ffmpeg"。
 *
 * @param configured - 配置里的值。
 * @param envNames - 依次尝试的环境变量。
 * @param fallback - 兜底命令名。
 * @param candidates - 已知的绝对路径候选。
 * @returns 命令或路径。
 */
function resolveExecutable(configured, envNames, fallback, candidates = []) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  for (const key of envNames) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* 探测失败就当不存在 */
    }
  }
  return fallback;
}

/**
 * 猜一个等宽字体给 drawtext 用。
 *
 * @returns 字体路径；猜不到返回空串（调用方会因此关掉烧字）。
 */
function defaultFont() {
  if (process.platform === 'win32') return 'C:/Windows/Fonts/consolab.ttf';
  if (process.platform === 'darwin') return '/System/Library/Fonts/Menlo.ttc';
  return '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

/**
 * 归一化外部转写命令。
 *
 * 只收**数组**，不收字符串：一条带占位符的字符串要交给 shell 才能用，
 * 而路径里的空格、引号、`&` 在 shell 里各有各的坏法。数组由调用方直接交给
 * 子进程服务，不经过任何 shell，`{input}` / `{output}` 在元素级别替换。
 *
 * @param value - 配置里的值。
 * @returns 字符串数组；配置无效时为空数组（等于不启用）。
 */
function normalizeCommand(value) {
  if (!Array.isArray(value)) return [];
  const items = value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
  if (items.length === 0) return [];
  // 两个占位符都要出现，否则命令拿不到视频、也交不出字幕。
  const joined = items.join(' ');
  if (!joined.includes('{input}') || !joined.includes('{output}')) return [];
  return items;
}

/**
 * 把占位符换成实际路径。纯函数，单测钉住。
 *
 * @param argv - 命令模板。
 * @param params - 替换值。
 * @returns 展开后的 argv。
 */
export function expandCommand(argv, params) {
  if (!Array.isArray(argv)) return [];
  return argv.map((item) =>
    String(item).replaceAll('{input}', params.input ?? '').replaceAll('{output}', params.output ?? ''),
  );
}

function clampInt(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback));
}
