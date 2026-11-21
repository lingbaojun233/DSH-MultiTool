# sticker — 表情包模块

让 DSH 能**发一张 GIF**，而不是只发文字。

## 为什么要有"压缩层"

原始表情包是 157 个 500×500 / 50fps 的 GIF，合计 **460MB**，单张最大 8.6MB。
直接发出去谁都受不了：聊天软件里转圈、手机端还要再被压一次。

所以模块里分两个目录：

| 目录 | 用途 |
| --- | --- |
| `orig\` | 原始包，只归档，不对外发 |
| `send\` | **压缩版**，300px / 15fps / 80 色，约 0.9MB，对外一律发这个 |

压缩用 ffmpeg 的调色板两遍法（`palettegen` → `paletteuse`），必须走 `-filter_complex`：

```text
[0:v] fps=15,scale=300:-1:flags=lanczos,split [a][b];
      [a] palettegen=max_colors=80:stats_mode=diff [p];
      [b][p] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle
```

用 `-vf` 会直接失败（单路输出没法既当输入源又当输出）。

## 挑图不用模型

文件名里就带着表情名（`蓝色大肥鱼_停止工作_2026-...gif`），所以按关键词打分足够：

- 完全等于表情名 → 3 分
- 前缀命中 → 2 分
- 包含 → 1 分
- 逐字命中超过 60% → 0.4 分（让"不想干活"也能蹭到"停止工作"）

## 识图：没有名字的图靠它

表情名存在 catalog 里，有名字就够模型接话。但**外部来的 GIF 没有名字**，
所以加了一条识图路径：

```text
GIF → ffmpeg 抽第 12 帧（不足 13 帧退回第一帧）→ PNG → base64
    → video 模块 /v1/look（它持有 key）→ qwen3.8-flash 看一眼
    → 一句中文描述 → 缓存到 data\stickers\descriptions.json
```

为什么走视频模块：**key 只存一份**。sticker 自己再存一个 key，迟早会出现两处不一致。

缓存很关键：同一张图不该每次发表情都花一次视觉调用。`?force=1` 可强制重看。

实测（"停止工作"那张）：`蓝发兽耳女孩崩溃捂脸，面前弹出一个写着"停止运行"的报错弹窗。`
—— 连画面上的字都读出来了。

## 面板上的两个开关

- **默认**：用表情名（快，约 5 秒一轮）
- **勾「看图」**：先识图再回话（多 2~4 秒，但模型真的看见了画面）
- **没有名字的图**：自动走识图，不需要勾

## 接口

```text
GET /v1/health              → {ok, count, bytes}
GET /v1/list?q=&limit=      → {ok, items:[{id, name, mood, bytes}]}
GET /v1/pick?q=不想上班      → {ok, sticker, candidates}   挑一张
GET /v1/gif?id=<id>         → image/gif（可长期缓存）
GET /v1/reload              → 重新扫描 send\ 目录
```

## 面板

输入框旁边的 😀 打开表情面板，点一张就发出去（**不经过模型**，只记进对话历史，刷新后还在）。

## 实测

| 项 | 数值 |
| --- | --- |
| 原始 | 157 个 / 460MB |
| 压缩后 | 约 140MB，单张 0.6~1.4MB |
| 单张压缩耗时 | 1~2 秒 |

## 限制

- 只支持 GIF。原包如果有 APNG/WebP，需要另加处理。
- 表情名靠文件名解析，改文件名就会丢标签（catalog.json 可以手工补 `tags`）。
- QQ 参谋目前只能发文字，发图要另外走剪贴板/文件粘贴，这块没接。
