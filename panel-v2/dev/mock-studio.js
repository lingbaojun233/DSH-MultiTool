'use strict';
/*
 * v2-core 的桩服务（只在验收/本地联调用）。
 *   node dev/mock-studio.js            # 起在 127.0.0.1:8774
 * 契约和 panel-v2/server.js 代理的目标一致：
 *   POST /v1/jobs   GET /v1/jobs   GET /v1/jobs/:id   POST /v1/jobs/:id/redo   GET /v1/video/:id
 * 时间线是固定的，方便面板轮询断言：
 *   0 - 1.8s    running  第 1/7 场 配音中
 *   1.8 - 6.2s  running  第 3/7 场 manim 渲染中
 *   6.2s 之后   done，带 videoUrl / srtUrl / scenes
 */

const http = require('node:http');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8774;
const SCENE_TOTAL = 7;

const PHASE_TIMELINE = {
  voiceUntil: 1800,
  manimUntil: 6200,
};

function log(message) {
  process.stdout.write(`[mock-studio] ${message}\n`);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function splitText(text, parts) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim() || '聊聊今天的主题';
  const size = Math.max(4, Math.ceil(clean.length / parts));
  const chunks = [];
  for (let i = 0; i < parts; i += 1) {
    const piece = clean.slice(i * size, (i + 1) * size).trim();
    if (piece) chunks.push(piece);
  }
  while (chunks.length < parts) chunks.push(`第 ${chunks.length + 1} 场`);
  return chunks.slice(0, parts);
}

function normalizeScene(source, index) {
  const scene = source && typeof source === 'object' ? source : {};
  const tool = scene.tool === 'manim' || scene.tool === 'text' ? scene.tool : 'auto';
  return {
    text: String(scene.text || `第 ${index + 1} 场`),
    narration: String(scene.narration || ''),
    seconds: Number(scene.seconds) || 5,
    hint: String(scene.hint || ''),
    tool,
    stickers: Array.isArray(scene.stickers) ? scene.stickers : [],
    image: String(scene.image || ''),
    manim: scene.manim && typeof scene.manim === 'object' ? scene.manim : null,
    status: 'pending',
    note: String(scene.note || ''),
  };
}

function makeScenes(body) {
  if (Array.isArray(body.scenes) && body.scenes.length) {
    return body.scenes.map((scene, index) => normalizeScene(scene, index));
  }
  const text = String(body.script || body.topic || '');
  return splitText(text, SCENE_TOTAL).map((chunk, index) =>
    normalizeScene({ text: chunk, seconds: 5 }, index)
  );
}

function failCodeFor(body) {
  const haystack = JSON.stringify({
    topic: body.topic,
    script: body.script,
    scenes: body.scenes,
  });
  if (haystack.includes('__FAIL_VOICE__')) return 'VOICE_UNAVAILABLE';
  if (haystack.includes('__FAIL_MANIM__')) return 'MANIM_FAILED';
  return '';
}

function snapshot(job, now) {
  const elapsed = now - job.createdAt;
  const base = {
    ok: true,
    id: job.id,
    status: 'running',
    phase: 'tts',
    label: '配音中',
    done: 1,
    total: SCENE_TOTAL,
    elapsedMs: elapsed,
    ms: elapsed,
    bytes: 0,
    videoUrl: '',
    srtUrl: '',
    warnings: [],
    error: null,
    scenes: job.scenes,
    topic: job.topic,
    script: job.script,
    seconds: job.seconds,
    createdAt: new Date(job.createdAt).toISOString(),
  };

  if (job.failCode) {
    if (elapsed < 1200) return base;
    return Object.assign(base, {
      status: 'failed',
      phase: 'failed',
      label: '失败',
      error: job.failCode,
      warnings: job.failCode === 'VOICE_UNAVAILABLE' ? ['voice retry exhausted'] : [],
      elapsedMs: elapsed,
      ms: elapsed,
    });
  }

  if (elapsed < PHASE_TIMELINE.voiceUntil) return base;

  if (elapsed < PHASE_TIMELINE.manimUntil) {
    return Object.assign(base, {
      phase: 'manim',
      label: 'manim 渲染中',
      done: 3,
      elapsedMs: elapsed,
      ms: elapsed,
    });
  }

  return Object.assign(base, {
    status: 'done',
    phase: 'done',
    label: '完成',
    done: SCENE_TOTAL,
    elapsedMs: elapsed,
    ms: elapsed,
    bytes: 123456,
    videoUrl: `/v1/video/${job.id}`,
    srtUrl: `/v1/video/${job.id}?srt=1`,
  });
}

