# speak —— 发声模块

把文字合成为语音，返回 wav。面板里每条回复旁边有个 🔊，点了就读出来。

**现在默认只走 BreezeBlue 云端**（`provider:"breezeblue"`），音色由人设决定，
并且 `strict: true`：拿不到云端声音就返回 503，**不会**偷偷换成本地音色。

## 接口

```text
GET  /v1/health                 → 状态（strict / 队列 / 余额 / 重试策略 / 人设音色缓存）
GET  /v1/voice                  → 当前人设选中的音色 + 理由 + 缓存时间
GET  /v1/voice?force=1          → 强制按人设重算并覆盖缓存
POST /v1/voice {voiceId}        → 人工钉住音色（直到 force=1 或再次人工指定）
GET  /v1/voices?zh=1            → 中文音色清单（id + 名字 + 打分维度），给前端下拉
GET  /v1/usage                  → 本进程累计 calls/chars/credits/fallbacks/failures
GET  /v1/usage?refresh=1        → 先刷一次账本再返回（会立刻结算已出账的句子）
GET  /v1/balance                → 账户余额（30s 缓存；?refresh=1 强制重取）
POST /v1/speak {text, voice?, rate?, strict?}
                                → 200 audio/wav 字节
                                → 400 {error:'EMPTY_TEXT'|'BAD_JSON'|'UNKNOWN_VOICE'|'LOCAL_VOICE_BLOCKED'}
                                → 503 {error:'BREEZEBLUE_UNAVAILABLE'|'QUEUE_TIMEOUT'|'QUEUE_FULL'}
```

`POST /v1/speak` 的 `voice` 合法值：

| voice | 含义 |
| --- | --- |
| `""` / `auto` / `persona` / `default` | 人设决定（推荐，默认） |
| `breezeblue` / `cloud` | 云端默认音色（config.breezeblue.voiceId） |
| `voc_xxxxxxxx` | 指定云端音色 id |
| `huayan` / `huayan-fast` / `yaoyao` / `huihui` / `kangkang` | 显式点名本地引擎（**只有显式点名才用**） |

`voice:"persona"` 现在等价于 `""`（以前会被当成"认不出来的本地音色"静默落到 huayan，已修）。
strict 模式下传一个不认识的 `voice` 直接 400 `UNKNOWN_VOICE`，不会变成另一个嗓子。

## strict 模式（核心）

`config.json` 的 `strict: true`（默认开）：

- 云端 429 / 5xx / 超时 / 网络错误 → 按 `breezeblue.retry.backoffMs`（默认 `[1000,2000,4000,8000]`）
  退避重试，最多 `maxAttempts`（默认 4，即首次 + 3 次重试，实际等待 1s、2s、4s）
- 还是失败 → **HTTP 503**，body：

```json
{
  "ok": false,
  "error": "BREEZEBLUE_UNAVAILABLE",
  "strict": true,
  "attempts": 4,
  "retries": 3,
  "lastError": "BREEZEBLUE_HTTP_429 GENERATION_CONCURRENCY_EXCEEDED: ...",
  "errors": ["...", "...", "...", "..."],
  "retryable": true,
  "exhausted": true,
  "voiceId": "voc_xxx",
  "chars": 27,
  "billing": { "creditsEstimated": 4.995, "...": "..." },
  "hint": "strict 模式：不回退本地音色。检查 keyPath/额度/并发，或用 body.strict=false 显式降级"
}
```

**不返回任何替代音频。** 视频模块因此能明确区分"这句是真人念的"和"这句没拿到"。

- 确定性失败不浪费重试：key 文件缺失/为空（`BREEZEBLUE_NO_KEY`）、401/403/400、ffmpeg 失败
  （音频已经生成并扣费，再试等于再花一次钱）→ `attempts:1` 立即返回。
- `strict:false` 时保持老行为：失败回退 piper `huayan`，响应头带
  `x-speak-fallback-from: breezeblue` / `x-speak-provider: piper` / `x-speak-strict: 0`。
- 单次请求可用 `body.strict` 或 `?strict=0|1` 覆盖 config（studio 可以按镜头要求）。

## 并发（为什么必须有队列）

实测 BreezeBlue Starter 档**并发上限是 1**：同时发 4 句，1 句 200、3 句
`429 GENERATION_CONCURRENCY_EXCEEDED`。所以云端合成一律进本进程的串行队列：

- `breezeblue.maxConcurrency`（默认 1）、`queueMax`（默认 64，超了 503 `QUEUE_FULL`）、
  `queueTimeoutMs`（默认 180s，排队超时 503 `QUEUE_TIMEOUT`）
