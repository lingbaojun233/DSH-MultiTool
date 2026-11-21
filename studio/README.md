# studio — 视频创作模块

DSH 想做一个视频时用它。**模型不生成任何像素**：它只写"分镜 JSON + manim 脚本 + 英文画面描述"，
精确动画由 Manim 渲染，文字卡由 ffmpeg 渲染，人物/场景类画面交给 AI 视频生成（wan3.0-video）。

## 画面有三条路

| 场次类型 | 谁出像素 | 用在哪 |
| --- | --- | --- |
| `manim` | Manim（数学动画） | **默认**：公式、坐标、曲线、精确动画、推导 |
| `aivideo` | wan3.0-video（AI 生成，约 100 秒/条） | 人物、场景、动作、氛围（故事 / 拟人化演示），**一集最多 `maxAiVideo`（默认 4）条** |
| `text` | ffmpeg（渐变底 + 一行大字） | 开场 / 转场 / 结论，一集 1~2 场 |

`plot`（matplotlib）、`draw`（GDI+ 图元）、`html`（无头浏览器）的**渲染分支还在**，
是给旧项目兜底的兼容路径，但**规划提示词不再选择它们** —— 用户要求"视频只使用 manim"。

## 一集是怎么出来的

```text
分镜骨架（manim/aivideo/text）    POST /v1/plan 或 /v1/create
  ↓ manim 场逐场生成脚本（一次只问一场）；aivideo 场生成一条英文 prompt
Manim 渲染（-qm，1080p30） / wan 生成 5~10 秒片段（串行，~100 秒/条）
  ↓ 规格统一（缩放/补帧/截断）+ 风格注入（配色/背景/线宽/字体）
单场 mp4
  ↓ xfade 0.4 秒串联 + 旁白（speak）+ BGM
成片
```

**旁白先拿后渲**：所有场次的旁白必须先全部合成成功，否则整片失败返回
`VOICE_UNAVAILABLE`（HTTP 503）。以前这里失败会默默跳过，产出"一半真一半假"的片子。

## 场景契约（分镜 JSON）

```json
{
  "title": "标题",
  "style": "oscilloscope-math",
  "scenes": [
    {"kind": "manim", "text": "这一场标题", "narration": "旁白", "seconds": 8,
     "manim": {"scene": "DerivativeFormula", "code": "from manim import *\nclass DerivativeFormula(Scene):\n    def construct(self):\n        ..."}},
    {"kind": "text", "text": "一句短话", "narration": "旁白", "seconds": 3},
    {"kind": "aivideo", "text": "雪原飞行", "narration": "旁白", "seconds": 5,
     "video": {"prompt": "anime style, cel shading, wide shot, a girl flying over a snowy plain", "size": "1280*720"}}
  ]
}
```

- `video.prompt` 的要求：**英文**、一句、**≤120 字符**，说清主体 + 动作 + 风格 + 镜头；
  公式/坐标轴/标题文字**不要**写进去（那些用 manim）。`size` 默认 `1280*720`。
- `aivideo` 的成本护栏：一集最多 `maxAiVideo` 条（config，默认 4 = 20 秒）。
  超出的场次在渲染时**降级成文字卡并记日志**（`成本护栏：本集 aivideo N 场，上限 4 场；第 5 场降级…`）。
  这样模型一口气写 8 场也不会把额度烧光。

- `style` 可省，省了按人设决定（见下）。项目里写死就按写死的渲。
- `manim.code` 的硬约束（提示词里也这么要求）：
  - 只写 `from manim import *` + 一个 `class X(Scene):` + `def construct(self):`
  - import 只允许 `manim` / `numpy`；禁止文件/网络/subprocess/open/eval/exec/`__import__`/`Scene.embed`
  - ≤60 行；`MathTex` 可用（MiKTeX 已装）；中文 `Text(..., font="Microsoft YaHei")`
  - **坐标轴不要 `include_numbers=True`**（刻度数字是 DecimalNumber，逐帧排 TeX，慢且易失败）
  - 不要自己设背景色：渲染器按风格注入 `self.camera.background_color`
- `kind` 只是偏好。**真正的引擎按"手里有什么素材"决定**：
  `manim 脚本 > AI 生成画面 > matplotlib 代码 > draw 图元 > html > 文字卡`，前一个失败自动退到下一个。
  所以"有 draw 却被 manim 分支吞掉"这种事不会发生了（`sceneEngines()`）。

## 风格预设（studio/styles/*.json）

风格把「整集一套配色/线宽/字体/节奏」变成一份 JSON，渲染时**机械地**套上去：

