# video

## 何时用

- 用户发来视频文件或链接，问「这讲了什么」「值不值得看」
- 需要判断一段录像里发生了什么

## 何时不用

- 纯文字对话
- 视频在要登录的私有页面上（yt-dlp 抓不到）

## 输入 / 输出

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| frames | array | `[{t,dataUrl}]` 浏览器已抽好的帧 |
| url | string | 视频页面地址，服务器下载后抽帧 |
| text | string | 用户想问的话，可空 |
| → synopsis | string | 这段视频在讲什么 |
| → timeline | array | `[{t,what}]` 按时间点 |
| → reply | string | 大肥鱼用自己的口气回的 |

## 例子

```text
> POST /api/video/analyze {"text":"这游戏怎么玩的","frames":[8 帧]}
→ synopsis 造桥通车，reply「就是造桥通车 花有限的预算把桥搭起来…」
```
