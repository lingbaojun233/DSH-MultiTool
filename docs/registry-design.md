# 模块注册表 · 目录 · 加载器（设计）

目标只有一个：**让模型知道"有哪些模块、何时用"（常驻、极便宜），"怎么用"按需加载（贵、懒加载）**。

## 硬约束

| # | 约束 | 落到哪里 |
| --- | --- | --- |
| 1 | 目录行 ≤60 token/模块，只写"名字 + 触发条件" | `lib/catalog.js` 渲染与预算检查 |
| 2 | README 每模块一个文件，≤600 token，禁止合并 | `modules/<name>/README.md` + `lib/lint.js` |
| 3 | 动态"已激活"单独一行，绝不进目录 | catalog 返回两段，io 分开注入 |
| 4 | 增删模块只增删目录行与文件，不改变工具表 | 目录是文本，不注册工具 |
| 5 | 不做：目录向量检索 / 自动改写他人 README / 远程注册中心 | 扫描本地文件即可 |

## 目录结构

```text
registry/
├── modules/                     ← 目录数据（每个模块一个文件夹）
│   ├── memory/
│   │   ├── module.yaml          名字、触发条件、入口、成本、版本
│   │   └── README.md            决策卡：何时用/不用、输入输出、一个例子
│   ├── deploy/
│   └── panel/
├── lib/
│   ├── validate.js              校验 module.yaml，输出结构化错误
│   ├── catalog.js               扫描 + 渲染 + token 预算 + 触发条件冲突检测
│   ├── loader.js                read_module：白名单、截断、缓存标记、使用统计
│   ├── readme-gen.js            从 module.yaml + 入口生成决策卡
│   ├── lint.js                  README 质检（四段/禁词/例子一致性）
│   └── tokens.js                token 估算（与 memory 同算法，独立实现）
├── tests/
│   ├── triggers.yaml            30 条真实问法 + 期望模块
│   └── triggers.js              批量跑：漏触发/误触发/错配
├── cli.js                       validate / catalog / read / gen / lint / stats
└── README.md
```

运行时数据（模块外，`push` 安全）：`data/registry/usage.jsonl`（读取次数、读了是否用上）。

## 数据流

```text
① 目录注入（每次请求，稳定）
   io 拼 prompt 前
     └─► catalog.render()
           ├─ 扫描 modules/*/module.yaml（固定按 name 排序）
           ├─ 渲染每行 "- <name> — <when>"
           ├─ 预算检查：≤60 token/模块，超了报错并列出最长 3 行
           └─ 冲突检查：when 之间语义重叠 → 报冲突，不自动合并
     └─► prompt 顶部：
           [模块目录]
           - memory — …
           - deploy — …
           需要某模块的用法时：node registry\cli.js read <name>
           已激活：无                       ← 动态行，与目录分离

② 模型判断（只读目录，不读用法）
   模型看到触发条件，判断"要不要用某个模块"
      ├─ 不用 → 直接回答（目录开销 ≈ 十几 token/模块）
      └─ 要用 → 调用 read <name>

③ 懒加载（贵，只付一次）
   registry\cli.js read memory
     └─► loader.read(name)
           ├─ 白名单：不在目录里 → UNKNOWN_MODULE + 可用名单
           ├─ 读 README，≤600 token；超长截断并附 warning
           ├─ 同会话重复读取 → cached:true（调用方去重）
           └─ 记 usage：读取次数、后续是否真的调用

④ 质检（离线）
   cli lint → 四段齐全、无禁词、例子与 schema 一致、触发条件不重叠
```

## token 预算

| 项 | 预算 | 说明 |
| --- | --- | --- |
| 目录行 | ≤60 / 模块 | 3 个模块 ≈ 180 token，常驻 |
| README | ≤600 / 模块 | 只在 `read` 时进入上下文 |
| 已激活行 | ≤20 | 动态，单独一行 |
| 加载说明 | ≤30 | 固定一句，告诉模型怎么读 |

## 与现有模块的接入点

| 位置 | 改动 |
| --- | --- |
| `io/io.js` | 拼 prompt 时在人格块之前插入 `[模块目录]` 段；目录由 registry 提供 |
| `registry/cli.js` | 模型通过 bash 调用 `read <name>`；也可人工用 `catalog`/`lint` |
| 新增模块 | 建 `modules/<name>/`（yaml + README）即可，io 不改、工具表不变 |
