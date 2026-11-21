/**
 * plan.js —— 积分法采样计划：用"画面累计变化量"决定什么时候取帧、一秒取几张。
 *
 * 和上一版（分位归一 + gamma 曲线 + 二分预算）的根本区别：
 * 这里不再给"变化分 → 间隔"配一条曲线，而是把变化量当**电量**来攒 ——
 * 每攒够 `a` 个满屏变化就落一个抽帧时刻，然后清零。于是
 *
 *   - 间隔天然等于 a / 变化率，不需要 gamma 去压；
 *   - 全片抽帧总数 ≈ 累积变化量 / a，是闭式的，预算可以反解；
 *   - 变化是"面积占比"，不是"平均色差"，量纲能直接读成"画面变了百分之几"。
 *
 * 抽帧时刻只用来**判断密度**：每 `t` 秒数有几个时刻，n=1 单帧、2~4 用 2x2、
 * 5~9 用 3x3、10 以上用 4x4；窗口内的子图按网格均匀重取（不看时刻的具体位置），
 * 所以同一张拼图里每张子图的时间间隔严格相等。
 *
 * 全文件纯函数，无 IO，可离线断言。
 *
 * @module dsh-video-watching/plan
 */

/** 默认抽帧阈值：攒够 0.3 个满屏变化落一帧。 */
export const DEFAULT_A = 0.3;
/** 默认密度窗口（秒）。 */
export const DEFAULT_T = 1;
/** 默认强制补帧间隔（秒）。 */
export const DEFAULT_MAX_GAP = 5;
/**
 * 默认每批图片张数上限。
 *
 * 预算是按**图片张数**算的，不是按子图数：一个密窗口的 4/9/16 张子图只出**一张**图片，
 * 而一张图片约 384 token（单图封顶）且与里面几张子图无关。所以"多少帧画面"不决定钱，"多少张图片"才决定。
 */
export const DEFAULT_MAX_SHEETS = 10;
/** 整片最多交付多少张图（跨所有批次），这是真正的花钱上限。 */
export const DEFAULT_MAX_TOTAL_SHEETS = 100;
/** 网格上限（4x4）。 */
export const MAX_GRID = 4;
/** 一个 0.1 秒间隔内最多插几个时刻：防单帧极端跳变插出上百个。 */
export const MAX_CROSS_PER_PAIR = 16;
/** 判硬切的最小单帧跳变（面积占比）。 */
export const CUT_EDGE = 0.5;
/** 硬切要求邻域安静：前一个间隔低于 edge 的这个比例。 */
export const CUT_QUIET = 0.3;
/**
 * 噪声底的天花板（面积占比）。
 *
 * 噪声底的作用是扣掉颗粒、压缩噪声这种"一直在微微变化"的本底，所以它必须很小。
 * 不设上限的话，一条**全程都在动**的片子（每帧 3% 面积变化）会把 p10 算成 3%，
 * 扣完什么都不剩 —— 整片一帧都抽不出来。
 */
export const NOISE_FLOOR_CEIL = 0.02;

/** 网格阶数对应的标签。 */
const GRID_LABEL = { 1: '单帧', 2: '2x2', 3: '3x3', 4: '4x4', 0: '切点×2' };

/**
 * 升序副本。
 *
 * @param values - 输入。
 * @returns 排好序的新数组。
 */
function sortedCopy(values) {
  return [...values].sort((a, b) => a - b);
}

/**
 * 取分位数（输入必须已升序）。
 *
 * @param sorted - 升序数组。
 * @param p - 0 到 1。
 * @returns 分位值；空数组返回 0。
 */
export function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const clamped = Math.min(Math.max(Number(p) || 0, 0), 1);
  const index = Math.round(clamped * (sorted.length - 1));
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}

