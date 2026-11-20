# DSH-MultiTool

以 **DeepSeek Harness（DSH）** 为核心的 AI 多功能工具集。

一个核心 + 多个模块：核心是 DSH 本体，模块各占一个目录，彼此通过 IO 层通信。

```text
调用方（面板 / CLI / 脚本）
    │
    ▼
io  ──► 拼 prompt（目录 → 人格 → 上下文 → 记忆 → 当前消息）
    │
    ▼
core（dsh --profile headless "<task>"）──► 模型 + 工具
    │
    ▼
答案回传；异步把这一轮写进记忆库
```

## 程序布局（服务器 `C:\Apps\DSH-MultiTool\`）

```text
├── core\       DSH 本体：便携 Node、@deepseek-ai/dsh、headless profile、DSH_HOME
├── io\         IO 模块：与核心交互的唯一通道（127.0.0.1:8765）
├── panel\      面板：文本输入输出界面，反代 io（127.0.0.1:8766）
├── memory\     记忆：跨会话事件/事实/人格（127.0.0.1:8767，SQLite + FTS5）
├── registry\   模块注册表：目录常驻、用法懒加载
├── data\       运行时数据（记忆库、面板历史、审计；模块外，部署不覆盖）
└── logs\       服务日志（模块外）
```

## prompt 的组装顺序

io 在调用核心前按固定顺序拼接，**目录在最前**，以保证前缀稳定、可缓存：

```text
[模块目录]      registry 渲染：每行「名字 — 触发条件」，服务器视角 2 行 / 60 token
[人格设定]      persona 常驻块（宪法 + traits + 自传），≤1500 token
[最近对话]      面板带上的最近 6 轮
[可用记忆]      memory_search 召回，≤6 条 / ≤800 token，每条带证据
[当前消息]      用户这句话
```

## 仓库结构

```text
DSH-MultiTool/
├── core/                 bootstrap.ps1（安装/修复）、profile 模板、启动器
├── io/                   io.js（CLI + 库）、server.js、smoke-test.ps1
├── panel/                server.js、index.html/app.js/style.css、open-panel.cmd
├── memory/               server.js、lib/（闸门/存储/索引/召回/人格/维护）、
│                         schema/、rules/、test/acceptance.js
├── registry/             modules/<name>/{module.yaml,README.md}、
│                         lib/（校验/目录/加载器/生成/质检/预取）、
│                         tests/triggers.yaml、test/acceptance.js
├── plugin/               DSH 原生工具插件（把能力注册进工具表，而非只给散文）
└── docs/                 memory-design.md、registry-design.md
```

## 模块与状态

| 模块 | 作用 | 状态 |
| --- | --- | --- |
| core | DSH 本体 + 便携 Node | dsh 0.1.1-rc.2 / Node 22.23.5 |
| io | 唯一对话通道，负责拼 prompt、调核心、回写记忆 | 延迟 3.4 s（模型侧为主） |
| panel | 网页面板：Markdown 渲染、历史持久化、引用计数 | 经 SSH 隧道访问，仅监听回环 |
| memory | 事件 + 事实 + 人格；双预算召回；每日巩固 | 10 万条下 p95 **0.7 ms**，冷启动 11 ms，验收 7/7 |
| registry | 模块目录常驻、README 懒加载、触发测试 | 验收 11/11，触发测试 30/30 |
| plugin | 把记忆与模块读取注册成 DSH 原生工具 | 已装入 headless profile，模型实测会调用 |

服务器上的计划任务：`DSH-MultiTool IO`、`DSH-MultiTool Panel`、`DSH-MultiTool Memory`（均开机自启，SYSTEM）、
`DSH-MultiTool Memory Nightly`（每日 03:00）。

## 快速开始

```powershell
# 本地打开面板（自动建 SSH 隧道）
DSH-MultiTool\panel\open-panel.cmd

# 命令行直接问
node io\io.js send "帮我查一下上次说的部署路径"

# 模块注册表
node registry\cli.js catalog            # 渲染目录
node registry\cli.js read memory        # 懒加载用法
node registry\cli.js lint               # README 质检
```

## 关键约束（dsh 0.1.1-rc.2 实测）

- 任务**只能**作为位置参数；不支持 `-`（stdin 标记）、`--json`、`--session-id`。
- 凭据读取顺序：启动环境变量 → 当前目录 `.env` → `$DSH_HOME/.env`；headless 不读图形界面凭据库。
- 每次请求派生一个核心进程（约 1.5–2 s 启动），并发数 ≈ 进程数，当前无并发闸。

## 实测结论（决定设计取舍的依据）

| 结论 | 数据 |
| --- | --- |
| 人格块必须显式注入 | 之前漏接时模型完全看不到宪法；接入后回答体现身份与边界 |
| 对话上下文能消解指代 | 带 history 时能答"那个东西"；不带时会明确拒答而非编造 |
| 记忆召回有效 | 只存在于记忆里的信息可被召回并正确回答（3.5 s） |
| 目录字节必须稳定 | 同输入跨进程/跨机器 sha 一致（`62afa0cf…`） |
| **模型不会主动调 `read`** | 30 条标注问法，实测 **0 次**调用；它改为 `ls`/`find` 直接翻文件，甚至声称"我用 read 加载了文档"（幻觉） |
| 按触发条件预取不可行 | `when` 二元组打分：none 上界 0.04 与 memory 的 0.05 重合，无阈值可分 |
| 名字命中预取有效 | 明确说出模块名时注入 README，确定性、零误判，仅此时付约 250 token |
| **注册成工具后模型会主动调用** | 装上 plugin 后：`memory_search` 触发 +3 次、`read_module` +1 次；散文时代为 0 次 |

## 安全

- 凭据、Token 不进仓库；服务器 Key 放在 `core\home\.env`（仓库外）。
- SSH 仅公钥登录（`PasswordAuthentication no` + `KbdInteractiveAuthentication no`）。
- 所有服务只监听 `127.0.0.1`；本地经 SSH 隧道访问，不暴露公网端口。
