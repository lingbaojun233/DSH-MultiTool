# studio

## 何时用

- 用户说「做一个视频」「来个短片」，要一句提示词变出 mp4
- 需要可复现的画面：分镜是 JSON，改一句重渲染

## 何时不用

- 要分析已有视频（用 video 模块）
- 需要真实素材、拍摄画面或复杂剪辑

## 输入 / 输出

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| prompt | string | 一句话要求，如「讲讲下雨天不想出门」 |
| seconds | int | 目标总时长，默认 12，封顶 60 |
| voice | string | 旁白音色：yaoyao / huayan |
| bgm | string | `data\studio\bgm\` 下的文件名，可空 |
| → plan | object | 分镜 `{title, scenes:[{text,narration,seconds,bg}]}` |
| → jobId | string | 成片标识，取回用 `/api/studio/video?id=` |

## 例子

```text
> POST /v1/create {"prompt":"深夜写代码","seconds":10,"voice":"yaoyao"}
→ 4 场 / 8.8 秒 / 4 条旁白，jobId=46fa9f70-...
```