/**
 * 噪声底：低于它的变化当成"没动"（死区，不是相减）。
 *
 * 为什么是死区而不是减去：一条全程都在动的片子，每帧 3% 面积变化时 p10
 * 也是 3%，相减会把真实运动扣成 0；死区只过滤"恰好落在噪声量级"的帧，
 * 高于它的帧按原值计入累积量。
 *
 * 低分位只能用来估**小**噪声，所以结果封顶在 `NOISE_FLOOR_CEIL`。
 *
 * @param area - 逐帧面积变化分。
 * @param p - 分位，默认 0.1。
 * @returns 死区阈值。
 */
export function noiseFloor(area, p = 0.1) {
  return Math.min(NOISE_FLOOR_CEIL, percentile(sortedCopy(area), p));
}

/**
 * 积分：累积变化量每满 `a` 落一个时刻，然后清零。
 *
 * 为什么允许一个分析间隔里落多个时刻：0.1 秒内变了一整个画面时，
 * 那 0.1 秒装得下 3 个 `a`。禁止的话抽帧密度天花板就是分析帧率（10 帧/秒），
 * 一个硬切只能留一帧、看不出"切之前那个画面"。时刻用线性插值落在间隔内部，
 * 取帧时按原视频帧率重取。
 *
 * `multiCross: false` 时一个间隔最多落一个，**多余的变化量丢弃**（不是顺延）。
 *
 * @param params - 参数。
 * @param params.area - 逐帧面积变化分（0~1）。
 * @param params.scanFps - 分析帧率。
 * @param params.a - 阈值（满屏变化次数）。
 * @param params.floor - 噪声底。
 * @param params.multiCross - 是否允许一个间隔内多个时刻。
 * @param params.cap - 单个间隔最多几个时刻。
 * @returns 升序时刻数组（秒）。
 */
export function integrateMoments(params) {
  const { area } = params;
  const fps = Number(params.scanFps) > 0 ? Number(params.scanFps) : 10;
  const a = Math.max(1e-4, Number(params.a) || DEFAULT_A);
  const floor = Math.max(0, Number(params.floor) || 0);
  const multi = params.multiCross !== false;
  const cap = Math.max(1, Math.floor(Number(params.cap) || MAX_CROSS_PER_PAIR));
  const list = Array.isArray(area) ? area : [];
  const times = [];
  let acc = 0;

  for (let index = 0; index < list.length; index += 1) {
    const raw = Number(list[index]) || 0;
    // 死区：不高于噪声底的变化直接当 0，高于的按原值计入（不相减）。
    if (raw <= floor) continue;
    const value = raw;
    // `area[index]` 描述的是第 index-1 帧到第 index 帧之间的变化，所以这一段
    // 覆盖 [(index-1)/fps, index/fps]；落点必须按这个区间插值，不能整体后移一格。
    const origin = Math.max(0, index - 1);

    if (!multi) {
      if (acc + value >= a) {
        const need = a - acc;
        times.push((origin + need / value) / fps);
        acc = 0;
      } else {
        acc += value;
      }
      continue;
    }

    let consumed = 0;
    let guard = 0;
    while (acc + (value - consumed) >= a && guard < cap) {
      consumed += a - acc;
      acc = 0;
      times.push((origin + consumed / value) / fps);
      guard += 1;
    }
    acc += value - consumed;
  }
  return times;
}

/**
 * 找硬切：变化集中在一个 0.1 秒间隔内、且前后都安静。
 *
 * 判定必须收紧。只按"变化大"判，快速渐变转场（持续 0.2~0.8 秒）会被当成硬切，
 * 取前后两帧就把转场过程整个抹掉 —— 那正是最该看的部分。实测 232 秒的运动片
 * 里 80 处跳变中有 51 处（64%）是跨多个间隔的渐变转场。
 *
 * @param area - 逐帧面积变化分。
 * @param scanFps - 分析帧率。
 * @param options - 选项。
 * @param options.edge - 单帧跳变下限，默认 0.5。
 * @param options.quiet - 邻居安静阈值（相对 edge），默认 0.3。
 * @returns `{ time, index, before, after }` 数组。
 */
