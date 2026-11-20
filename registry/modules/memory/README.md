# memory

## 何时用

- 用户问"之前说过什么""上次那个"，或需要跨会话的事实、偏好、承诺
- 需要确认某件事是否真的发生过

## 何时不用

- 当前对话已包含全部信息
- 问题与历史无关（闲聊、常识问答）

## 输入 / 输出

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| query | string | 检索词，自然语言即可 |
| max_items | int | 1..32，默认 8 |
| max_tokens | int | 50..4000，默认 1200 |
| → items[].text | string | 记忆正文，≤120 token |
| → items[].evidence | string | 证据定位，如 `chat:g1#m2` |
| → used | object | `{count, tokens}` 实际用量 |

## 例子

```text
node cli.js search "上次说的部署路径" --max-items 5
→ {"items":[{"text":"部署在 C:\\Apps\\DSH-MultiTool","evidence":"chat:panel#m1"}],"used":{"count":1,"tokens":20}}
```
