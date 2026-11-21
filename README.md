# dsh-video-watching

让 DSH 按**画面累计变化量**决定看多密：变化攒够了才取一帧，一秒攒够几次就把它们拼进同一张图片。

不是"每 N 秒一帧"，也不是"先抽满再去重"，而是把变化量当电量来攒 —— 安静处几秒才落一帧，猛变处一秒落好几帧，转场和硬切一定留痕。

## 它解决的问题

等分抽帧会把 20 秒的长镜头白白占掉 10 帧，同时跨过两处 0.3 秒的快闪；全量密采再删则慢到原片的 1.5 到 3 倍。

这里把"取帧密度"直接挂在"画面变了多少"上，并且让这个关系可算、可复现、可截断：

```
变化率低  ──  攒 0.3 个满屏变化要 8 秒  ──  8 秒一帧
变化率高  ──  攒 0.3 个满屏变化要 0.1 秒 ──  一秒十帧，拼 4x4
```

## 四个工具

| 工具 | 干什么 | 视觉 token |
|---|---|---|
| `video_plan` | 扫描并**判预算**：报时长、切点、密度地图、完整看完要几张图、`maxTotalSheets` 够不够。够了就给 `planId`；不够就给四条带数字的选项（抬预算 / 截断 / 换档 / 调 a、t） | **0** |
| `video_watch` | 凭 `planId` 执行已批准的计划，按批交付拼图 + 时间码清单 + 字幕 + 音频分析，并把这一批的组成写进观看记录 | 每张图 384（1440p 拼图 / 1080p 单帧） |
| `video_note` | 把模型对这一批的分析（内容、剪辑手法、风格、动画做法）补写进同一份观看记录 | **0** |
| `video_closeup` | 按时间码取回全分辨率单帧 | 384（原分辨率，单图封顶） |

顺序是硬的：**先 plan 拿到 `planId`，再 watch**。plan 就是"这支片子能不能完整看下来、要花多少钱"的第一关；watch 只执行，不再改预算或密度。图里某张子图糊得看不清，用 `video_closeup` 对着时间码取原图。

## 名词

四个层级，从上往下包：

| 名词 | 指什么 |
|---|---|
| **批次** | 一次 `video_watch` 交付回来的整批图。`maxSheets` 是每批**图片张数**的上限，`estimate.sheets` 是实际张数。 |
| **图片** | 喂给模型的一次视觉输入，一张图。里面可能只有一幅画面，也可能是一组拼图。每张 384 token。 |
| **拼图** | 由 `k×k` 幅画面按网格拼成的一张图片（2×2 / 3×3 / 4×4，硬切是 2×1）。 |
| **子图** | 拼进同一张图里、与其它幅尺寸相同的一幅画面。4×4 里就有 16 张子图。 |

这里的「画面」就是视频在某一时刻的一幅图，四个层级之外的最底层概念。

顺序是：批次 ⊃ 图片（= 单幅画面的单帧图 或 一组拼图）⊃ 子图。

**`maxSheets` 数的是图片，不是子图**：一个 4×4 拼图占 1 张图片，里面 16 张子图不另算钱。

## 采样计划是怎么算出来的

全在 `lib/plan.js` 里，纯函数，可离线断言。

1. **扫描**：整片解码一次，按 10 fps、长边 120 px 存成 raw RGB，逐帧算**面积变化分** `d`：
   画面切成 4×4 方块，块内平均色差超过 8/255 的方块占比，取值 0 到 1。
   `d = 0.12` 直接读作"12% 的画面变了"，和"累积变化量"是同一个量纲。
2. **死区**：低于噪声底的变化当 0，高于的按原值计入。噪声底取低分位（封顶 2%），
   只用来吃掉颗粒和压缩噪声。用"相减"会出事：一条全程每帧 3% 面积变化的片子，
   低分位也是 3%，相减后什么都不剩，整片一帧都抽不出来。
3. **积分**：累积变化量每满 `a` 落一个抽帧时刻，然后清零。**间隔天然等于 `a / 变化率`**，
   不需要 gamma 曲线去压。一个 0.1 秒间隔里攒得下几个 `a` 就落几个时刻（`multiCross`），
   时刻按 `d` 线性插值落在间隔内部；取帧时按**原视频帧率**重取，不受 10 fps 限制。
