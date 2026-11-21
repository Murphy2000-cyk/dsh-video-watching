/**
 * presets.js —— 两套采样预设。
 *
 * 单独成文件是因为"预算可行性"和"执行计划"都要读它们，而前者不能反向依赖
 * `orchestrate.js`（会成环）。
 *
 * 这里的值是**默认值**：profile 配置里写了同名键就以配置为准（`effectiveArgs`）。
 *
 * @module dsh-video-watching/presets
 */

/**
 * 两套参数预设。**必须由调用方明确选择**，代码不替用户猜。
 *
 *   - `analysis`：识别动画、运镜、特效。密度按"看清手法"给（a=0.3），
 *     硬切可以取前后两帧，每批交付也小一点。
 *   - `understand`：只认视频讲了什么。密度按"看懂内容"给（a=1），窗口放宽到 1.5 秒、
 *     静止段容忍 6 秒间隔，每批能装 20 张。
 */
export const PRESETS = {
  analysis: { a: 0.3, t: 1, maxGap: 5, multiCross: true, cutPair: false, maxSheets: 10 },
  understand: { a: 1, t: 1.5, maxGap: 6, multiCross: true, cutPair: false, maxSheets: 20 },
};

/**
 * 取一套预设；名字不认识时退回 `analysis`。
 *
 * @param name - 预设名。
 * @returns 预设对象。
 */
export function presetOf(name) {
  return PRESETS[name] ?? PRESETS.analysis;
}

/**
 * 把 preset 与配置合成一份生效的采样参数。
 *
 * 采样口径只由"预设 + 配置"决定，**不读调用参数**：工具 schema 里没有这几个字段，
 * 插件这一层也不给覆盖的口子。配置里写了值就以配置为准（用户改配置 = 用户改参数），
 * `null` / 缺省表示跟随预设。
 *
 * @param args - 工具入参（只取 `preset`）。
 * @param cfg - 归一化后的配置。
 * @returns `{ a, t, maxGap, multiCross, cutPair, maxSheets }`。
 */
export function effectiveArgs(args, cfg = {}) {
  const preset = presetOf(args?.preset);
  const pick = (key) => (cfg[key] === null || cfg[key] === undefined ? preset[key] : cfg[key]);
  return {
    a: pick('a'),
    t: pick('t'),
    maxGap: pick('maxGap'),
    multiCross: pick('multiCross'),
    cutPair: pick('cutPair'),
    maxSheets: pick('maxSheets'),
  };
}
