# 记忆模块设计（v0：只描述结构，不含实现）

## 0. 目标与边界

**目标**：跨会话记住"谁在何时说了什么、DSH 做了什么"，在需要时以最低 token 成本召回，
用于压制胡言乱语与人格漂移。

**硬约束（来自需求）**

1. 每条记忆必须带证据（来源 + 定位），无证据不入库。
2. 检索按"条数 + token"双预算返回，默认 ≤8 条 / ≤1200 token。
3. 三层：身份常驻、事实（巩固后）、事件（原始）。
4. 任何"忘记"必须可执行、可验证、可撤销。
5. 不做：向量数据库、微服务、云端同步、替用户做决定。

## 1. 三层记忆

| 层 | 名称 | 内容 | 生命周期 | 注入策略 |
| --- | --- | --- | --- | --- |
| L1 | 身份 identity | 我是谁、说话方式、边界、用户的稳定偏好 | 用户确认后才改，版本化 | 每次固定注入，独立预算 ≤200 token |
| L2 | 事实 fact | 巩固后的陈述句，带多条证据 | 由事件按确定性规则巩固 | 按分数注入，约占剩余预算 60% |
| L3 | 事件 event | 原始对话/动作记录 | 只追加，不改写 | 按分数注入，约占剩余预算 40% |

分层意图：**L1 抗漂移，L2 抗胡言，L3 保真相**（可回溯到原文）。

## 2. 目录结构

### 2.1 模块（仓库内 `memory/`）

```text
memory/
├── server.js                  HTTP 入口（127.0.0.1:8767），只做路由与参数校验
├── lib/
│   ├── gate.js                证据闸门：校验 evidence 完整性，不合格拒收
│   ├── store.js               追加写、按月分片、行号偏移、快照
│   ├── indexer.js             倒排索引（实体/标签/词项→记录），可重建
│   ├── recall.js              打分 + 双预算打包 + 渲染注入块
│   ├── tokens.js              token 估算（确定性、无外部依赖、写读同源）
│   ├── consolidate.js         事件→事实（确定性规则，不做模型判断）
│   ├── forget.js              forget / verify / restore / purge
│   ├── identity.js            L1 读写、版本化、变更提案
│   └── audit.js               写入/召回/遗忘审计（追加、可选哈希链）
├── rules/
│   ├── consolidate.rules.json 巩固规则参数（阈值、有效期、去重键）
│   └── identity.guardrails.json 身份层允许的字段与变更限制
├── schema/
│   ├── event.schema.json
│   ├── fact.schema.json
│   ├── identity.schema.json
│   └── tombstone.schema.json
└── README.md                  运维说明（端口、任务、数据位置、排错）
```

### 2.2 数据（程序文件夹内、模块外 `data/memory/`）

放在模块外，`push` 整目录替换不会伤到数据；与 `logs/` 同级。

```text
data/memory/
├── events/
│   └── 2026-11.jsonl          原始事件，按月分片，只追加
├── facts/
│   ├── proposed.jsonl         待巩固（证据不足）
│   ├── active.jsonl           已巩固（可注入）
│   └── conflicts.jsonl        冲突待裁决（不注入）
├── identity/
│   ├── identity.v3.yaml       版本化身份层，人工可编辑
│   └── proposals.jsonl        待用户确认的变更提案
├── index/
│   └── inverted.json          索引快照，损坏可全量重建
├── tombstones.jsonl           遗忘记录（可撤销）
├── quarantine/                物理清除前的隔离区
└── audits/
    ├── recall.jsonl
    ├── write.jsonl
    └── forget.jsonl
```

## 3. 模块划分

