# registry —— 模块注册表 / 目录 / 加载器

让模型知道**有哪些模块、何时用**（目录常驻，约 30 token/模块），**怎么用**按需加载（README，≤600 token）。
设计见 [`../docs/registry-design.md`](../docs/registry-design.md)。

## 目录

```text
registry/
├── modules/<name>/
│   ├── module.yaml     名字、触发条件、入口、成本、版本
│   └── README.md       决策卡：何时用/不用、输入输出、一个例子
├── lib/
│   ├── tokens.js       token 估算（与 memory 同算法）
│   ├── yaml.js         极简 YAML 解析
│   ├── validate.js     module.yaml 校验
│   ├── catalog.js      目录渲染 + 预算 + 冲突检测
│   ├── loader.js       read_module：白名单 / 截断 / 会话缓存 / 用量统计
│   ├── readme-gen.js   决策卡生成
│   └── lint.js         README 质检
├── tests/              30 条触发测试集 + 批跑脚本
└── cli.js              命令入口
```

## 用法

```powershell
node cli.js validate            # 校验全部 module.yaml
node cli.js catalog             # 渲染目录（就是注入给模型的那段）
node cli.js read memory         # 懒加载某模块的 README
node cli.js lint                # 质检全部 README
node cli.js gen memory          # 生成决策卡（只打印，不写盘）
node cli.js stats               # 读取次数 / 读了没用的清单
```

模型侧通过 `node <registry>\cli.js read <name>` 加载用法；目录里只有名字和触发条件。

## 新增一个模块

1. 建 `modules/<name>/module.yaml`（字段见下）
2. 写 `modules/<name>/README.md`：四段固定结构
3. `node cli.js validate && node cli.js lint <name>`

不用改 io、不改工具表——**只多一行目录**。

```yaml
name: memory            # 全小写，唯一
title: 跨会话记忆
when: 需要回忆之前说过的事、用户偏好或已确认的事实时   # ≤40 字
not_when: 当前对话已经包含全部信息，或问题与历史无关时  # 必填
entry:
  type: cmd             # tool | cmd
  name: memory/cli.js   # 相对仓库根
cost: 低                # 低 | 中 | 高
readme: README.md
version: 0.1.0
```

## 预算与硬约束

| 项 | 上限 | 谁保证 |
| --- | --- | --- |
| 目录行 | 60 token / 模块 | `catalog.js` 预算检查 + `lint.js` |
| README | 600 token | `loader.js` 截断 + `lint.js` |
| 目录总文本 | 字节稳定 | 按 name 排序，无时间戳 |

- 目录文本**不含**"已激活"这类动态状态，动态行由 io 单独拼在后面。
- 触发条件重叠只**报告**，不自动合并。

## 触发测试

```powershell
node tests/triggers.js            # dry：关键词启发式，秒级
node tests/triggers.js --live     # 真模型，30 条，约 2-4 分钟
```

指标：漏触发（该用没用）< 5%、误触发（不该用却用）< 10%。未达标会列出最可疑的 5 条与命中的目录行。

## 验收

```powershell
node test/acceptance.js
```

覆盖：目录跨请求/跨进程字节一致、新增模块只多一行、目录行与 README 预算、集成前后 token 对比。