4. **补帧**：相邻时刻超过 `maxGap` 就在中间插一帧。没有这条，静态幻灯片会留下几十秒的空洞
   （实测 155 秒的讲解片，最大空洞 38 秒，全片只有 9% 的秒上有帧）。
5. **密度定网格**：每 `t` 秒数时刻个数 n —— `n=1` 单帧，`2~4` 用 2×2，`5~9` 用 3×3，`10+` 用 4×4。
6. **窗口内均匀重取**：拼图的**子图**按网格均匀取（`k×k` 张、间距 `t/k²`），不看时刻的具体位置，
   所以同一张拼图里每张子图的时间间隔严格相等。`n` 只负责选档位。
7. **硬切可选取前后两帧**：`cutPair` 打开时，对"单间隔瞬时跳变"取前一帧 + 后一帧。
   判定收得很紧（单帧跳变 ≥ 0.5 且前后两个间隔都低于 0.15），渐变转场永远不会命中 ——
   那些窗口仍然按密度取满子图，转场过程完整保留。
8. **预算在 plan 里判，不在取图时收**：按上面这套口径把整段铺满要的图片张数是 `required`，和配置里的 `maxTotalSheets` 比。够，就给 `planId` 让 watch 执行；不够，**不会**悄悄抬 `a` 或砍尾巴，而是把四条带数字的路交给你选。
   一整个 2×2/3×3/4×4 拼图只算**一张**图片，因为一张图约 384 token，跟里面几张子图无关 ——
   所以"多少帧画面"不决定钱，"多少张图片"才决定。

扫描结果按 `路径 + 大小 + 修改时间 + 分析帧率 + 分析尺寸 + 块参数` 缓存在配置的 `cacheDir`（默认 `~/.dsh/cache/video-watching/`）；定稿的计划快照存在同目录的 `plans/` 下。

## 两道检查：模式选择 + 预算

**第一道在 plan 之前**：`video_plan` 要求 `userConfirmed: true`，否则直接报错、**不扫描、不出图、不花钱**。因为"走解析还是走理解"是插件干活之前的第一个决定，不该等到取图那一步再定。

**第二道也在 plan 里**：plan 会按当前档位、按该模式的密度，算出**完整看完这段窗口需要多少张图**（`required`），和配置里的 `maxTotalSheets` 比。不够时它**不给 `planId`**，只给四条路，每条都带数字：

```
<budget required="128" minimum="96" max="100" feasible="false" .../>
<options>
  raise       128 sheets  full coverage  a=0.3 t=1  budget=128
  truncate    100 sheets  covers to 0:03:42, 88s unseen  a=0.3 t=1  budget=100
  understand   44 sheets  full coverage  a=1 t=1.5  budget=100
  density     100 sheets  full coverage  a=0.47 t=1.25  budget=100
</options>
```

模型必须把这些数字摆给用户，用户选一条，再带 `choice={"id":"..."}` 调一次 plan 定稿。**watch 没有 planId 就跑不起来**，所以"预算不够就悄悄变稀 / 悄悄截断"这条老路被堵死了。

`raise` 的预算是**一次性**的（只进快照，不改 profile）；想长期改就动配置里的 `maxTotalSheets`。

## 两种模式

**采样口径不在工具参数里。** `a` `t` `maxGap` `multiCross` `cutPair` `maxSheets`
这六个值模型传不进来：schema 里没有这些字段，传了会被 Agent 拒。它们只有两个来源：
模式（自带默认值）和 profile 配置（覆盖）。**模型只能选模式，不能改口径。**

`mode` 在 plan 时必填，代码不替用户猜：

| 模式 | `mode` | `a` | `maxGap` | `maxSheets`（每批） | 适用 |
|---|---|---|---|---|---|
| **视频解析** | `analysis` | `0.3` | `5` | `10` | 识别动画、运镜、特效：密度按"看清手法"给 |
| **视频理解** | `understand` | `1` | `6` | `20` | 只认视频主要内容：窗口放宽到 1.5 秒，容忍更长间隔 |

`cutPair` 两档都是关的；配置里打开后，硬切窗口会取前后两帧。