```json
{"id":"oscilloscope-math","name":"示波器数学","bg":"#010402","fg":"#8dffb0",
 "accent":"#4dff88","muted":"#3f7a58","accent2":"#ffb547","line_width":3,
 "glow":true,"font":"Microsoft YaHei","motion":"slow","camera":"follow"}
```

| id | 名称 | 底色 | 主色 | 字色 | 线宽 |
| --- | --- | --- | --- | --- | --- |
| `oscilloscope-math` | 示波器数学 | `#010402` | `#4dff88` | `#8dffb0` | 3 |
| `blueprint` | 工程蓝图 | `#18336b` | `#e7f0f9` | `#e7f0f9` | 2 |
| `whiteboard` | 白板讲解 | `#f7f5ef` | `#2a5cb3` | `#23262c` | 4 |

来源是 [lemomo-ai/lemo-opuscar](https://github.com/lemomo-ai/lemo-opuscar) 对应风格的 `STYLE.md`，
只提炼"我们的渲染器真能执行"的部分（颜色/线宽/字体/节奏/机位），散文部分压成 `notes` 进提示词。

注入是确定性的（`styles.js` 的 `applyToManimCode`）：
1. `BLUE/GREEN/TEAL…` → 主色；`YELLOW/GOLD/ORANGE/RED…` → 强调色；`WHITE` → 字色；`GREY…` → 次要色
2. 插一行 `self.camera.background_color = "<bg>"`
3. 显式写的 `stroke_width` / `font` 覆盖成风格值
4. 文字卡用风格底色做渐变、风格字色做文字

风格进画面缓存键（`sceneKey` 里的 `style`）：换风格一定重渲，不会复用旧配色的片段。

### 默认风格由人设决定

`GET /v1/style` 的算法：

```text
项目/请求显式指定 → 人设（GET 127.0.0.1:8767/v1/persona 的 block 关键词投票）
                  → 人设缓存（按 version 失效）→ 默认 whiteboard
```

关键词映射（命中次数投票，同分按顺序）：

| 风格 | 关键词（节选） |
| --- | --- |
| `oscilloscope-math` | 数学 公式 方程 函数 微积分 导数 积分 几何 向量 证明 定理 物理 概率 math formula |
| `blueprint` | 理性 严谨 逻辑 工程 结构 系统 原理 机制 参数 拆解 技术 精确 推导 架构 |
| `whiteboard` | 温柔 叙事 故事 陪伴 情感 聊天 轻松 童话 日常 治愈 软 可爱 黏人 暖 |

缓存写在 `data/studio/persona-style.json`（`{version, styleId, reason}`），
版本没变就不再算；人设服务挂了就沿用缓存（`source:"cache", stale:true`）。

## 接口

```text
GET  /v1/health                        → {ok,width,height,fps,ffmpeg,font,manim,styles,...}
GET  /v1/styles                        → 风格列表
GET  /v1/styles/:id                    → 单个风格（404 STYLE_NOT_FOUND）
GET  /v1/style                         → 当前生效风格 + reason + source + personaVersion
POST /v1/plan    {prompt,seconds,style}→ {ok, plan, manimRatio, style}
POST /v1/render  {plan,voice,bgm,style}→ {ok, file, jobId, style}
POST /v1/create  {prompt,seconds,voice,bgm,style} → 一步到底（内部走两段式规划）
POST /v1/project {title,scenes,style}  → 建项目
POST /v1/project/patch   {id,patches}  → 只发改动
POST /v1/project/render  {id,scope,style} → 出片（style 会写回项目）
POST /v1/aivideo {prompt,seconds,size} → 独立生成一条 AI 片段（插件 gen_video 用它）
                                      → {ok, path, taskId, ms, bytes, seconds, width, height}
```

`/v1/create` 现在和 `/v1/plan` 走同一套两段式提示词（以前是另一套 rich/draw 提示词，
两条路迟早会走偏，所以删了）。

### AI 视频（wan3.0-video）的配置与密钥

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `wanKeyPath` | `<root>\secrets\wan.key` | 密钥文件；也接受 `secrets\qwen.key`、`video\secrets.json` 的 `apiKey`、`WAN_API_KEY` 环境变量 |
| `wanTimeoutMs` | `480000` | 一条的总超时（提交 + 轮询 + 下载） |
| `maxAiVideo` | `4` | 一集最多几条（每条 5 秒、约 100 秒生成时间） |

**密钥不进代码、不进日志**：日志里只出现 `密钥来自 wan.key` 这种来源文件名。
接口只用百炼原生路径（`/api/v1/services/aigc/video-generation/video-synthesis` +
`/api/v1/tasks/{id}`），`/compatible-mode/v1/videos` 之类一律 `url error`，别再试。

## 三层缓存

```text
旁白  按 (文本, 音色) 缓存           → 改一句只重合成那一句
片段  按 (引擎, 素材, 时长, 风格, 文字卡淡化, 分辨率) 缓存
拼接  按 (片段列表, 时长, fps) 缓存  → 只换声音时连拼接都不用重跑
```

`scope`：`auto`（内容优先，旁白决定时长）/ `audio`（画面优先，只重做声音）/ `all`（全重画）。

## 三个踩过的坑（都修了）

1. **rich 场景丢坐标轴**：以前按 `s.kind` 分派引擎，`kind:'manim'` 但脚本没生成出来的场次
   会被 `normalizeScene` 改回 `text`，于是 manim 分支不跑、rich 分支（要求 `kind==='rich'`）也不跑，
   场景里的 `draw.shapes` 被彻底吞掉，最后出了一张没有坐标轴的文字卡。
   现在按素材排序（`sceneEngines`），有 draw 就一定排在链条里。
2. **0.4 秒交叉淡化时标题叠加**：xfade 是重叠转场，两张文字卡在 0.4 秒窗口里同时全亮。
   只给"头尾各 0.15 秒"其实治不了：窗口里两张卡都还是不透明，中点必然是 50/50 重影。
   所以淡化按 **xfade 中点**摆（`lib/render.js` 的 `staticClip({edgeFade, edgeLead, edgeColor})`）：
   - 入场：延后 `edgeLead/2`（0.2 秒）开始，时长 `textEdgeFade`（0.15 秒）
   - 出场：提前 `edgeLead/2` 结束，同样 0.15 秒
   - 淡到**风格底色**而不是黑（白板这类浅色风格淡到黑会变成一下黑屏闪烁）
   于是 A 的标题在窗口前半段就淡完、B 的在后半段才出来，重叠为零。
   项目可以用 `textEdgeFade: 0` 关掉（进画面缓存键，改了一定重渲）。
3. **偶发回退 huayan 导致音色不一致**：studio 侧改成"渲染前先确认所有旁白都拿到了"，
   任一失败就整片失败返回 `VOICE_UNAVAILABLE`（503），不产出半真半假的片子。
   speak 侧的 strict 模式负责"拿不到就别回退"。

## 抖动

静帧走 `staticClip`：**不做 zoompan**，一帧铺满整场，逐帧像素完全一致（实测帧差 0.0000）。
想要运动就交给 manim（真动画），而不是让一张图假动。

## 实测（2026-11-21，服务器 1920×1080@30，无并发干扰）

| 项目 | 结果 |
| --- | --- |
| **60 秒 / 8 场全 manim + 8 条旁白** | **192.4s**（旁白串行 8 句 ≈30s、manim 8 场 143.3s、拼接混音 ≈20s）；成片 61.2s / 1.27MB |
| 单场 manim | 11.6s ~ 31.6s（简单公式 11.6~16.9s；NumberPlane+Circle+Rotate 31.6s；含 MathTex 首帧 16.9s） |
| 3 场全 manim（含 MathTex 公式） | 66.2s；成片 23.2s / 491KB |
| 同场景换风格重渲（manim 1 场 6s） | 22.5s / 12.1s；底色均值 (1.1,4.0,1.4) → (243,242,236) |
| 3 张文字卡（8.2s） | 7.3~8.2s |
| GDI 图元场（draw） | 11.5s / 2 场 |
| 静帧抖动（文字卡片段相邻帧） | **mean_abs_diff 0.000000，max_diff 0，>2 的像素 0** |
| 输出 | 1920×1080 / h264 / AAC；60 秒约 1.3MB（静态文字卡约 0.17MB/8s） |
| 文字卡片段复用 | `scope:'audio'` 秒级出片 |

标题重叠（边缘图相关性，"两个标题同时可见的最大值"）：

| 文字卡淡化 | 交界窗口里两标题同时可见 | 中点（2.80s）A / B |
| --- | --- | --- |
| 开（0.15s，跨中点） | **0.656**（只是背景板，无字形） | 0.000 / 0.000 |
| 关（0.00s） | 0.899（真·叠字） | 0.899 / 0.906 |

## 限制

- manim 每场是**一次真实渲染**：实测 11.6~31.6 秒/场（MiKTeX 首次约 25 秒，之后走缓存）。
  一集 60 秒（8 场）串行要 3 分钟出头，这是 manim 的固有成本。
- 旁白必须**串行**合成（BreezeBlue Starter 并发上限 1），8 句约 30 秒；单句超时 150 秒。
- manim 场景的动画长度由脚本里 `run_time` 之和决定，渲染后统一补帧/截断到本场秒数。
- 没有转场以外的时间线能力（无遮罩、无画中画、无逐帧关键帧控制）。
- 表情叠加在成片前一次做完；`html` 需要无头浏览器，服务器上不可用（仅开发机）。