export function detectHardCuts(area, scanFps, options = {}) {
  const list = Array.isArray(area) ? area : [];
  const fps = Number(scanFps) > 0 ? Number(scanFps) : 10;
  const edge = Math.max(0.01, Number(options.edge) || CUT_EDGE);
  const quiet = edge * Math.max(0, Number(options.quiet ?? CUT_QUIET));
  const cuts = [];

  for (let index = 0; index < list.length; index += 1) {
    const value = Number(list[index]) || 0;
    if (value < edge) continue;
    // 前一帧必须是这条曲线的上升沿，否则是一段连续运动里的某一帧。
    if (index > 0 && (Number(list[index - 1]) || 0) >= value) continue;
    const before = index > 1 ? Number(list[index - 2]) || 0 : 0;
    const after = index + 1 < list.length ? Number(list[index + 1]) || 0 : 0;
    if (before > quiet || after > quiet) continue;

    // 变化落在第 index-1 帧与第 index 帧之间：index-1 是出镜头的最后一帧，
    // index 是入镜头的第一帧。归窗用区间中点，正好 1.0 秒处的切点才不会被
    // 边界条件推到下一个窗口去。
    const outTime = Math.max(0, index - 1) / fps;
    const inTime = index / fps;
    cuts.push({ time: (outTime + inTime) / 2, index, before: outTime, after: inTime });
  }
  return cuts;
}

/**
 * 由密度选网格阶数：n=1 单帧，2~4 用 2、5~9 用 3、10 以上用 4。
 *
 * @param count - 窗口内的时刻数。
 * @returns 1 / 2 / 3 / 4。
 */
export function gridFor(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n <= 1) return 1;
  return Math.min(MAX_GRID, Math.ceil(Math.sqrt(n)));
}

/**
 * 按 `t` 秒窗口给时刻分桶。
 *
 * 窗口边界固定对齐到 `t` 的整数倍，不随 `from` 漂移 —— 否则同一部片换个
 * 起止时间就会得到不同的拼图切法。
 *
 * @param moments - 时刻数组。
 * @param t - 窗口长度（秒）。
 * @param from - 窗口起（秒）。
 * @param to - 窗口止（秒）。
 * @returns 窗口数组。
 */
export function windowsOf(moments, t, from, to) {
  const width = Math.max(0.05, Number(t) || DEFAULT_T);
  const map = new Map();
  for (const moment of moments) {
    if (moment < from - 1e-9 || moment > to + 1e-9) continue;
    const key = Math.floor(moment / width);
    const bucket = map.get(key);
    if (bucket === undefined) map.set(key, [moment]);
    else bucket.push(moment);
  }
  return [...map.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([key, list]) => ({
      index: key,
      start: key * width,
      end: (key + 1) * width,
      moments: list.sort((a, b) => a - b),
    }));
}

/**
 * 生成整段的采样计划。
 *
 * 预算用 `a` 反解：帧数超上限就抬 `a` 再走一遍（不超过 10 次二分）。
 * 抬 `a` 而不是砍尾巴，因为"抽稀"要全局一致，否则前密后疏会骗过读者。
 *
 * @param params - 参数。
 * @param params.duration - 视频时长（秒）。
 * @param params.scanFps - 分析帧率。
 * @param params.area - 逐帧面积变化分（0~1）。旧字段 `scores` 会在 0~255 量纲下被识别并换算。
 * @param params.a - 阈值（满屏变化次数），默认 0.3。
 * @param params.t - 密度窗口（秒），默认 1。
 * @param params.maxGap - 强制补帧间隔（秒），默认 5；0 表示不补。
 * @param params.multiCross - 是否允许一个间隔内多个时刻，默认 true。
 * @param params.cutPair - 硬切是否取前后两帧，默认 false。
 * @param params.maxSheets - **每批图片张数**上限，默认 10（analysis 10 / understand 20）。密窗口的多张子图只算一张图片。
 * @param params.maxTotalSheets - **整片**图片张数上限，默认 100，这才是花钱的天花板。
 * @param params.overflow - 超预算时的做法：`'thin'`（全局抬 `a` 变稀）/ `'stop'`（看到上限就停，后面的内容不看）。

 * @param params.from - 起（秒）。
 * @param params.to - 止（秒）。
 * @returns `{ frames, groups, stats }`。
 */
