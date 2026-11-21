/**
 * 真片子上的音频端到端验证：本地语音 + 云端 BGM/音效。
 *
 * 用一支 3 分 51 秒的讲解片（有旁白、没配乐），看：
 *   - 本地语音能不能转出带时间码的句子；
 *   - BGM 分析会不会如实说"没有音乐"；
 *   - 整次调用多花多少时间。
 */

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { buildTools, resolveConfig } from '../index.js';
import { createRunner } from '../lib/ffmpeg.js';

// 视频路径：命令行第一个参数优先，没给就用本机这支讲解片当默认样例。
const VIDEO = process.argv[2] ?? 'F:/Agent/DeepseekHarness/Interaction/20261104_litsearch_v220_视频/literature-search_2.2.0_介绍.mp4';
const DSH_SHERPA = 'C:/Users/lenovo/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/sherpa-onnx-node';

function spawnStub(spec) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const buf = { stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk) => {
    buf.stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk) => {
    buf.stderr += chunk.toString('utf8');
  });
  const done = new Promise((resolve, reject) => {
    child.on('close', (code, signal) => resolve({ exitCode: code, signal }));
    child.on('error', reject);
  });
  const reader = (name) => ({ readFrom: () => ({ text: buf[name], nextOffset: buf[name].length, lossy: false }) });
  return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } };
}

function jpegSize(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return { width: 0, height: 0 };
}

let saved = 0;
const attachments = {
  async saveImages(items) {
    return items.map((item) => {
      saved += 1;
      return { attachmentId: `probe-${saved}`, mediaType: item.mediaType, bytes: item.data.length, ...jpegSize(item.data) };
    });
  },
};

const ctx = {
  subprocess: { spawn: spawnStub },
  get: (name) => (name === 'attachments' ? attachments : undefined),
  tools: { register: () => () => {} },
};

const cfg = resolveConfig({ sherpaPath: DSH_SHERPA, bgmMaxChunks: 8, record: false });
const run = createRunner((spec) => spawnStub(spec), { graceMs: 2000, timeoutMs: 180000 });
const tools = buildTools({ ctx, run, cfg });
const planTool = tools.find((tool) => tool.name === 'video_plan');
const watch = tools.find((tool) => tool.name === 'video_watch');

// 先定稿，再拿 planId 执行（预算不够就按截断定稿，探针只关心音频那条线）。
const planned = await planTool.execute({ input: VIDEO, mode: 'understand', userConfirmed: true }, { signal: undefined });
let planId = planned.planId;
if (typeof planId !== 'string') {
  const committed = await planTool.execute(
    { input: VIDEO, mode: 'understand', userConfirmed: true, choice: { id: 'truncate' } },
    { signal: undefined },
  );
  planId = committed.planId;
}

const started = Date.now();
const value = await watch.execute({ input: VIDEO, planId, batch: 1 }, { signal: undefined });
const seconds = ((Date.now() - started) / 1000).toFixed(1);

const audio = value.audio;
const lines = [
  `耗时 ${seconds} s`,
  `整体状态：${audio.status}`,
  `备注：${audio.notes.length === 0 ? '（无）' : audio.notes.join(' | ')}`,
  '',
  `语音：status=${audio.speech.status} source=${audio.speech.source} 句数=${audio.speech.count}`,
  ...audio.speech.lines.slice(0, 6).map((line) => `  [${line.start.toFixed(2)}-${line.end.toFixed(2)}] ${line.text}`),
  '',
  `BGM：status=${audio.bgm.status} model=${audio.bgm.model} 片数=${audio.bgm.chunks} 抽样=${audio.bgm.sampled}`,
  `  音乐=${audio.bgm.music} 风格=${audio.bgm.style} 速度=${audio.bgm.tempo} 情绪=${audio.bgm.musicMood}`,
  `  特征=${audio.bgm.characteristics}`,
  `  检索词=${audio.bgm.searchWords.join(', ')}`,
  `  变化点=${audio.bgm.changes.map((change) => `${change.at}s ${change.from}→${change.to}`).join(' | ') || '无'}`,
  `  音效=${audio.bgm.sfx.join(', ') || '无'}`,
  ...audio.bgm.segments.map((segment) => `  seg ${segment.from}-${segment.to} ${segment.music}/${segment.style}/${segment.tempo} ${segment.characteristics}`),
];

await writeFile('F:/Agent/DeepseekHarness/Project/Project20261119/audio-probe-real.txt', lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
