/**
 * feasibility.js —— 预算闸门：这段窗口按现在的密度能不能**完整**看完。
 *
 * 判据只有一条：按预设密度原样铺满整段所需的图数 `required`，是否 ≤ `maxTotalSheets`。
 * 不把"变稀之后还能覆盖全片"算成够 —— 那等于闸门不存在。
 *
 * 不够时给出四条可执行的路，每条都带数字（几张、覆盖到哪、a/t 改成多少），
 * 让模型能直接把选择摆到用户面前，而不是问一句"预算不够怎么办"。
 *
 * @module dsh-video-watching/feasibility
 */

import { buildGroups, groupCost } from './delivery.js';
import { planFrames, planFeasibility } from './plan.js';

/** 参与计划、也参与快照的采样字段。 */
const SAMPLING_KEYS = ['a', 't', 'maxGap', 'multiCross', 'cutPair', 'maxSheets'];

/**
 * 取一份采样参数的副本。
 *
 * @param sampling - 采样参数。
 * @returns 只含采样键的对象。
 */
function samplingOf(sampling) {
  const out = {};
  for (const key of SAMPLING_KEYS) out[key] = sampling[key];
  return out;
}

/**
 * 千分位之外的定点小数：正文里要给人看，不能出现 0.47000000000000003。
 *
 * @param value - 数值。
 * @returns 三位小数。
 */
