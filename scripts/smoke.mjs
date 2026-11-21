/**
 * 端到端冒烟：造一部**已知节奏**的测试片，看插件是否真的按节奏分配帧。
 *
 * 测试片的构造就是断言的前提：
 *   0-8 秒   纯黑静止     → 应该几秒一帧
 *   8-16 秒  持续运动     → 应该密一些
 *   16-24 秒 每秒一次硬切 → 应该最密，且每个切点都落帧
 *
 * 跑法：`node scripts/smoke.mjs`（需要 ffmpeg / ffprobe 在 PATH，或设 DSH_FFMPEG_PATH）
 * 产物：`smoke-out/` 下的拼图与清单，可以直接打开看。
 */

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTools, resolveConfig } from '../index.js';
import { createRunner } from '../lib/ffmpeg.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'smoke-out');
// 造测试片也用插件自己解析出来的路径 —— 这样连"找不找得到 ffmpeg"这件事一起验了。
const FFMPEG = resolveConfig({}).ffmpegPath;

/**
 * 一个最小可用的 subprocess 服务替身：接口形状按 Agent 契约来，
 * 被验证的就是生产代码本身，而不是它的克隆。
 *
 * @param spec - Agent spawn 请求。
 * @returns 句柄。
 */
function spawnStub(spec) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const buf = { stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk) => {
    buf.stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk) => {
    buf.stderr += chunk.toString('utf8');
  });
  const done = new Promise((resolve, reject) => {
    child.on('close', (code, signal) => resolve({ exitCode: code, signal }));
    // 起不来时要 reject，而不是编一个退出码：Agent 的真实行为就是 failed 的 done，
    // 生产代码据此外退到 `ffmpeg -i`，替身必须复现这一点。
    child.on('error', (error) => reject(error));
  });
  const reader = (name) => ({ readFrom: () => ({ text: buf[name], nextOffset: buf[name].length, lossy: false }) });
  return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } };
}

/**
 * 从 JPEG 里读宽高（SOF0/1/2 段）。附件服务真实返回值就是这个口径，
 * 替身也照做，否则清单里的分辨率会是假的 0×0。
 *
 * @param buffer - JPEG 字节。
 * @returns `{ width, height }`；解析不出返回 0。
 */
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

/** 重定向到 `smoke-out/` 的附件服务替身。 */
let savedCounter = 0;
const attachments = {
  async saveImages(items) {
    return Promise.all(
      items.map(async (item) => {
        savedCounter += 1;
        const name = `saved-${String(savedCounter).padStart(2, '0')}-${item.name}`;
        await writeFile(join(OUT, name), item.data);
        const size = jpegSize(item.data);
        return { attachmentId: `stub-${savedCounter}`, mediaType: item.mediaType, bytes: item.data.length, ...size };
      }),
    );
  },
};

const ctx = {
  subprocess: { spawn: spawnStub },
  get: (name) => (name === 'attachments' ? attachments : undefined),
  tools: { register: () => () => {} },
};

/**
 * 跑一条 ffmpeg 命令，失败就带着 stderr 抛出来。
 *
 * @param args - 参数表（不含程序名）。
 */
async function ff(args) {
  const handle = spawnStub({ argv: [FFMPEG, ...args], cwd: ROOT });
  const outcome = await handle.done;
  if (outcome.exitCode !== 0) {
    throw new Error(`ffmpeg ${args[0]} 失败（${outcome.exitCode}）：${handle.collected.stderr.readFrom().text.slice(-800)}`);
  }
}

/**
 * 造测试片。
 *
 * @returns 视频路径。
 */
