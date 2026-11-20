# memory —— 记忆模块

跨会话记住"谁在何时说了什么、DSH 做了什么"，在需要时以最低 token 成本召回。
设计见 [`../docs/memory-design.md`](../docs/memory-design.md)。

当前是 **P0**：证据闸门、追加存储、倒排索引、双预算召回。
**尚未实现**：巩固（P1）、冲突裁决（P1）、遗忘（P2）、身份编辑（P3）、io/panel 接入（P4）。

## 接口（127.0.0.1:8767）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/health` | 存活 + 索引/存储统计 |
| GET | `/v1/stats` | 事件数、月份数、数据目录、最旧/最新时间 |
| POST | `/v1/events` | 写入一条事件；**无证据直接 400 并记录拒收原因** |
| GET | `/v1/events?limit=50` | 读最近事件（含证据），供面板查看 |
| POST | `/v1/recall` | 召回：`{query, budget:{maxItems,maxTokens}, render:true}` |
| POST | `/v1/reindex` | 从日志重建索引（索引损坏时用） |

写入示例（字段说明见 `schema/event.schema.json`）：

```json
{
  "actor": "user",
  "kind": "message",
  "text": "项目文件夹叫 DSH-MultiTool，部署在 C:\\Apps\\DSH-MultiTool",
  "evidence": { "source": "chat", "locator": "panel#m12", "excerpt": "…" },
  "entities": ["DSH-MultiTool"],
  "tags": ["project", "path"],
  "salience": 0.8,
  "sessionId": "s_20261120"
}
```

召回返回（默认预算 ≤8 条 / ≤1200 token）：

```json
{
  "ok": true,
  "identity": null,
  "items": [
    { "id": "evt_…", "layer": "event", "text": "…", "tokens": 42, "score": 0.71,
      "evidence": { "source": "chat", "locator": "panel#m12" } }
  ],
  "used": { "count": 1, "tokens": 42 },
  "budget": { "maxItems": 8, "maxTokens": 1200 },
  "truncated": false,
  "candidates": 3
}
```

调用方可以要更小的预算，但全局天花板是 32 条 / 4000 token —— 防止上层把上下文撑爆。

## 数据位置（模块外，push 不会破坏）

```text
data/memory/
├── events/YYYY-MM.jsonl     原始事件，按月分片，只追加
├── rejected.jsonl           被闸门拒收的写入（含原因，可复盘）
├── index/inverted.json      索引快照（可重建）
├── audits/{write,recall}.jsonl
└── identity/identity.v1.yaml  身份层（P0 只读，存在则注入，≤200 token）
```

## 运行与部署

```powershell
# 本机直接跑
node memory\server.js

# 部署到服务器（计划任务 DSH-MultiTool Memory，开机自启，SYSTEM）
..\deploy-tool\deploy.ps1 push -Source .\memory -Name memory
..\deploy-tool\deploy.ps1 svc -Name 'DSH-MultiTool Memory' -TaskAction restart
```

## P0 已验证的边界

- 无 `evidence.source` / `locator` → 400，且写入 `rejected.jsonl`，不会污染记忆。
- 召回同时受条数与 token 两个上限约束，超出的条目被丢弃并置 `truncated`。
- 索引只是缓存：删掉 `index/inverted.json` 后重启自动重建，不影响数据。
- 身份层超 200 token 会被截断并标记省略号，不允许无限膨胀。
