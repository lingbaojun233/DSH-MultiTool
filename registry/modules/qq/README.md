# qq

## 何时用

- 用户说「帮我看看 QQ 有没有新消息」「这局我该怎么回」
- 需要把挑好的回复填进 QQ 输入框

## 何时不用

- 无人值守批量发消息
- 不在解锁的桌面会话里（锁屏、RDP 断开即失效）

## 输入 / 输出

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `start.cmd` | cmd | 起本地后端 + 开小窗口 |
| Action | string | `info` / `capture` / `guard` / `send` / `commit` |
| Text | string | `send` 要发的内容 |
| -NoSend | switch | 只粘贴不回车，供人确认 |
| → messages | array | `[{side,text}]` 带说话人的转录 |
| → candidates | array | `[{reply,why,reasoning,path}]` 候选回复 |

## 例子

```text
> start.cmd
→ messages 6 · candidates 3
```

工具本体在仓库外：`../../qq-tool/`。截屏与按键由本地脚本做，看懂聊天、写回复由模型做，发送由人点头。
