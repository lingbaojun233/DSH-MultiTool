'use strict';
// Probe: can we synthesize with Microsoft Edge's read-aloud endpoint from plain Node?
const crypto = require('node:crypto');
const fs = require('node:fs');

const TRUSTED = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WIN_EPOCH = 11644473600n;

function secMsGec() {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  let ticks = (nowSec + WIN_EPOCH) * 10000000n;
  ticks -= ticks % 3000000000n; // 向下取整到 5 分钟
  return crypto.createHash('sha256').update(`${ticks}${TRUSTED}`).digest('hex').toUpperCase();
}

function ssml(text, voice, rate, pitch) {
  const esc = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>` +
    `<voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${esc}</prosody></voice></speak>`;
}

function synthesize(text, voice, opts = {}) {
  return new Promise((resolve) => {
    const url = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' +
      `?TrustedClientToken=${TRUSTED}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-130.0.2849.68` +
      `&ConnectionId=${crypto.randomUUID().replace(/-/g, '')}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      return resolve({ ok: false, error: 'WS_CONSTRUCT: ' + err.message });
    }
    ws.binaryType = 'arraybuffer';
    const chunks = [];
    let settled = false;
    const finish = (r) => { if (settled) return; settled = true; try { ws.close(); } catch { } resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: 'TIMEOUT' }), 20000);

    ws.onopen = () => {
      const ts = new Date().toISOString();
      const config = `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
              },
            },
          },
        });
      ws.send(config);
      const req = `X-RequestId:${crypto.randomUUID().replace(/-/g, '')}\r\n` +
        `Content-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n` +
        ssml(text, voice, opts.rate || '+0%', opts.pitch || '+0Hz');
      ws.send(req);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        if (ev.data.includes('Path:turn.end')) {
          clearTimeout(timer);
          const buf = Buffer.concat(chunks);
          finish({ ok: buf.length > 1000, bytes: buf.length, audio: buf });
        }
        return;
      }
      const buf = Buffer.from(ev.data);
      const headerEnd = buf.indexOf('Path:audio');
      if (headerEnd < 0) return;
      // 帧结构：[2 字节头长度 BE][头][音频]
      const headerLen = buf.readUInt16BE(0);
      chunks.push(buf.subarray(2 + headerLen));
    };

    ws.onerror = (e) => { clearTimeout(timer); finish({ ok: false, error: 'WS_ERROR: ' + (e && e.message || 'unknown') }); };
    ws.onclose = (e) => { clearTimeout(timer); finish({ ok: false, error: `WS_CLOSE code=${e.code} reason=${e.reason || ''}` }); };
  });
}

(async () => {
  const voices = process.argv.slice(2);
  if (!voices.length) voices.push('zh-CN-XiaoyiNeural', 'zh-CN-XiaoxiaoNeural');
  for (const v of voices) {
    const started = Date.now();
    const r = await synthesize('主人，我今天有点想你了呀', v);
    const ms = Date.now() - started;
    if (r.ok) {
      const out = `C:\\Users\\Administrator\\Desktop\\大肥鱼2.0\\.work\\edge-${v}.mp3`;
      fs.writeFileSync(out, r.audio);
      console.log(`OK   ${v}  ${ms}ms  ${r.bytes} bytes -> ${out}`);
    } else {
      console.log(`FAIL ${v}  ${ms}ms  ${r.error}`);
    }
  }
})();