## 参数

三层：**工具参数**（模型每次可传）、**采样参数**（跟随模式，配置可覆盖）、**其余配置**（写 profile）。

### 工具参数

| 工具 | 参数 | 必填 | 说明 |
|---|---|---|---|
| `video_plan` | `input` `mode` `userConfirmed` | ✅ | 模式由用户定 |
| | `from` `to` | | 只看这一段（判够不够也按这段算） |
| | `choice` | | 用户选完方案后回填：`{id, budget?, a?, t?}`，`id` ∈ raise / truncate / understand / density |
| `video_watch` | `input` `planId` | ✅ | `planId` 由 plan 返回，没有就报错 |
| | `batch` `burn` `transcriptFile` | | 第几批 / 角标内容 / 外部字幕 |
| `video_note` | `input` `planId` `batch` `note` | ✅ | 这一批的分析（Markdown），写进观看记录 |
| `video_closeup` | `input` `times` | ✅ | 时间码，`12.5` 或 `"01:30"` |

### 采样参数（跟随 mode，配置可覆盖，模型传不进）

| 参数 | `analysis` | `understand` | 作用 |
|---|---|---|---|
| `a` | 0.3 | 1 | 攒够几个"满屏变化"落一帧，越小越密 |
| `t` | 1 | 1.5 | 密度窗口（秒），窗口内时刻数决定网格阶数 |
| `maxGap` | 5 | 6 | 超过这么多秒没取帧就强制补一帧；`0` 关闭 |
| `multiCross` | true | true | 允许一个 0.1 秒间隔里落多个时刻 |
| `cutPair` | false | false | 硬切取前后两帧 |
| `maxSheets` | **10** | **20** | **每批**图片张数上限；只影响切批，不影响总花费 |

### 配置参数（写 profile）

| 参数 | 默认 | 范围 | 作用 |
|---|---|---|---|
| `maxTotalSheets` | `100` | 1–5000 | **整片**图数上限，也是 plan 判"完整看完够不够"的唯一基准 |
| `overflow` | `stop` | `thin/stop` | 只影响 plan 的**推荐项**（`stop` 推荐截断、`thin` 推荐调 a/t），不再自动执行 |
| `scanFps` | `10` | 1–30 | 分析帧率，只影响变化率分辨率 |
| `longSide` | `120` | 32–480 | 分析图长边（1080p ÷ 16） |
| `block` / `blockThreshold` | `4` / `8` | 2–16 / 1–64 | 面积变化分的方块边长与块级阈值 |
| `quality` | `3` | 2–31 | JPEG 压缩质量 `-q:v`，越小越清晰；与「分辨率档位」是两件事 |
| `burn` | `time` | `time/index/none` | 烧进子图角标的时间码 / 序号 |
| `fontFile` | consolab.ttf | 路径 | 烧字字体 |
| `cacheDir` | `~/.dsh/cache/video-watching` | 绝对路径 | 扫描结果缓存位置 |
| `record` | `true` | true/false | 是否把每批的组成与音频分析写进观看记录 |
| `recordDir` | `~/Desktop` | 路径或 `desktop` | 观看记录（Markdown）放哪个目录 |
| `ffmpegPath` / `ffprobePath` | 自动解析 | 路径 | ffmpeg 位置 |
| `timeoutMs` / `toolTimeoutMs` / `graceMs` | 180000 / 900000 / 2000 | 毫秒 | 超时与终止宽限 |
| `transcriptCommand` | `[]` | 数组 | 外部转写命令 |
| `speechMode` | `auto` | off/auto | 本地语音识别开关：auto = 有依赖就做、没有就如实报不可用 |
| `speechModelDir` | `~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx` | 路径 | SenseVoice ONNX 模型目录 |
| `sherpaPath` | 空 | 路径 | 借用已有的 `sherpa-onnx-node`（空则按包名找） |
| `bgmMode` | `auto` | off/auto | BGM / 音效分析开关：off = 不上传音频 |
| `bgmModel` | `qwen3.8-omni-flash` | 模型名 | 云端模型 |
| `bgmKeyEnv` | `DASHSCOPE_AUDIO_API_KEY` | 变量名 | 密钥从哪个环境变量读 |
| `bgmChunkSeconds` | `30` | 5–120 | 片长，等于 BGM 变化点的时间精度 |
| `bgmMaxChunks` | `24` | 1–200 | 片数上限，超了均匀抽样并标注 `sampled` |
| `cacheMaxEntries` | `200` | 10–100000 | 扫描缓存最多留几个文件，超了按最久没写过的淘汰 |