async function buildFixture() {
  const work = join(OUT, '_fixture');
  await mkdir(work, { recursive: true });
  const common = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '25'];

  const still = join(work, 'a.mp4');
  const motion = join(work, 'b.mp4');
  await ff(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=25:d=8', ...common, still]);
  await ff(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=8', ...common, motion]);

  const colors = ['0xff0000', '0x00ff00', '0x0000ff', '0xffff00', '0xff00ff', '0x00ffff', '0xffffff', '0x101010'];
  const cuts = [];
  for (let index = 0; index < colors.length; index += 1) {
    const path = join(work, `c${index}.mp4`);
    await ff(['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colors[index]}:s=640x360:r=25:d=1`, ...common, path]);
    cuts.push(path);
  }

  const list = join(work, 'list.txt');
  await writeFile(list, [still, motion, ...cuts].map((path) => `file '${path.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
  const joined = join(work, 'joined.mp4');
  const final = join(work, 'fixture.mp4');
  await ff(['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
  await ff([
    '-v', 'error', '-y',
    '-i', joined,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=24',
    '-c:v', 'copy', '-c:a', 'aac', '-shortest',
    final,
  ]);
  return final;
}

/**
 * 同一部片子跑三种交付形态，比较张数与 token。
 *
 * 这是上一轮讨论的落点：密段挤进拼图、疏段可以各自成图。
 *
 * @param byName - 工具表。
 * @param input - 视频路径。
 * @param label - 打印用的标签。
 */
async function compareModes(buildWith, input, label) {
  const cases = [
    { name: '默认 a=0.3', args: {} },
    { name: '总量 3 张', cfg: { maxTotalSheets: 3 }, args: { maxGap: 0 } },
    { name: 'stop 截断', cfg: { maxTotalSheets: 3 }, args: { maxGap: 0, overflow: 'stop' } },
    { name: 'cutPair 开', args: { cutPair: true } },
    { name: 'multiCross 关', args: { multiCross: false } },
    { name: 'a=1.5 省 token', args: { a: 1.5 } },
  ];
  const rows = [];
  for (const item of cases) {
    // 这一组比的是**密度**，所以把总量放开（40 张对一个 24 秒片等于不设限）；
    // 总量上限是配置项，所以按用例换一套工具（模型侧改不了它）。
    const scoped = buildWith({ maxTotalSheets: item.cfg?.maxTotalSheets ?? 40 });
    const watch = await scoped.video_watch.execute(
      { input, preset: 'analysis', userConfirmed: true, ...item.args },
      { signal: undefined },
    );
    rows.push({
      mode: item.name,
      frames: watch.frames.length,
      sheets: watch.sheets.length,
      singles: watch.plan.singles ?? 0,
      cutPairs: watch.plan.cutPairs ?? 0,
      truncated: watch.plan.truncated,
      tokens: watch.estimate.tokens,
    });
  }
  console.log('  ' + '形态'.padEnd(16) + '帧'.padStart(4) + '图'.padStart(4) + '单帧'.padStart(6) + '切点'.padStart(6) + 'token'.padStart(8));
  for (const row of rows) {
    console.log(
      '  ' + row.mode.padEnd(16) + String(row.frames).padStart(4) + String(row.sheets).padStart(4) +
        String(row.singles).padStart(6) + String(row.cutPairs).padStart(6) + String(row.tokens).padStart(8),
    );
  }
  const [auto, few, stop, cut, multi, cheap] = rows;
  check(label + '：总量上限收紧后图数明显减少', few.sheets < auto.sheets, auto.sheets + ' -> ' + few.sheets + ' 张');
  check(label + '：overflow stop 会提前结束', stop.truncated === true, 'truncated=' + stop.truncated);
  check(label + '：overflow thin 不截断', auto.truncated === false, 'truncated=' + auto.truncated);
  // cutPair 只对"单间隔硬切"生效，测试片里有 8 次硬切。
  check(label + '：cutPair 打开后硬切取前后两帧', cut.cutPairs >= 1, 'cutPairs=' + cut.cutPairs);
  check(label + '：multiCross 关闭后不会更密', multi.frames <= auto.frames, auto.frames + ' -> ' + multi.frames);
  check(label + '：a=1.5 显著省帧', cheap.frames < auto.frames, auto.frames + ' -> ' + cheap.frames + ' 格');
}

const results = [];

/**
 * 记录一条断言。
 *
 * @param label - 断言。
 * @param ok - 是否通过。
 * @param detail - 细节。
 */
function check(label, ok, detail) {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${detail ?? ''}`);
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  console.log('构造测试片…');
  const video = await buildFixture();
  console.log(`测试片：${video}\n`);

  const cfg = resolveConfig({ scanFps: 10, cacheDir: join(OUT, '_cache') });
  const run = createRunner((spec) => spawnStub(spec), { graceMs: 2000, timeoutMs: 180000 });
  const buildWith = (overrides) => {
  const scopedCfg = resolveConfig({ scanFps: 10, cacheDir: join(OUT, '_cache'), ...overrides });
  return Object.fromEntries(buildTools({ ctx, run, cfg: scopedCfg }).map((tool) => [tool.name, tool]));
};
const byName = buildWith({});

  console.log('--- video_plan：全片 ---');
  const plan = await byName.video_plan.execute({ input: video, preset: 'analysis', userConfirmed: true }, { signal: undefined });
  const planText = byName.video_plan.output.render({}, plan)[0].text;
  console.log(planText);
  await writeFile(join(OUT, 'plan.txt'), planText, 'utf8');

  const windowOf = (from, to) => buildWith({ maxTotalSheets: 8 }).video_plan.execute({ input: video, preset: 'analysis', userConfirmed: true, from, to }, { signal: undefined });
  const stillPlan = await windowOf(0, 7.5);
  const cutPlan = await windowOf(16.5, 23.9);
  const stillRate = stillPlan.plan.count / 7.5;
  const cutRate = cutPlan.plan.count / 7.4;

  console.log('\n--- 密度差异 ---');
  check('快剪段的采样密度显著高于静止段',
    cutRate > stillRate * 1.5,
    `静止 ${stillRate.toFixed(2)} 帧/秒（${stillPlan.plan.count} 帧） vs 快剪 ${cutRate.toFixed(2)} 帧/秒（${cutPlan.plan.count} 帧）`,
  );
  check('静止段几乎不给帧', stillPlan.plan.count <= 3, `静止段 ${stillPlan.plan.count} 格 / 7.5 秒`);
  check('快剪段认出至少 7 次硬切', cutPlan.plan.cuts >= 7, `cuts=${cutPlan.plan.cuts}`);
  check('变化量按窗口记账', cutPlan.plan.totalChange > stillPlan.plan.totalChange, `${stillPlan.plan.totalChange} -> ${cutPlan.plan.totalChange}`);

  console.log('\n--- video_watch ---');
  const watch = await buildWith({ maxTotalSheets: 4 }).video_watch.execute({ input: video, preset: 'analysis', userConfirmed: true }, { signal: undefined });
  const blocks = byName.video_watch.output.render({}, watch);
  console.log(blocks[0].text);
  await writeFile(join(OUT, 'watch.txt'), blocks[0].text, 'utf8');

  const images = blocks.filter((block) => block.type === 'image');
  check('交付了图块', images.length === watch.sheets.length, `${watch.sheets.length} 张`);
  check('图数没超预算', watch.sheets.length <= 4, `${watch.sheets.length} 张图`);
  check('每张子图都落在某张图片的格位里', watch.frames.every((frame) => frame.sheet >= 1 && frame.sheet <= watch.sheets.length && frame.cell >= 1), 'ok');
  const keys = new Set(watch.frames.map((frame) => `${frame.sheet}:${frame.cell}`));
  check('子图格位不重复', keys.size === watch.frames.length, `${keys.size}/${watch.frames.length}`);
  check('图片尺寸真实（不是 0×0）', watch.sheets.every((sheet) => sheet.image.width > 0), watch.sheets.map((sheet) => `${sheet.image.width}x${sheet.image.height}`).join(' '));

  // ---- 顺序三层：交付单元内子图 / 每张图片内部 / 图片与图片之间 ----
  const times = watch.frames.map((frame) => frame.time);
  check(
    '交付单元内：子图按时间单调不减',
    times.every((time, index) => index === 0 || time >= times[index - 1] - 1e-9),
    `${times.length} 帧`,
  );
  const perSheet = new Map();
  for (const frame of watch.frames) {
    if (!perSheet.has(frame.sheet)) perSheet.set(frame.sheet, []);
    perSheet.get(frame.sheet).push(frame);
  }
  check(
    '每张图片内部：子图号递增且时间递增',
    [...perSheet.values()].every(
      (cells) =>
        cells.every((cell, index) => cell.cell === index + 1) &&
        cells.every((cell, index) => index === 0 || cell.time >= cells[index - 1].time - 1e-9),
    ),
    'ok',
  );
  const firsts = [...perSheet.values()].map((cells) => cells[0].time);
  check(
    '图片与图片之间：起始时间递增',
    firsts.every((time, index) => index === 0 || time >= firsts[index - 1] - 1e-9),
    firsts.map((t) => t.toFixed(2)).join(' < '),
  );

  console.log('\n--- video_closeup ---');
  const close = await byName.video_closeup.execute({ input: video, times: [3.5, '00:18'] }, { signal: undefined });
  console.log(byName.video_closeup.output.render({}, close)[0].text);
  check('取回两帧原图', close.frames.length === 2, close.frames.map((frame) => `${frame.label} ${frame.width}x${frame.height}`).join(' | '));

  console.log('\n--- 字幕对齐 ---');
  const srtPath = join(OUT, 'demo.srt');
  await writeFile(
    srtPath,
    [
      '1',
      '00:00:09,000 --> 00:00:11,500',
      '这是第二段的第一句',
      '',
      '2',
      '00:00:18,200 --> 00:00:20,900',
      '硬切段的一句台词',
      '',
      '3',
      '00:00:00,500 --> 00:00:02,000',
      '开场的黑屏旁白',
      '',
    ].join('\n'),
    'utf8',
  );
  const withSubs = await byName.video_watch.execute(
    { input: video, preset: 'analysis', userConfirmed: true, transcriptFile: srtPath },
    { signal: undefined },
  );
  check('字幕被读进来', withSubs.transcript.count === 3, `${withSubs.transcript.count} 条：${withSubs.transcript.source}`);
  check(
    '每条字幕都带时间码且按秒对齐',
    withSubs.transcript.lines.every((line) => typeof line.start === 'number') &&
      Math.abs(withSubs.transcript.lines[0].start - 0.5) < 0.01,
    withSubs.transcript.lines.map((line) => `${line.start}s`).join(' '),
  );
  const subsText = byName.video_watch.output.render({}, withSubs)[0].text;
  check('字幕行进了正文', /\[0:00\.500\] 开场的黑屏旁白/.test(subsText), 'ok');

  console.log('\n--- 交付形态对比（密段拼图 / 档位 / 疏段单帧）---');
  await compareModes(buildWith, video, 'fixture');

  const extra = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
  if (extra !== undefined) {
    console.log(`\n--- 外部视频： ---`);
    await compareModes(buildWith, extra, 'external');
  }

  const failures = results.filter((item) => !item.ok);
  console.log(`\n合计 ${results.length} 项，失败 ${failures.length} 项。产物在 ${OUT}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('冒烟失败：', error?.stack ?? error);
  process.exitCode = 1;
});