| 编号 | 模块 | 职责 | 输入 | 输出 | 失败处理 |
| --- | --- | --- | --- | --- | --- |
| M1 | 证据闸门 gate | 校验 evidence 与必填字段 | 写入请求 | 通过 / 拒收+原因 | 拒收写 `rejected` 日志，绝不静默丢 |
| M2 | 存储 store | 追加、分片、行号偏移 | 合法记录 | id + 偏移 | 写失败回滚内存索引 |
| M3 | 索引 indexer | 维护倒排索引 | 记录 | 索引条目 | 损坏则全量重建 |
| M4 | 巩固 consolidate | 事件聚合成事实 | 事件集 + 规则 | proposed / active / conflict | 规则冲突标 conflict，不猜 |
| M5 | 召回 recall | 过滤→打分→预算打包→渲染 | 查询 + 预算 | 注入块 + 引用 | 超预算降级 short；仍超则丢弃并标 truncated |
| M6 | 遗忘 forget | forget/verify/restore/purge | 目标 + 原因 | tombstone + 审计 | verify 失败自动回滚 |
| M7 | 身份 identity | L1 读写、版本、提案 | 提案 | 新版本 / 待确认 | 未确认不生效 |
| M8 | 接口 api | HTTP / CLI 面 | 请求 | JSON | 统一错误码 |

**依赖方向（单向，禁止回环）**：
`api →（gate | recall | forget | identity）→（store | indexer | consolidate | tokens）`；
`store` 不依赖任何上层，`tokens` 是最底层纯函数。

## 4. 数据模型（字段定义，不含代码）

### 4.1 event（L3，原始）

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| id | 是 | `evt_<ulid>` |
| ts | 是 | 发生时间（UTC，ISO8601） |
| actor | 是 | `user` / `dsh` / `system` |
| kind | 是 | `message` / `action` / `observation` |
| text | 是 | 原始文本或动作摘要 |
| evidence.source | 是 | `chat` / `video` / `doc` / `panel` 等 |
| evidence.locator | 是 | `group123#msg456`、`v3@12:30` 等 |
| evidence.excerpt | 否 | 原文片段（≤200 字），便于核对 |
| entities | 否 | 人物、群、项目、文件 |
| tags | 否 | 自由标签 |
| salience | 是 | 0..1，写入时确定（用户说"记住"→ 高） |
| sessionId | 是 | 来源会话 |
| hash | 是 | 内容哈希，用于去重与防篡改 |

**闸门规则**：`evidence.source` 与 `evidence.locator` 任一缺失即拒收；`text` 为空拒收。

### 4.2 fact（L2，巩固后）

| 字段 | 说明 |
| --- | --- |
| id | `fct_<ulid>` |
| statement | 一句话陈述（注入用，≤80 字） |
| subject / predicate / object | 结构化三元组，用于去重与冲突检测 |
| evidenceIds | ≥1 条事件 id（多源更强） |
| support | 支撑事件条数 |
| confidence | 0..1，**由规则计算，不由模型判断** |
| status | `proposed` / `active` / `conflict` / `retired` |
| validFrom / validTo | 有效期（`validTo` 到期自动 retired） |
| supersedes | 本事实取代的旧事实 id |
| short | ≤40 字降级文本，预算不足时使用 |

### 4.3 identity（L1，身份常驻）

- 形态：版本化文本（YAML），字段分区：`self`（我是谁）、`voice`（语气）、`boundaries`（边界）、`user_prefs`（用户稳定偏好）。
- 每个分区条目也带 `evidence`，指向首次确立的对话。
- 变更流程：提案 → 用户确认 → 生成新版本 + diff 存档；未确认不生效。
- 上限：≤200 token，超出则拒绝写入（强制精简）。

### 4.4 tombstone（遗忘）

| 字段 | 说明 |
| --- | --- |
| forgetId | `fgt_<ulid>` |
| targets | 记录 id 列表，或查询条件（按条件遗忘） |
| digest | 目标内容哈希集合（验证用） |
| reason | 用户给出的原因或系统原因 |
| ts | 操作时间 |
| undoOf | 若为撤销，指向原 forgetId |
| status | `active` / `undone` / `purged` |