> 采样口径的六个键（`a`/`t`/`maxGap`/`multiCross`/`cutPair`/`maxSheets`）在配置里是**可选覆盖**：不写（`null`）就跟随模式，写了就以配置为准。工具参数里没有它们，所以模型改不了。

## 分批交付（一个视频切成很多批次）

长片不是一次全给你，而是**按时间顺序切成若干批**，一批一批交付，你逐批总结：

```
第 1 批：0:00 - 0:10   10 张图
第 2 批：0:10 - 0:20   10 张图
...
第 7 批：1:00 - 1:05    4 张图
```

调用 `video_watch` 时**不传 `batch`** 就是第一批；返回里带一段：

```
<batch index="1" total="7" size="10" sheets="64" from="0:00" to="0:10" next="2" batchDone="false" videoComplete="true"/>
<next>This is batch 1 of 7. Summarise it now, then call video_watch again with planId="…" and batch=2 ...</next>
```

- `total` = 这个视频一共几批；`next` = 下一批的编号（0 表示已是最后一批）
- `batchDone` = 计划里最后一批；`videoComplete` = 整片是否都计划到了。**两者要分开读**：截断方案下 `batchDone=true` 而 `videoComplete=false`，正文会同时写清 `coveredTo` 与未看时长
- 每批的张数由 `maxSheets` 决定（解析 10 / 理解 20）
- 整片总量在 plan 那一步就已经卡过了；watch 不再看 `maxTotalSheets`

**必须按顺序、在同一个会话里逐批看。** 上下文连贯靠会话本身：前面几批的返回留在对话里，
后面的批次才能接着理解。如果分批丢给子代理或换会话，连贯性就断了。

**不要一次性把所有批次都拉下来**——那样等于又回到"一次看太多"，总结质量会掉，这正是分批要避免的。

## 观看记录（Markdown）

每看一批，插件就把这一批**量得到的东西**写进文档：批次起止、每张图的网格与 token、每张子图的时间码、台词、语音转写、BGM 标签与检索词。模型对这一批的判断（在讲什么、怎么剪的、什么风格、动画怎么做的）由 `video_note` 补进同一段的占位处 —— 事实与判断分开写，谁也不冒充谁。

```
桌面\video.观看记录.md

# video.mp4 · 观看记录
- 规格：64.85 秒 · 1920×1080 · 30 fps · 有音轨 · 0 条字幕轨
- 计划：`bc54410fdcc7a3f5` · 模式 视频解析 · a=0.3 t=1s · 每批最多 10 张
- 预算：64 张图 ≈ 24576 tokens · 覆盖 0:00.000–1:04.850 · 共 7 批

## 批次 1 / 7 · 0:00.000–0:10.000
- 图片：10 张 · 画面 47 幅 · 抽取失败 0 幅
### 时间与图片组成
- **图 1**（全局 1）0:00.000–0:01.000 · 4×4 · 16 格 · 384 tokens
  - 子图时间：0:00.031、0:00.094、…
  - 台词：剪映用的爽吧 / 字幕识别快
### 语音
- [0:00.240–0:04.380] 剪映用的爽吧…
### BGM
- 0:00.000–0:10.000 · prominent / 电子 / 快 / 欢快 — 节奏感强烈…
### 内容 / 剪辑手法 / 风格 / 动画
（video_note 写进来的分析）
```

- 默认路径：`~/Desktop/<视频名>.观看记录.md`；`recordDir` 可以改。
- 同一部片子换计划再跑一次，会追加"新一轮分析"，不覆盖上一轮。
- `record: false` 可以整体关掉；关掉之后 `video_note` 会直接报错，而不是悄悄什么都不写。
- 写文档失败**不会**让取图失败：记录是旁路，交付是主路。

## 拼图与 token

