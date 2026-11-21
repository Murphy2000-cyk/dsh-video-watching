# 看视频插件 · 架构与运行流程

> 插件 id：`video-watching`　包名：`dsh-video-watching`　入口：`index.js`　版本：0.9.2
> 本文描述**当前实现**。凡写"现在"的地方都与代码一致。

---

## 一、它解决什么问题

普通的视频理解插件按固定间隔抽帧（比如每 2 秒一张）。两条路都不好：

- 间隔大：快剪、动效、转场全被跳过去，看到的和实际片子不是一回事。
- 间隔小：静止的聊天镜头也被逐秒抽，token 全花在没变化的地方。

这个插件改的是**采样决策**：先扫全片算一条"画面变化曲线"，只在变化攒够的地方落帧；一秒内落了多个帧就拼进一张小图；看不清的再用 `video_closeup` 单独取原分辨率。

核心约束一句话：**一张图固定约 384 token，所以"交付几张图"就是钱，"多少格画面"不是。**

## 二、职责只有两段：plan 先行 + watch 执行

| 段 | 工具 | 干什么 | 能不能动预算 |
|---|---|---|---|
| 定稿 | `video_plan` | 扫描、算计划、判 `maxTotalSheets` 够不够、给选项、落快照、发 `planId` | **只有这里动预算** |
| 执行 | `video_watch` | 凭 `planId` 取快照、按批取帧拼图、交附件与音频 | **完全不看预算** |
| 补看 | `video_closeup` | 按时间码取原分辨率单帧 | 无关 |

为什么要把预算从执行段拿走：

1. **钱要在开工前说清**。"够不够看完"是个二值判断，藏在执行段里就只能表现为"悄悄变稀"或"悄悄截断"，而这两种都会让模型把半份内容当成全片。
2. **决定必须有人签字**。预算不够时 plan 不返回 `planId`，watch 就没有入口 —— 这把"先问用户"从口头约定变成了结构约束。
3. **快照让计划可复现**。watch 按快照里的 `a`/`t`/`maxGap`/`limit` 重算，算出来必须与定稿时一致；配置在两步之间被改，就要求重新 plan。

## 三、三层参数

| 层 | 定义位置 | 谁能改 | 模型可见 |
|---|---|---|---|
| 工具参数 | `lib/tools.js` 的 schema | 模型每次调用可传 | 是 |
| 模式 | `lib/modes.js` 的 `MODES` | 只由改代码 | 否 |
| 配置 | profile 的 `cordis.patch.yml` | 只有用户 | 否 |

**优先级只有两级：配置（写了就生效）> 模式（自带默认值）。中间没有"工具参数"这一层。**

采样口径（`a`、`t`、`maxGap`、`multiCross`、`cutPair`、`maxSheets`）**不在工具参数里**：模型传不进来，传了会被 Agent 的 schema 校验拒掉。这是刻意的，理由见第八节。

### 3.1 工具参数

| 工具 | 参数 | 必填 |
|---|---|---|
| `video_plan` | `input` `mode` `userConfirmed` + `from` `to` + `choice{id,budget?,a?,t?}` | `input` `mode` `userConfirmed` |
| `video_watch` | `input` `planId` + `batch` `burn` `transcriptFile` | `input` `planId` |
| `video_note` | `input` `planId` `batch` `note` | 全部必填 |
| `video_closeup` | `input` `times` `burn` | `input` `times` |

`userConfirmed` 是**模式选择开关**：不是 `true` 就直接抛错，不扫描、不出图、不花钱。
`planId` 是**预算凭据**：没有它 watch 直接抛错，因为没人事先论证过"这段看完要几张图"。

### 3.2 模式

| 参数 | `analysis` | `understand` | 含义 |
|---|---|---|---|
| `a` | 0.3 | 1 | 攒够几个满屏变化落一帧 |
| `t` | 1 秒 | 1.5 秒 | 密度窗口：窗口内时刻数决定网格阶数 |
| `maxGap` | 5 秒 | 6 秒 | 超过这么久没帧就强制补一帧 |
| `multiCross` | true | true | 允许一个 0.1 秒间隔落多个时刻 |
| `cutPair` | false | false | 硬切取前后两帧（一张图 2 格） |
| `maxSheets` | 10 | 20 | **每批**图片张数（只影响切批） |

