# 视频面板 v2

只有三个视图：**做视频 / 任务 / 设置**。原生 HTML + CSS + 一个 `app.js`，没有框架、没有构建、没有 npm 依赖。

```
node panel-v2/server.js          # http://127.0.0.1:8775
```

后端是 v2-core（默认 `http://127.0.0.1:8774`），本面板只做代理，不碰 studio / speak / 旧 panel。

## 启动与配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DSH_PANEL_V2_PORT` | `8775` | 面板端口 |
| `DSH_PANEL_V2_HOST` | `127.0.0.1` | 监听地址 |
| `STUDIO_V2_URL` | `http://127.0.0.1:8774` | v2-core 地址 |
| `DSH_SEPARATOR_URL` | `http://127.0.0.1:8768` | 登录/注册（`/api/auth/*`）透传目标 |
| `DSH_SPEAK_URL` | `http://127.0.0.1:8770` | 音色清单（`/api/studio/voices`）透传目标 |

## 代理

| 面板 | v2-core |
| --- | --- |
| `GET/POST /api/studio/*` | `http://127.0.0.1:8774/v1/*` |
| `GET /api/studio/video/:id` | `GET /v1/video/:id`（mp4 流式转发，支持 Range） |
| `GET /api/studio/video/:id?srt=1` | `GET /v1/video/:id?srt=1`（字幕） |
| `GET /api/studio/voices?zh=1` | speak `GET /v1/voices?zh=1`（设置页音色下拉） |
| `GET /api/health` | 面板 + 上游探测，给顶栏状态灯用 |
| `GET/POST /api/auth/*` | separator `/v1/auth/*`（面板不存口令） |

鉴权透传：浏览器的 `Authorization`、`Cookie` 原样转给上游；`<a download>` 这类发不了请求头的下载链接用 `?token=xxx` 换 `Authorization` 头，且 token 不会转发进上游日志。

## 三个视图

### 做视频（默认）

首屏元素：

- `textarea#topicInput` — 占位「你想做什么视频？也可以贴一段稿子」
- `div#secondsSeg` — 30 / 45 / 60 / 90 秒（默认 45）
- `button#startBtn` — 「开始做」
- `details#advanced` — 默认收起，标题「高级」

自动判断：去空白后 **> 80 字** 或 **≥ 3 个非空行** → 当稿子发 `{script, seconds}`；否则当主题发 `{topic, seconds}`。提示条会显示「按主题处理/按稿子处理 · N 字」。

提交后立刻在下方出现任务卡（占位 `queued`），2 秒轮询 `GET /v1/jobs/:id` 更新进度、已用时间、失败原因、完成按钮。进行中文案形如 `第 3/7 场 manim 渲染中…  已用 12 秒`。

「高级」折叠区里：

- 风格 / 音色下拉（默认「跟人设」，跟人设时**不传**这两个字段）
- 分镜表：`# / 文字 / 秒 / 类型(auto|manim|text) / 提示 / 插入·删`，可「+ 加一场」「清空」
- 有分镜时提交 `{scenes, seconds}`；重做模式提交 `{scenes}` 到 `/v1/jobs/:id/redo`
- 重做提交成功后旧分镜会自动清空，避免劫持下一次「开始做」

### 任务

`GET /api/studio/jobs` 最近 50 条，每张卡：标题（主题 / `稿子 · N 字` / `分镜 · N 场`）、`时长 · 场数 · 任务 id`、状态 chip。

- 进行中：`第 3/7 场 manim 渲染中…` + 已用时间（本地每秒走）+ 进度条
- 完成：`[播放] [下载视频] [下载字幕] [重做]`，播放是卡内 `<video>`
- 失败：一行可读中文，如 `VOICE_UNAVAILABLE → 配音服务不可用，已重试`、`MANIM_FAILED → 动画生成失败，已降级为文字卡`
- 重做：取任务分镜 → 切回做视频页、自动展开「高级」、载入分镜表，改完点「开始做」即 redo

### 设置

风格下拉（跟人设 / 白板讲解 / 工程蓝图 / 示波器数学）与音色下拉（跟人设（推荐） + speak 动态清单）。改完即时写入 `localStorage`（键 `dsh-panel-v2-prefs`），刷新后与做视频页折叠区的两个下拉同步。只读一行：

```
当前人设：大肥鱼（迷糊版） · 白板讲解 · 温柔口语
```

## 契约字段

`POST /v1/jobs` 接受 `{topic?|script?|scenes?, seconds?, style?, voice?}`，返回 `{ok, jobId}`。
`GET /v1/jobs/:id` 返回 `{ok, id, status, phase, label, done, total, elapsedMs, ms, bytes, videoUrl, srtUrl, warnings[], error, scenes[]}`。
`POST /v1/jobs/:id/redo` 接受 `{scenes}`，返回 `{ok, jobId}`。

场景对象：`{ text, narration, seconds, hint, tool:'manim'|'text'|'auto', stickers[], image, manim:{code,scene}|null, status, note }`。
面板提交分镜时只发可编辑字段（`text/narration/seconds/hint/tool/stickers/image/manim`），不带运行时 `status/note`。

风格 id：`whiteboard | blueprint | oscilloscope-math`，空串 = 跟人设 = 不传字段。
音色：`voc_xxx` 由 speak 的 `/v1/voices?zh=1` 动态给出，面板启动时异步拉一次（经 `/api/studio/voices`）；拉不到就只留「跟人设（推荐）」，并提示“想换音色请在聊天里说「换音色」”。空串 = 跟人设 = 不传字段。

## 本地联调与验收

```powershell
# 1) 桩服务（契约固定时间线：0-1.8s 配音中，1.8-6.2s 第 3/7 场 manim，之后完成）
node panel-v2/dev/mock-studio.js

# 2) 面板
$env:STUDIO_V2_URL='http://127.0.0.1:8774'; node panel-v2/server.js

# 3) 一键真跑验收（自动起桩 v2-core + 桩 speak + 面板 + 无头 Edge，CDP 驱动，截图落 dev/shots）
node panel-v2/dev/verify.mjs
```

桩音色：`dev/mock-speak.js`（默认 8770，`voc_test_a/小暖`、`voc_test_b/小刚`），验收脚本会自动起在临时端口并让面板的 `DSH_SPEAK_URL` 指过去。
桩的失败开关：主题/稿子里出现 `__FAIL_VOICE__` → `VOICE_UNAVAILABLE`；`__FAIL_MANIM__` → `MANIM_FAILED`。

## 和旧 panel 的差别

删掉了：聊天记忆/历史、人格编辑、账号页、上传附件、表情包、图片/视频理解、人设长文、预估耗时与 credits、多套创建/规划/渲染/项目接口、TTS/字幕独立页。
理由：v2 只回答一个问题——「把想做的视频说出来，拿到 mp4」。其余能力留在各自模块，面板不再重复一遍入口。