export function planFrames(params) {
  const duration = Math.max(0, Number(params.duration) || 0);
  const scanFps = Number(params.scanFps) > 0 ? Number(params.scanFps) : 10;
  const t = Math.max(0.05, Number(params.t) || DEFAULT_T);
  const a = Math.max(1e-4, Number(params.a) || DEFAULT_A);
  const maxGap = Math.max(0, Number(params.maxGap ?? DEFAULT_MAX_GAP));
  const multiCross = params.multiCross !== false;
  const cutPair = params.cutPair === true;

  const from = Math.min(Math.max(Number(params.from) || 0, 0), duration);
  const to = Math.min(Math.max(Number.isFinite(params.to) ? params.to : duration, from), duration);

  // 兼容旧调用：scores 是 0~255 的均值差，area 是 0~1 的面积占比。
  let area = Array.isArray(params.area) ? params.area : null;
  if (area === null && Array.isArray(params.scores)) {
    area = params.scores.map((value) => Math.max(0, Math.min(1, (Number(value) || 0) / 255)));
  }
  const series = area ?? [];
  const floor = Number.isFinite(Number(params.floor)) ? Math.max(0, Number(params.floor)) : noiseFloor(series);
  // 只统计窗口内的变化量：全片总量配窗口阈值会得出"这个窗口变化很大"的假结论。
  const totalChange = series.reduce((sum, value, index) => {
    const time = Math.max(0, index - 1) / scanFps;
    if (time < from - 1e-9 || time > to + 1e-9) return sum;
    const raw = Number(value) || 0;
    return sum + (raw > floor ? raw : 0);
  }, 0);

  // 两个不同的上限，别再混：
  //   maxSheets      = **每批**交付几张图（由 mode 决定，解析 10 / 理解 20）
  //   maxTotalSheets = **整片**最多几张图（跨所有批次，默认 100），这才是花钱的天花板
  // 一张图片约 384 token（单图封顶）且与子图数无关，所以图片张数才是钱；子图数只是中间量。
  const maxSheets = Math.max(1, Math.floor(Number(params.maxSheets) || DEFAULT_MAX_SHEETS));
  const maxTotalSheets = Math.max(1, Math.floor(Number(params.maxTotalSheets) || DEFAULT_MAX_TOTAL_SHEETS));

  // 超预算的两种做法：thin = 整体变稀（密度形状保留）；stop = 看到上限就停。
  const overflow = params.overflow === 'stop' ? 'stop' : 'thin';

  /**
   * 把这批分组折成几张图。
   *
   * 现在计划分组与图是**一一对应**的：密窗口一张、单帧一张、切点一张。
   * 所以张数就是分组数，不再有"装箱"这一层。
   *
   * @param groups - 计划分组。
   * @returns 图片张数。
   */
  const sheetsOf = (groups) => groups.length;

  const cuts = detectHardCuts(series, scanFps);

  /**
   * 给定阈值，走完"时刻 → 补帧 → 窗口 → 子图"整条链。
   *
   * @param threshold - 阈值。
   * @returns `{ groups, moments, fillers }`。
   */
  const build = (threshold) => {
    const raw = integrateMoments({ area: series, scanFps, a: threshold, floor, multiCross });
    const moments = [];
    const fillers = [];
    let last = from;
    const consider = (time, filler) => {
      if (time < from - 1e-9 || time > to + 1e-9) return;
      if (filler) fillers.push(time);
      else moments.push(time);
    };

    // 强制补帧：相邻时刻（含片头）超过 maxGap 就在中间插一帧。
    if (maxGap > 0) {
      for (const moment of raw) {
        while (moment - last > maxGap) {
          last += maxGap;
          consider(last, true);
        }
        consider(moment, false);
        last = moment;
      }
      while (to - last > maxGap) {
        last += maxGap;
        consider(last, true);
      }
    } else {
      for (const moment of raw) consider(moment, false);
    }

    const windows = windowsOf([...moments, ...fillers], t, from, to);
    const fillerSet = new Set(fillers.map((time) => time.toFixed(6)));
    const groups = [];

    for (const window of windows) {
      const real = window.moments.filter((moment) => !fillerSet.has(moment.toFixed(6)));
      const cut = cuts.find((item) => item.time >= window.start && item.time < window.end);
      const k = gridFor(real.length);

      // 硬切窗口：取前后两帧。
      //
      // 只在 cutPair 打开时走这条，而且 `detectHardCuts` 已经要求"单间隔跳变 +
      // 前后都安静"，所以渐变转场（跨多个间隔）永远不会命中 —— 那些窗口仍然按
      // 密度取 k*k 个均匀帧，转场过程完整保留。
      if (cutPair && cut !== undefined) {
        groups.push({
          kind: 'cut',
          k: 0,
          label: GRID_LABEL[0],
          start: Math.max(from, cut.before),
          end: Math.min(to, cut.after),
          cutTime: cut.time,
          cells: [
            { time: Math.max(from, Math.min(to, cut.before)), role: 'before' },
            { time: Math.max(from, Math.min(to, cut.after)), role: 'after' },
          ],
        });
        continue;
      }

      if (k <= 1) {
        const time = real.length > 0 ? real[0] : window.moments[0];
        if (time === undefined) continue;
        const clamped = Math.max(from, Math.min(to, time));
        groups.push({
          kind: 'single',
          k: 1,
          label: GRID_LABEL[1],
          start: clamped,
          end: clamped,
          cells: [{ time: clamped, role: 'single' }],
        });
        continue;
      }

      // 密窗口：按 k*k 均匀重取，子图间距严格相等。
      const cells = [];
      const step = t / (k * k);
      for (let cellIndex = 0; cellIndex < k * k; cellIndex += 1) {
        const time = Math.min(to, window.start + (cellIndex + 0.5) * step);
        if (time < from) continue;
        cells.push({ time, role: 'grid' });
      }
      if (cells.length === 0) continue;
      groups.push({
        kind: 'grid',
        k,
        label: GRID_LABEL[k],
        start: window.start,
        end: window.end,
        cells,
      });
    }

    groups.sort((left, right) => left.start - right.start);
    // 相邻窗口可能被 maxGap 补帧切成同一个人工碎块，合并同标签的相邻小窗口
    return { groups, moments: moments.length, fillers: fillers.length };
  };

  // 补帧本身就有下限：只靠 maxGap 补出来的图数若已超过预算，就是自相矛盾，
  // 按更硬的那条走（并如实标 budgetRaised）。
  const floorSheets = sheetsOf(build(Number.MAX_SAFE_INTEGER).groups);
  const budgetRaised = floorSheets > maxTotalSheets;
  const cap = Math.max(maxTotalSheets, floorSheets);

  let attempt = build(a);
  let aEff = a;
  let truncated = false;
  if (overflow === 'stop') {
    // 停：不抬阈值，按时间顺序留前 N 张，后面的内容干脆不看。
    if (sheetsOf(attempt.groups) > cap) {
      const all = attempt.groups;
      let kept = all;
      for (let count = all.length; count >= 0; count -= 1) {
        if (sheetsOf(all.slice(0, count)) <= cap) {
          kept = all.slice(0, count);
          break;
        }
      }
      truncated = kept.length < all.length;
      attempt = { ...attempt, groups: kept };
    }
  } else if (sheetsOf(attempt.groups) > cap) {
    // 稀：抬 `a` 重算，直到张数进预算。**不能按索引隔一张丢一张** ——
    // 那种丢法会把补帧点一起删掉（maxGap 的承诺当场失效），还会把一段长静止
    // 整段删空，而且没有任何字段说它发生了。抬阈值是全局一致的：
    // 变化大的地方仍然比静的地方密，只是整体稀一档。
    const ceiling = maxGap > 0 ? Number.MAX_SAFE_INTEGER / 2 : Math.max(a, totalChange);
    let low = a;
    let high = Math.min(Math.max(a * 16, (totalChange / Math.max(1, cap)) * 1.5, a + 0.5), ceiling);
    let best = null;
    let bestThreshold = high;
    // 先保证 high 自己进预算：补帧下限就是可达到的最小张数，所以一定收敛。
    for (let guard = 0; guard < 40; guard += 1) {
      const trial = build(high);
      if (sheetsOf(trial.groups) <= cap) {
        best = trial;
        bestThreshold = high;
        break;
      }
      low = high;
      if (high >= ceiling) break;
      high = Math.min(high * 2, ceiling);
    }
    if (best !== null) {
      // 二分回找"刚好进预算"的最小阈值：同样的钱，密度别浪费。
      for (let iteration = 0; iteration < 16; iteration += 1) {
        const mid = (low + high) / 2;
        const trial = build(mid);
        if (sheetsOf(trial.groups) > cap) {
          low = mid;
        } else {
          high = mid;
          best = trial;
          bestThreshold = mid;
        }
      }
      aEff = bestThreshold;
      attempt = best;
    }
  }

  const groups = attempt.groups;

  const frames = [];
  for (const group of groups) {
    for (const cell of group.cells) {
      frames.push({
        time: cell.time,
        role: cell.role,
        kind: group.kind,
        k: group.k,
        label: group.label,
        windowStart: group.start,
        windowEnd: group.end,
        group,
      });
    }
  }
  frames.sort((left, right) => left.time - right.time);

  // 覆盖到哪、有没有留下没看的部分。没截断时整段窗口都看过了（最差的空洞由 maxGap 兜着），
  // 所以 coveredTo 就是 to；`stop` 截断时它是最后一个交付窗口的结束，剩下的时间是**没看过**的。
  const coveredTo = truncated ? Math.min(to, Math.max(from, groups.length === 0 ? from : groups[groups.length - 1].end)) : to;
  const unseenSeconds = Math.max(0, to - coveredTo);

  // 间隔按"从 from 到 coveredTo 的整条覆盖线"算，含片头与片尾两段：
  // 只算帧与帧之间会漏掉"第一帧离片头多远""最后一帧之后空了多久"。
  const gaps = [];
  let previousTime = from;
  for (const frame of frames) {
    gaps.push(Math.max(0, frame.time - previousTime));
    previousTime = frame.time;
  }
  gaps.push(Math.max(0, coveredTo - previousTime));
  const mean = gaps.length === 0 ? 0 : gaps.reduce((sum, value) => sum + value, 0) / gaps.length;
  for (let index = 0; index < frames.length; index += 1) {
    const next = index + 1 < frames.length ? frames[index + 1].time : coveredTo;
    frames[index].interval = Math.max(0, next - frames[index].time);
    frames[index].tier = { key: frames[index].label, label: frames[index].label };
  }

  const maxInterval = gaps.length === 0 ? 0 : Math.max(...gaps);
  // 窗口粒度会把帧在窗口内前后挪最多 `t`，所以判定给 `t` 的余量。
  // 超出余量的空洞是真实缺陷（thin 的"隔一张丢一张"就是 5 秒变 8 秒），必须如实报。
  const maxGapBroken = maxGap > 0 && maxInterval > maxGap + t + 1e-6;
  const thinned = aEff > a * (1 + 1e-9);

  const tiles = groups.filter((group) => group.kind === 'grid').length;
  const singles = groups.filter((group) => group.kind === 'single').length;
  const cutGroups = groups.filter((group) => group.kind === 'cut').length;

  return {
    frames,
    groups,
    stats: {
      count: frames.length,
      moments: attempt.moments,
      fillers: attempt.fillers,
      tiles,
      singles,
      cutPairs: cutGroups,
      cuts: cuts.length,
      cutHits: cutGroups,
      a,
      aEff,
      scale: a > 0 ? aEff / a : 1,
      t,
      maxGap,
      multiCross,
      cutPair,
      maxSheets,
      maxTotalSheets,
      batches: Math.max(1, Math.ceil(sheetsOf(groups) / maxSheets)),
      sheets: sheetsOf(groups),
      overflow,
      truncated,
      videoComplete: !truncated,
      coveredTo,
      unseenSeconds,
      budgetRaised,
      thinned,
      maxGapBroken,
      floorSheets,
      noiseFloor: floor,
      totalChange,
      from,
      to,
      meanInterval: mean,
      minInterval: gaps.length === 0 ? 0 : Math.min(...gaps),
      maxInterval,
    },
  };
}

