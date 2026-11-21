# 看视频插件 · 架构与运行流程

> 插件 id：`video-watching`　包名：`dsh-video-watching`　入口：`index.js`
> 本文描述**当前实现**，不是设计稿。凡写"现在"的地方都与代码一致。

---

## 一、它解决什么问题

普通的视频理解插件按固定间隔抽帧（比如每 2 秒一张）。两条路都不好：

- 间隔大：快剪、动效、转场全被跳过去，看到的和实际片子不是一回事。
- 间隔小：静止的聊天镜头也被逐秒抽，token 全花在没变化的地方。

这个插件改的是**采样决策**：先扫全片算一条"画面变化曲线"，只在变化攒够的地方落帧；一秒内落了多个帧就拼进一张小图；看不清的再用 `video_closeup` 单独取原分辨率。

核心约束一句话：**一张图固定约 384 token，所以"交付几张图"就是钱，"多少格画面"不是。**

---

## 二、三层参数（谁能改什么）

| 层 | 定义位置 | 谁能改 | 模型可见 |
|---|---|---|---|
| 工具参数 | `lib/tools.js` 的 schema | 模型每次调用可传 | 是 |
| 预设 | `lib/orchestrate.js` 的 `PRESETS` | 只由改代码 | 否 |
| 配置 | profile 的 `cordis.patch.yml` | 只有用户 | 否 |

**优先级只有两级：配置（写了就生效）> 预设（默认值）。中间没有"工具参数"这一层。**

采样口径（`a`、`t`、`maxGap`、`multiCross`、`cutPair`、`maxSheets`、`overflow`）**不在工具参数里**：模型传不进来，传了会被 Agent 的 schema 校验拒掉。这是刻意的，理由见第七节。

### 2.1 工具参数

| 工具 | 参数 | 必填 |
|---|---|---|
| `video_watch` | `input` `preset` `userConfirmed` `batch` `from` `to` `burn` `transcriptFile` | `input` `preset` `userConfirmed` |
| `video_plan` | `input` `preset` `userConfirmed` `from` `to` | 同上 |
| `video_closeup` | `input` `times` `burn` | `input` `times` |

`userConfirmed` 是模式确认门禁：不是 `true` 就直接抛错，不扫描、不出图、不花钱。

### 2.2 预设

| 参数 | `analysis` | `understand` | 含义 |
|---|---|---|---|
| `a` | 0.3 | 1 | 攒够几个满屏变化落一帧 |
| `t` | 1 秒 | 1.5 秒 | 密度窗口：窗口内时刻数决定网格阶数 |
| `maxGap` | 5 秒 | 6 秒 | 超过这么久没帧就强制补一帧 |
| `multiCross` | true | true | 允许一个 0.1 秒间隔落多个时刻 |
| `cutPair` | false | false | 硬切取前后两帧（一张图 2 格） |
| `maxSheets` | 10 | 20 | **每批**图片张数 |

### 2.3 配置（25 项长期 + 6 项采样覆盖）

| 组 | 键 |
|---|---|
| 二进制 | `ffmpegPath` `ffprobePath` |
| 扫描口径 | `scanFps`(10) `longSide`(120) `block`(4) `blockThreshold`(8) |
| 输出 | `quality`(3) `burn`(time) `fontFile` |
| 字幕 | `transcriptCommand`([]) |
| 缓存 | `cacheDir` `cacheMaxEntries`(200) |
| 超时 | `timeoutMs`(180000) `toolTimeoutMs`(900000) `graceMs`(2000) |
| 预算 | `maxTotalSheets`(100) `overflow`(stop) |
| 采样覆盖 | `a` `t` `maxGap` `multiCross` `cutPair` `maxSheets`（默认 `null` = 跟随预设） |
| 语音 | `speechMode`(auto) `speechModelDir` `sherpaPath` |
| BGM | `bgmMode`(auto) `bgmModel` `bgmKeyEnv` `bgmChunkSeconds`(30) `bgmMaxChunks`(24) |

---

## 三、模块地图