## 5. 数据流

### 5.1 写入路径

```text
调用方（io / panel）
   │  POST /v1/events  {actor, text, evidence, entities, salience, sessionId}
   ▼
┌─────────────┐   evidence 缺失/不完整
│  M1 gate    │ ────────────────────────► rejected.jsonl（记原因，不静默丢）
└─────────────┘
   │ 通过（补齐 hash、ts、id）
   ▼
┌─────────────┐
│  M2 store   │  追加 data/memory/events/YYYY-MM.jsonl ──► 返回行号+偏移
└─────────────┘
   │
   ▼
┌─────────────┐
│ M3 indexer  │  更新 inverted.json（entity / tag / term → ids）
└─────────────┘
   │
   ▼
返回 {id, storedAt, layer:"event"}
```

### 5.2 召回路径（双预算）

```text
调用方 │ POST /v1/recall {query, budget:{maxItems:8, maxTokens:1200}, sessionId?}
       ▼
┌──────────────────────────────────────────────────────────────┐
│ L1 身份层：整块固定注入（独立预算 ≤200 token，永不被挤出）        │
└──────────────────────────────────────────────────────────────┘
       ▼
┌─────────────── M5 recall ────────────────────────────────────┐
│ 1) 过滤：命中 tombstone → 剔除；conflict → 剔除；过期 → 剔除     │
│ 2) 候选：倒排索引取 term/entity 交集+并集，叠加时间窗           │
│ 3) 打分：recency + term匹配(BM25-lite) + salience               │
│          + 层权重(L2>L3) + 证据强度(多源更高)                   │
│ 4) 打包：L2 先、L3 后，逐条试算 token                           │
│          放不下 → 用 short 版 → 仍放不下 → 跳过（记 truncated）  │
│ 5) 渲染：编号块，每条形如                                       │
│          [fct_01] 用户的项目叫 DSH-MultiTool ⟵ chat:g123#m456   │
└──────────────────────────────────────────────────────────────┘
       ▼
返回 {items[], used:{count, tokens}, truncated, excluded:{tombstoned, conflicted}}
```

**预算规则**：调用方可传更小值，但全局天花板 `maxItems ≤ 32`、`maxTokens ≤ 4000`，
防止上层把上下文撑爆。返回值里的 `used` 供调用方二次收紧。

### 5.3 巩固路径（每日定时，确定性规则）

调度：**每日一次**（默认本地 03:00，可通过 `consolidate.rules.json` 调整），由 memory 进程内的
定时器触发；也可手动 `POST /v1/consolidate` 立即跑一次（带 `dryRun` 只出报告不落盘）。

```text
events/*.jsonl
   │
   ▼
┌──────────────── M4 consolidate ────────────────┐
│ R1 事件显式标记 remember → proposed            │
│ R2 同一 (subject,predicate,object) 出现 ≥2 条  │
│    且证据来源互不相同 → active（合并去重）      │
│ R3 同 (subject,predicate) 不同 object →        │
│    双方进 conflicts，均不注入，等用户裁决        │
│ R4 validTo 到期 → retired                      │
└────────────────────────────────────────────────┘
   │
   ├─► facts/proposed.jsonl
   ├─► facts/active.jsonl
   └─► facts/conflicts.jsonl
```

规则是**计数与匹配**，不是模型判断——"不替用户做决定"体现在：冲突不自动选边，
身份不自动改写。

#### 5.3.1 什么叫"冲突"，什么叫"裁决"

**冲突**：同一个 subject + predicate，出现了不同的 object。

| 例子 | 结论 |
| --- | --- |
| A：项目叫 `DSH-MultiTool`（证据 chat:panel#m12）<br>B：项目叫 `MemoryBox`（证据 chat:panel#m88） | 冲突：同一对象同一属性，值不同 |
| A：预算 5 元（证据 chat:g1#m10，2026-10）<br>B：预算 8 元（证据 chat:g1#m40，2026-11） | 未必冲突：可能是不同时期，靠 `validFrom/validTo` 区分 |
| A：用户喜欢深色主题<br>B：用户喜欢浅色主题 | 冲突，且可能是偏好变化，需人判断 |

