'use strict';
/*
 * speak 的桩（只给验收/联调用）：实现 GET /v1/voices?zh=1。
 * 面板的 /api/studio/voices 会转发到这里，设置页拿它动态填音色下拉。
 *   node dev/mock-speak.js          # 127.0.0.1:8770
 */

const http = require('node:http');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8770;

const DEFAULT_VOICES = [
  {
    voiceId: 'voc_test_a',
    name: '小暖',
    language: 'zh-CN',
    gender: 'female',
    age: 'young',
    tones: ['温柔'],
    tags: [],
    description: '桩音色：温柔女声',
  },
  {
    voiceId: 'voc_test_b',
    name: '小刚',
    language: 'zh-CN',
    gender: 'male',
    age: 'adult',
    tones: ['沉稳'],
    tags: [],
    description: '桩音色：沉稳男声',
  },
];

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function startSpeak(options) {
  const opts = options || {};
  const port = Number(opts.port || DEFAULT_PORT);
  const voices = Array.isArray(opts.voices) ? opts.voices : DEFAULT_VOICES;
  const requests = [];

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${HOST}:${port}`);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: 'BAD_REQUEST' });
      return;
    }
    requests.push({ at: Date.now(), method: req.method, path: url.pathname, search: url.search });
    process.stdout.write(`[mock-speak] ${req.method} ${url.pathname}${url.search}\n`);

    if (req.method === 'GET' && url.pathname === '/v1/voices') {
      const wantZh = /^(1|true|yes)$/i.test(url.searchParams.get('zh') || '');
      const list = wantZh ? voices.filter((voice) => /^zh/i.test(voice.language)) : voices.slice();
      const current = list.length ? list[0].voiceId : '';
      sendJson(res, 200, {
        ok: true,
        filter: wantZh ? 'zh' : 'all',
        total: voices.length,
        returned: list.length,
        cached: true,
        at: Date.now(),
        current,
        currentName: list.length ? list[0].name : '',
        voices: list.map((voice) => Object.assign({}, voice, { current: voice.voiceId === current })),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/health') {
      sendJson(res, 200, { ok: true, service: 'mock-speak', port, voices: voices.length });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      process.stdout.write(`[mock-speak] listening on http://${HOST}:${port}\n`);
      resolve({
        server,
        port,
        requests,
        close() {
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

module.exports = { startSpeak };

if (require.main === module) {
  startSpeak({ port: Number(process.env.MOCK_SPEAK_PORT || DEFAULT_PORT) }).then(() => {
    process.stdout.write('[mock-speak] ready\n');
  });
}
