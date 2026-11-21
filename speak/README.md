# speak — 发声模块

把文字合成语音，返回 wav。面板里每条回复旁边有个 🔊，点了就读出来。

## 为什么用 Windows SAPI 而不是 qwen

先说结论：**这个网关的音频模型调不通**，不是我没试。

```text
GET  /audio/speech              → 缺 model（路由存在，从 body 读）
POST /audio/speech {model,...}  → {"code":"InvalidParameter","message":"url error, please check url"}
POST /audio/transcriptions      → 同上
api-key 换成 query / header / 表单 → 仍是 404 或 url error
```

`/models` 里确实列着 `qwen-audio-3.0-tts-plus`、`qwen-audio-3.0-asr-flash`、`qwen-audio-3.0-realtime-plus`，但网关没给它们配可路由上游 —— 只能走 chat 和看图。

所以默认走 **Windows SAPI**（离线、免 key、免费）：

| | |
| --- | --- |
| 语音 | `Microsoft Huihui Desktop`（zh-CN 女声），本机和服务器都有 |
| 速度 | 合成约 0.1s，端到端约 1s |
| 音质 | 机械但清楚，不是 qwen 那种自然音色 |

`config.json` 里 `provider` 改成 `"qwen"` 会明确报 `QWEN_AUDIO_NOT_ROUTED` 而不是假装成功 —— 等拿到可用音频路由再填。

## 五个音色，按名字点单

`POST /v1/speak {text, voice}` 里的 `voice` 决定用哪个引擎，调用方不用关心底层：

| voice | 引擎 | 特点 |
| --- | --- | --- |
| `huayan` | Piper (CPU, onnx) | **默认**，22050Hz，音质最好，约 1.2s/句，峰值 160MB |
| `huayan-fast` | Piper x_low | 约 0.94s/句、92MB，但声调有损 |
| `yaoyao` | WinRT OneCore | 0.88s/句，年轻女声，系统自带 |
| `huihui` | WinRT OneCore | 老式播音腔（就是最初那个） |
| `kangkang` | WinRT OneCore | 男声 |

`config.json` 的 `voice` 是默认值，重启生效。

Piper 装在 `C:\Apps\DSH-MultiTool\tools\piper\`（包含 `espeak-ng-data\` 与 VC 运行时 dll，
都是 app-local 部署，没装系统级 redist）。

### 为什么不用 xiao_ya / keqing 这些"角色音色"

它们是 **pinyin 音素表**模型（`"phoneme_type":"pinyin"`，音素是多字符的 `zh`/`ai`/`ang`），
而 Piper 1.2.0 只接受单码点音素，直接报 `"ai" is not a single codepoint`，wav 0 字节。
要换人声得上 sherpa-onnx 的 pinyin 模型 —— 注意那个 `sherpa-onnx-non-streaming-tts-x64.exe`
是 GUI 子系统，当 CLI 用会静默挂起，得找官方 CLI 版。

## 接口

```text
GET  /v1/health  → {ok, provider, voice, rate}
POST /v1/speak   → {text, voice?, rate?}   body
                 ← audio/wav 字节（直接喂 <audio>）
```

面板侧有 `/api/tts`：需要登录，把 wav 原样透传给浏览器。

## 念之前会先洗一遍

人格里写着「语音只说出口的话」，这一条在 `cleanForSpeech()` 里落地：

- 去掉 Markdown（标题、加粗、代码块、链接保留文字）
- 去掉 emoji 和颜文字（`（´･ω･`）` 念出来是噪音）
- 超过 `maxChars`（默认 300）截断，避免把整篇念完

## 实测

| 文本 | 结果 |
| --- | --- |
| 主人，桥塌了诶，我赌你前三座全掉下去 | 264 KB wav / 1.03s（含网络） |

## 限制

- **情感为零**：SAPI 不支持语气/情绪，人格里那些语气词念出来是平的。
- **只出一个音色**：zh-CN 只有 Huihui（女声）。
- **服务器没有声卡也没关系**：SAPI 输出到文件，不需要播放设备。