function startMock(options) {
  const opts = options || {};
  const port = Number(opts.port || DEFAULT_PORT);
  const jobs = [];
  const requests = [];
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${HOST}:${port}`);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: 'BAD_REQUEST' });
      return;
    }

    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        body = await readJson(req);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: 'BAD_REQUEST' });
        return;
      }
    }

    requests.push({
      at: Date.now(),
      method: req.method,
      path: url.pathname,
      search: url.search,
      body,
      authorization: req.headers.authorization || '',
      contentType: req.headers['content-type'] || '',
    });
    log(`${req.method} ${url.pathname}${url.search}`);

    if (opts.requireAuth && !req.headers.authorization) {
      sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/jobs') {
      const hasTopic = typeof body.topic === 'string' && body.topic.trim();
      const hasScript = typeof body.script === 'string' && body.script.trim();
      const hasScenes = Array.isArray(body.scenes) && body.scenes.length;
      const count = [hasTopic, hasScript, hasScenes].filter(Boolean).length;
      if (count !== 1) {
        sendJson(res, 400, { ok: false, error: 'BAD_REQUEST', detail: '需要 topic / script / scenes 三选一' });
        return;
      }
      seq += 1;
      const job = {
        id: `j${seq}`,
        createdAt: Date.now(),
        topic: hasTopic ? body.topic : '',
        script: hasScript ? body.script : '',
        seconds: Number(body.seconds) || 45,
        style: body.style || '',
        voice: body.voice || '',
        scenes: makeScenes(body),
        failCode: failCodeFor(body),
      };
      jobs.push(job);
      sendJson(res, 200, { ok: true, jobId: job.id });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/jobs') {
      const now = Date.now();
      const list = jobs
        .slice()
        .reverse()
        .map((job) => snapshot(job, now));
      sendJson(res, 200, { ok: true, jobs: list });
      return;
    }

    const detail = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && detail) {
      const job = jobs.find((item) => item.id === decodeURIComponent(detail[1]));
      if (!job) {
        sendJson(res, 404, { ok: false, error: 'JOB_NOT_FOUND' });
        return;
      }
      sendJson(res, 200, snapshot(job, Date.now()));
      return;
    }

    const redo = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/redo$/);
    if (req.method === 'POST' && redo) {
      const job = jobs.find((item) => item.id === decodeURIComponent(redo[1]));
      if (!job) {
        sendJson(res, 404, { ok: false, error: 'JOB_NOT_FOUND' });
        return;
      }
      if (!Array.isArray(body.scenes) || !body.scenes.length) {
        sendJson(res, 400, { ok: false, error: 'BAD_REQUEST', detail: 'scenes 不能为空' });
        return;
      }
      seq += 1;
      const next = {
        id: `j${seq}`,
        createdAt: Date.now(),
        topic: job.topic,
        script: job.script,
        seconds: Number(body.seconds) || job.seconds,
        style: job.style,
        voice: job.voice,
        scenes: makeScenes(body),
        failCode: job.failCode,
        redoOf: job.id,
      };
      jobs.push(next);
      sendJson(res, 200, { ok: true, jobId: next.id });
      return;
    }

    const video = url.pathname.match(/^\/v1\/video\/([^/]+)$/);
    if (req.method === 'GET' && video) {
      if (url.searchParams.get('srt') === '1') {
        const text = '1\n00:00:00,000 --> 00:00:02,500\n第一场：桩服务生成的字幕\n\n2\n00:00:02,500 --> 00:00:05,000\n第二场\n';
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': Buffer.byteLength(text),
          'cache-control': 'no-store',
        });
        res.end(text);
        return;
      }
      // 桩片：一个带 ftyp 头的占位 mp4，够浏览器发起请求、够验收下载
      const bytes = Buffer.alloc(4096, 0);
      bytes.write('ftypisom', 4, 'ascii');
      bytes.write('mock-studio-video', 64, 'ascii');
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': bytes.length,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      });
      res.end(bytes);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      log(`listening on http://${HOST}:${port}`);
      resolve({
        server,
        port,
        jobs,
        requests,
        close() {
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

module.exports = { startMock };

if (require.main === module) {
  startMock({ port: Number(process.env.MOCK_STUDIO_PORT || DEFAULT_PORT) }).then(() => {
    log('ready');
  });
}
