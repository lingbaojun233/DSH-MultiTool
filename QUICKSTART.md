# DSH-MultiTool 一键部署（Windows）

解压 → 跑一个脚本 → 打开浏览器就能用。

---

## 1. 你需要什么

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11 或 Windows Server 2019+，x64 |
| 权限 | **管理员** PowerShell（脚本要注册开机自启的计划任务） |
| 磁盘 | ≥ 3 GB（DSH 核心约 1.5 GB） |
| 网络 | 能访问 npm 镜像与 GitHub（装依赖用） |
| 模型 Key | 一个 DeepSeek API Key，必填 |

Node **不用提前装**：安装脚本会自己下载便携版 Node 并放进 `core\runtime\node`，不动系统环境。

---

## 2. 三步装上

把 zip 解压到任意目录（例如 `D:\dsh-release`），在该目录里**以管理员身份**打开 PowerShell：

```powershell
# 1) 进解压出来的目录
cd D:\dsh-release

# 2) 跑安装（默认装到 C:\Apps\DSH-MultiTool，端口 8765 起）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

想换目录或换端口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Root D:\DSH -PortBase 9000
```

```powershell
# 3) 装完浏览器打开
start http://127.0.0.1:8766/
```

> 脚本会做 8 件事：拷文件 → 装 DSH 核心 → 装 6 个插件 → 写密钥模板 → 配端口 → 注册 10 个计划任务 → 起服务 → 等面板返回 200。
> 第一次大约 5–15 分钟，主要时间花在下载 Node 和 npm 依赖上。

---

## 3. 装完还要做两件事

### 3.1 填模型 Key（不填不能聊天）

编辑 `<安装目录>\core\home\.env`：

```text
DEEPSEEK_API_KEY=sk-你的key
```

### 3.2 拿邀请码登录面板

面板注册要邀请码，安装脚本已经随机生成，写在：

```text
<安装目录>\secrets\invite-code.txt
```

安装结尾的控制台也会把它打印出来。打开面板 → 注册 → 填邀请码 → 登录。

> 邀请码只从这个文件读，不再写在 `start-server.cmd` 里。早期提交曾硬编码过生产邀请码与 PFX 口令 —— clone 过旧版本的话请重新拉取并轮换。

---

## 4. 端口一览

`-PortBase` 是这一串端口的起点，默认 **8765**：

| 服务 | 端口 | 用途 |
| --- | --- | --- |
| io | base + 0 | 把任务喂给 DSH 核心的通道 |
| **panel** | **base + 1** | **你打开的面板** |
| memory | base + 2 | 跨会话记忆 |
| separator | base + 3 | 登录 / 注册 / 会话 |
| video | base + 4 | 视频相关接口 |
| speak | base + 5 | 语音合成 |
| listen | base + 6 | 语音识别 |
| studio | base + 7 | 视频创作引擎 |
| sticker | base + 8 | 表情包 |

同一台机器上想跑第二套，两个参数都要换（换端口 + 换任务名前缀，否则计划任务会互相覆盖）：

```powershell
.\install.ps1 -Root D:\DSH -PortBase 19000 -TaskPrefix DSH-MultiTool-2
```

---

## 5. 可选能力（不装也能用核心功能）

| 能力 | 还需要什么 | 放哪里 |
| --- | --- | --- |
| 语音合成（说） | BreezeBlue Key | `<安装目录>\secrets\breezeblue.key` |
| 视频（做视频） | Qwen Key + ffmpeg | `video\secrets.json` + `tools\ffmpeg\bin\ffmpeg.exe` |
| 数学动画场景 | Python 3.11 + manim | `tools\python311\python.exe` |
| 表情包 / 记忆 / 语音识别 | 无 | 开箱可用 |

没放 ffmpeg 时：聊天、记忆、表情包、视频**分镜规划**都正常，只是**渲染不出 mp4**。

---

## 6. 已验证 / 未验证

**本版本实际跑通过**（在服务器上用一个干净临时目录 `C:\Apps\DSH-MultiTool-test`、`-PortBase 19000`、任务前缀 `DSH-MultiTool-TEST` 实测）：