- 队列只包住"请求云端 + ffmpeg 转封装"；人设音色解析走缓存，不进队列
- 响应头 `x-speak-queue-wait-ms` 给出这句排了多久；`GET /v1/usage` 的 `queue` 有平均/最大等待

实测（4 并发，queue=1）：4/4 成功，wall 14~19s，第 4 句排队 8~14s，**零 429**。

## 计费可见

BreezeBlue **按字符计费**，约 `0.185 credits/字`（实测 22 字 = 4.2，16 字 = 3.0）。
订阅结算是 **60 秒一批**：`settlement_interval_seconds=60`，实测 charge 在调用后 ~29s 才进账本，
所以"合成完立刻读余额"经常差值是 0。为此有两层口径：

1. **每句落地**：`GET /v1/usage` 的 `recentCalls[i]` 有
   `chars / creditsEstimated / creditsSpent / settledCredits`，
   其中 `settledCredits` 是把账本里的 charge 按字符数匹配回这一句得到的**真实花费**。
2. **累计**：`credits` = 认领到本进程那些句子的真实 credits 之和（滞后 ≤ ~60s）；
   `creditsEstimated` = 字符数 × 单价（立刻可得，用来对照）；
   `accountCredits` = 账本上所有新 charge（账户级参考，别的工具用同一个 key 也会算进来）。

`logs/speak.log` 每句两行：

```text
speak ok provider=breezeblue voice=大肥鱼（迷糊版） chars=22 bytes=200116 ms=4060 attempts=1 queueWaitMs=0 strict=true
billing chars=22 creditsBefore=1643.4 creditsAfter=1643.4 creditsSpent=0 creditsEstimated=4.07 settledImmediately=false
billing sentence: chars=22 settled=4.2 est=4.07 diff=+0.13 voice=voc_8yud7hz7c9q2 processCredits=4.2
billing settled: 1 charge(s) +4.2 credits (claimed 1 for this process, +4.2); process credits=4.2, account credits=4.2
```

余额读取有 30 秒缓存（`balanceTtlMs`），不会每句都多打一个云端请求；
进程每 60s 自动对一次账本，`/v1/usage?refresh=1` 可以立刻对账。

## 音色管理

`lib/persona-voice.js`：

1. `GET http://127.0.0.1:8767/v1/persona` 拿 `block` + `version`（+ `traits`）
2. 按人设画像（性别/年龄感/情绪色调）给 zh 音色池打分（权重见 `/v1/voices` 的 `scoringDimensions`：
   language 硬门槛、gender 34、age 22、tone 12、ageNeighbor 9、toneClash -6）
3. 缓存 `data/speak/persona-voice.json`：`version` 没变直接命中；**version 一变就重选**
   （已实测：温柔少女人设 → 大肥鱼（偶像版）；五十岁长者人设 → 深思先生）
4. 人工指定（`POST /v1/voice`）一直有效，直到 `force=1` 或再次人工指定

中文音色只有 9 个：专业翻译官（中文）、大肥鱼（破晓/偶像/迷糊/机灵）、哈基米娘、香农小姐、深思先生、知绘小姐。
`GET /v1/voices?zh=1` 直接给前端下拉用。

云端接口（key 在 `C:\Apps\DSH-MultiTool\secrets\breezeblue.key`，每次现读，不常驻内存）：

```text
GET  https://api.breeze.blue/v1/voices                     50 个音色（一周缓存一次）
POST https://api.breeze.blue/v1/text-to-speech/{voice_id}  → audio/mpeg（mp3）
GET  https://api.breeze.blue/v1/balance                    余额 + 账单（charges）
```

云端返回 mp3，整条链路吃 wav，所以 `ffmpeg -ar 22050 -ac 1 -c:a pcm_s16le` 转成和 piper 一致的规格。

## 响应头

```text
x-speak-voice           机器可读：云端是 voc_xxx，本地是 huayan
x-speak-voice-name      中文音色名，percent-encoded（HTTP 头只允许 latin-1）
x-speak-voice-id        voc_xxx（本地为空）
x-speak-provider        breezeblue / piper / winrt
x-speak-strict          1 = 这句是 strict 云端产物；0 = 回退或显式本地
x-speak-attempts        这次打了几次云端（1229 → 4）
x-speak-retries         重试次数 = attempts-1
x-speak-queue-wait-ms   排队等了多久
x-speak-chars           实际计费字符数
x-speak-credits-est     估算 credits（字符数 × 单价）
x-speak-credits-spent   合成前后余额差（结算滞后，常为 0）
x-speak-balance         合成后的余额
x-speak-fallback-from   breezeblue（只有回退时出现）
x-speak-cloud-error     回退原因（ASCII 化）
x-speak-persona-cached  人设音色是否命缓存
x-speak-explicit-local  1 = 显式点名本地引擎
```

