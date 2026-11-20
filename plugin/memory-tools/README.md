# memory-tools —— 把能力注册成 DSH 原生工具

这个 bundle 解决一个具体问题：**模型不会主动调用 `registry\cli.js read`**（实测 30 条问法中 0 次），
而是用 `ls`/`find` 自己翻文件。原因不是它不爱用工具，而是这些能力从来没被注册成"工具"——
它只看到目录里的一段散文。

注册后，模型拿到的是一张真实的工具表：

| 工具 | 作用 |
| --- | --- |
| `memory_search` | 按双预算召回记忆，每条带证据 |
| `memory_remember` | 写入一条事件，无证据拒收 |
| `memory_forget` | 软删 / 撤销，可审计 |
| `read_module` | 读某模块的用法卡（替代翻文件） |

## 安装（服务器 headless profile）

```powershell
# 1. 放进 profile 的 node_modules
$dst = "C:\Apps\DSH-MultiTool\core\home\profiles\headless\node_modules\@dsh-multitool\memory-tools"
robocopy plugin\memory-tools $dst /MIR

# 2. 在 profile 的 package.json 里声明 bundle
#    "dsh": { "profile": { "bundles": [..., "@dsh-multitool/memory-tools"] } }

# 3. 验证（不调用模型）
dsh.cmd --profile headless --dump-config | findstr memory-tools
```

## 配置

`cordis.patch.yml` 里的 row config：

```yaml
- insert:
    - id: dsh-multitool-memory-tools
      name: '@dsh-multitool/memory-tools'
      config:
        memoryUrl: 'http://127.0.0.1:8767'
        registryDir: 'C:\Apps\DSH-MultiTool\registry'
        nodeBin: 'C:\Apps\DSH-MultiTool\core\runtime\node\node.exe'
```

## 代价

工具表常驻约 500–700 token（四个工具的 name + description + schema），与"目录常驻、用法懒加载"的省法相反。
换来的是模型**真的会调用**，而不是绕过去。

## 回滚

从 `profile/package.json` 的 `bundles` 里删掉这一项即可；或整目录删除。
headless 每次调用都重新加载 profile，无需重启服务。

## 已知限制

- 只注册工具，不注册界面；面板里看不到这四个工具。
- `read_module` 通过子进程调 `registry\cli.js`，依赖该路径存在。
- 工具执行失败返回结构化 JSON，不抛异常；模型需要自己判断 `ok`。
