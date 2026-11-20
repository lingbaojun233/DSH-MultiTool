# qq

## 何时用

- 用户说「帮我看看 QQ 有没有新消息」「帮我回他一句」
- 需要把拟好的话以用户本人身份发进 QQ

## 何时不用

- 无人值守批量发消息
- 用户正在打字（`guard` 返回 `safeToType=False`），或不在解锁的桌面会话里

## 输入 / 输出

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| Action | string | `info` / `capture` / `guard` / `send` / `commit` |
| Text | string | `send` 要发的内容 |
| -NoSend | switch | 只粘贴不回车，供人确认 |
| -ClearFirst | switch | 发送前清空输入框已有草稿 |
| → stdout | string | 单行 `key=value` |
| → png | file | `capture` / `send` 落图到 `out/` |
| → file | path | 落盘图片的绝对路径 |

## 例子

```text
> qq.cmd -Action capture
→ file=out\capture-20261121-000256.png
```

工具本体在仓库外：`../../qq-tool/`。看懂聊天、写回复由模型做，代码只截屏和按键。
