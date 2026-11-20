# speak

## 何时用

- 需要把一段文字读出来（回复转语音、念提示）
- 面板里想给回复加个「朗读」按钮

## 何时不用

- 只要文字
- 需要自然拟人的音色（SAPI 很机械）

## 输入 / 输出

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| text | string | 要念的文字，会先洗掉 Markdown 和颜文字 |
| voice | string | 语音名，空 = 自动挑中文女声 |
| rate | int | 语速 -10..10，默认 -1 |
| → wav | bytes | `audio/wav`，直接喂 `<audio>` |

## 例子

```text
> POST /v1/speak {"text":"主人，桥塌了诶"}
→ audio/wav 264 KB，voice=Microsoft Huihui Desktop
```
