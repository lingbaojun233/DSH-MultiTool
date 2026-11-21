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

## 批量预识图

157 张图一张张点太慢。`POST /v1/describe-all` 会先把待办数出来，**立刻返回**，
然后在后台串行跑：

```text
POST /v1/describe-all  {"force":false,"limit":0}
  → {"ok":true,"started":true,"total":157,"pending":157}

GET /v1/describe-status
  → {"ok":true,"total":157,"described":42,"pending":115,"running":true,
     "failed":0,"lastError":"","startedAt":"...","finishedAt":null}
```

- **串行、每张之间 100ms**：视觉调用有并发限制，并发打过去只会一起排队/限流。
- 默认只跑**还没有描述**的 id；`force=true` 全部重看，`limit=N` 只跑前 N 张。
- 已经在跑时再点，返回 `{"ok":true,"started":false,"alreadyRunning":true}`，不会起第二批。
- 没有待办（比如刚跑完）返回 `started:false, pending:0`。
- 单张失败**不中断整批**：计入 `failed`，`lastError` 记最后一个错误，循环继续。
- 跑完往 `logs\sticker.log` 写一行汇总，不逐张刷屏。
- `pending` 的两种含义：**running 时**是这一轮队列还剩几张；**跑完后**是“全目录还缺几张描述”。
  所以带 `limit` 的批次跑完，`pending` 会回到剩下的总数，而不是 0。

进度靠 `descriptions.json` 实时统计，服务重启后 `described` 不会归零；
批量状态（running/failed/时间）只在内存里，重启即清空。

## 收藏夹

DSH 自己挑中、想“记住”的表情放进 `data\stickers\favorites.json`：

```json
{
  "a1b2c3": { "name": "开心", "note": "验收收藏", "at": "2026-11-21T06:58:04.851Z" }
}
```

```text
POST   /v1/favorite  {"id":"a1b2c3","name":"开心","note":"顺手记的"}
DELETE /v1/favorite?id=a1b2c3
GET    /v1/favorites
```

语义（都是踩过的坑）：

- **收藏名覆盖 `mood`**：`/v1/list` 里这张的 `mood` 变成收藏时给的名字。
  用户自己起的名字比打包脚本的标签更权威；而 `list`/`pick` 的打分都读 `mood`，
  覆盖一处就同时影响展示和搜索。
- `/v1/list` 的每项都带 `favorite: true|false`，**收藏的整体排在前面**
  （先按 favorite 排，再按得分，最后按名字）。
- `/v1/list?favorite=1` 只返回收藏。
- `/v1/pick` 里收藏 **+1 分**，但只对原本就有命中的图加分 ——
  否则一张收藏图会对任何无关查询都“及格”，把真正匹配的挤掉。
- 收藏不存在的 id → `404 {"ok":false,"error":"NOT_FOUND"}`；
  重复收藏视为改备注，**保留第一次的 `at`**，排序不会乱跳。
- 取消收藏是幂等的（删两次不报错），`favorites.json` 用“先写临时文件再 rename”，
  避免半截 JSON 把整个收藏夹读丢。

## 本地验收

`dataDir` / `videoUrl` 都能用环境变量覆盖（优先级：默认值 < `config.json` < 环境变量），
不用为了试一下就去改服务器上的配置：

```text
DSH_STICKER_PORT / DSH_STICKER_DATA_DIR / DSH_STICKER_VIDEO_URL / DSH_STICKER_FFMPEG
```

本地验收用临时 `data\send` + 一个假 `ffmpeg.exe`（只把一张模板 PNG 拷到输出路径）
+ 一个桩 `/v1/look` 服务（固定返回描述），就能完整跑通批量与收藏，
不碰生产目录，也不消耗视觉额度。

## 面板上的两个开关

- **默认**：用表情名（快，约 5 秒一轮）
- **勾「看图」**：先识图再回话（多 2~4 秒，但模型真的看见了画面）
- **没有名字的图**：自动走识图，不需要勾

## 接口

```text
GET  /v1/health                     → {ok, count, bytes}
GET  /v1/list?q=&limit=&favorite=1  → {ok, total, count, items:[{id,name,mood,tags,bytes,mtime,favorite}]}
GET  /v1/pick?q=不想上班             → {ok, sticker, candidates}   挑一张
GET  /v1/gif?id=<id>                → image/gif（可长期缓存）
GET  /v1/reload                     → 重新扫描 send\ 目录
GET|POST /v1/describe?id=&force=1   → 识一张（结果缓存）
POST /v1/describe-all {force,limit} → {ok, started, total, pending}   立刻返回，后台串行跑
GET  /v1/describe-status            → {ok, total, described, pending, running, failed, lastError, startedAt, finishedAt}
POST /v1/favorite {id,name,note}    → {ok, favorite:{id,name,note,at}}
DELETE /v1/favorite?id=             → {ok, id, removed}
GET  /v1/favorites                  → {ok, count, items:[{id,name,note,at}]}
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
