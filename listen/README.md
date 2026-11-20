# listen — 听力（语音转文字）

把一段音频转成文字。识别在本机 Windows SAPI 里跑，不联网、不花 token。

## 原理

```
POST /v1/transcribe { audioBase64, mime }
  → 写临时文件 os.tmpdir()/listen-XXXX/in.<ext>（ext 先看文件头，再看 mime）
  → 不是规范 WAV 就调 ffmpeg 转：-ar 16000 -ac 1 -acodec pcm_s16le out.wav
  → spawn powershell -NoProfile -File asr.ps1 -In out.wav -Out out.txt
      asr.ps1: System.Speech.Recognition.SpeechRecognitionEngine
               SetInputToWaveFile + DictationGrammar，循环 Recognize() 到 null
  → 读回 UTF-8 文本（无 BOM），删临时目录，返回 { ok, text, ms, provider }
```

文本走文件而不是 stdout：SYSTEM 账户下 PowerShell 5.1 的 stdout 是 OEM 代码页
（cp936），经 Node 按 UTF-8 解码必然乱码。写 UTF-8 文件没这个问题。

`asr.ps1` 纯 ASCII 是硬要求：PS 5.1 把无 BOM 的 UTF-8 当 ANSI 读，中文注释会乱码。

## 听声音，不只是听人话

视频里的"声音"不只是台词：还有配乐、撞击、环境音。所以除了 `/v1/transcribe`（纯转写），还有 `/v1/hear`：

```text
POST /v1/hear  { filePath }             服务器上的音/视频文件
            或 { audioBase64, mime }    直接给字节
← { ok, duration, transcript, events[], summary, levels[], truncated }
```

它做三件事：

1. **抽音轨**：ffmpeg `-vn -ac 1 -ar 16000`，视频直接能吃；超过 `maxHearSeconds`（默认 180）截断并标记 `truncated`
2. **算能量曲线**：从 ffmpeg 管道拿 8k 单声道 PCM，按 `hearWindowSec`（默认 0.25s）逐窗口算 RMS → dBFS。
   这里**必须用二进制接 stdout**，`toString('utf8')` 会把样本毁掉。
3. **翻译成"听到了什么"**：静音段、突然的响动（跳升 ≥12dB 且 >-18dBFS）、持续有声段，再和 ASR 文本合并成一句话。

`levels` 是抽稀到 2 秒一个点的曲线，前端可以画波形。

### 为什么自己算能量而不是问模型

因为这个网关**没有可用的音频理解模型** —— 拿不到"第 12 秒是爆炸声"这种语义。既然拿不到语义，就给物理量：哪几秒静音、哪里音量突变、整体吵不吵。所有推断性结论都带"像"字，不装成事实。

## 接口

### GET /v1/health

```json
{ "ok": true,
  "provider": "windows-sapi",
  "recognizers": [{ "id": "MS-2052-80-DESK", "culture": "zh-CN", "name": "Microsoft Speech Recognizer 8.0 ..." }],
  "ffmpeg": true, "port": 8771, "timeoutMs": 60000 }
```

`ok` 为 true 的条件：asr.ps1 存在且至少装了一个 SAPI 识别引擎。没引擎时 `ok:false`
并带 `error`。识别引擎列表缓存 60 秒，避免每次探活都起一个 PowerShell。

### POST /v1/transcribe

请求：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| audioBase64 | string | 音频的 base64，可带 `data:audio/webm;base64,` 前缀 |
| mime | string | `audio/wav` / `audio/webm` / `audio/ogg` / `audio/mp4` … 可省，省了按文件头猜 |

返回：

```json
{ "ok": true, "text": "今天服务器又崩了", "ms": 1203, "provider": "windows-sapi",
  "segments": 1, "confidence": 0.82, "recognizer": "MS-2052-80-DESK",
  "source": "wav", "converted": false }
```

失败一律 HTTP 200 + `{ ok:false, error }`（面板只看 body，不看状态码）：

| error | 含义 |
| --- | --- |
| EMPTY_AUDIO / BAD_BASE64 / AUDIO_TOO_SHORT | 音频没传对 |
| BAD_JSON | body 不是 JSON |
| BODY_TOO_LARGE | 超过 `maxAudioBytes`（默认 32MB，HTTP 413） |
| FFMPEG_MISSING / FFMPEG_FAILED | 转换失败，`FFMPEG_FAILED` 后面带 ffmpeg 尾部输出 |
| TIMEOUT | 单次超过 `timeoutMs`（默认 60s），进程已被杀 |
| ASR_FAILED | SAPI 报错，后面带 asr.ps1 的 stderr |