| 文件 | 行数 | 职责 |
|---|---|---|
| `index.js` | 50 | 只留入口：`apply` / `inject` / 再导出 |
| `lib/config.js` | 155 | 配置归一化、路径与默认值 |
| `lib/tools.js` | 473 | 三个工具的定义（schema 与执行体） |
| `lib/orchestrate.js` | 510 | 编排：探测→扫描→计划→切批→出图→音视频→组装 |
| `lib/scan.js` | 196 | 全片扫描，产出逐帧变化曲线 |
| `lib/plan.js` | 524 | 时刻积分、硬切、补帧、分窗、网格、预算、`batchOf` |
| `lib/delivery.js` | 48 | 计划分组 → 交付图片（1:1） |
| `lib/grid.js` | 126 | 拼图合成、token 估算、尺寸规则 |
| `lib/ffmpeg.js` | 373 | 探测、取帧（含 ffprobe 缺失时的退回路径） |
| `lib/audio.js` | 628 | 本地语音识别 + 云端 BGM 分析 |
| `lib/cache.js` | 99 | 扫描曲线缓存与淘汰 |
| `lib/render.js` | 153 | 返回值 → 内容块 |
| `lib/util.js` | 257 | 字幕读取、时间码、并发、杂项 |
| `lib/time.js` | 188 | 时间码解析与切片 |

依赖方向是单向的：`index → orchestrate → {plan, scan, grid, delivery, audio, ffmpeg, util} → time/cache`。`render` 与 `tools` 只依赖数据形状。

---

## 四、主流程（一次 `video_watch` 的 13 步）

```
① 门禁 → ② 解析参数 → ③ 探测 → ④ 查缓存 → ⑤ 扫描 → ⑥ 积分成时刻
   → ⑦ 找硬切 → ⑧ 补帧 → ⑨ 分窗成格 → ⑩ 总量预算 → ⑪ 切批
   → ⑫ 出图 → ⑬ 语音/BGM → ⑭ 起名渲染落盘
```

| 步 | 代码位置 | 做什么 | 花钱/耗时 |
|---|---|---|---|
| ① 门禁 | `orchestrate.js` `executeWatch` | `userConfirmed !== true` 抛错 | 0 |
| ② 参数 | `config.js` + `effectiveArgs` | 预设 + 配置 → 采样口径 | 0 |
| ③ 探测 | `ffmpeg.js` `probeVideo` | 时长/分辨率/帧率/音轨/字幕轨 | 一次 ffprobe 或 `ffmpeg -i` |
| ④ 缓存 | `cache.js` `readCache` | 键 = 路径+大小+mtime+扫描参数 | 0 |
| ⑤ 扫描 | `scan.js` | 10 fps 抽帧 → 缩到 120 px → 4×4 块 → 逐块亮度差 → 变化曲线 | 解码全片，长片首次数分钟 |
| ⑥ 积分 | `plan.js` `integrateMoments` | 扣噪声底，累计够 `a` 落一个时刻 | 0 |
| ⑦ 硬切 | `plan.js` `detectHardCuts` | 单间隔跳变 + 前后安静 | 0 |
| ⑧ 补帧 | `plan.js`（`maxGap`） | 相邻时刻超 `maxGap` 就在中间插一帧 | 0 |
| ⑨ 分窗成格 | `plan.js` `windowsOf` + `gridFor` | 按 `t` 分窗；窗口内时刻数 → 1/2×2/3×3/4×4 | 0 |
| ⑩ 总量预算 | `plan.js` | 超 `maxTotalSheets` 时 `stop` 截断 / `thin` 变稀 | 0 |
| ⑪ 切批 | `plan.js` `batchOf` | 每 `maxSheets` 张一批，`batch` 取第几批 | 0 |
| ⑫ 出图 | `ffmpeg.js` + `grid.js` | 取帧、拼 1440p 拼图、JPEG | 并发取帧，几秒 |
| ⑬ 语音/BGM | `audio.js` | 本地 ASR（本批范围）+ 云端 BGM（本批切片） | 本地约 2 秒；云端按秒计费 |
| ⑭ 组装 | `orchestrate.js` + `render.js` | 每张图的 `title`、文本块、附件、写缓存 | 0 |

**三个工具的终点不同**：

| 工具 | 停在 | 视觉 token |
|---|---|---|
| `video_plan` | 第 ⑩ 步 | 0（不出图） |
| `video_watch` | 第 ⑭ 步 | 每张 384 |
| `video_closeup` | 第 ③ 步 + 按 `times` 取原帧 | 每帧 384 |

---

## 五、数据结构

### 5.1 计划（`plan.stats`）

```
count        子图总数（格数）
sheets       图片总数（一组=一张）
batches      总批数 = ceil(sheets / maxSheets)
tiles        拼图张数
singles      单帧张数
cutPairs     切点双帧张数
cuts         硬切点数
aEff         实际使用的阈值（预算收紧后可能远大于 a）
scale        aEff / a，>1 说明为了塞进预算而变稀了
budgetRaised 预算被 maxGap 顶穿（floorSheets > maxTotalSheets）
truncated    被 stop 截断
coveredTo    截断后覆盖到第几秒
maxInterval  实际最大间隔
```

