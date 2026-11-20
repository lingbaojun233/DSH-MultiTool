# listen

## 何时用

- 用户发来语音消息或录音，要知道里面说了什么
- 面板里按住说话，需要把话变成文字再回复

## 何时不用

- 纯文字对话
- 录音是英文或方言（机器上只装了中文听写引擎）

## 输入 / 输出

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| audioBase64 | string | 音频的 base64，可带 data URL 前缀 |
| mime | string | `audio/wav` / `audio/webm` 等，可省（按文件头猜） |
| → text | string | 识别出的一整句话，无标点 |
| → ms | int | 耗时（毫秒），含 ffmpeg 转换 |
| → provider | string | 固定 `windows-sapi` |

## 例子

```text
> POST /api/listen/transcribe {"audioBase64":"<webm base64>","mime":"audio/webm"}
→ text「今天服务器又崩了我有点烦」ms 1180
```