**为什么不自动选**：自动取新 → 一句口误就被固化成"事实"，之后模型一直说错（正是要防的胡言乱语）；
自动取旧 → 用户明明改过，模型却坚持旧认知（人格/认知滞后）。所以默认两边都不注入，宁可少说。

**裁决**（人的一次点击，不是模型的判断）包含三个动作：

1. **选边**：A 有效 / B 有效 / 两者并存（若其实不矛盾，按时期拆成两条带有效期的段）
2. **归因**：可选填一句原因，写进审计，便于日后回溯
3. **落结果**：胜者 `status=active` 且 `supersedes` 败者；败者 `status=retired`（**保留证据，不删除**）

裁决本身可撤销：撤销后回到 `conflict` 状态，重新进入待裁决列表。

#### 5.3.2 裁决流程：先问，不答则自动（已定）

**决策链**：

```text
检测到冲突
   │
   ├─(1) 当次召回命中冲突 ──► 注入"存在冲突"标记，模型在回答里**先问用户**
   │        例：「我这里有两条互相矛盾的说法：项目叫 DSH-MultiTool，另一次说叫 MemoryBox，
   │              以哪个为准？」+ 面板渲染结构化选项卡片
   │
   ├─(2) 用户作答 ──► resolved_by_user（走 5.3.1 的裁决三动作）
   │
   └─(3) 超时未答 ──► 自动裁决 auto_resolved
            规则（按序，默认值可配）：
              R-a 证据时间更新的胜出（新覆盖旧，记 supersedes）
              R-b 时间相同时，支撑事件条数多的胜出
              R-c 仍平手 → 保留旧事实，新事实 retired（不删除，留证据）
            落盘时打 auto=true 标记，面板显示「系统自动裁决 · 可撤销」
```

**三条护栏**（否则"模型自己决定"会变成第二个漂移源）：

1. **自动裁决不是模型自由发挥**，而是执行上面 R-a / R-b / R-c 的确定规则——
   模型只负责"把问题问出口"，不负责拍板。
2. **自动结果一律可撤销**：面板显示自动裁决项，一键撤销后回到 `conflict`。
3. **自动裁决必留痕**：审计记录触发时间、规则编号、被取代方 id，事后可回答"它为什么改了说法"。

**超时定义**（默认 7 天，或"用户连续 N 次未回应"，取先到者）：超时不是从冲突产生算起，
而是从**第一次向用户提问**算起，避免用户没看到问题就被自动决定。

**同一时刻最多注入 2 条冲突**，防止占用召回预算、把回答变成一串反问。



### 5.4 遗忘路径（可执行 / 可验证 / 可撤销）

```text
forget(ids | query, reason)
   ▼
┌──────────────── M6 forget ────────────────────┐
│ 1) 解析目标（id 列表或查询命中集）                │
│ 2) 计算 digest（目标内容哈希集合）                │
│ 3) 写 tombstones.jsonl（status=active）          │
│ 4) 从索引剔除，记入 excluded 集合                 │
│ 5) verify：用同一查询重新召回，断言目标 0 命中     │
│    并核对存储层（行仍在，但被 tombstone 屏蔽）      │
│ 6) 产出验证报告 → audits/forget.jsonl             │
└────────────────────────────────────────────────┘
   │
   ├─ restore(forgetId)：status=undone，重新索引（可撤销）
   └─ purge(forgetId, confirm)：移入 quarantine/ → 删原行（不可逆，需二次确认）

三种"忘记"的语义边界：
  forget  = 召回层面不可见（默认，可撤销）
  purge   = 物理删除（显式确认，不可撤销）
  两者都留审计，前者留 digest 以便核对删了什么
```

