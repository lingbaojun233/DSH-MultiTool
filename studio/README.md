# studio — 视频创作模块

DSH 想做一个视频时用它。**模型不生成任何像素**：它只写"分镜 JSON + manim 脚本 + 英文画面描述"，
精确动画由 Manim 渲染，文字卡由 ffmpeg 渲染，人物/场景类画面交给 AI 视频生成（wan3.0-video）。

## 画面有三条路

| 场次类型 | 谁出像素 | 用在哪 |
| --- | --- | --- |
| `manim` | Manim（数学动画） | **默认**：公式、坐标、曲线、精确动画、推导 |
| `aivideo` | wan3.0-video（AI 生成，约 100 秒/条） | 人物、场景、动作、氛围（故事 / 拟人化演示），**一集最多 `maxAiVideo`（默认 2）条** |
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

**旁白先拿后渲，但不再"一句失败整集失败"**：每句旁白先带重试地拿（失败重试 2 次，间隔 3s/8s）。
仍拿不到的句子只让**那一场静音**，整集继续出片，任务 `status:'done'`、`warnings` 里写清
"第 N 场没有声音"；只有**全部旁白都失败**才 `status:'failed'`（且成片照样保留，不删已渲画面）。

## 任务化：一次提交，服务端负责到底

`POST /v1/jobs` 提交后立刻返回 `jobId`（<1s），实际工作在后台跑；`GET /v1/jobs/:id` 轮询。
任务状态写 `data/studio/jobs/<jobId>.json`，完整请求 + 最终分镜写 `data/studio/library/<jobId>.json`
（都是原子写：先写 `.tmp` 再 rename）。**进程重启后 jobs 里的 running/queued 会标 failed
（`error:'服务重启，任务中断'`），library 里的配方一个字节都不动，刷新/关页面/重启都能重跑。**

```text
queued ──> running(prepare → voice → scenes → concat → mix) ──> done
                    │
                    └── 没兜住的异常 / 全部旁白失败 ──> failed（已完成的片段与成片保留）
```

自愈顺序（每一层都先兜底，兜不住才降级）：

| 失败在哪 | 先做什么 | 还不行 | 最终兜底 |
| --- | --- | --- | --- |
| 画面描述翻译（`PLAN_NOT_JSON`） | 用用户原话当提示词 | — | 文字卡 |
| manim 渲染失败/超时 | **把 stderr 尾部（≤400 字符）贴回模型修一次**，用修好的代码重渲 | 降级 aivideo（该场有 prompt 且配额允许） | 文字卡 |
| aivideo 失败/超时 | 降级 manim（该场有代码） | — | 文字卡 |
| 某一整场彻底没画面 | 跳过这一场，其它场继续 | — | ≥1 场成功就合成 mp4 |
| 某句旁白拿不到 | 重试 2 次（3s/8s） | 该场静音，任务 `done` + `warnings` | 全部旁白失败才 `failed`（成片仍保留） |

并发上限 `jobConcurrency`（默认 **1**）：同时只跑一个 job，其余排队；`GET /v1/jobs/:id` 里
`queuePosition` 是排队位置。进度每完成一场更新 `done/total` 与 `phase/label`
（如 `第 3/8 场 manim 渲染中…`）。

## 场景契约（分镜 JSON）

```json
{
  "title": "标题",
  "style": "oscilloscope-math",
  "scenes": [
    {"kind": "manim", "text": "这一场标题", "narration": "旁白", "seconds": 8,
     "image": "<uploadId>",
     "manim": {"scene": "DerivativeFormula", "code": "from manim import *\nclass DerivativeFormula(Scene):\n    def construct(self):\n        ..."}},
    {"kind": "text", "text": "一句短话", "narration": "旁白", "seconds": 3},
    {"kind": "aivideo", "text": "雪原飞行", "narration": "旁白", "seconds": 5,
     "image": "<uploadId>",
     "video": {"prompt": "anime style, cel shading, wide shot, a girl flying over a snowy plain", "size": "1280*720"}}
  ]
}
```

### 参考图（上传图片）

`scene.image` 可以填：

| 写法 | 含义 |
| --- | --- |
| `"<uploadId>"` | 面板 `PUT /api/upload` 返回的 `uploadId`（会去 `data/uploads` 找，并**复制**进 `data/studio/uploads`） |
| `"/api/upload/<uploadId>"` | 面板的预览链接，从里面抽 uploadId |
| `"data/studio/uploads/x.png"` 或绝对路径 | 必须是 `data/studio/uploads/` 下的文件 |
| `"x.png"` | 相对名，只在上面两个 uploads 目录里找 |

**安全边界**（分镜 JSON 是模型/面板给的，不能当读文件入口）：

