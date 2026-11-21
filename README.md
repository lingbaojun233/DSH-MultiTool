# DSH-MultiTool

一个装在自己 Windows 机器上的 AI 助手：**DeepSeek Harness（DSH）核心 + 9 个常驻服务 + 6 个原生工具插件**。

它能**聊天**（可带附件）、**记事**（跨会话记忆）、**听你说话**（语音识别）、**开口讲话**（语音合成）、**看图**、**做视频**（自动写分镜并渲染 mp4）、**发表情包**，还支持**多用户登录**各聊各的。

装完之后，你打开的就是一个网页面板，像用聊天软件一样用它。

---

## 30 秒上手

```powershell
# 1) 下载 Release 里的 zip，解压到任意目录，然后在该目录用【管理员】PowerShell：
cd D:\dsh-release

# 2) 一条命令装完（默认装到 C:\Apps\DSH-MultiTool，端口 8765 起）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

# 3) 打开面板
start http://127.0.0.1:8766/
```

然后做两件事就完整可用了：

1. 把模型 Key 写进 `C:\Apps\DSH-MultiTool\core\home\.env` → `DEEPSEEK_API_KEY=sk-...`
2. 用邀请码注册账号。邀请码在 `C:\Apps\DSH-MultiTool\secrets\register-code.txt`（安装结尾也会打印）

装到别处、换端口：

```powershell
.\install.ps1 -Root D:\DSH -PortBase 9000
```

> **已验证**：全新目录 `install.ps1 -Root <临时目录> -PortBase 19000` 跑通 —— 9 个服务全部监听、面板首页 HTTP 200、10 个计划任务注册成功、重复执行不报错不重复建任务。
> 详细清单见 [QUICKSTART.md](QUICKSTART.md)。

**安装脚本会做 8 件事**：拷文件 → 装便携 Node + DSH 核心 → 装 6 个插件 → 写密钥模板 → 配端口 → 注册 10 个计划任务 → 起服务 → 等面板返回 200。第一次约 5–15 分钟（下载 Node 与 npm 依赖）。

Node **不用提前装**，脚本会下载便携版放进 `core\runtime\node`，不污染系统环境。

---

## 能做哪些事

| 能力 | 你可以怎么用 |
| --- | --- |
| **聊天** | 「帮我把这段话改得客气一点」；也能直接拖附件进去，让它读图/读文件后回答 |
| **记忆** | 「还记得我上次说的部署路径吗」——它跨会话记得你说过的事，不用重复交代 |
| **听（语音识别）** | 在面板按住说话，说完松手，它会把你说的转成文字再回答 |
| **说（语音合成）** | 让它「用温柔的语气念一遍」，回答会直接变成语音播出来 |
| **看图** | 发一张截图问「这个报错是什么意思」，它看图回答 |
| **做视频** | 「讲讲导数是什么，一分钟」——自动写分镜、生成动画、配音、渲染成 mp4 |
| **发表情包** | 说「发个无语的表情」——它会在图库里挑一个贴到对话里 |
| **多用户** | 家里人各自注册账号，共享同一个"人格"，但各有各的称呼和相处记录 |

---

## 面板怎么用

打开 `http://127.0.0.1:8766/`，第一次先注册（要邀请码）。

| 位置 | 干什么 |
| --- | --- |
| **聊天页** | 主界面。输入框发消息；可拖入图片/文件；按住麦克风键说话；出现的语音条可直接播放 |
| **视频创作 → 写稿** | 你给一段讲解稿，它拆成分镜再渲染。例：贴一段 300 字讲稿 → 「开始创作」 |
| **视频创作 → 分镜** | 你自己填每一场「画什么 + 念什么 + 几秒」，它只负责把画面翻译成动画 |
| **视频创作 → 全自动** | 只给一个主题和时长。例：「导数是什么，60 秒」→ 它自己写稿、分镜、配音、渲染 |
| **视频创作 → 进度** | 渲染要几分钟，页面会轮询进度；失败会给出可读原因而不是一串报错 |
| **表情包** | 对话里自动展示；也能直接说「发个 XX 表情」 |
| **记忆抽屉** | 看它记住了你哪些事，可清理 |
| **账号管理**（管理员） | 删除账号会连带清空该用户的会话、相处档案和记忆 |

视频渲染依赖外部工具，缺了会明确提示（见下节）。

---

## 配置

### 必填：模型 Key

`<安装目录>\core\home\.env`：