一张图片花多少 token 取决于像素，不取决于里面几张子图。按 42px 网格算 `rows × (cols+1) + 2`，地板 192、天花板 384。

分辨率档位是**按档定死**的，不靠预算逼近：

| 形态 | 单张子图 | 整张图片 | token |
|---|---|---|---|
| 1×1（单帧） | 1920×1080（1080p） | 1920×1080 | 384 |
| 2×2 | 1280×720（720p） | 2560×1440（1440p） | 384 |
| 3×3 | 852×478（≈480p） | 2556×1434（≈1440p） | 384 |
| 4×4 | 640×360（360p） | 2560×1440（1440p） | 384 |
| 2×1（切点前后） | 1280×720 | 2560×720 | 384 |

四档整图都顶到单图 token 天花板，所以**升档不额外花钱**；钱只跟"有几张图片"有关，而 **图片张数 = 分组数**（密窗口一张、单帧一张、切点一张）。

实测（`node scripts/smoke.mjs <视频>`）：

| 片子 | 形态 | 子图 | 图片 | token |
|---|---|---|---|---|
| 24 秒测试片（黑场 / 运动 / 8 次硬切） | 默认 `a=0.3`，`maxSheets=40`（不触顶） | 95 | 17 | 6528 |
| 同上 | `maxSheets=3`，`maxGap=0` | 3 | 3 | 1152 |
| 同上 | `maxSheets=3 + overflow stop` | 12 | 3 | 1152 |
| 同上 | `cutPair` 开 | 79 | 17 | 6528 |
| 同上 | `a=1.5` | 17 | 14 | 5376 |
| 11 秒 1080p 测试片 | 默认 `a=0.3` | 18 | 2 | 768 |

对照旧版（800×450 一张 233 token）：**同样的张数，换档之后成本约 +65%**，换来的是 4×4 每张子图从 200×112 变成 **640×360**、2×2 从 400×225 变成 **1280×720**。

## 安装

**必需**：`ffmpeg`。

**可选**（不准备也能用，只是对应能力会关掉，并在返回里如实说明）：

| 想要 | 需要准备 | 不准备会怎样 |
|---|---|---|
| 本地语音识别 | `sherpa-onnx-node` + SenseVoice ONNX 模型 | 语音那一路报 `unavailable`，字幕与 BGM 不受影响 |
| BGM / 音效分析 | 环境变量 `DASHSCOPE_AUDIO_API_KEY` | BGM 那一路报 `unavailable` |
| 烧时间码 | 带 `drawtext` 的 ffmpeg + 存在的字体文件 | 自动关掉烧字，清单里会说明 |

```bash
dsh plugin --profile web add dsh-video-watching
```

装完**重启 `dsh web`**。不重启的话工具列表里看不到新参数，老会话会一直用启动时加载的那份 schema。

`ffprobe` 有就更好（拿结构化元数据最准），**没有也能跑**：缺它的时候探测退回解析 `ffmpeg -i` 打印的元数据。只装过 `pip install imageio-ffmpeg` 的环境就属于"有 ffmpeg、没有 ffprobe"，这条路是特意留的。

### 换一台电脑 / 换一个 profile

按这个顺序凑齐，缺哪样就只丢对应的能力，不会整个不可用：

1. **Node ≥ 20**（`package.json` 的 `engines` 要求）。
2. **ffmpeg**。查找顺序：配置 `ffmpegPath` → `DSH_FFMPEG_PATH` / `FFMPEG_PATH` → `~/.dsh/bin/ffmpeg/` → winget 的 Links 目录 → PATH。往 PATH 里加目录要重启 Agent 才生效，所以插件会先自己看一眼那几个常见位置。
3. **（可选）`sherpa-onnx-node`**：本地语音的推理引擎，原生包，**不作为插件的硬依赖**。两种办法：
   - 装进插件目录：`cd <插件目录> && npm install sherpa-onnx-node`
   - 或者借用机器上已有的那份，用配置 `sherpaPath` 指向它的目录（本机就是借用 DSH 安装里的）。