- 只认 `data/studio/uploads`（studio 规范目录）和 `data/uploads`（面板上传目录）两个根；
- 扩展名白名单 `.png/.jpg/.jpeg/.webp`；
- 路径含 `..`、或绝对路径落在两个根之外 → **拒收**，日志写
  `scene#N image 被拒（PATH_TRAVERSAL|OUTSIDE_UPLOAD_DIR|BAD_EXT|UPLOAD_NOT_FOUND）`，
  该场降级为"不用图"继续渲染，不会让整条任务失败。

**manim 场**：提示词会明确告诉模型"这一场有参考图，路径是 …，用 `ImageMobject` 嵌进去，
不要自己画"。模型没写 `ImageMobject` 时，studio **确定性注入**一张 35% 不透明度的背景图
（`scale_to_fit_height(config.frame_height)`），保证图一定出现在画面里。
**文字卡**：`image` 会作为整场底图（`lib/render.js` 的 `imageStill`）。
**aivideo 场**：`wanvideo.js` 已支持 `first_frame_url`（`CFG.aivideoImage` 开关，默认关）；
网关是否会真的使用这个字段尚未拿到有效对照实验（见"已知限制"）。


- `video.prompt` 的要求：**英文**、一句、**≤120 字符**，说清主体 + 动作 + 风格 + 镜头；
  公式/坐标轴/标题文字**不要**写进去（那些用 manim）。`size` 默认 `1280*720`。
- `aivideo` 的成本护栏：一集最多 `maxAiVideo` 条（config，默认 2；每条 100~400 秒）。
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
POST /v1/create  {prompt,seconds,voice,bgm,style} → 一步到底（内部走 job，同步返回旧形状）
POST /v1/project {title,scenes,style}  → 建项目
POST /v1/project/patch   {id,patches}  → 只发改动
POST /v1/project/render  {id,scope,style} → 出片（内部走 job，同步返回旧形状）
POST /v1/aivideo {prompt,seconds,size} → 独立生成一条 AI 片段（插件 gen_video 用它）
                                      → {ok, path, taskId, ms, bytes, seconds, width, height}

# 任务化（推荐入口）
POST /v1/jobs                          → {ok, jobId, status, queuePosition}，立刻返回
  body: {prompt?|script?|scenes?, seconds?, style?, voice?, maxAiVideo?, bgm?, scope?}
GET  /v1/jobs                          → {ok, jobs:[最近 20 个任务摘要]}
GET  /v1/jobs/:id                      → {ok, jobId, status, phase, label, done, total,
                                          elapsedMs, ms, bytes, videoUrl, jobIdForVideo,
                                          credits, warnings, error, scenes[], queuePosition}
POST /v1/jobs/:id/cancel               → {ok}（排队中立即取消；渲染中在下一场边界停）
GET  /v1/video?id=<renderId>           → 直接播放/下载成片（支持 Range）

# 配方库（提交即存档，可重跑）
GET  /v1/library                       → {ok, items:[{id,createdAt,title,seconds,sceneCount,
                                          style,voice,status,videoUrl}]} 最近 50 条
