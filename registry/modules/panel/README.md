# panel

## 何时用

- 需要让用户在浏览器里直接对话，或翻看历史回复
- 需要把某轮问答的完整上下文展示给人看

## 何时不用

- 纯命令行任务，不需要人机界面
- 只需要一段文本结果，终端里就能看完

## 输入 / 输出

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| text | string | 用户输入 |
| sessionId | string | 会话标识，用于记忆证据定位 |
| history | array | 最近轮次 `[{role,text}]` |
| → answer | string | 回答正文 |
| → memory | object | `{used:{count,tokens}, items[]}` |

## 例子

```text
POST /api/input {"text":"我的猫叫什么？","sessionId":"p1"}
→ {"ok":true,"answer":"你的猫叫布丁。","memory":{"used":{"count":1}}}
```

## 两种访问方式

| 入口 | 监听 | 用途 |
| --- | --- | --- |
| HTTP | `127.0.0.1:8766` | 本机 / SSH 隧道（麦克风在 localhost 下可用） |
| HTTPS | `0.0.0.0:8443` | 公网直连，浏览器直接开 `https://<服务器IP>:8443` |

为什么两个口并存：HTTP 只监听回环，不暴露到公网；HTTPS 才有传输加密，
而且浏览器只在**安全上下文**（https 或 localhost）里给麦克风权限 —— 上了 HTTPS 手机也能按着说话。

## 公网暴露的防护（都已生效）

- 登录/注册按来源 IP 限速：10 次 / 10 分钟，超了返回 429
- 注册默认 `invite`：必须填邀请码；改成 `closed` 就只有管理员能建号
- 密码 scrypt 加盐，token 只存哈希，会话 30 天
- `/api/admin/*` 校验 `role=admin`
- 自签证书（`data/panel-cert.pfx`，CN/SAN 都是服务器 IP，10 年）

## 自签证书的代价

浏览器第一次访问会报"不安全"，点「高级 → 继续前往」即可；之后不再提示。
想去掉警告只能上真证书（需要域名 + Let's Encrypt 或 Cloudflare Tunnel）。