function round3(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

/**
 * 一份计划折成"几张图、多少钱、覆盖到哪"。
 *
 * @param plan - `planFrames` 的结果。
 * @param aspect - 源宽高比。
 * @returns 指标对象。
 */
function metricsOf(plan, aspect) {
  const cost = groupCost(buildGroups({ groups: plan.groups }), aspect);
  return {
    sheets: plan.stats.sheets,
    tokens: cost.tokens,
    coveredTo: round3(plan.stats.coveredTo),
    unseenSeconds: round3(plan.stats.unseenSeconds),
    batches: plan.stats.batches,
  };
}

/**
 * 判预算是否够，并生成候选方案。
 *
 * @param params - 参数。
 * @param params.duration - 时长（秒）。
 * @param params.scanFps - 分析帧率。
 * @param params.area - 逐帧面积变化分。
 * @param params.from - 窗口起。
 * @param params.to - 窗口止。
 * @param params.aspect - 源宽高比，用于估 token。
 * @param params.sampling - 当前生效的采样参数。
 * @param params.maxTotalSheets - 配置里的整片预算。
 * @param params.alternate - 另一套预设的采样参数（`understand` 方案用）。
 * @param params.prefer - 推荐项：`thin` 倾向 `density`，`stop` 倾向 `truncate`。
 * @returns `{ budget, options, plan }`。
 */
export function feasibilityOf(params) {
  const { duration, scanFps, area, from, to, aspect, sampling, maxTotalSheets, alternate, prefer } = params;
  const base = {
    duration,
    scanFps,
    area,
    from,
    to,
    maxGap: sampling.maxGap,
    multiCross: sampling.multiCross,
    cutPair: sampling.cutPair,
    maxSheets: sampling.maxSheets,
    maxTotalSheets,
  };

  const analysis = planFeasibility({ ...base, a: sampling.a, t: sampling.t });
  const budget = {
    ...metricsOf(analysis.full, aspect),
    required: analysis.required,
    minimum: analysis.minimum,
    max: analysis.max,
    feasible: analysis.feasible,
    a: round3(sampling.a),
    t: round3(sampling.t),
  };
  if (analysis.feasible) return { budget, options: [], plan: analysis.full };

  const options = [];
  options.push({
    id: 'raise',
    ...metricsOf(analysis.full, aspect),
    ...samplingOf(sampling),
    budget: analysis.required,
    feasible: true,
    note: 'full coverage at the chosen density; the budget has to go up to this many sheets',
  });

  const truncate = analysis.truncate ?? planFrames({ ...base, a: sampling.a, t: sampling.t, overflow: 'stop' });
  options.push({
    id: 'truncate',
    ...metricsOf(truncate, aspect),
    ...samplingOf(sampling),
    budget: analysis.max,
    feasible: true,
    note: 'keep the budget and stop early; everything after the coverage end stays unseen',
  });

  const other = alternate ?? sampling;
  const alternatePlan = planFeasibility({
    ...base,
    a: other.a,
    t: other.t,
    maxGap: other.maxGap,
    multiCross: other.multiCross,
    cutPair: other.cutPair,
    maxSheets: other.maxSheets,
  });
  options.push({
    id: 'understand',
    ...metricsOf(alternatePlan.full, aspect),
    ...samplingOf(other),
    budget: analysis.max,
    feasible: alternatePlan.feasible,
    note: alternatePlan.feasible
      ? 'switch to the looser mode; full coverage, less detail'
      : `even the looser mode needs ${alternatePlan.required} sheets`,
  });

  if (analysis.density !== null) {
    options.push({
      id: 'density',
      ...metricsOf(analysis.density.plan, aspect),
      ...samplingOf(sampling),
      a: round3(analysis.density.a),
      t: round3(analysis.density.t),
      budget: analysis.max,
      feasible: true,
      note: `raise a to ${round3(analysis.density.a)} and t to ${round3(analysis.density.t)}; full coverage, sparser`,
    });
  }

  const preferred = prefer === 'thin' && analysis.density !== null ? 'density' : 'truncate';
  for (const option of options) option.recommended = option.id === preferred && option.feasible === true;

  return { budget, options, plan: analysis.full, density: analysis.density, truncate };
}

/**
 * 把 `choice` 解析成"用哪套采样、按哪种模式、上限多少"。
 *
 * 支持 `budget` 作为一次性预算覆盖（只对这一次计划生效，不写配置）。
 *
 * @param params - 参数。
 * @param params.choice - 工具传进来的选择。
 * @param params.sampling - 当前档位的采样参数。
 * @param params.alternate - 另一套预设的采样参数。
 * @param params.feasibility - `feasibilityOf` 的结果。
 * @returns `{ mode, sampling, limit }` 或 `{ error }`。
 */
export function resolveChoice(params) {
  const { choice, sampling, alternate, feasibility } = params;
  const id = typeof choice?.id === 'string' ? choice.id : '';
  const requested = Number(choice?.budget);
  const hasBudget = Number.isFinite(requested) && requested > 0;
  const limitOf = (fallback) => (hasBudget ? Math.floor(requested) : fallback);

  if (id === 'raise') {
    return { mode: 'raise', sampling: samplingOf(sampling), limit: limitOf(feasibility.required) };
  }
  if (id === 'truncate') {
    return { mode: 'truncate', sampling: samplingOf(sampling), limit: limitOf(feasibility.max) };
  }
  if (id === 'understand') {
    return { mode: 'understand', sampling: samplingOf(alternate ?? sampling), limit: limitOf(feasibility.max) };
  }
  if (id === 'density') {
    if (feasibility.density === null) {
      return { error: 'no a/t combination fits this budget: even the maxGap floor is above it; raise the budget or truncate' };
    }
    const a = Number.isFinite(Number(choice?.a)) ? Number(choice.a) : feasibility.density.a;
    const t = Number.isFinite(Number(choice?.t)) ? Number(choice.t) : feasibility.density.t;
    return {
      mode: 'density',
      sampling: { ...samplingOf(sampling), a, t },
      limit: limitOf(feasibility.max),
    };
  }
  return { error: `unknown choice "${id}"; use one of raise / truncate / understand / density` };
}

/**
 * 按定稿的采样与模式算最终计划。
 *
 * `truncate` 用 `stop` 截断并尊重 `limit`；其余模式一律**不设上限**执行
 * （能走到这一步，说明预算已经论证过够了）。
 *
 * @param params - 参数。
 * @returns `planFrames` 的结果。
 */
export function planFor(params) {
  const { duration, scanFps, area, from, to, sampling, mode, limit } = params;
  if (mode === 'truncate') {
    return planFrames({
      duration,
      scanFps,
      area,
      from,
      to,
      ...samplingOf(sampling),
      maxTotalSheets: Math.max(1, Math.floor(Number(limit) || 1)),
      overflow: 'stop',
    });
  }
  return planFrames({
    duration,
    scanFps,
    area,
    from,
    to,
    ...samplingOf(sampling),
    maxTotalSheets: Number.MAX_SAFE_INTEGER,
  });
}