GET  /v1/library/:id                   → {ok, item:{..., request:{...}, scenes:[...]}}
POST /v1/library/:id/rerun             → {ok, jobId}  用保存的配方重跑（新 jobId，原记录保留）
DELETE /v1/library/:id                 → {ok}
```

`/v1/create` 现在和 `/v1/plan` 走同一套两段式提示词（以前是另一套 rich/draw 提示词，
两条路迟早会走偏，所以删了）。

### AI 视频（wan3.0-video）的配置与密钥

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `wanKeyPath` | `<root>\secrets\wan.key` | 密钥文件；也接受 `secrets\qwen.key`、`video\secrets.json` 的 `apiKey`、`WAN_API_KEY` 环境变量 |
| `wanTimeoutMs` | `480000` | 一条的总超时（提交 + 轮询 + 下载） |
| `maxAiVideo` | `2` | 一集最多几条（**每条 100~400 秒**：实测约 100 秒，排队/重试时到 400 秒）；请求体可用 `maxAiVideo` 覆盖 |
| `aivideoImage` | `false` | 是否把 `image` 作为 `first_frame_url` 传给 wan（网关是否生效未证实，默认关） |
| `uploadDir` | `<outDir>\uploads` | studio 规范上传目录（参考图必须落在这里才认；面板上传会复制进来） |
| `panelUploadDir` | `<root>\data\uploads` | 面板 `PUT /api/upload` 的落点，按 uploadId 只读查找 |
| `jobConcurrency` | `1` | 同时跑几个任务；其余排队（`queuePosition`） |
| `defaultUserId` | `1` | 任务替模型调 io 的用户 id（调用方没带 `x-dsh-user` 时用） |

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
   任一句失败只让那一场静音（重试 2 次后），整集继续出片；只有全部旁白都失败才 `VOICE_UNAVAILABLE`（503），且成片仍保留。speak 侧的 strict 模式负责"拿不到就别回退"。
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

### 任务化 / 自愈 / 图片实测（2026-11-21 22:07~22:24，真服务器）

| 验收 | 数字 / 结果 |
| --- | --- |
| 正常 3 场（manim + aivideo + 文字卡） | 提交 **123ms** 返回 jobId；总 **288.4s**（manim 约 20s、aivideo 单条 **114.5s**、余下旁白/拼接/混音）；成片 **2.46MB / 13.2s**；3 场引擎 `manim/aivideo/text` 全 `ok`，`/v1/video` Range 200→206 可播。第 1 句旁白遇到上游 BreezeBlue 429，按规则静音并写 warning —— 任务仍 `done` |
| manim 失败自愈 | 故意给语法错脚本：日志 `把错误贴回给模型重试一次` → 模型改对 → manim 重渲成功。总 **46.5s**；`scenes[0].engine=manim,status=degraded`，`warnings` 记录修复 |
| 配音部分失败 | 停掉 speak：第 1 场命中缓存、第 2 场 3 次尝试（3s/8s）后静音。任务 **done**，**208KB / 11.2s**，`warnings:["第 2 场没有声音…已重试 2 次"]`，复用 2 场 + 新渲 1 场 |
| 全部旁白失败 | 任务 **failed / VOICE_UNAVAILABLE**（规则要求），但成片 **77KB** 仍保留；同一构建下部分失败仍是 done |
| 重启恢复 | `schtasks /End` + `/Run`；**2.6s** 恢复健康。中断任务变 `failed / 服务重启，任务中断`，`scenes[].note` 同样写清；配方库 15 条仍在；重启后新任务 **18.5s** 正常出片 |
| 并发（上限 1） | 同时提交 2 个：第二个 `status:queued, queuePosition:1`；第一个 **35.3s** 结束，第二个在 **2ms 后**开始，两个都 done（88KB / 76KB） |
| 配方重跑 / 缓存 | 首跑 **288.4s** → 首次重跑 **38.0s**（`imagePath` 刚进缓存键，3 场重渲一次；期间 aivideo 额度 429，自动降级文字卡，任务仍 done）→ 再重跑 **253ms**（`reused=3, rendered=0`）；原配方记录始终保留 |
| 图片 + manim | 面板 uploadId（复制进 `data/studio/uploads`）+ 模型代码没写 `ImageMobject`：日志 `参考图已注入 manim 背景层`，**32.6s** 出片；抽帧可见参考图（35% 不透明度铺底）。请求里的 `image` 仍是原 uploadId |
| 图片路径非法 | `../../etc/passwd` → 日志 `scene#0 image 被拒（PATH_TRAVERSAL）`，warning `第 1 场：图片被拒…`，任务仍 `done`（两场文字卡） |
| aivideo 首帧图 | **未能完成对照实验**：wan 网关 22:2x 起 `HTTP 429 Throttling.AllocationQuota`（月度额度耗尽，12-03 16:00 UTC 重置），A/B/C 三条都没提交成功 |

标题重叠（边缘图相关性，"两个标题同时可见的最大值"）：

| 文字卡淡化 | 交界窗口里两标题同时可见 | 中点（2.80s）A / B |
| --- | --- | --- |
| 开（0.15s，跨中点） | **0.656**（只是背景板，无字形） | 0.000 / 0.000 |
| 关（0.00s） | 0.899（真·叠字） | 0.899 / 0.906 |

## 限制

- **aivideo 首帧图（`first_frame_url`）未完成验证**：`wanvideo.js` 已经会把
  `first_frame_url` 原样提交（`aivideoImage` 开关，默认关），但 2026-11-21 22:20
  起 wan 网关返回 `HTTP 429 Throttling.AllocationQuota`（月度额度耗尽，12-03 16:00 UTC 重置），
  对照组（不带图 / 公网 URL / data URL）三条都没能提交成功，所以**无法判断网关是否真的使用首帧图**。
  面板的 `https://<ip>:8443` 是自签证书，网关大概率不信任；若要走公网 URL，需要一个有效证书的公网地址。
  manim 场和文字卡的参考图不受影响（已实测）。

- manim 每场是**一次真实渲染**：实测 11.6~31.6 秒/场（MiKTeX 首次约 25 秒，之后走缓存）。
  一集 60 秒（8 场）串行要 3 分钟出头，这是 manim 的固有成本。
- 旁白必须**串行**合成（BreezeBlue Starter 并发上限 1），8 句约 30 秒；单句超时 150 秒。
- manim 场景的动画长度由脚本里 `run_time` 之和决定，渲染后统一补帧/截断到本场秒数。
- 没有转场以外的时间线能力（无遮罩、无画中画、无逐帧关键帧控制）。
- 表情叠加在成片前一次做完；`html` 需要无头浏览器，服务器上不可用（仅开发机）。