## 前端 / studio 怎么适配

1. **成功判定改成看状态码**：`200` 才是音频；`503` 是"这句没拿到"，body 是 JSON，别当音频播。
   `error === 'BREEZEBLUE_UNAVAILABLE'` 表示云端重试 4 次仍失败（可以整段重试或提示）；
   `QUEUE_TIMEOUT` / `QUEUE_FULL` 表示排队太久/太长（一集 8 句串行约 35~60s，建议前端超时 ≥120s）。
2. **并发不要超过 1 个语义上的"在飞"请求**：现在服务端会排队，前端并发 4 个也能成功，
   但第 4 个要等 10s+。更省心的做法是前端顺序请求（队列已经在服务端兜底）。
3. **音色下拉**用 `GET /v1/voices?zh=1`，`current:true` 是当前人设音色；选中后 `POST /v1/voice {voiceId}`。
4. **成本**：一集 8 句 × 平均 18 字 ≈ 144 字 ≈ **27 credits**（0.185/字，约 ¥0.1 量级）。
   想知道实际花了多少：`GET /v1/usage?refresh=1` 看 `credits` 与 `recentCalls[].settledCredits`。
5. 想强制"必须有真人声音"就**别**传 `strict:false`，也别显式点 `voice:"huayan"`。

## 配置项（config.json）

```json
{
  "strict": true,                    // 只用 BreezeBlue；false = 老行为（回退 huayan）
  "strictAllowExplicitLocal": true,  // strict 下是否允许显式点名本地音色
  "logFile": "",                     // 默认 ../logs/speak.log
  "breezeblue": {
    "voiceId": "voc_cc9mhfrqw4z2",   // 人设不可用时的兜底音色
    "creditsPerChar": 0.185,         // 只用于估算
    "maxConcurrency": 1,             // 云端并发上限实测为 1，别调高
    "queueMax": 64,
    "queueTimeoutMs": 180000,
    "retry": {
      "maxAttempts": 4,
      "backoffMs": [1000, 2000, 4000, 8000],
      "retryStatus": [408, 429, 500, 502, 503, 504],
      "retryOnNetwork": true
    },
    "balanceTtlMs": 30000,
    "balanceAfterMaxAgeMs": 5000
  }
}
```

测试/多实例可以用环境变量 `DSH_SPEAK_CONFIG` 指向另一份 config（默认读同目录 `config.json`）。

## 本地引擎（只在 strict=false 回退 或 显式点名时用）

| voice | 引擎 | 特点 |
| --- | --- | --- |
| `huayan` | Piper (CPU, onnx) | **回退音色**；22050Hz，约 1.2s/句 |
| `huayan-fast` | Piper x_low | 约 0.94s/句，音色有损 |
| `yaoyao` | WinRT OneCore | 约 0.88s/句，年轻女声 |
| `huihui` / `kangkang` | WinRT OneCore | 老式播音腔 / 男声 |

## 念之前会先洗一遍

`cleanForSpeech()`：去 Markdown、去 emoji/颜文字、`²`→"的平方"、`×`→"乘以"、
去中文引号书名号（TTS 会念出"引号"两个字整句就碎）、超 `maxChars`（默认 300）截断。

## 历史与限制

- 不是 qwen：MaaS token-plan 网关把 `qwen-audio-3.0-tts-plus` 列在 `/models` 里，
  但 `/audio/speech` 一律回 `"url error, please check url"` —— 那个网关没给音频模型配可路由上游。
  `provider="qwen"` 现在仍会明确报 `QWEN_AUDIO_NOT_ROUTED`，不假装成功。
- 云端比 piper 慢：同一句 22 字，云端 4.0s（含 ffmpeg），音频 4.5s；huayan 约 1.2s。
- 云端并发上限 1（Starter 档），超了就是 429；`fetch failed` 也实测出现过 —— 两者都会重试。
- 中文音色只有 9 个，人设差异再大也只能在这 9 个里挑最像的。
- HTTP 头只允许 latin-1：中文音色名必须 percent-encode 再进 `x-speak-voice-name`，
  否则 `writeHead` 抛 `ERR_INVALID_CHAR`，音频钱都花了却只给调用方一个连接重置。
- 服务端没有声卡也没关系：全部输出到文件。