4. **（可选）SenseVoice 模型**：一个目录，至少两个文件。

   | 文件 | 大小 | 来源 |
   |---|---|---|
   | `model.int8.onnx` | 239,233,841 B（约 228 MB） | `https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`（同仓库的 `model.onnx` 是 fp32 版，937 MB，不需要） |
   | `tokens.txt` | 315,894 B | 同一个仓库 |

   放到 `speechModelDir` 指向的目录（默认 `~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx`）。
   **最省事的办法**：装过 DSH 自带语音输入的机器上，这份模型已经在那个默认路径了，整目录复制过去即可。
5. **（可选）密钥**：环境变量 `DASHSCOPE_AUDIO_API_KEY`，值到阿里云百炼控制台申请（地域选华北2北京，BGM 用 `qwen3.8-omni-flash`）。**只放环境变量**，不要写进 profile，更不要提交到仓库。

配好之后**重启 `dsh web`**。然后记住两件事：

- **同一个 profile 里的所有会话都能用**，不需要每个对话重装；
- **换一个 profile 要在那个 profile 里再装一次**（补丁是按 profile 挂的）。

## 配置

写在 profile 的 `cordis.patch.yml` 里。下面这份是**照抄就能跑**的最小配置，其余都注释着备查：

```yaml
- id: video-watching
  name: dsh-video-watching
  config:
    overflow: stop          # 超预算时：stop = 看到上限就停；不写则 thin = 全片变稀
    # 采样密度由调用的 mode 决定，配置里不设 a / t / maxGap / maxSheets
    # ffmpegPath: D:/ffmpeg/bin/ffmpeg.exe      # 也认 DSH_FFMPEG_PATH / FFMPEG_PATH
    # ffprobePath: D:/ffmpeg/bin/ffprobe.exe
    # scanFps: 10             # 分析帧率（1–30）
    # longSide: 120           # 分析图长边（32–480）
    # block: 4                # 面积变化分的方块边长（2–16）
    # blockThreshold: 8       # 块级阈值（1–64，0–255 量纲）
    # quality: 3              # JPEG -q:v，2 最好 / 31 最差
    # burn: time              # time / index / none
    # fontFile: C:/Windows/Fonts/consolab.ttf   # 非 Windows 上没有该文件，会自动关掉烧字
    # cacheDir: F:/Data/video-watching     # 默认 ~/.dsh/cache/video-watching
    # cacheMaxEntries: 200    # 缓存最多留几个文件，超了按最久没写过的淘汰
    # record: true            # 每批的图片组成 / 语音 / BGM 写进 Markdown 观看记录
    # recordDir: desktop      # 记录放哪：desktop（默认）或一个绝对路径
    # speechMode: auto        # off / auto：本地语音识别
    # speechModelDir: ~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx
    # sherpaPath: C:/somewhere/node_modules/sherpa-onnx-node
    # bgmMode: auto           # off / auto：off 则不上传音频
    # bgmModel: qwen3.8-omni-flash
    # bgmKeyEnv: DASHSCOPE_AUDIO_API_KEY
    # bgmChunkSeconds: 30     # 片长，等于 BGM 变化点的时间精度
    # bgmMaxChunks: 24        # 片数上限，超了均匀抽样
    # transcriptCommand: ["D:/asr/.venv/Scripts/python.exe", "D:/asr/run.py", "{input}", "--out", "{output}"]
```

扫描缓存默认落在 `~/.dsh/cache/video-watching/`，可用 `cacheDir` 改到任意绝对路径（目录会自动创建）；缓存按「路径+大小+修改时间+分析帧率+分析尺寸+块参数」失效，改视频或改分析参数都会重算。

烧字需要这份 ffmpeg 带 `drawtext`（Gyan 等完整构建有，`imageio_ffmpeg` 那种精简构建没有）。探不到就自动关掉烧字，并在清单里如实说明。

## 字幕

它**不自带 ASR 引擎**，音频这条路走现成的，按代价从低到高：

1. `transcriptFile` 传入 SRT / VTT / JSON（`[{start,end,text}]` 或 whisper 的 `{segments:[...]}`）
2. 没传就读视频内嵌字幕轨，导出成 SRT 再解析
3. 再没有就跑 `transcriptCommand` 配的外部转写命令
4. 都没有就是 `transcript: none`

三条路都带毫秒级时间码，并与画面窗口对齐；解析结果会**按时间排序**，乱序的字幕文件不会把先后说反。

