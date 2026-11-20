# panel —— 文本输入输出面板

给 IO 模块用的最小界面：输入一段文本，看到核心返回的答案。目前只做文本，不做附件、会话、多轮。

## 结构

```text
panel/
├── server.js          静态托管 + 反代到 io / separator（127.0.0.1:8766 -> 8765 / 8768）
├── index.html         页面骨架（含登录/注册浮层）
├── app.js             前端逻辑（发送、等待态、错误、健康指示、登录态）
├── style.css          深色主题
├── start-server.cmd   计划任务入口（开机自启）
└── open-panel.cmd     本地一键启动器（建隧道 + 开浏览器）
```

数据流：

```text
浏览器 -> 127.0.0.1:8766（本机 SSH 隧道）
       -> 服务器 127.0.0.1:8766（panel server）
       -> 127.0.0.1:8765（io）  /  127.0.0.1:8768（separator：登录/注册/会话）
       -> DSH 核心
```

面板不直接调核心，只调 io；端口都绑回环，不对外暴露。

## 本地打开

双击 `DSH-MultiTool\panel\open-panel.cmd`：它会检查本机 8766 是否已在监听，没有就后台建
SSH 隧道（`ssh -N -L 8766:127.0.0.1:8766 fish-server`），然后打开浏览器。

等价的手动方式：

```powershell
ssh -N -L 8766:127.0.0.1:8766 fish-server     # 保持这个窗口
# 浏览器打开 http://127.0.0.1:8766
```

## 登录与用户态

- 顶栏右侧是用户区：未登录显示「登录」，登录后显示显示名 +「退出」。
- 首次使用：点「登录」→「注册一个」。用户名 3–32 位小写字母/数字/下划线，密码至少 6 位，
  显示名可留空（默认用用户名）。注册成功即自动登录。
- token 存在 `localStorage['dsh-panel-token']`；页面启动时调 `GET /api/auth/me` 校验，
  无效就弹登录层并禁用输入框。
- 受保护请求（`/api/input`、`/api/persona`、`/api/memory/*`）都带
  `Authorization: Bearer <token>`；遇到 401 会清 token、弹层并提示「会话过期，请重新登录」。
- 「退出」先调 `POST /api/auth/logout` 删除服务端会话，再清本地 token。
- 面板把 `/api/auth/*` 代理到 separator 的 `/v1/auth/*`，浏览器始终只与面板同源通信。

## 开机自启（服务器上已配置）

| 项 | 值 |
| --- | --- |
| 任务名 | `DSH-MultiTool Panel` |
| 触发器 | 开机（AtStartup） |
| 身份 | `SYSTEM` |
| 入口 | `start-server.cmd` |
| 日志 | `..\logs\panel.log`（放在模块目录外，避免 `push` 整目录替换时被占用） |

## 记忆与人格

- 顶部「记忆」按钮打开抽屉，三块内容现拉现看：
  - **人格**：版本号、五项 traits、完整宪法常驻块；
  - **记忆库**：事件 / 事实 / 冲突 / 实体 / 已删 的实时计数；
  - **最近事件**：最近 20 条，含说话人、时间与证据定位。
- 每条回答的元信息会显示这一轮的实际用量，例如 `9.0 秒 · 记忆 13 条 · 事件 +1 · 12:26`。
  用量来自 io 的统计：本轮审计日志（模型自己调了几次 `memory_search`、取回多少条）+ 记忆库前后计数差值。
- 用量随历史一起落盘，刷新后仍然可见（`panel-history.jsonl` 里带 `usage` 字段）。
- 抽屉走 `/api/persona`、`/api/memory/*` 代理到记忆服务，浏览器只与面板通信。

## 排错

- 页面打开但状态显示"核心未就绪"：查 io 服务 `Get-ScheduledTaskInfo -TaskName 'DSH-MultiTool IO'`，
  以及 `io\service.log`。
- 页面打不开或显示"连接断开"：本机隧道没起来，重跑 `open-panel.cmd`；确认 `ssh fish-server whoami` 可用。
- 面板进程本身：`Get-Process node`，或看 `panel\service.log` 的最后几行。

## 对话历史（持久化）

历史存在服务器，**刷新页面、换浏览器、重启面板进程都不会丢**：

```text
C:\Apps\DSH-MultiTool\data\panel-history.jsonl    每行一条 {role, text, ts, ms?}
```

放在模块目录之外，所以 `push` 整目录替换也不会清掉它。写入时机：提问时先记 `user`，
核心返回后记 `assistant`（失败记 `error`）。文件超过 2 MB 且行数 > 1000 时，自动裁剪到最近 800 条。

| 接口 | 说明 |
| --- | --- |
| `GET /api/history?limit=200` | 读取最近 N 条 |
| `DELETE /api/history` | 清空（页面右上角"清空"按钮，会二次确认） |

## 已知限制

- 无多轮上下文：核心当前版本不支持 `--session-id`，每次提问都是独立会话；
  历史只是展示层，不会把前文带进下一次请求。
- 对话历史仍是一份全局 `panel-history.jsonl`，多账号共用，不做按用户隔离。
- 登录态存在浏览器 localStorage；清理浏览器数据会退出登录。
- 只监听回环，靠 SSH 隧道与账号登录保护；如需对外开放，另配反向代理与 HTTPS。
- 历史无上限保护（除 2 MB 裁剪）：长期使用会持续增长，需要时手工删 `data\panel-history.jsonl`。