### 5.2 一张图（sheet）

```
sheet    批内序号         global  全片序号
from/to  时间范围（绝对）  title   覆盖这段时间的口播/字幕（可选）
cols/rows 网格阶数        width/height  像素
tokens   384（封顶）      image  附件引用
```

三种形态：`single`（1 格）、`grid`（4/9/16 格）、`cut`（2 格，切点前后）。

### 5.3 一批（batch）

```
index  第几批（1 起）      total  共几批
size   每批张数上限        sheets 整片图片总数
from/to 本批时间范围       next   下一批编号（0 = 没下一批）
done   是否最后一批
```

**批次号越界直接报错**，不做夹紧（见第八节）。

---

## 六、失败模式与降级

| 情况 | 行为 |
|---|---|
| 路径不存在 / 不是视频 | 抛错，不返回空结果 |
| 没有 ffprobe | 退回解析 `ffmpeg -i` 的 stderr |
| 某些帧取不出来 | 跳过并计入 `skipped`，不整单失败 |
| 一张图都取不出 | 抛错 |
| 语音模型缺失 | `speech.status = unavailable`，写进 `<note>` |
| 没有 API key / 云端失败 | `bgm.status = unavailable`，写进 `<note>`，**绝不把"没分析"写成"没有声音"** |
| 超出总预算 | `stop` 截断 / `thin` 变稀，如实写 `truncated`、`coveredTo` |
| 批次号越界 | **抛错**，写明范围与下一步 |
| 附件服务返回数量不符 | 抛错，拒绝部分交付 |

---

## 七、为什么采样口径不进工具参数

三个理由，都是踩过的：

1. **模型会顺手改**。曾经在调用里传了 `maxSheets: 12`，报告里却写成"插件默认行为"，用户无法分辨。
2. **改了就没法复现**。同一支片子两次调用得到不同密度的图，而参数不在返回值里，事后无从追溯。
3. **费用不可控**。`a` 从 0.3 改成 0.05 会让图数涨十倍，而用户看不见这个动作。

现在唯一的改动路径是配置或改预设，两者都留痕。

---

## 八、已修与待修

### 已修

- 模式门禁：`userConfirmed` 必须为 `true`，覆盖 `video_plan` 与 `video_watch`。
- 分批交付：`maxSheets` 从"整片总量"改成"每批张数"，新增 `maxTotalSheets`。
- 语音/BGM 按批裁剪（此前每批都把整片重复分析一遍，音频量是 7 倍）。
- 每张图带时间范围与全片序号。
- 语音作为图片标题（`title`），不烧进画面。
- **批次号越界报错**（此前是静默夹紧，会把"跳批"伪装成"看完了"）。

### 待修（需用户确认后动手）

1. **截断在正文里不吭声**：`plan.truncated` / `coveredTo` 只存在于字段，`render.js` 没输出。模型看到 `done=true` 会以为看完了。
2. **预算收紧后不再补 `maxGap`**：`thin` 走"隔一张丢一张"时，间隔会翻倍（实测 5 秒承诺变成 8.16 秒），且不报 `maxGapBroken`。
3. **`thin` 的丢法不均匀**：按索引隔一丢一，长静止段可能被整段删掉。
4. **`budgetRaised` 语义模糊**：只在 `floorSheets > maxTotalSheets` 时为 true，不含"被 thin 抽稀"的情况。

---

## 九、成本模型

- 每张图 ≈ 384 token（与格数无关）
- 解析模式每批 10 张 = 3.8k token；理解模式每批 20 张 = 7.7k token
- 整片上限 100 张 ≈ 38.4k token
- 音频：本地语音 0 成本；BGM 按音频秒数计费，实测 1 小时 ≈ ¥0.45
- 扫描：免费，但首次要解码全片（缓存后为 0）

---

## 十、文件落点

| 内容 | 位置 |
|---|---|
| 插件本体 | `F:\Agent\DeepseekHarness\dsh-video-watching\` |
| 扫描缓存 | profile 配置的 `cacheDir`（当前指向 `Data-of-skill-plugin\agent-data\cache\video-watching`） |
| 临时目录 | `%TEMP%\dsh-video-watching-*`，`finally` 里删除 |
| 交付图片 | DSH attachments 目录 |
| 测试与脚本 | `test\`、`scripts\`（`npm test` / `contract` / `real` / `smoke`） |
