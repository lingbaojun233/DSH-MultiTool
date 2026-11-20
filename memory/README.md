# memory —— 记忆模块（v0.2）

跨会话记住"谁在何时说了什么、DSH 做了什么"，在需要时以最低 token 成本召回。
设计文档：[`../docs/memory-design.md`](../docs/memory-design.md)。

**技术栈**：Node 22 内置 `node:sqlite`（SQLite 3.54 + FTS5 trigram），**零外部依赖**，冷启动约 10ms。

## 目录

```text
memory/
├── server.js              HTTP 服务（127.0.0.1:8767）
├── cli.js                 CLI（remember / search / forget / undo / nightly / persona / proactive / stats）
├── nightly.cmd            每日巩固任务入口（03:00）
├── db/
│   ├── schema.sql         可读版结构参考
│   ├── migrate.js         迁移执行器（幂等、事务）
│   └── open.js            连接 + PRAGMA + 自动迁移
├── migrations/001_init.sql 可执行 DDL
├── lib/
│   ├── remember.js        写入管线
│   ├── search.js          检索
│   ├── persona.js         人格状态
│   ├── maintenance.js     夜间维护 + 遗忘/撤销
│   ├── proactive.js       主动回忆（回声块）
│   ├── text.js            归一化 / 哈希 / 线索
│   ├── budget.js          token 估算与打包
│   └── errors.js          结构化错误
├── tools/*.schema.json    三个工具的 schema（≤150 token）
└── test/acceptance.js     验收脚本
```

数据在模块外：`C:\Apps\DSH-MultiTool\data\memory\memory.db`（`push` 不会破坏）。

## 数据模型

| 表 | 作用 |
| --- | --- |
| `events` | 原始事件：谁、何时、何地、说了什么、证据、置信、显著度、hash、软删 |
| `entities` / `event_entities` | 人/群/话题；`aliases` 里可放 QQ 号、昵称、人称，把同一个人串起来 |
| `facts` | 主体-谓词-客体；`evidence_event_ids` 必填，支持 conflict/retired |
| `persona` | 单行：宪法（不可变）、traits、自传（≤15 条，每条挂事件 id）、版本 |
| `changelog` | 每次人格变更的 diff，支持回滚 |
| `tombstones` | 遗忘记录（含快照），支持撤销 |
| `events_fts` | FTS5 全文索引，应用层同步维护，遗忘即时生效 |

## 三个对外工具

| 工具 | 入口 | 说明 |
| --- | --- | --- |
| `memory_remember` | `POST /v1/tools/memory_remember` | 写一条；**无证据返回 400 `E_NO_EVIDENCE`** |
| `memory_search` | `POST /v1/tools/memory_search` | 召回；双预算；每条带 id + 证据 |
| `memory_forget` | `POST /v1/tools/memory_forget` | 软删（`{id}`）或撤销（`{undo:true, tombstoneId}`） |

错误统一为 `{ok:false, code, message, hint}`，不用自然语言报错。

## CLI

```powershell
node cli.js remember "用户的项目叫 DSH-MultiTool" --evidence chat:panel#m1
node cli.js remember --file input.json          # 支持 BOM
node cli.js search "上次说过的部署路径" --max-items 5 --max-tokens 600
node cli.js forget event:12 --reason "用户要求"
node cli.js undo 3
node cli.js nightly --dry-run
node cli.js persona
node cli.js proactive --turn 42 --session s1
node cli.js stats --json
```

## 写入管线（remember）

```text
证据门槛 → 归一化 → 价值门槛 → 精确去重 → 近似合并(7天,Jaccard≥0.8)
        → 实体链接 → 事实抽取 → 显著度(0-100) → 写 events + FTS
```

每条分支都有明确 `reason`：`stored` / `no_evidence` / `chitchat` / `not_worth` / `duplicate` / `merged` / `error`。
写库在事务里，失败整体回滚；嵌套调用走 SAVEPOINT。

## 检索（search）

```text
候选三路（各 top20，SQL 层过滤 deleted=0）：
  FTS5（多词 OR，<3 字符走 LIKE）| 实体名/别名 | 时间窗（默认近 30 天）
  → 去重 → 打分 → 预算打包 → 输出
score = relevance × (0.5 + salience/200) × exp(-ageDays/30) × confidence × novelty
```

- 预算默认 8 条 / 1200 token，单条 ≤120 token，天花板 32 条 / 4000 token。
- 无命中返回 `items: []`，不编造。
- 只有"回忆型问句"（之前/上次/记得…）才做 top20 二次精排，返回 `reranked:true`。
- `debug[]` 给出每条候选的分项分数，可手算复核。

## 人格（persona）

- 宪法正文的唯一来源是 [`persona/constitution.md`](persona/constitution.md)（由「大肥鱼人设卡 · 私聊版」压缩而来，980 token）。
- 宪法不可变：任何自动写入都被拒绝；只有 `node cli.js persona install persona/constitution.md [--reset-traits]`
  能替换，且会写 changelog、版本 +1、可回滚。
- traits 五项 0-100，初始值与每周回归目标来自 `DEFAULT_TRAITS`（人设卡基线：65/88/55/80/60）。
- 自传 ≤15 条，每条必须挂真实事件 id；不合规条目被丢弃并记录。
- `render()` 输出 ≤1500 token 的常驻块，**同输入逐字节一致**（利于前缀缓存）。

## 夜间维护与遗忘

- `nightly`：合并重复事实 → 冲突双方标 `conflict`（**不静默取舍**）→ 30 天显著度 ×0.9 → 低显著降权不删 → 旧 `raw_content` 归档。
- `forget`：软删 + 移出 FTS + 写墓碑（含快照），**立即**不可检索。
- `undoForget`：恢复行 + 重建 FTS + 标记撤销。

## 验收结果（10 万条事件）

| 指标 | 要求 | 实测 |
| --- | --- | --- |
| 冷启动 | < 2s | **11ms** |
| search p95 | < 100ms | **0.7ms**（p50 0.3ms） |
| 预算 | 严格不超 | 3 组预算全部满足 |
| 事实证据可回查 | 100% | 50/50 |
| forget | 1s 内不可检索 | **0ms**，undo 可恢复 |
| 冲突 | 不被静默合并 | 双方均 conflict，证据保留 |
| 外部依赖 | 无 | 仅 Node 内置模块 |

复跑：`node test/acceptance.js`（完整）或 `--quick`（1 万条）。

## 部署

| 任务 | 触发 | 作用 |
| --- | --- | --- |
| `DSH-MultiTool Memory` | 开机 | 常驻 HTTP 服务（8767） |
| `DSH-MultiTool Memory Nightly` | 每日 03:00 | 巩固 + 衰减 + 归档 |

日志在 `..\logs\memory.log` 与 `..\logs\memory-nightly.log`（模块外，`push` 安全）。

## 已知限制

- `novelty` 与主动回忆的频率闸/黑名单是**进程内存**，重启清零。
- 衰减按"每次运行"生效（无"上次衰减时间"字段），一天跑两次会衰减两次。
- 事实抽取是规则式，只认 `X叫Y / X在Y / X是Y / X的Y是Z` 四类句式。
- `forget` 目前只支持事件；事实的遗忘走后续迁移。
- 近似合并只累加 `merge_count`，被合并内容的原文不入库。
- P0 的 JSONL 数据不会被自动导入 SQLite（两者并存于 `data/memory/`）。
