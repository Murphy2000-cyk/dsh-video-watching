import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { appendBatch, ensureHeader, recordPathOf, writeAnalysis } from '../index.js';

const PLAN_ID = '0123456789abcdef';

/** 造一份最小 cfg：只开记录、指到临时目录。 */
function cfgOf(dir) {
  return { record: true, recordDir: dir };
}

/** 与 executeWatch 传进来的形状一致（只取 record.js 用到的字段）。 */
function audioOf() {
  return {
    status: 'ok',
    notes: [],
    speech: { status: 'ok', source: 'local asr', count: 1, lines: [{ start: 0.24, end: 4.38, text: '简映用的爽吧' }] },
    bgm: {
      status: 'ok',
      model: 'qwen3.8-omni-flash',
      chunks: 1,
      sampled: false,
      segments: [{ from: 0, to: 10, music: '电子', style: '快', tempo: '欢快', musicMood: '', characteristics: '动感' }],
      changes: [],
      sfx: [],
      searchWords: ['电子舞曲'],
    },
  };
}

/** 造一份最小 plan 与 probe。 */
function planOf() {
  return {
    stats: { sheets: 12, from: 0, to: 30, batches: 2 },
    probe: { duration: 30, width: 1920, height: 1080, fps: 30, hasAudio: true, subtitleTracks: [] },
  };
}

test('ensureHeader 写文档头：规格、计划、预算都在', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-record-'));
  try {
    const { stats, probe } = planOf();
    const path = await ensureHeader({
      cfg: cfgOf(dir),
      input: 'C:/media/video.mp4',
      probe,
      plan: { stats },
      planId: PLAN_ID,
      snapshot: { mode: 'analysis', a: 0.3, t: 1, maxSheets: 10 },
    });
    assert.equal(path, recordPathOf(cfgOf(dir), 'C:/media/video.mp4'));
    assert.match(path, /video\.观看记录\.md$/);
    const text = await readFile(path, 'utf8');
    assert.match(text, /^# video\.mp4 · 观看记录/);
    assert.match(text, /计划：`0123456789abcdef`/);
    assert.match(text, /模式 视频解析/);
    assert.match(text, /12 张图 ≈ 4608 tokens/);
    assert.match(text, /共 2 批/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('appendBatch 写清这一批的时间、图片组成、语音、BGM，并留出分析位', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-record-'));
  try {
    const { stats, probe } = planOf();
    const cfg = cfgOf(dir);
    await ensureHeader({
      cfg,
      input: 'C:/media/video.mp4',
      probe,
      plan: { stats },
      planId: PLAN_ID,
      snapshot: { mode: 'understand', a: 1, t: 1.5, maxSheets: 20 },
    });
    const path = await appendBatch({
      cfg,
      input: 'C:/media/video.mp4',
      planId: PLAN_ID,
      batch: { index: 1, total: 2, from: 0, to: 10 },
      sheets: [{ sheet: 1, global: 1, start: 0, end: 1, cols: 2, rows: 2, tokens: 384, title: '开场一句话' }],
      cellsBySheet: [['0:00.031', '0:00.375', '0:00.750', '0:00.969']],
      transcript: { lines: [] },
      audio: audioOf(),
      skipped: 0,
      frames: 4,
      probe,
      plan: { stats },
      snapshot: { mode: 'understand', a: 1, t: 1.5, maxSheets: 20 },
    });
    assert.equal(path, recordPathOf(cfg, 'C:/media/video.mp4'));
    const text = await readFile(path, 'utf8');
    assert.match(text, /## 批次 1 \/ 2 · 0:00\.000–0:10\.000/);
    assert.match(text, /- 图片：1 张 · 画面 4 幅 · 抽取失败 0 幅/);
    assert.match(text, /\*\*图 1\*\*（全局 1）0:00\.000–0:01\.000 · 2×2 · 4 格 · 384 tokens/);
    assert.match(text, /子图时间：0:00\.031、0:00\.375/);
    assert.match(text, /台词：开场一句话/);
    assert.match(text, /### 语音/);
    assert.match(text, /\[0:00\.240–0:04\.380\] 简映用的爽吧/);
    assert.match(text, /### BGM/);
    assert.match(text, /电子 \/ 快 \/ 欢快 — 动感/);
    assert.match(text, /找相似曲目的检索词：电子舞曲/);
    // 分析位的标题要点明三段结构，否则模型只会写一段概括
    assert.match(text, /### 本批记录 · 观看情况 \/ 详细 \/ 总结/);
    assert.match(text, /<!-- 待补分析 0123456789abcdef 批次 1 -->/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeAnalysis 替换占位；同一批再写一次就追加补记，不重复覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-record-'));
  try {
    const { stats, probe } = planOf();
    const cfg = cfgOf(dir);
    const input = 'C:/media/video.mp4';
    await ensureHeader({
      cfg,
      input,
      probe,
      plan: { stats },
      planId: PLAN_ID,
      snapshot: { mode: 'analysis', a: 0.3, t: 1, maxSheets: 10 },
    });
    await appendBatch({
      cfg,
      input,
      planId: PLAN_ID,
      batch: { index: 1, total: 1, from: 0, to: 10 },
      sheets: [],
      cellsBySheet: [],
      transcript: { lines: [] },
      audio: { status: 'off', notes: [], speech: { status: 'off', source: '', count: 0, lines: [] }, bgm: null },
      skipped: 0,
      frames: 0,
      probe,
      plan: { stats },
      snapshot: { mode: 'analysis', a: 0.3, t: 1, maxSheets: 10 },
    });

    const first = await writeAnalysis({ cfg, input, planId: PLAN_ID, batch: 1, note: '- 快切卡点，每 0.5 秒换镜' });
    assert.equal(first.appended, false);
    let text = await readFile(first.path, 'utf8');
    assert.match(text, /快切卡点/);
    assert.doesNotMatch(text, /待补分析/);

    const second = await writeAnalysis({ cfg, input, planId: PLAN_ID, batch: 1, note: '- 补充：转场用闪白' });
    assert.equal(second.appended, true);
    text = await readFile(first.path, 'utf8');
    assert.match(text, /## 批次 1 分析（补记）/);
    assert.match(text, /转场用闪白/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('record: false 时既不写文档，也不允许写分析', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-record-'));
  try {
    const cfg = { record: false, recordDir: dir };
    const { stats, probe } = planOf();
    const path = await ensureHeader({ cfg, input: 'C:/media/video.mp4', probe, plan: { stats }, planId: PLAN_ID, snapshot: { mode: 'analysis', a: 0.3, t: 1, maxSheets: 10 } });
    assert.equal(path, null);
    const batch = await appendBatch({ cfg, input: 'C:/media/video.mp4', planId: PLAN_ID, batch: { index: 1, total: 1, from: 0, to: 1 }, sheets: [], cellsBySheet: [], transcript: { lines: [] }, audio: audioOf(), skipped: 0, frames: 0 });
    assert.equal(batch, null);
    await assert.rejects(() => writeAnalysis({ cfg, input: 'C:/media/video.mp4', planId: PLAN_ID, batch: 1, note: 'x' }), /recording is off/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