外部命令只收**数组**，不收字符串：

```yaml
config:
  transcriptCommand:
    - D:/asr/.venv/Scripts/python.exe
    - D:/asr/run.py
    - "{input}"
    - --out
    - "{output}"
```

理由是字符串要走 shell 才带得动占位符，而路径里的空格、引号、`&` 在 shell 里各有各的坏法。数组由 Agent 直接交给子进程服务，不经过任何 shell，`{input}` / `{output}` 在**元素级别**替换。两个占位符缺一个，这条配置就不生效。

命令失败**不会瞒着**：清单里会写 `transcript: none (transcript command failed: ...)`，而不是装作"本来就没台词"。


## 音频

音频分两块，各走各的路，互不依赖：

| 块 | 走哪 | 给什么 | 花钱 |
|---|---|---|---|
| **语音** | 本地 sherpa-onnx + SenseVoice int8（CPU，0 显存） | 逐句文本 + 词级时间戳 | 0 |
| **BGM / 音效** | 云端 `qwen3.8-omni-flash` | 风格 / 速度 / 情绪 / 乐器 / 听感 / 检索词 | 约 ¥0.5 每小时音频 |

三个词先说清楚：**语音**（说的话）、**BGM**（背景音乐）、**音效**（非音乐的突发声）。

BGM 不给时间戳，时间轴由插件切片决定；"风格有没有变"是**相邻片枚举比对**出来的，不问模型。

`musicMood` 指的是**音乐的情绪**（温暖/紧张/宏大…），不是说话人的情绪；说话人的情绪不输出。

**密钥只从环境变量读**（默认 `DASHSCOPE_AUDIO_API_KEY`），插件代码、配置、仓库里都没有密钥。

**失败不糊弄**：任一块不可用就把 `audio.status` 降为 `unavailable` 或 `partial`，在 `notes` 里写原因，正文明确写 "BGM was NOT analysed"，不会让"没分析"看起来像"没有声音"。

**依赖可缺**：`sherpa-onnx-node` 是原生包，不作为硬依赖。找不到就只做 BGM；也可以把 `sherpaPath` 指向机器上已有的那份。

### 找相似 BGM

每片分析会产出 `searchWords`（3–5 个），插件把它们去重后放进 `<bgm>` 的 `search words for a similar track:` 一行。拿这串词去素材库检索即可；插件本身不连曲库。

## 已知限制

- **分析帧率决定变化率的分辨率**。0.1 秒以内的变化在 10 fps 上看不到；要更细就把 `scanFps` 提到 20–30（花的只是解码时间）。
- **窗口边界会把一个突变拆到两个窗口**。0.99 秒处的一个跳变可能被切成 2 帧 + 1 帧，多出一张图。这是固定 `t` 秒窗口的代价。
- **只能分辨"瞬时 / 渐变"**。游程长度分不出淡入淡出、划像、缩放、快速运镜的区别 —— 那要看图判断，算法不替你说。
- **画面内小于约 1 个方块（≈1/30 宽）的改动**在分析图上会打折。`longSide` 提到 160 能找回一部分。
- **1/8 级别的子图认不出字幕和脸**。这是子图的物理尺寸决定的，该用 `video_closeup`。
- **扫描要解码全长**。90 分钟的片子第一次要跑几分钟，之后走缓存。
- **`tile` 只按连续文件名读**。取帧有失败时脚本会把成功的重排成连续序列，清单写的是重排后的子图序号，时间码是真实的。
- **淡入淡出的黑帧不再主动躲开**（0.3.1 会躲）。现在按窗口均匀重取，过渡里的黑帧是转场的一部分，躲掉反而看不到转场怎么做的。
- **单帧不再打包**（0.5.0 起）。一帧一张图，所以长片安静段（每几秒一帧）的图数会比过去多得多，靠 `maxTotalSheets` 与 plan 的预算检查兜住。
- **非 Windows 默认不烧字**。默认字体是 Windows 的 `consolab.ttf`；在 Linux / macOS 上这个文件不存在，插件会检测到并**自动关掉烧字**（不报错）。要烧字就自己给 `fontFile` 一个存在的字体路径。
- **BGM 风格判断的验证面还很窄**。只测过合成鼓点（答"电子/四拍/无旋律"）与纯旁白（答"无音乐"）；真实配乐下的准确率未验证。
- **本地语音会写错专有名词**。实测把 "GitHub" 转成 "gitopub"；时间戳是准的，字面不保证。
- **BGM 那一路会把音频上传到云端**。敏感素材请把 `bgmMode` 设成 `off`。
- **分辨率档位固定**：单帧 1080p、拼图 1440p（2×2 单张子图 720p / 3×3 480p / 4×4 360p）。每张图片 384 token，比过去的 800×450（233）贵约 65%，换来 4×4 里子图 640×360 的可读性。

