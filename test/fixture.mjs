/**
 * 测试用的样例值：**由真实代码算出来**，不是手写的一份。
 *
 * 手写样例的最大问题是会漂移：`estimate` 里少写一个键，单测照样全绿，
 * 而 Agent 按 output schema 校验返回值时会直接把整次工具调用判成
 * `INVALID_TOOL_OUTPUT`。所以这里走一遍
 * 合成变化序列 → planFrames → buildGroups → groupCost → headOf 的真实链路。
 */

import { headOf } from '../index.js';
import { densityMap, planFrames } from '../lib/plan.js';
import { buildGroups, groupCost } from '../lib/delivery.js';

const FPS = 10;
const DURATION = 90;

/**
 * 造一段"平时微微动、每 7.5 秒跳一次"的面积变化序列。
 *
 * @returns 0~1 的数组。
 */
function syntheticArea() {
  const series = new Array(DURATION * FPS).fill(0.004);
  for (let at = 3; at < DURATION; at += 7.5) series[Math.round(at * FPS)] = 0.9;
  return series;
}

/**
 * 跑一遍真实计划链。
 *
 * @returns `{ plan, groups, estimate, area }`。
 */
export function sampleAnalysis() {
  const area = syntheticArea();
  const plan = planFrames({ duration: DURATION, scanFps: FPS, area, a: 0.3, t: 1, maxGap: 5, maxFrames: 60 });
  const groups = buildGroups({ groups: plan.groups, perSheet: 20 });
  const estimate = groupCost(groups, 16 / 9);
  return { plan, groups, estimate, area };
}

/**
 * 造一份公共的头字段（= `video_plan` 的完整返回值）。
 *
 * @returns 头字段对象。
 */
export function sampleHead() {
  const { plan, groups, estimate, area } = sampleAnalysis();
  return headOf({
    input: 'C:/media/demo.mp4',
    probe: {
      duration: DURATION,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      subtitleTracks: [{ index: 2, language: 'zh' }],
    },
    scan: { fps: FPS, scores: area, area, luma: [], seconds: 1.2, cached: false },
    plan,
    density: densityMap(plan.groups),
    estimate,
    groups,
  });
}

/**
 * 造一份音频分析结果（与 `analyzeAudio` 的返回同形）。
 *
 * 手写样例漏键会在宿主校验时报 `INVALID_TOOL_OUTPUT`，所以这里按 schema 逐字段给全，
 * 并在契约脚本里再和真实返回值比对一次。
 *
 * @returns 音频结果对象。
 */
export function sampleAudio() {
  return {
    status: 'ok',
    notes: [],
    speech: {
      status: 'ok',
      source: 'local asr (sherpa-onnx / SenseVoice int8)',
      count: 2,
      lines: [
        { start: 0.12, end: 2.4, text: '这是一段测试语音。' },
        { start: 10.1, end: 13.9, text: '第二段录音只有一句。' },
      ],
    },
    bgm: {
      status: 'ok',
      model: 'qwen3.8-omni-flash',
      chunks: 2,
      sampled: false,
      music: 'light',
      style: '钢琴',
      tempo: '慢',
      musicMood: '温暖',
      instruments: ['钢琴'],
      characteristics: '单音钢琴，稀疏，留白多',
      searchWords: ['钢琴', '温暖', '稀疏'],
      changes: [{ at: 60, from: '钢琴/慢', to: '电子/快' }],
      sfx: ['重击声'],
      segments: [
        { from: 0, to: 30, music: 'light', style: '钢琴', tempo: '慢', musicMood: '温暖', characteristics: '稀疏' },
        { from: 30, to: 60, music: 'light', style: '钢琴', tempo: '慢', musicMood: '温暖', characteristics: '继续' },
      ],
    },
  };
}