### 3.3 配置（33 项）

| 组 | 键 |
|---|---|
| 二进制 | `ffmpegPath` `ffprobePath` |
| 扫描口径 | `scanFps`(10) `longSide`(120) `block`(4) `blockThreshold`(8) |
| 输出 | `quality`(3) `burn`(time) `fontFile` |
| 字幕 | `transcriptCommand`([]) |
| 缓存 | `cacheDir` `cacheMaxEntries`(200) |
| 观看记录 | `record`(true) `recordDir`(~/Desktop) |
| 超时 | `timeoutMs`(180000) `toolTimeoutMs`(900000) `graceMs`(2000) |
| 预算 | `maxTotalSheets`(100) `overflow`(stop，只决定 plan 的推荐项) |
| 采样覆盖 | `a` `t` `maxGap` `multiCross` `cutPair` `maxSheets`（默认 `null` = 跟随模式） |
| 语音 | `speechMode`(auto) `speechModelDir` `sherpaPath` |
| BGM | `bgmMode`(auto) `bgmModel` `bgmKeyEnv` `bgmChunkSeconds`(30) `bgmMaxChunks`(24) |

## 四、模块地图

| 文件 | 行数 | 职责 |
|---|---|---|
| `index.js` | 70 | 入口：`apply` / `inject` / 再导出 |
| `lib/modes.js` | 59 | 两套模式与 `effectiveArgs` |
| `lib/config.js` | 212 | 配置归一化、路径与默认值 |
| `lib/tools.js` | 604 | 四个工具的定义（schema 与执行体） |
| `lib/orchestrate.js` | 765 | 探测→扫描→初判/定稿→取帧→拼图→音视频→记录→组装 |
| `lib/feasibility.js` | 238 | 预算检查：`required`/`minimum`/四选项/`choice` 解析 |
| `lib/plans.js` | 205 | 计划快照：哈希、落盘、校验、淘汰 |
| `lib/record.js` | 259 | 观看记录：文档头、批次追加、分析补写 |
| `lib/plan.js` | 736 | 积分法采样、补帧、分窗、预算、`planFeasibility`、`fitDensity` |
| `lib/scan.js` | 255 | 全片扫描，产出逐帧变化曲线 |
| `lib/grid.js` | 161 | 拼图合成、token 估算、尺寸规则 |
| `lib/delivery.js` | 66 | 计划分组 → 交付分组、成本 |
| `lib/render.js` | 293 | 返回值 → 内容块（含 budget/options/coverage 正文） |
| `lib/cache.js` | 127 | 扫描曲线缓存与淘汰 |
| `lib/audio.js` | 700 | 本地语音识别 + 云端 BGM 分析 |
| `lib/ffmpeg.js` | 452 | 探测、取帧、拼图、字幕导出 |
| `lib/util.js` | 312 | 字幕读取、时间码、并发、杂项 |
| `lib/time.js` | 232 | 时间码解析与切片 |

依赖方向是单向的：`index → orchestrate → {feasibility, plan, scan, grid, delivery, audio, ffmpeg, util} → plans/modes → time/cache`。

## 五、主流程

### 5.1 `video_plan` 初判（预算够不够）

```
① 模式选择 → ② 探测 → ③ 扫描（缓存优先）→ ④ 按模式密度算 required
       → ⑤ 算补帧下限 minimum → ⑥ required ≤ maxTotalSheets ?
```