## 代码结构

`index.js` 只留入口（`apply`、`inject`、`name`），并把下面几块的对外符号原样再导出——测试与脚本按 `index.js` 的名字取用，搬文件不动它们的 import。

| 文件 | 装什么 | 约行数 |
|---|---|---|
| `index.js` | 插件入口 + re-export | 70 |
| `lib/modes.js` | 两套模式 + `effectiveArgs`（模式与配置的合成） | 59 |
| `lib/config.js` | 配置归一化：夹取、解析外部命令、猜字体、定缓存与记录目录 | 212 |
| `lib/tools.js` | 四个工具的定义（**模型读到的描述与参数在这里**） | 604 |
| `lib/orchestrate.js` | 探测、扫描、plan 初判/定稿、watch 执行、note 落盘、取帧拼图交附件 | 765 |
| `lib/feasibility.js` | 预算检查：`required` / `minimum` / 四个候选方案 / choice 解析 | 238 |
| `lib/plans.js` | 计划快照：id 哈希、落盘、校验、淘汰 | 205 |
| `lib/record.js` | 观看记录：文档头、批次追加、分析补写（Markdown） | 259 |
| `lib/render.js` | 返回值 → 内容块（纯函数，不碰 IO） | 293 |
| `lib/util.js` | 执行与渲染共用的小工具 | 312 |
| `lib/plan.js` | 积分法采样计划 + `planFeasibility` / `fitDensity`（纯算法） | 736 |
| `lib/scan.js` | raw RGB → 面积变化分 | 255 |
| `lib/grid.js` | 网格与 token 计量 | 161 |
| `lib/delivery.js` | 计划分组 → 交付分组、成本 | 66 |
| `lib/cache.js` | 扫描缓存键与读写 | 127 |
| `lib/ffmpeg.js` | ffmpeg / ffprobe 命令封装 | 452 |
| `lib/time.js` | 时间码与字幕解析 | 232 |
| `lib/audio.js` | 本地语音 + 云端 BGM 分析 | 700 |

## 开发

```bash
npm test                               # 100 项：纯函数 + 预算 + 工具契约 + 渲染 + 观看记录
node scripts/smoke.mjs [视频]          # 端到端：造测试片、走 plan→watch 两段、比交付形态
node scripts/verify-agent-contract.mjs  # 用 Agent 自己的校验器验 schema（含"预算不足"形态）
node scripts/verify-real-output.mjs    # 真跑四个工具，拿真实返回值过校验器
```

`npm test` 不需要 ffmpeg，也不需要装进 DSH。`smoke.mjs` 与 `verify-real-output.mjs` 需要 ffmpeg；给 smoke 一个视频路径就会对那部片子再跑一遍对比。

## 许可

代码 MIT。

图标形象是社区创作的「DeepSeek 鲸鱼娘」风格插画，**版权归原作者**。本仓库仅在本机自用、不用于商业分发；要随插件一起对外分发，请先取得作者许可。

图标文件有两个，内容必须一致：

- `icon.png` —— 圆角方图（256×256，带透明通道），后续可导出的源文件在 `art/`（原图 `whale-girl.png`、裁切源 `crop-center.png`、512 成品 `icon-512.png`）。
- `icon.svg` —— **Agent 实际读取的文件**。它按 `包根/icon.svg` 的约定找图标，找不到就报 `ENOENT`，所以这个文件必须存在；里面是把 `icon.png` 内嵌成 data URI 的壳。改图之后要重新生成它，不能只换 `icon.png`。