```text
DEEPSEEK_API_KEY=sk-...
```

模型凭据读取顺序：启动环境变量 → 当前目录 `.env` → `$DSH_HOME\.env`。

### 邀请码（谁能注册）

```text
<安装目录>\secrets\register-code.txt
```

想换邀请码：改这个文件，然后重启 Separator 任务（面板左侧「注册」页立刻生效）。

想彻底关闭注册（只留管理员）：把 `<安装目录>\separator\start-server.cmd` 里
`DSH_REGISTER_MODE=invite` 改成 `closed`，重启任务。

### 语音 / 视频（可选）

| 能力 | 文件 | 说明 |
| --- | --- | --- |
| 语音合成「说」 | `secrets\breezeblue.key` | 填 BreezeBlue 的 Key，留空则该功能不可用 |
| 视频「做视频」 | `video\secrets.json` 的 `apiKey`，或 `secrets\qwen.key` | 视频理解/规划用 |
| 渲染 mp4 | `tools\ffmpeg\bin\ffmpeg.exe` | **缺它渲染不出视频**，但分镜规划照常 |
| 数学动画场景 | `tools\python311\python.exe` + manim | 可选，用于公式/函数图场景 |

没有 ffmpeg 时：聊天、记忆、表情包、语音识别、视频**分镜规划**都正常。

### 端口

`-PortBase` 是端口块的起点，默认 **8765**，九个服务依次 +0…+8：

| 服务 | 偏移 | 默认端口 | 作用 |
| --- | --- | --- | --- |
| io | +0 | 8765 | 唯一对话通道，拼 prompt 调核心 |
| **panel** | **+1** | **8766** | **你打开的面板** |
| memory | +2 | 8767 | 跨会话记忆（SQLite + FTS5） |
| separator | +3 | 8768 | 注册 / 登录 / 会话 / 相处档案 |
| video | +4 | 8769 | 视频理解与规划 |
| speak | +5 | 8770 | 语音合成 |
| listen | +6 | 8771 | 语音识别 |
| studio | +7 | 8772 | 视频创作引擎（分镜 → 动画 → 渲染） |
| sticker | +8 | 8773 | 表情包 |

同一台机器跑第二套：换 `-PortBase` **并且**换 `-TaskPrefix`，否则计划任务会互相覆盖。

所有服务默认只监听 `127.0.0.1`。要在别的机器上访问，用 SSH 隧道：

```powershell
ssh -N -L 8766:127.0.0.1:8766 user@your-host
```

---

## 常见问题

**面板打不开**
```powershell
Get-ScheduledTask -TaskName "DSH-MultiTool *" | Select-Object TaskName, State
Test-NetConnection 127.0.0.1 -Port 8766
Get-Content C:\Apps\DSH-MultiTool\logs\panel.log -Tail 40
```
任务在 Running 但端口没开，就是进程起不来，看日志最后几行。

**能打开面板，但聊天一直转圈**
`core\home\.env` 没填 `DEEPSEEK_API_KEY`，或 Key 无效。看 `logs\io.log`。

**视频渲不出 mp4**
缺 ffmpeg。放一份到 `tools\ffmpeg\bin\ffmpeg.exe`，重启 Studio 任务。
先只想看分镜：让它在对话里「只出分镜、别渲染」即可（`plan_only`）。

**没有声音**
`secrets\breezeblue.key` 是空的；或者缺 ffmpeg（音频转码要用）。

**表情包不出现**
表情包目录/data 为空，或 Sticker 任务没起来。看 `logs\sticker.log`。

**计划任务没启动**
注册时用的是「开机时」触发。重启机器，或手动 `Start-ScheduledTask -TaskName "DSH-MultiTool Panel"`。
在远程桌面里注册完，建议注销重登一次让任务列表刷新。

**重装 / 换目录**
直接再跑一次 `install.ps1`：不会覆盖已填的 Key、邀请码、服务配置，也不会重复建任务。
要彻底重来先 `uninstall.ps1`。

```powershell
# 卸载（交互确认；-KeepData 保留记忆库和历史）
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```
卸载只按计划任务名停服务，**不会杀机器上别的 node 进程**。

---

## 目录结构

