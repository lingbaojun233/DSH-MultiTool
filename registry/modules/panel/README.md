# panel

## 何时用

- 需要让用户在浏览器里直接对话，或翻看历史回复
- 需要把某轮问答的完整上下文展示给人看

## 何时不用

- 纯命令行任务，不需要人机界面
- 只需要一段文本结果，终端里就能看完

## 输入 / 输出

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| text | string | 用户输入 |
| sessionId | string | 会话标识，用于记忆证据定位 |
| history | array | 最近轮次 `[{role,text}]` |
| → answer | string | 回答正文 |
| → memory | object | `{used:{count,tokens}, items[]}` |

## 例子

```text
POST /api/input {"text":"我的猫叫什么？","sessionId":"p1"}
→ {"ok":true,"answer":"你的猫叫布丁。","memory":{"used":{"count":1}}}
```