| 步 | 代码位置 | 做什么 |
|---|---|---|
| ① 模式选择 | `executePlan` | `userConfirmed !== true` 直接抛错（没问过用户就不开工） |
| ② 探测 | `ffmpeg.js probeVideo` | 时长/分辨率/帧率/音轨/字幕轨；无 ffprobe 时退 `ffmpeg -i` |
| ③ 扫描 | `scan.js` + `cache.js` | 10 fps 抽帧 → 缩到 120 px → 4×4 块 → 逐块亮度差；键含路径/大小/mtime/全部扫描口径 |
| ④ required | `plan.js planFrames` | 不设上限跑一遍 = "该模式密度铺满整段要几张" |
| ⑤ minimum | 同上 | `a→∞` 只剩 maxGap 补帧时的张数，即物理下限 |
| ⑥ 判定 | `feasibility.js` | `required ≤ max` 为够 |

够：落快照、发 `planId`，正文写"可以 watch 了"。
不够：**不发 `planId`**，给 `budget` 块与 `options`：

| 选项 | 含义 | 结果 |
|---|---|---|
| `raise` | 抬预算到 `required`（一次性，只进快照） | 全片、原密度 |
| `truncate` | 保持预算、按时间顺序截断 | `videoComplete=false`，`coveredTo` 给到哪 |
| `understand` | 换低密度档重算 | 可能仍不够，那就再报一轮选项 |
| `density` | 算出一组能进预算的 `a'`/`t'`（先抬 a，下限顶破时再抬 t） | 全片覆盖、更稀 |

### 5.2 `video_plan` 定稿（用户选完）

```
choice → 解析采样与 limit → 重算计划 → 校验进预算 → 落快照 → planId
```

- `raise` 的 `budget` 是**一次性**的，不写 profile。
- `density` 用 `fitDensity` 算出的 `a'`/`t'`（也接受 `choice.a`/`choice.t` 覆盖）。
- 仍然不够时抛错，并列出剩余选项。

### 5.3 `video_watch` 执行

```
① planId → 读快照 → ② 校验（文件/扫描口径）→ ③ 探测+扫描
→ ④ 按快照重算计划并比对 → ⑤ 切批 → ⑥ 取帧 → ⑦ 拼图 → ⑧ 交附件
→ ⑨ 字幕 → ⑩ 语音/BGM → ⑪ 定标题 → ⑫ 渲染 → ⑬ 观看记录
```

| 步 | 细节 | 花钱/耗时 |
|---|---|---|
| ① 快照 | `plans.js readPlan`，不存在就要求重新 plan | 0 |
| ② 校验 | 路径、大小、mtime、扫描口径；预算与密度**不校验**（它们是快照自己定的） | 0 |
| ③ 探测+扫描 | 与 plan 同一份缓存 | 命中则 0 |
| ④ 重算比对 | 张数与 `coveredTo` 必须与快照一致，否则拒绝交付 | 0 |
| ⑤ 切批 | `batchOf(groups, snapshot.maxSheets, batch)`；越界报错 | 0 |
| ⑥ 取帧 | 每格一次 `ffmpeg -ss … -frames:v 1`，并发 4；失败计入 `skipped` | 几秒 |
| ⑦ 拼图 | `ffmpeg -vf tile=colsxrows:padding=4` | 每张一条命令 |
| ⑧ 交附件 | 返回引用数不符就抛错，拒绝部分交付 | 0 |
| ⑨ 字幕 | `transcriptFile` → 内嵌轨 → `transcriptCommand` → none | 视情况 |
| ⑩ 语音/BGM | 本地 SenseVoice（60 秒一片）+ 云端 BGM（30 秒一片） | 本地约 2 秒；云端按秒 |
| ⑪ 标题 | 口播与字幕里与这张图重叠的句子，截 42 字进 `sheet.title` | 0 |
| ⑫ 渲染 | `renderWatch`：文本 + N 张图片 | 0 |
| ⑬ 记录 | `record.js appendBatch`：本批的图组成、时间码、语音、BGM 追加进 Markdown；`video_note` 再补模型分析 | 0 |

## 六、数据结构

### 6.1 快照（`plans/<id>.json`）

```
input size mtimeMs duration from to mode
a t maxGap multiCross cutPair maxSheets
scanFps longSide block blockThreshold
resolution limit sheets coveredTo createdAt
```