```text
C:\Apps\DSH-MultiTool\
├─ install.ps1  uninstall.ps1  QUICKSTART.md
├─ core\                  DSH 本体
│  ├─ runtime\node\       便携 Node（不装到系统）
│  ├─ app\                @deepseek-ai/dsh 及其依赖
│  ├─ home\               DSH_HOME：profiles / sessions / .env
│  ├─ bootstrap.ps1       安装或修复核心（幂等）
│  └─ dsh.cmd             命令行入口
├─ io\                    对话通道（8765）
├─ panel\                 网页面板（8766）
├─ memory\                记忆 + 每日巩固（8767）
├─ separator\             登录 / 注册 / 会话（8768）
├─ video\                 视频理解（8769）
├─ speak\                 语音合成（8770）
├─ listen\                语音识别（8771）
├─ studio\                视频创作引擎（8772）
├─ sticker\               表情包（8773）
├─ secrets\               internal-token / breezeblue.key / register-code
├─ data\                  记忆库、面板历史、渲染产物（部署不覆盖）
├─ logs\                  每个服务一个日志
└─ tools\                 可选外部工具：ffmpeg / python311 / piper
```

各服务通过 `start-server.cmd` 启动，日志一律写到 `logs\`（所以升级可以整目录替换业务代码）。

---

## 架构与实现

一句话：**面板 → io → 一个短命的 DSH 进程 → 模型 + 工具**，其余模块围绕这条主线做记忆、身份和媒体能力。

```text
浏览器(panel 8766)
   │  Bearer token
   ▼
separator(8768)  校验身份；每人一份相处档案
   │
   ▼
io(8765)  拼 prompt：模块目录 → 人格 → 最近 6 轮 → 当前消息
   │      node core/app/.../bin.js --profile headless "<task>"
   ▼
DSH 核心  模型 + 6 个原生工具插件
   │        ↑ memory_search / speak / listen / watch / make_video / sticker
   ▼
答案回传面板；异步把这一轮写进记忆库(memory 8767)
```

设计上几个刻意的选择：

- **每次请求派生一个核心进程**（1.5–2 s 启动），没有常驻的"核心守护进程"。好处是崩溃不互相拖累、升级只要换文件；代价是并发数 ≈ 进程数，当前无并发闸。
- **记忆不自动注入**：`memory_search` 是原生工具，由模型按需调用，省 token；io 只在回答后回写事件。
- **能力靠插件注册成工具**，而不是写在 prompt 里的散文。实测：散文时代模型 30 条问法 **0 次**调用 `read`；注册成工具后会主动调 `memory_search` / `make_video`。
- **一切只监听回环**，对外靠隧道或反向代理，不直接暴露公网端口。
- **业务代码与数据分离**：`data\`、`logs\`、`secrets\` 都在模块目录外，升级可以整目录替换 `io\`、`studio\` 等而不丢数据。

---

## 开发

```powershell
# 改完某个服务，替换目录后重启对应任务即可（任务名见下表）
Get-ScheduledTask -TaskName "DSH-MultiTool *" | Select-Object TaskName, State
Stop-ScheduledTask    -TaskName "DSH-MultiTool Studio"
Start-ScheduledTask   -TaskName "DSH-MultiTool Studio"

# 命令行直接问一句（不走面板）
C:\Apps\DSH-MultiTool\core\dsh.cmd --profile headless "帮我看看今天的记忆"

# 看核心装得对不对
C:\Apps\DSH-MultiTool\core\dsh.cmd --profile headless --dump-config

# 单模块冒烟
powershell -NoProfile -File .\io\smoke-test.ps1
node memory\test\acceptance.js --quick
```

插件是独立仓库，改完推到各自 GitHub，服务器上重装那一个就行：

```powershell
cd C:\Apps\DSH-MultiTool\core\home\profiles\headless
& ..\..\..\runtime\node\npm.cmd install https://github.com/lingbaojun233/dsh-studio/archive/refs/heads/main.tar.gz --no-audit --no-fund
```

插件清单（各自一个仓库）：

| 插件 | 仓库 |
| --- | --- |
| dsh-memory | github.com/lingbaojun233/dsh-memory |
| dsh-speak | github.com/lingbaojun233/dsh-speak |
| dsh-listen | github.com/lingbaojun233/dsh-listen |
| dsh-watch | github.com/lingbaojun233/dsh-watch |
| dsh-studio | github.com/lingbaojun233/dsh-studio |
| dsh-sticker | github.com/lingbaojun233/dsh-sticker |

### 安全

- 凭据不进仓库：`core\home\.env`、`secrets\`、`video\secrets.json` 都在 `.gitignore` 里。
- SSH 只允许公钥登录。
- 面板注册默认需要邀请码（`invite` 模式）。
