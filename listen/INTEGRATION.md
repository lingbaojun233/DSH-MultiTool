# listen 模块 → 面板对接说明

给 `panel\` 的接入说明。**本文件只写接法，不改 panel 任何文件。**

## 1. 服务地址

- 服务：`http://127.0.0.1:8771`（只在服务器本机监听，不对外）
- 计划任务：`DSH-MultiTool Listen`（SYSTEM / AtStartup），入口 `listen\start-server.cmd`
- 健康检查：`GET /v1/health` → `{ ok, provider, recognizers:[...], ffmpeg }`
- 日志：`C:\Apps\DSH-MultiTool\logs\listen.log`

panel 服务也跑在同一台机器上，所以直接 `fetch('http://127.0.0.1:8771/v1/transcribe')`
即可，不需要认证、不需要 key。

## 2. 路由怎么加

在 panel 现有的路由表里加两条（照 `/api/video/analyze` 的写法，代理一层是为了
统一错误信封 + 让前端只认 `/api/*`）：

```js
// GET /api/listen/health  —— 面板显示「耳朵在不在线」
{ method: 'GET', path: '/api/listen/health',
  handler: async () => {
    const r = await fetch('http://127.0.0.1:8771/v1/health');
    return r.json();               // { ok, provider, recognizers, ffmpeg, ... }
  } }

// POST /api/listen/transcribe  —— body 原样透传 { audioBase64, mime }
{ method: 'POST', path: '/api/listen/transcribe',
  handler: async (req) => {
    const body = await readJsonBody(req);           // 注意：上限放到 32MB
    const r = await fetch('http://127.0.0.1:8771/v1/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        audioBase64: body.audioBase64,
        mime: body.mime || 'audio/webm',
      }),
      signal: AbortSignal.timeout(70000),           // 服务端 60s 上限 + 余量
    });
    return r.json();                                 // { ok, text, ms, provider }
  } }
```

要点：

- 面板这条路由的 **body 上限必须 ≥ 32MB**（base64 后体积，约 24MB 音频），
  现有的小 JSON 上限会直接 413。
- 服务端失败也是 **HTTP 200 + `{ok:false, error}`**，前端不要靠状态码判断，
  一律看 `ok`。
- 前端 abort 时不要重试同一条音频 —— 服务端已经在跑识别，重发会叠一份 CPU。

## 3. 前端怎么录音

浏览器只有 `MediaRecorder`，录出来是 `audio/webm;codecs=opus`，**直接发**，
转码交给服务端的 ffmpeg（前端转码要 WASM，没必要）。

```js
async function recordAndTranscribe(maxMs = 60000) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((resolve) => { rec.onstop = resolve; });
  rec.start();
  setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, maxMs);
  // ……点「说完」时：rec.requestData(); rec.stop();
  await done;
  stream.getTracks().forEach((t) => t.stop());

  const blob = new Blob(chunks, { type: 'audio/webm' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  }
  const audioBase64 = btoa(bin);

  const res = await fetch('/api/listen/transcribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audioBase64, mime: 'audio/webm' }),
  }).then((r) => r.json());

  if (!res.ok) throw new Error(res.error || 'ASR_FAILED');
  return res.text;             // 一整句中文，没有标点
}
```

细节：

- `btoa` 只能吃 latin1，必须按 0x8000 分块 `String.fromCharCode.apply`，
  一次性 `String.fromCharCode(...buf)` 在几 MB 音频上会爆栈。
- 权限：页面要用 `getUserMedia` 必须是 **https 或 127.0.0.1/localhost**。
  面板走 `http://<服务器IP>:8766` 时浏览器会拒绝麦克风 —— 这一点会挡住大部分
  远程访问场景，接之前先想好（自签 https，或让用户在服务器本机开 127.0.0.1）。
- 录音前先 `GET /api/listen/health`，`ok:false` 就把按钮置灰，别让用户对着
  录音按钮喊半天才看到报错。
- 建议录完先看 `MediaRecorder.isTypeSupported('audio/webm;codecs=opus')`，
  Safari 只给 mp4（`audio/mp4`）也能用，服务端认得。

## 4. 交互上要注意

1. **文字要给人看一遍再发**。SAPI 中文听写有错字，直接把 `text` 塞进对话会让
   模型顺着错字跑偏。面板应该把识别结果填进输入框、允许用户改完再回车。
2. **没有标点、没有分段**。要断句就自己按长度插，或者交给 io 的模型整理。
3. **一次一条**。服务串行吃 CPU，按下按钮后禁用按钮到返回为止。
4. `text` 为空字符串但 `ok:true` 是正常情况（录到了静音/噪音），前端要当
   「没听清」处理，别报错。
5. 60 秒是**转写**上限，不是录音长度上限；录 3 分钟的音频识别时间会顶到 60s 被杀。
   建议前端录音自己限在 60 秒内。