### 附带的调试接口

`GET /v1/recognizers` 强制重新枚举 SAPI 引擎（不走缓存），排查装机问题时用。

## 配置 `config.json`

| 键 | 默认 | 说明 |
| --- | --- | --- |
| port | 8771 | 监听端口 |
| host | 127.0.0.1 | 只本机，不对外 |
| provider | windows-sapi | 写进响应的 provider 字段 |
| powershell | powershell.exe | 系统 PATH 里的 PS 5.1 |
| asrScript | asr.ps1 | 相对模块目录，也可写绝对路径 |
| ffmpeg | `C:\Apps\DSH-MultiTool\tools\ffmpeg\bin\ffmpeg.exe` | 转换用，可覆盖 |
| recognizer | `""` | 指定引擎 id；空 = 优先 zh-CN，否则第一个 |
| timeoutMs | 60000 | 单次转写总上限（下载 + 转换 + 识别） |
| maxAudioBytes | 33554432 | 请求体上限（base64 后），约 24MB 音频 |
| sampleRate | 16000 | 转换目标采样率 |

## 实测

服务器上用 `Microsoft Huihui Desktop` 合成中文、再喂回 `/v1/transcribe`（16k 单声道 wav）：

| 原文 | 识别结果 | 耗时 |
| --- | --- | --- |
| 今天服务器又崩了，我有点烦 | 今天服务器又帮了我有点烦 | 1.24s |
| 帮我看一下磁盘还剩多少空间 | 当我看一下磁盘还剩多少空间 | 1.11s |
| 明天下午三点提醒我给客户打电话 | 明天3:00PM提醒我给客户打电话 | 1.09s |
| 这个月的电费好像涨了不少，你帮我查一下上个月的账单，顺便把结果发到我邮箱 | 这个月的电费好象长了不少你帮我查一下上个月的帐单顺便把结果发到我邮箱 | 1.59s |

同样的音频转成 webm/opus 再发，结果一致、耗时接近。

结论：整句意思基本能对，错字集中在同音词（崩→帮、帮→当、涨→长、账→帐）；
数字会自动转成阿拉伯数字（三点 → 3:00PM）。做逐字稿不行，判断「他大概说了什么」够用。
含英文字母/单位的短句（如「只剩十六个G了」）错得厉害，别指望。

## 限制（实话）

- **只听中文**。机器上装的是 zh-CN 听写引擎（`MS-2052-80-DESK`），英文只能听个大概，
  方言基本不行。
- **准确率一般**。DictationGrammar 是通用听写，没有热词、不能纠错；专有名词、
  数字、地名容易错。够用来判断「他大概说了什么」，不足以做逐字稿。
- **没有标点、没有断句**。asr.ps1 把各段结果直接拼起来，中间不加标点。
- **SAPI 的坑**：`Recognize()` 文档说读完返回 `$null`，实测常常改成抛异常
  （"No audio input is supplied"，因为输入流已被它自己摘掉）。asr.ps1 把这种异常
  当「读完了」处理，保住已经认出来的部分；如果第一段就抛，才返回 `ASR_FAILED`。
- **只能是 WAV 进 SAPI**。webm/ogg/mp4 依赖 ffmpeg；服务器上 ffmpeg 不在时，
  非 wav 音频直接报 `FFMPEG_MISSING`。
- **`config.json` 必须是无 BOM 的 UTF-8**。带 BOM 时 `JSON.parse` 会抛，
  早期版本会静默回退到默认配置（连端口都变）；现在代码里会先剥掉 BOM。
- **串行吃 CPU**。每次转写起一个 PowerShell + 一个识别引擎，并发多了会互相抢核；
  面板一次只发一条就行。
- **临时文件**在 `%TEMP%\listen-*`，处理完立刻删；进程被杀时由系统清理。
  SYSTEM 账户下 `%TEMP%` 实际是 `C:\Windows\TEMP`。


## 日志

`..\logs\listen.log`（`start-server.cmd` 重定向 + server.js 自己 append）。
每次转写一行：字节数、mime、ok、耗时、字数，失败带 error。
