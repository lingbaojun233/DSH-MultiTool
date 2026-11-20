# deploy

## 何时用

- 需要把本地目录推到服务器并解包生效
- 需要重启远端计划任务，或查看远端目录与服务状态

## 何时不用

- 只在本机改文件、不需要远端生效
- 只想比对代码差异或看提交历史

## 输入 / 输出

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| action | string | `test` / `push` / `put` / `svc` / `run` / `clean` |
| source | string | 本地文件或目录 |
| name | string | 远端目录名，也是包名前缀 |
| remotePath | string | `put` 的目标完整路径 |
| taskAction | string | `svc` 的动作：status/start/stop/restart |
| → ok | bool | 是否成功 |
| → target | string | 远端落地路径 |

## 例子

```text
.\deploy.ps1 push -Source .\memory -Name memory
→ {"ok":true,"target":"C:\\Apps\\DSH-MultiTool\\memory"}
```
