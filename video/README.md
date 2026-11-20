# video — 看视频模块

给面板用：用户发来一段视频，它先让多模态模型看懂画面，再把描述交给 io，由**大肥鱼用自己的口气**回应。

## 为什么要拆成两段

```text
视频 → [本模块] → 视频描述（时间轴 + 内容）
                       ↓
                  [io /v1/input] → 人格 + 记忆生效 → 大肥鱼的回复
```

如果让多模态模型直接扮演大肥鱼，人格和记忆就用不上了。拆开之后：**看画面**用视觉模型，**说话**回到 DSH 核心，两边各自最优。

## 输入两条路

| 来源 | 做法 | 依赖 |
| --- | --- | --- |
| 本地文件 | **浏览器**解码、抽 N 帧 JPEG，只上传帧 | 无 |
| 网络链接 | 服务器 yt-dlp 下载 → ffmpeg 抽帧 | `tools\yt-dlp.exe` + `tools\ffmpeg` |

本地视频**不上传原文件**：60 MB 的录像传上去要几十秒，而在浏览器里抽 8 帧不到 1 秒。

## 模型

走阿里云 MaaS 网关（OpenAI 兼容），实测可用的看图模型：

| 模型 | 看图 | 备注 |
| --- | --- | --- |
| `qwen3.8-flash` | ✅ | 默认，8 帧约 25s |
| `qwen4-max` | ✅ | 备用（配置里 fallbackModel） |
| `qwen3.7-plus` | ✅ | 较慢 |
| `qwen3.7-max` / `glm-5.3` | ❌ 400 | 不吃图片输入 |

`config.json` 里改 `model` 即可换。不可用时自动退到 `fallbackModel`。

## 接口

```text
GET  /v1/health        → {ok, model, hasKey, ffmpeg, ytdlp}
POST /v1/analyze       → {frames:[{t,dataUrl}], text}     浏览器抽好的帧
POST /v1/analyze-url   → {url, text, frames}              服务器下载后抽帧
```

返回 `{ok, model, synopsis, timeline[], highlights[], onScreen, usage}`。

面板侧还有一层 `/api/video/analyze` 和 `/api/video/url`：它会在拿到描述后**继续调 io**，把大肥鱼的回复一起返回。

## 配置

`config.json`（可进仓库）放非敏感项；**`secrets.json` 放 apiKey，已 gitignore**，部署时单独传。

```json
{ "gateway": "...", "model": "qwen3.8-flash", "maxFrames": 16, "frameMaxSide": 896 }
```

## 已知限制

- **抽帧是均匀取样**，不是场景检测。跳剪很快的视频，关键帧可能正好被跳过 —— 要更准就得加场景变化检测。
- **不看音频**。目前只喂画面，没有转写台词。
- **链接受平台限制**：B 站等要登录态的内容 yt-dlp 会失败，报错会原样返回。
- **单次成本不低**：8 帧约 4300 输入 token（约 25s），16 帧翻倍。帧数是唯一有效的成本旋钮。