/**
 * 预算可行性：这段窗口按现在的密度**完整**看下来要几张、物理下限几张、够不够。
 *
 * 这是 `video_plan` 的预算检查：`required > max` 就是"不够"，调用方必须停下来问用户，
 * 不能拿一个悄悄变稀或悄悄截断的计划继续走。
 *
 * @param params - 与 `planFrames` 相同的参数。
 * @returns `{ max, required, minimum, feasible, full, truncate, density }`。
 */
export function planFeasibility(params) {
  const max = Math.max(1, Math.floor(Number(params?.maxTotalSheets) || DEFAULT_MAX_TOTAL_SHEETS));
  // 不设上限跑一遍 = "该模式密度原样铺满整段"，这才是"够不够"的基准。
  const full = planFrames({ ...params, maxTotalSheets: Number.MAX_SAFE_INTEGER });
  const required = full.stats.sheets;
  // 补帧下限：只靠 maxGap 也得这么多张，低于它预算无论如何都做不到。
  const minimum = full.stats.floorSheets;
  const feasible = required <= max;
  return {
    max,
    required,
    minimum,
    feasible,
    full,
    truncate: feasible ? null : planFrames({ ...params, maxTotalSheets: max, overflow: 'stop' }),
    density: feasible ? null : fitDensity({ ...params, maxTotalSheets: max }),
  };
}