- 全新安装 21 秒完成（npm 缓存已热；冷缓存约 2–5 分钟，视 GitHub 连通性而定）
- 9 个服务全部监听 19000–19008；面板首页 `GET /` 返回 **HTTP 200**；`io /v1/health` 返回 `ready:true`
- 6 个插件全部落到 `node_modules` 并出现在 profile 的 bundle 列表里
- 10 个计划任务注册成功（9 个开机自启 + 1 个每日 03:00）
- 此安装上真调 `make_video {plan_only:true}` → 返回 7 场分镜（`mode:"script"`，24 秒），不是报错
- 重复执行 `install.ps1`：退出码 0、任务仍是 10 个不重复、每个 `start-server.cmd` 的管理块只有 1 段、密钥和邀请码保持不变、9 个端口继续可连
- `uninstall.ps1 -Force`：10 个任务全部移除、目录删除干净、遗留的 node.exe 按「本安装端口 + 本安装路径」精确回收
- 全程生产的 `C:\Apps\DSH-MultiTool` 与其 10 个计划任务状态**前后一致**（脚本对比 `TaskName=State` 无差异）

**未在本版本验证：**

- 从零下载 Node 与 dsh 的完整路径（本次验证用 `-CoreFrom` 复用了已有核心；下载与镜像回退逻辑来自已随仓维护的 `core\bootstrap.ps1`）
- 完全没有外网的机器（安装需要 npm 与 GitHub）
- Windows 10 家庭版（计划任务以 SYSTEM 运行）
- 公网 HTTPS 访问（面板默认只听 127.0.0.1；对外需要反向代理或自备证书）
- 语音合成 / 视频真实渲染（本次未填 BreezeBlue Key，也未放 ffmpeg；只验证了视频分镜规划）

---

## 7. 常见问题

**面板打不开**
```powershell
# 服务起来了吗
Get-ScheduledTask -TaskName "DSH-MultiTool *" | Select-Object TaskName, State
# 面板端口在听吗（把 8766 换成你的 panel 端口）
Test-NetConnection 127.0.0.1 -Port 8766
# 看日志
Get-Content C:\Apps\DSH-MultiTool\logs\panel.log -Tail 40
```

**能打开但聊天没反应**：`core\home\.env` 里没填 `DEEPSEEK_API_KEY`，或填错了。看 `logs\io.log`。

**视频渲不出 mp4**：缺 ffmpeg。放到 `tools\ffmpeg\bin\ffmpeg.exe`，再重启 Studio 任务。

**没有声音**：`secrets\breezeblue.key` 是空的；或者缺 ffmpeg（wav 转码要用）。

**计划任务没启动**：重开一个管理员 PowerShell 再 `Get-ScheduledTask`；任务触发条件是「开机时」，注册后需要重启或手动 `Start-ScheduledTask`。

**已经装过，想重装**：直接再跑一次 `install.ps1`。要彻底重来就先 `uninstall.ps1`。

---

## 8. 卸载

```powershell
# 交互确认 + 连数据一起删
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1

# 想留记忆库和历史，只删程序
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 -KeepData

# 装的时候换过端口/任务前缀，卸载时也要带上，否则找不到那些任务
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 -Root D:\DSH -PortBase 19000 -TaskPrefix DSH-MultiTool-2
```

卸载只按计划任务名停服务。极少数情况下 `cmd.exe` 被停掉而它启动的 `node.exe` 还在跑（会占着端口和
`memory.db`），此时卸载脚本只回收「监听本安装端口 **且** 命令行里带本安装路径」的 `node.exe`，
**不会碰机器上其它 node 进程**。

---

## 9. 装完的目录长这样

```text
C:\Apps\DSH-MultiTool\
├─ core\             DSH 核心（runtime\node、app、home）
├─ io\ panel\ memory\ separator\ video\ speak\ listen\ studio\ sticker\   九个服务
├─ secrets\          internal-token.txt / breezeblue.key / invite-code.txt / panel-cert.pass
├─ data\             记忆库、面板历史、渲染产物
├─ logs\             每个服务一个日志
├─ tools\            可选：ffmpeg / python311 / piper
├─ install.ps1
├─ uninstall.ps1
└─ QUICKSTART.md     本文件
```

细节和架构见主仓 README。