## 6. 防胡言乱语 / 人格漂移的具体机制

| 机制 | 做法 |
| --- | --- |
| 引用约束 | 注入块内每条都带 `[id] 陈述 ⟵ 证据`；提示词要求"块内没有就说不知道" |
| 人格唯一源 | L1 是人格与语气的唯一来源；L2/L3 不得改写，L1 变更必须用户确认 |
| 冲突不注入 | 冲突事实一律排除，宁可少说 |
| 证据可核对 | 面板展示引用徽标，点开可看原始 locator 与 excerpt |
| 召回可复盘 | 每次召回记录 query、命中 id、token 用量，事后能查"它为什么这么说" |
| 写入可拒 | 无证据的请求直接拒收并记录原因，避免垃圾记忆污染 |

## 7. 与现有模块的接入点

| 位置 | 改动 | 时机 |
| --- | --- | --- |
| 进程 | `memory/server.js` 监听 `127.0.0.1:8767` | P0 |
| 自启 | 计划任务 `DSH-MultiTool Memory`（SYSTEM / AtStartup） | P0 |
| io | 发送前 `POST /v1/recall` 组上下文块；收到答案后 `POST /v1/events` 落事件 | P4 |
| panel | 新增「记忆」视图：查看**全部**记忆（身份 / 事实 / 事件 / 冲突 / 遗忘记录），支持冲突裁决、单条忘记与恢复 | P4 |
| 部署 | `push -Name memory`；数据在 `data/memory/`，与模块分离 | P0 |

证据定位约定（写入方负责生成）：`chat:<sessionId>#<msgId>`、`panel:<sessionId>#<n>`、
`doc:<file>@L12-L30`、`video:<asset>@12:30`。

## 8. 里程碑

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 | 目录、schema、gate、store、recall（无巩固） | 无证据写入被拒；召回 ≤8 条/≤1200 token 且每条带证据 |
| P1 | 巩固与冲突 | 两条同源陈述能合并；冲突进 conflicts 且不被召回 |
| P2 | 遗忘四步 + 审计 | forget 后 verify 报告 0 命中；restore 后恢复；purge 有隔离区 |
| P3 | identity 版本化与提案 | 未确认的变更不生效；版本可 diff |
| P4 | 接入 io / panel | 一次真实对话能写入并召回，面板可见引用 |

## 9. 已定 / 待定的取舍

| # | 取舍 | 状态 | 结论 |
| --- | --- | --- | --- |
| 1 | 分片粒度 | **已定** | 按月分片（`events/YYYY-MM.jsonl`） |
| 2 | 巩固触发 | **已定** | 每日定时一次（默认 03:00 本地时间），可手动触发 dry-run |
| 3 | 冲突裁决 | **已定** | **先问用户 → 超时未答则按确定规则自动裁决**，自动结果可审计、可撤销（详见 5.3.2） |
| 4 | 身份层可见性 | **已定** | 面板可查看**全部**记忆内容（含身份）；身份仍以 `identity.vN.yaml` 为唯一源头，面板只读展示 |

### 9.1 冲突裁决的落地形态（已定）

| 环节 | 结果 |
| --- | --- |
| 谁来问 | 模型在召回命中冲突时**主动提问**，面板同时渲染结构化选项卡片 |
| 谁来决定 | 用户点击优先；超时未答则由**确定规则**自动裁决（见 5.3.2） |
| 自动规则 | 默认：新的胜出 → 证据多者胜 → 平手保留旧的（可在 `consolidate.rules.json` 改） |
| 超时 | 默认自首次提问起 7 天，或连续 10 次未回应 |
| 可撤销 | 自动裁决与人工裁决都可撤销，撤销后回到待裁决 |
| 可审计 | 记录规则编号、时间、被取代方，面板可查"为什么改了" |

不采用"纯自动以新为准"（口误会被固化），也不采用"永不裁决"（记忆永久缺失）。