/**
 * 算一个"能塞进预算、且覆盖全段"的密度：先抬 `a`，抬到补帧下限顶破预算时再抬 `t`。
 *
 * 为什么要抬 `t`：`a` 只减少"变化时刻"，压不下补帧点的数量；把窗口放宽，
 * 补帧点会并进同一张图，下限才降得下来。
 *
 * @param params - 与 `planFrames` 相同的参数。
 * @returns `{ plan, a, t }`；连 `t` 放到 120 秒都塞不下时返回 `null`。
 */
export function fitDensity(params) {
  const max = Math.max(1, Math.floor(Number(params?.maxTotalSheets) || DEFAULT_MAX_TOTAL_SHEETS));
  let t = Math.max(0.05, Number(params?.t) || DEFAULT_T);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const plan = planFrames({ ...params, t, overflow: 'thin', maxTotalSheets: max });
    if (plan.stats.sheets <= max) return { plan, a: plan.stats.aEff, t };
    t *= 1.5;
    if (t > 120) break;
  }
  return null;
}

/**
 * 把整片的图按时间顺序切成若干批。
 *
 * 为什么要分批：一次性把几十张图丢给模型，总结质量会掉；分小批、逐批总结更稳。
 * 切法**按图张数**，不按时间等分 —— 这样每批都是连续的一段，批与批之间不留空洞。
 *
 * @param groups - 完整计划分组（按时间升序）。
 * @param batchSize - 每批最多几张图。
 * @param index - 要取第几批（1 开始）。
 * @returns `{ slice, meta }`，meta 里的 next 为 0 表示没有下一批。
 */
