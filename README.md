# DSH-MultiTool

以 **DeepSeek Harness（DSH）** 为核心的 AI 多功能工具集。

## 架构

一个核心 + 多个模块。核心与每个模块在程序文件夹下**各占一个目录**：

```text
程序文件夹（服务器上 C:\Apps\DSH-MultiTool\）
├── core\     核心 = DSH 本体：便携 Node、@deepseek-ai/dsh、headless profile、DSH_HOME
├── io\       IO 模块：向核心喂输入、从核心取输出的唯一通道（127.0.0.1:8765）
└── panel\    面板模块：文本输入输出界面，反代 io（127.0.0.1:8766）
```

模块不直接调用模型，只通过 IO 模块与核心交互；核心的模型、工具、安全默认值都来自 DSH 本体，
模块不重复实现。

## 数据流

```text
调用方 ──(HTTP POST /v1/input 或 CLI send)──> io 模块
                                                │ 以位置参数传入任务
                                                ▼
                                        dsh --profile headless "<task>"
                                                │ 模型推理 + 工具执行
                                                ▼
                                        stdout = 最终答案
                                                │
调用方 <──(JSON {ok, answer, exitCode, ms})──────┘
```

## 仓库结构

```text
DSH-MultiTool/
├── core/
│   ├── bootstrap.ps1            在 Windows 上安装/修复核心（幂等）
│   ├── start-core.ps1           用 WMI 后台拉起安装（脱离 WinRM 管道）
│   ├── start-bootstrap.cmd      同上，cmd 入口
│   └── profile/headless/        headless profile 模板
├── io/
│   ├── io.js                    CLI + 库：调用核心并取回答案
│   ├── server.js                HTTP 接口（默认 127.0.0.1:8765）
│   └── smoke-test.ps1           端到端冒烟测试
├── panel/
│   ├── server.js                静态托管 + 反代 io（127.0.0.1:8766）
│   ├── index.html / app.js / style.css
│   ├── start-server.cmd         计划任务入口
│   └── open-panel.cmd           本地一键启动（隧道 + 浏览器）
├── memory/
│   ├── server.js                记忆接口（127.0.0.1:8767）
│   ├── lib/                     闸门 / 存储 / 索引 / 召回 / token 估算
│   ├── schema/  rules/          事件 schema、巩固与冲突规则
│   └── README.md
├── registry/
│   ├── modules/<name>/          每个模块一个目录：module.yaml + README.md
│   ├── lib/                     校验 / 目录渲染 / 加载器 / README 生成 / 质检
│   ├── tests/triggers.yaml      30 条触发测试集
│   └── cli.js                   validate / catalog / read / lint / gen / stats
└── docs/
```

## 部署状态

| 组件 | 状态 | 版本 |
| --- | --- | --- |
| core | 已部署并验证 | dsh 0.1.1-rc.2 + Node v22.23.5 |
| io | 已部署、开机自启（SYSTEM 计划任务） | CLI + HTTP 均通过 |
| panel | 已部署、开机自启（SYSTEM 计划任务） | 本地经 SSH 隧道访问，端到端 3.5 s |
| memory | 已部署、开机自启 + 每日 03:00 巩固，v0.2 | SQLite+FTS5，10 万条下 p95 0.7ms，验收 7/7 |
| registry | 已部署，注入 io 的 prompt 顶部 | 目录 92 token（3 模块），触发测试 30/30，验收 9/9 |

服务器侧基础设施：OpenSSH Server（仅公钥登录）、WinRM（控制通道）、
计划任务 `DSH-MultiTool IO`（开机拉起 `io\server.js`）。

验证记录（服务器实测）：`io send` → 3.4 s 返回；HTTP `/v1/input` → 3.2 s 返回；中文任务往返正常。

## 关键约束（0.1.1-rc.2 实测）

- `dsh --profile headless "<task>"`：**任务只能作为位置参数**。
- 不支持 `-`（stdin 标记）、`--json`、`--session-id` —— 文档里这些是更新版本的能力；
  传 `-` 会被当成任务文本原样回复。
- 凭据读取顺序：启动环境变量 → 当前目录 `.env` → `$DSH_HOME/.env`；headless 不读图形界面凭据库。

## 安全

- 凭据、Token 一律不进本仓库；服务器上的 Key 放在 `core\home\.env`（已在仓库外）。
- 详见 `../secrets/README.md`。
