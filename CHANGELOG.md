# 变更记录

版本号遵循 `package.json` 里的 `version`，GitHub Release 的 tag 与之一一对应（`v0.8.0`）。

## 0.8.0 —— 2026-11-21

**改名与统一术语，旧计划快照全部失效（`PLAN_VERSION` 升到 2）。**

- **参数 `preset` → `mode`**：一个名字只承担一个意思。`video_plan` 的必填项从 `preset` 改为 `mode`，取值仍是 `analysis` / `understand`；旧调用会直接报参数错误，不会静默按默认值跑。
- **“交付单元”统一叫「批次」**：工具返回值、渲染文本、文档与测试里的 `delivery unit` / `交付单元` 全部改为 `批次` / `batch`。
- **模式与预算处置方式拆开**：`mode` 只表示看的方式（`analysis` 分析画面 / `understand` 看懂内容），预算不够时怎么处理是另一个字段 `resolution`（`full` / `raise` / `truncate` / `understand` / `density`），不再混在同一个名字里。
- 模式由**用户**指定，工具要求显式传 `userConfirmed: true`；模型不得替用户选模式。
- 修掉体检报出的文档引用错误（`ARCHITECTURE.md` 里旧 `lib/presets.js` 的说法），审计 0 错 0 警。

## 0.7.0 —— 2026-11-21

**观看记录功能。**

- 新增 `video_note` 工具：把模型对某一批的分析写进 Markdown 观看记录，0 视觉 token。
- `video_watch` 每交付一批就往同一份记录里追加一节：时间码、图片组成、语音转写、BGM 结论。
- 记录落点 `recordDir`（默认桌面），文件名 `<视频名>.观看记录.md`；`record: false` 可整体关闭（关掉后 `video_note` 也报错）。
- 首次 `video_watch` 惰性建表头，避免只 plan 不 watch 就留下空文件。

## 0.6.0

**预算闸门前移到 `plan`。**

- `video_plan` 负责判预算：报 `required` / `minimum`，不够就给四条带数字的选项；`video_watch` 只执行已批准的计划，不再读 `maxTotalSheets`，也不会偷偷抬 `a` 或砍尾巴。
- `batchDone`（这一批交完了）与 `videoComplete`（整片交完了）拆成两个字段。
- 批次号越界改为直接报错，不再静默夹紧到边界。

## 更早

- 积分法采样：按画面累计变化量决定抽帧密度，`a` / `t` 两个参数分别控制“攒多少变化落一帧”和“每几秒数一次密度定网格”。
- 多帧拼图（2×2 / 3×3 / 4×4）与 `video_closeup` 回取原图。
- 本地语音（sherpa-onnx + SenseVoice）与云端 BGM 分析。