export function batchOf(groups, batchSize, index = 1) {
  const list = Array.isArray(groups) ? groups : [];
  const size = Math.max(1, Math.floor(Number(batchSize) || DEFAULT_MAX_SHEETS));
  const total = Math.max(1, Math.ceil(list.length / size));
  const asked = Math.floor(Number(index) || 1);
  // 越界直接报错，不做"夹紧"。原因：夹紧会让 batch=99 悄悄返回最后一批，
  // 而返回值里带着 done=true，模型会把"跳批"误当成"全片看完"，最后交一份
  // 少了大半内容的总结，而且没人知道少了。宁可让这次调用失败。
  if (asked < 1 || asked > total) {
    throw new Error(
      `batch ${asked} is out of range: this video has ${total} batch(es), numbered 1-${total}` +
        (asked < 1 ? '. Omit batch to get the first one.' : `. Call again with batch=${Math.min(asked, total)} or continue from batch.next.`),
    );
  }
  const wanted = asked;
  const start = (wanted - 1) * size;
  const slice = list.slice(start, start + size);
  const first = slice[0];
  const last = slice[slice.length - 1];
  return {
    slice,
    meta: {
      index: wanted,
      total,
      size,
      sheets: list.length,
      from: first === undefined ? 0 : first.start,
      to: last === undefined ? 0 : last.end,
      next: wanted < total ? wanted + 1 : 0,
      batchDone: wanted >= total,
    },
  };
}

