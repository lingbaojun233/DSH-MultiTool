# io —— 输入输出模块

模块与核心之间的**唯一通道**：喂任务进去，拿答案回来。

## 两种形态

### 1. CLI

```powershell
# 位置参数传任务
node io.js send "介绍一下你自己"

# 从文件读任务（推荐：中文/长文本不受命令行转义影响）
node io.js send --file prompt.txt

# 从 stdin 读
Get-Content prompt.txt -Raw | node io.js send --stdin

# 只看核心是否就绪
node io.js health
```

输出：成功时只打印答案；失败时退出码非 0，错误写 stderr。
加 `--json` 打印完整结果对象。

### 2. HTTP

```powershell
node server.js
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/health` | 核心就绪状态 |
| POST | `/v1/input` | `{"text":"..."}` → `{ok, answer, exitCode, ms}` |

```powershell
$body = @{ text = "1+1 等于几" } | ConvertTo-Json -Compress
Invoke-RestMethod http://127.0.0.1:8765/v1/input -Method Post `
  -Body ([Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json; charset=utf-8'
```

环境变量：`DSH_IO_HOST`（默认 127.0.0.1）、`DSH_IO_PORT`（8765）、
`DSH_IO_TOKEN`（设置后需带 `Authorization: Bearer <token>`）、`DSH_CORE_DIR`。

## 记忆接入

io 是所有对话的唯一漏斗，记忆就挂在这里：

```text
用户问题 ──► memory_search（召回 ≤6 条 / ≤800 token）
          ──► 拼成 [可用记忆] 块前置到 prompt
          ──► dsh --profile headless
          ──► 答案返回给调用方
          ──► 异步 memory_remember ×2（用户消息 + DSH 回答，均带证据）
```

- 证据定位：`chat:<sessionId>#u<时间戳>` 与 `chat:<sessionId>#d<时间戳>`。
- 召回块只声明"这里没有的信息不要编造"，不保证模型一定引用。
- 记忆服务不可用时**静默降级**：照常对话，只是没有记忆。
- `--no-memory` 可整体关闭；`DSH_MEMORY_DISABLED=1` 环境变量同理。
- 返回体多一个 `memory` 字段：`{ used:{count,tokens}, items:[{id,evidence}] }`。

## 冒烟测试

```powershell
powershell -NoProfile -File io\smoke-test.ps1
# {"exitCode":0,"seconds":3.4,"answer":"OK","stderr":""}
```

用 .NET 进程 API 启动核心，不经过 cmd，避免引号与管道问题。

## 实现要点

- 调用形式固定为 `node <core>\app\node_modules\@deepseek-ai\dsh\lib\bin.js --profile headless "<task>"`。
- 环境注入 `DSH_HOME=<core>\home`，核心的 profile 与 `.env` 都在那里。
- 答案取 stdout；stderr 是推理过程与诊断，只在失败时透出。

## 版本限制（dsh 0.1.1-rc.2 实测）

- 任务**只能**作为位置参数传入；`-` 会被当成任务文本，不会读 stdin。
- 不支持 `--json` / `--session-id`，因此没有事件流与会话续接；
  当前 `parseStream()` 仍兼容 NDJSON，升级核心后自动生效。
- 单次调用一个任务，进程退出；多轮会话需要等核心升级或自行维护上下文。

## 开机自启（服务器上已配置）

`server.js` 以计划任务方式常驻：

| 项 | 值 |
| --- | --- |
| 任务名 | `DSH-MultiTool IO` |
| 触发器 | 开机（AtStartup） |
| 运行身份 | `SYSTEM`（无需登录、无需密码） |
| 入口 | `start-server.cmd` |
| 日志 | `..\logs\io.log`（追加写；放在模块目录外，避免 `push` 整目录替换时被占用） |
| 失败策略 | 每 1 分钟重试，最多 3 次；不设运行时长上限 |

运维命令（管理员）：

```powershell
Start-ScheduledTask   -TaskName 'DSH-MultiTool IO'
Stop-ScheduledTask    -TaskName 'DSH-MultiTool IO'
Get-ScheduledTaskInfo -TaskName 'DSH-MultiTool IO'   # LastTaskResult 267009 = 正在运行
```

注意：任务的工作目录是 `io\`，所以核心进程的 cwd 就是这里；日志长期追加，需要时手工清理。

## 安全

- 服务器 SSH 已改为**仅公钥登录**：`PasswordAuthentication no` + `KbdInteractiveAuthentication no`。
- HTTP 接口默认只监听 `127.0.0.1`；如果需要对外开放，先设 `DSH_IO_TOKEN`，再改 `DSH_IO_HOST`。