`id = sha1(字段按固定顺序拼接).slice(0,16)`；内容与 id 不自洽的快照一律不认。

### 6.2 预算块（`value.budget`）

```
required   按模式密度铺满整段要几张
minimum    保 maxGap 的物理下限
max        配置里的 maxTotalSheets
feasible   required ≤ max
sheets/tokens/coveredTo/unseenSeconds/batches   当前计划的估计
```

### 6.3 计划统计（`value.plan`）

```
count sheets batches tiles singles cutPairs cuts cutHits
a aEff scale t maxGap multiCross cutPair maxSheets maxTotalSheets overflow
truncated videoComplete coveredTo unseenSeconds budgetRaised thinned maxGapBroken floorSheets
noiseFloor totalChange meanIntervalSeconds minIntervalSeconds maxIntervalSeconds from to
```

### 6.4 一张图（sheet）

```
sheet 批内序号     global 全片序号     from/to 时间范围     title 口播/字幕（可选）
cols/rows 网格      width/height 像素    tokens 384          image 附件引用
```

三种形态：`single`（1 格）、`grid`（4/9/16 格）、`cut`（2 格，切点前后）。

### 6.5 一批（batch）

```
index total size sheets from to next batchDone videoComplete
```

`batchDone` = 计划里的最后一批；`videoComplete` = 整片是否真的看完了。截断方案下前者真、后者假。

### 6.6 观看记录（`<recordDir>/<视频名>.观看记录.md`）

`video_plan` 定稿时写文档头（规格、计划、预算）；`video_watch` 每交付一批就追加一节：

```
## 批次 i / total · from–to
- 图片：N 张 · 画面 M 幅 · 抽取失败 K 幅
### 时间与图片组成     每张图：全局序号 / 起止 / 网格 / 格数 / tokens / 子图时间码 / 台词
### 语音             本地 ASR 逐句，带起止
### BGM              逐片标签 + 变化点 + 音效 + 检索词
### 内容 / 剪辑手法 / 风格 / 动画
<!-- 待补分析 <planId> 批次 i -->      ← video_note 用（planId, batch）精确替换
```

- 标记带 `planId`：同一部片子跑第二轮时，两轮的同一批不会互相覆盖。
- `record: false` 时三个入口都不写；`video_note` 直接报错，不静默成功。
- 写文档失败不让 watch 失败：记录是旁路。

## 七、失败模式与降级

| 情况 | 行为 |
|---|---|
| 路径不存在 / 不是视频 | 抛错 |
| 没有 ffprobe | 退回解析 `ffmpeg -i` 的 stderr |
| 没有 `userConfirmed` | plan 抛错，一步都不走 |
| 没有 `planId` / 快照被淘汰 | watch 抛错，要求重新 plan |
| 文件或扫描口径变了 | watch 抛错，要求重新 plan |
| 重算结果与快照不符 | watch 抛错，不交"没被批准"的计划 |
| 某些帧取不出来 | 跳过并计入 `skipped`，不整单失败 |
| 一张图都取不出 | 抛错 |
| 语音模型缺失 | `speech.status = unavailable`，写进 `<note>` |
| 没有 API key / 云端失败 | `bgm.status = unavailable`，写进 `<note>`，**绝不把"没分析"写成"没有声音"** |
| 批次号越界 | **抛错**，写明范围与下一步 |
| 附件服务返回数量不符 | 抛错，拒绝部分交付 |
| 观看记录写不进去（磁盘/权限） | watch 照常交付；`record` 字段缺省，不把"没记录"当成"没看过" |
| 没看过就调 `video_note` | 抛错：记录文档还不存在 |

## 八、为什么采样口径与预算都不进工具参数

1. **模型会顺手改**。曾经在调用里传了 `maxSheets: 12`，报告里却写成"插件默认行为"，用户无法分辨。
2. **改了就没法复现**。同一支片子两次调用得到不同密度，而参数不在返回值里，事后无从追溯。
3. **费用不可控**。`a` 从 0.3 改成 0.05 会让图数涨十倍，而用户看不见这个动作。
4. **预算尤其不能由执行段决定**。"不够就变稀"会把"没看全"伪装成"看完了"。

