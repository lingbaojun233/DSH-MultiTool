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
