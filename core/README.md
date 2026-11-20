# core —— DSH 本体

核心就是 DeepSeek Harness 本身，以独立、可搬移的目录形态存在。

## 安装后的目录

```text
core\
├── runtime\node\       便携 Node.js（LTS win-x64，不解压到系统目录）
├── app\node_modules\@deepseek-ai\dsh\    DSH 包（自包含依赖）
├── home\               DSH_HOME：profiles / sessions / .env
│   ├── profiles\headless\
│   └── .env            DEEPSEEK_API_KEY=...
├── dsh.cmd             启动器（设置 DSH_HOME 与 PATH 后调用 dsh）
└── bootstrap-status.json  最近一次安装结果
```

`dsh.cmd` 是核心的唯一入口：

```bat
dsh.cmd --profile headless "你的任务"
```

## 安装 / 修复

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File core\bootstrap.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File core\bootstrap.ps1 -Force
```

`bootstrap.ps1` 是幂等的：已装好的部分会跳过。

- 下载 Node 走镜像回退：`npmmirror` → `huaweicloud` → `nodejs.org`（默认参数可改）。
- 参数：`-DshVersion`、`-NodeVersion`、`-NodeMirrors`、`-NpmRegistry`、`-Force`。
- 失败会把原因写进 `bootstrap-status.json`，不会留下"半装"状态。

### 绕开 npm 的离线安装

在没有稳定 npm 解析能力的机器上，可以直接把**已装好且自包含**的 dsh 包复制到
`app\node_modules\@deepseek-ai\dsh`，再跑一次 `bootstrap.ps1` —— 它会发现版本已匹配，
跳过 npm，只补 profile、启动器和校验。

## 凭据

`home\.env`：

```text
DEEPSEEK_API_KEY=sk-...
```

headless 的读取顺序是：启动环境变量 → 工作目录 `.env` → `$DSH_HOME/.env`。
该文件属于核心自身配置，**不放进任何仓库**。

## 实测注意事项

- `[Console]::OutputEncoding` 在 WinRM 下会因"句柄无效"抛错，必须 try/catch 包裹。
- 生成 `dsh.cmd` 时每行用括号包住再 `-join "\r\n"`，否则数组拼接会把带引号的行拆散。
- 进程不要用 `start /b` 从 WinRM 里拉起：子进程会继承管道导致调用挂死，改用 `Win32_Process.Create`。