/**
 * 把分组压成一份"密度地图"：连续同标签的窗口并成一段。
 *
 * @param groups - `planFrames` 的分组。
 * @param options - 选项。
 * @param options.maxRuns - 最多几段，默认 14。
 * @returns `{ label, from, to, count, interval }` 数组。
 */
export function densityMap(groups, options = {}) {
  const list = Array.isArray(groups) ? groups : [];
  if (list.length === 0) return [];
  const maxRuns = Math.max(1, Math.floor(options.maxRuns ?? 14));

  const runs = [];
  for (const group of list) {
    const firstCell = group.cells?.[0]?.time ?? group.start;
    const lastCell = group.cells?.[group.cells.length - 1]?.time ?? group.end;
    const last = runs[runs.length - 1];
    if (last !== undefined && last.label === group.label) {
      last.to = Math.max(last.to, lastCell);
      last.count += group.cells.length;
      last.first = Math.min(last.first, firstCell);
      last.last = Math.max(last.last, lastCell);
    } else {
      runs.push({
        label: group.label,
        key: group.kind,
        from: group.start,
        to: lastCell,
        count: group.cells.length,
        first: firstCell,
        last: lastCell,
      });
    }
  }

  while (runs.length > maxRuns) {
    let shortest = 0;
    for (let index = 1; index < runs.length; index += 1) {
      if (runs[index].count < runs[shortest].count) shortest = index;
    }
    const previous = runs[shortest - 1];
    const next = runs[shortest + 1];
    if (previous === undefined && next === undefined) break;
    const target =
      previous === undefined ? next : next === undefined ? previous : previous.count >= next.count ? previous : next;
    const victim = runs[shortest];
    target.from = Math.min(target.from, victim.from);
    target.to = Math.max(target.to, victim.to);
    target.count += victim.count;
    target.first = Math.min(target.first, victim.first);
    target.last = Math.max(target.last, victim.last);
    runs.splice(shortest, 1);
  }

  return runs.map((run) => ({
    label: run.label,
    from: run.from,
    to: run.to,
    count: run.count,
    // 间隔要按"第一张子图到最后一张"实测，不能拿窗口跨度除以子图数：
    // 一串单帧窗口的跨度是 0，除出来就是 0，印成 `every 100/s`。
    interval: run.count > 1 ? (run.last - run.first) / (run.count - 1) : 0,
  }));
}
