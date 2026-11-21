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
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    { name: '默认（跟随预设）', cfg: {}, preset: 'analysis' },
    { name: '预算 3 → 截断', cfg: { maxTotalSheets: 3 }, preset: 'analysis', choice: { id: 'truncate' } },
    { name: '预算 3 → 密度', cfg: { maxTotalSheets: 3 }, preset: 'analysis', choice: { id: 'density' } },
    { name: '换 understand', cfg: {}, preset: 'analysis', choice: { id: 'understand' } },
    { name: 'cutPair 开', cfg: { cutPair: true }, preset: 'analysis' },
    { name: 'multiCross 关', cfg: { multiCross: false }, preset: 'analysis' },
    { name: 'a=1.5 省 token', cfg: { a: 1.5 }, preset: 'analysis' },
  ];
  const rows = [];
  for (const item of cases) {
    const scoped = buildWith({ maxTotalSheets: 40, ...item.cfg });
    const args = { input, preset: item.preset, userConfirmed: true };
    if (item.choice !== undefined) args.choice = item.choice;
    const planned = await scoped.video_plan.execute(args, { signal: undefined });
    const ok = typeof planned.planId === 'string';
    check(`${label}：${item.name} 能定稿`, ok, ok ? planned.planId : `选项=${(planned.options ?? []).map((option) => option.id).join('/')}`);
    if (!ok) continue;
    const watch = await scoped.video_watch.execute({ input, planId: planned.planId, batch: 1 }, { signal: undefined });
    rows.push({
      mode: item.name,
      frames: watch.plan.count,
      sheets: watch.plan.sheets,
      batches: watch.plan.batches,
      coverage: watch.plan.videoComplete ? 'full' : `to ${watch.plan.coveredTo.toFixed(1)}s`,
      tokens: watch.estimate.tokens,
      cuts: watch.plan.cutPairs,
    });
  }
  console.log(
    '  ' + '形态'.padEnd(18) + '帧'.padStart(4) + '图'.padStart(4) + '批'.padStart(4) + '  覆盖'.padEnd(10) + 'token'.padStart(8),
  );
  for (const row of rows) {
    console.log(
      '  ' + row.mode.padEnd(18) + String(row.frames).padStart(4) + String(row.sheets).padStart(4) + String(row.batches).padStart(4) +
        '  ' + row.coverage.padEnd(9) + String(row.tokens).padStart(8),
    );
  }
  const byMode = Object.fromEntries(rows.map((row) => [row.mode, row]));
  const auto = byMode['默认（跟随预设）'];
  const truncate = byMode['预算 3 → 截断'];
  const density = byMode['预算 3 → 密度'];
  const understand = byMode['换 understand'];
  const cut = byMode['cutPair 开'];
  const multi = byMode['multiCross 关'];
  const cheap = byMode['a=1.5 省 token'];
  if (truncate !== undefined) check(label + '：截断方案真的少看图', truncate.coverage !== 'full', truncate.coverage);
  if (density !== undefined) check(label + '：密度方案覆盖全片且不超预算', density.coverage === 'full' && density.sheets <= 3, `${density.coverage} / ${density.sheets} 张`);
  if (understand !== undefined && auto !== undefined) check(label + '：换 understand 更省', understand.sheets < auto.sheets, `${auto.sheets} -> ${understand.sheets} 张`);
  if (cut !== undefined) check(label + '：cutPair 打开后硬切取前后两帧', cut.cuts >= 1, 'cutPairs=' + cut.cuts);
  if (multi !== undefined && auto !== undefined) check(label + '：multiCross 关闭后不会更密', multi.frames <= auto.frames, auto.frames + ' -> ' + multi.frames);
  if (cheap !== undefined && auto !== undefined) check(label + '：a=1.5 显著省帧', cheap.frames < auto.frames, auto.frames + ' -> ' + cheap.frames + ' 格');
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

  const cfg = resolveConfig({ scanFps: 10, cacheDir: join(OUT, '_cache'), recordDir: join(OUT, '_record') });
  const run = createRunner((spec) => spawnStub(spec), { graceMs: 2000, timeoutMs: 180000 });
  const buildWith = (overrides) => {
  const scopedCfg = resolveConfig({ scanFps: 10, cacheDir: join(OUT, '_cache'), recordDir: join(OUT, '_record'), ...overrides });
  return Object.fromEntries(buildTools({ ctx, run, cfg: scopedCfg }).map((tool) => [tool.name, tool]));
};
const byName = buildWith({});

  console.log('--- video_plan：全片 ---');
  const plan = await byName.video_plan.execute({ input: video, preset: 'analysis', userConfirmed: true }, { signal: undefined });
  const planText = byName.video_plan.output.render({}, plan)[0].text;
  console.log(planText);
  await writeFile(join(OUT, 'plan.txt'), planText, 'utf8');
  check('预算够时 plan 给出 planId', typeof plan.planId === 'string', plan.planId ?? '(无)');
  check('预算块说明了够不够', plan.budget?.feasible === true, `required=${plan.budget?.required} max=${plan.budget?.max}`);

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

  console.log('\n--- 预算检查 ---');
  try {
    await byName.video_watch.execute({ input: video }, { signal: undefined });
    check('没有 planId 的 watch 会被拒', false, '居然执行了');
  } catch (error) {
    check('没有 planId 的 watch 会被拒', /planId/.test(String(error?.message ?? error)), '已拒绝');
  }

  const tight = buildWith({ maxTotalSheets: 4 });
  const refused = await tight.video_plan.execute({ input: video, preset: 'analysis', userConfirmed: true }, { signal: undefined });
  check(
    '预算不够时 plan 不给 planId、只给选项',
    refused.planId === undefined && (refused.options ?? []).length >= 3,
    `required=${refused.budget?.required} max=${refused.budget?.max} options=${(refused.options ?? []).map((item) => item.id).join('/')}`,
  );
  const blockedText = byName.video_plan.output.render({}, refused)[0].text;
  check('预算不够的正文明确禁止先 watch', /Do NOT call video_watch yet/.test(blockedText), 'ok');

  const truncatedPlan = await tight.video_plan.execute(
    { input: video, preset: 'analysis', userConfirmed: true, choice: { id: 'truncate' } },
    { signal: undefined },
  );
  check('选截断后可以定稿', typeof truncatedPlan.planId === 'string', truncatedPlan.planId ?? '(无)');

  console.log('\n--- video_watch（截断计划）---');
  const watch = await tight.video_watch.execute({ input: video, planId: truncatedPlan.planId, batch: 1 }, { signal: undefined });
  const blocks = byName.video_watch.output.render({}, watch);
  console.log(blocks[0].text);
  await writeFile(join(OUT, 'watch.txt'), blocks[0].text, 'utf8');
  check('截断计划：videoComplete=false 并写进正文', watch.plan.videoComplete === false && /videoComplete="false"/.test(blocks[0].text), `coveredTo=${watch.plan.coveredTo}`);
  check('batchDone 与 videoComplete 分开表达', typeof watch.batch.batchDone === 'boolean' && watch.batch.batchDone === true && watch.plan.videoComplete === false, 'ok');

  // 关键不变量：预算只在 plan 那一步参与决策，watch 不再读它。
  const loose = buildWith({ maxTotalSheets: 100 });
  const loosePlan = await loose.video_plan.execute({ input: video, preset: 'analysis', userConfirmed: true }, { signal: undefined });
  const strict = buildWith({ maxTotalSheets: 2 });
  const stillRuns = await strict.video_watch.execute({ input: video, planId: loosePlan.planId, batch: 1 }, { signal: undefined });
  check('watch 不再读 maxTotalSheets：配置改成 2 也能执行已定稿的计划', stillRuns.sheets.length > 2, `${stillRuns.sheets.length} 张`);

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

  console.log('\n--- 观看记录 ---');
  const noteResult = await byName.video_note.execute(
    { input: video, planId: truncatedPlan.planId, batch: 1, note: '- 冒烟：这一批的画面与音频已写入记录。' },
    { signal: undefined },
  );
  const recordText = await readFile(noteResult.path, 'utf8');
  check('记录文档落在配置的目录', noteResult.path.startsWith(join(OUT, '_record')), noteResult.path);
  check('记录写了批次时间与图片组成', /## 批次 1 \//.test(recordText) && /### 时间与图片组成/.test(recordText), 'ok');
  check('记录里有语音与 BGM 段', /### 语音/.test(recordText) && /### BGM/.test(recordText), 'ok');
  check(
    'video_note 填进了自己那一批的占位',
    /冒烟：这一批/.test(recordText) && !new RegExp(`待补分析 ${truncatedPlan.planId} 批次 1`).test(recordText),
    noteResult.appended ? 'appended' : 'filled',
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
  // 字幕现在按**本批**裁剪，所以要像真模型那样把每一批都取一遍再合并。
  const subtitlePlan = await byName.video_plan.execute({ input: video, preset: 'analysis', userConfirmed: true }, { signal: undefined });
  const batches = [];
  for (let index = 1; index <= 40; index += 1) {
    const value = await byName.video_watch.execute(
      { input: video, planId: subtitlePlan.planId, transcriptFile: srtPath, batch: index },
      { signal: undefined },
    );
    batches.push(value);
    if (value.batch.batchDone) break;
  }
  const allLines = batches.flatMap((value) => value.transcript.lines);
  const firstBatchText = byName.video_watch.output.render({}, batches[0])[0].text;
  check('分批取完：批数与 total 一致', batches.length === batches[0].batch.total, `${batches.length} 批 / total=${batches[0].batch.total}`);
  check('每批都带时间范围与全局序号', batches.every((value) => value.sheets.every((sheet) => typeof sheet.from === 'number' && typeof sheet.global === 'number')), 'ok');
  check('每批的语音都落在本批时间范围内', batches.every((value) => value.transcript.lines.every((line) => line.start >= value.batch.from - 0.01 && line.start <= value.batch.to + 0.01)), 'ok');
  // 测试片开头 8 秒是静止画面，第一批从 5 秒起（静止段没有变化，只有 maxGap 补的那一帧），
  // 所以 0.5 秒那条字幕本就不在任何一批的范围内。这里按"覆盖到的范围"核对，别写死条数。
  const covered = [batches[0].batch.from, batches.at(-1).batch.to];
  const expected = [9, 18.2];
  check('跨批合并后字幕齐了（覆盖范围内）', allLines.length === expected.length, `${allLines.length} 条：${batches[0].transcript.source}，覆盖 ${covered[0]}-${covered[1]}s`);
  check(
    '每条字幕都带时间码且按秒对齐',
    allLines.every((line) => typeof line.start === 'number') &&
      allLines.every((line) => expected.some((time) => Math.abs(line.start - time) < 0.01)),
    allLines.map((line) => `${line.start}s`).join(' '),
  );
  check('字幕行进了正文', /\[0:09\.000\] 这是第二段的第一句/.test(firstBatchText), 'ok');

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