现在唯一的改动路径是配置、模式，或 plan 阶段由用户签字的一次性 `choice`。

## 九、已修与待修

### 已修（0.8.0）

- **`preset` 改名为 `mode`**（不兼容）：工具参数、快照字段、输出里的 `plan.mode` 一并改；同时把预算处置方式从 `mode` 改名为 `resolution`（`full`/`raise`/`truncate`/`understand`/`density`），一个名字只留一个含义。快照版本升到 2，旧快照自动失效。
- **旧 `presets` 模块改名为 `lib/modes.js`**：`PRESETS` → `MODES`，`presetOf` → `modeOf`。
- **「交付单元」统一叫「批次」**（一条记录里一个概念只留一个名字）。
- 顺手删掉一个只有 BOM 的空文件 `lib/index.js`。

### 已修（0.7.0）

- 观看记录：`video_plan` 写文档头，`video_watch` 每批追加时间码、图片组成、语音、BGM，`video_note` 补模型分析；默认放桌面，`record`/`recordDir` 可配。
- 术语：把"门禁"统一改成"模式选择"/"预算凭据"等直白说法，工具描述与文档同步。
- 工具从 3 个变成 4 个；契约脚本、冒烟脚本同步覆盖 `video_note`。

### 已修（0.6.0）

- 预算判断从 watch 前移到 plan：不够就停、给四个带数字的选项，watch 必须凭 `planId` 执行。
- 计划快照与 `planId`：配置或文件在两步之间变化会要求重新 plan。
- `batchDone` 与 `videoComplete` 拆开，截断方案在正文里写清 `coveredTo` 与未看时长。
- `thin` 不再"隔一张丢一张"：抬阈值是全局一致的，且不破坏 `maxGap`（新增 `maxGapBroken` 字段兜底）。
- `density` 方案会把 `t` 一起放宽（补帧点能并进同一张图），否则补帧下限永远顶破预算。
- 未截断时 `coveredTo` 等于窗口终点，`unseenSeconds` 为 0（此前会谎报"只看到 55 秒"）。

### 已知限制

- `minimum` 可能高于 `maxTotalSheets`（`maxGap` 太小、预算太小）：此时 `density` 方案需要把 `t` 放宽到十几秒，画面会变得很稀。
- 计划快照存在 `cacheDir/plans/`，按 mtime 淘汰（200 个）；清缓存后旧的 `planId` 失效。
- 扫描仍是首次解码全片的瓶颈，缓存键变化（改 `scanFps`/`longSide`/`block`/`blockThreshold`）会触发重扫。

## 十、成本模型

- 每张图 ≈ 384 token（与格数无关）
- 解析模式每批 10 张 = 3.8k token；理解模式每批 20 张 = 7.7k token
- 整片上限由 `maxTotalSheets` 定（默认 100 ≈ 38.4k token）
- 音频：本地语音 0 成本；BGM 按音频秒数计费，实测 1 小时 ≈ ¥0.45
- 扫描：免费，但首次要解码全片（缓存后为 0）
- 预算检查本身只做纯计算，不额外解码

## 十一、文件落点

| 内容 | 位置 |
|---|---|
| 插件本体 | 仓库根目录（DSH 以插件包的形式加载，路径由 profile 决定） |
| 扫描缓存 | profile 配置的 `cacheDir`（当前指向 `Data-of-skill-plugin\agent-data\cache\video-watching`） |
| 计划快照 | 同目录下的 `plans\` |
| 观看记录 | `recordDir`（默认桌面）下的 `<视频名>.观看记录.md` |
| 临时目录 | `%TEMP%\dsh-video-watching-*`，`finally` 里删除 |
| 交付图片 | DSH attachments 目录 |
| 测试与脚本 | `test\`、`scripts\`（`npm test` / `contract` / `real` / `smoke`） |
