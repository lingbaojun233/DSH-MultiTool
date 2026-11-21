'use strict';
/**
 * wanvideo.js -- 用百炼原生协议调 wan3.0-video，生成一段"真人/AI 画面"视频。
 *
 * 为什么不用兼容模式：这个网关的 /compatible-mode/v1/videos、/v1/videos 一律返回
 * url error，只有**百炼原生路径**能用（实测过，别再试错）：
 *   提交 POST /api/v1/services/aigc/video-generation/video-synthesis
 *        headers: authorization: Bearer <key> / content-type: application/json
 *                 x-dashscope-async: enable
 *        body:  {"model":"wan3.0-video","input":{"prompt":"…"},
 *                "parameters":{"size":"1280*720","duration":5}}
 *        →      {"output":{"task_id":"…","task_status":"PENDING"}}
 *   轮询 GET /api/v1/tasks/{task_id}  → output.task_status / output.video_url
 *   实测 5 秒 720p 约 100 秒出结果，产物 15~20MB。
 *
 * 三条硬约束（都是踩出来的）：
 *   1) **串行**：模块级 Promise 队列，同一进程同时只跑一个任务 —— 并发提交会争额度，
 *      而且网关对同一账号的并发很敏感，串行最稳。
 *   2) **超时**：默认 8 分钟，超时就报 WAN_TIMEOUT，绝不无限等（上层还要拼接/混音）。
 *   3) **落地即校验**：文件 > 100KB 且 ffmpeg 能读出时长，否则算失败。
 *      服务器上只有 ffmpeg.exe 没有 ffprobe.exe，所以用 `ffmpeg -i` 的 stderr 解析
 *      （和 lib/manim.js 的 probeVideo 同一个办法）。
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { spawn } = require('node:child_process');

// 标准百炼接口（按量付费）。token-plan 网关额度耗尽后切到这条；host/model 可由调用方覆盖。
const HOST = 'https://dashscope.aliyuncs.com';
const SUBMIT_PATH = '/api/v1/services/aigc/video-generation/video-synthesis';
const TASK_PATH = '/api/v1/tasks/';
const MODEL = 'wanx2.1-t2v-turbo';
// 轮询间隔 6 秒：实测 100 秒出片，6 秒一次 ≈ 17 次请求，够快又不至于把网关问烦
const POLL_MS = 6000;
// 产物下限：正常 5 秒 720p 是 15MB 以上，小于 100KB 一定是错误页/空壳
const MIN_BYTES = 100 * 1024;
const MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_SIZE = '1280*720';

// ---------------------------------------------------------------- 串行队列 --

/**
 * 模块级串行队列。为什么是"串行"而不是"限并发"：
 *   生成一条要占 100 秒额度和带宽，同时跑两条只会让两条都更慢，
 *   还有可能触发网关的并发限制。要并发就多开进程，不要在这里偷偷并行。
 */
let chain = Promise.resolve();

function serialize(task) {
  // 用 then(task, task)：前一个任务失败也不能把队列卡死
  const run = chain.then(task, task);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

/** 队列里还有几个任务在排队（测试/日志用）。 */
let waiting = 0;
function queueDepth() {
  return waiting;
}

// -------------------------------------------------------------------- 工具 --

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function clampSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 5;
  // wan 只出 5 秒或 10 秒，请求值只用来决定取哪一档，真正的截断由上层做
  return n > 5 ? 10 : 5;
}

function validSize(value) {
  const text = String(value || '').trim();
  return /^\d{2,5}\*\d{2,5}$/.test(text) ? text : DEFAULT_SIZE;
}

/** 把上游响应里的 code/message 拼成一句话（失败时一定要带上，否则只能看到 HTTP 200）。 */
function errDetail(data) {
  if (!data || typeof data !== 'object') return '';
  const out = data.output && typeof data.output === 'object' ? data.output : {};
  const code = data.code || out.code || '';
  const msg = data.message || out.message || '';
  const parts = [];
  if (code) parts.push(`code=${code}`);
  if (msg) parts.push(`message=${String(msg).slice(0, 300)}`);
  return parts.join(' ');
}

/** 读一行纯文本密钥：容忍 BOM、首尾引号、多行文件（只取第一行非空）。 */
function readKeyFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const first = raw.replace(/^\uFEFF/, '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
    return first.replace(/^["']|["']$/g, '').trim();
  } catch {
    return '';
  }
}

/** 从 {"apiKey":"…"} 这种 JSON 里取密钥（老模块 video\secrets.json 的格式）。 */
function readJsonKey(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object') return '';
    return String(data.apiKey || data.api_key || data.key || '').trim();
  } catch {
    return '';
  }
}

/**
 * 找密钥：env → keyPath → keyFiles → jsonFiles。
 * 只把"来源文件"带出去，**绝不把密钥本身写进返回值以外的任何地方**（日志/错误都不能有）。
 */
function resolveKey(opts = {}) {
  const env = String(opts.envKey || '').trim();
  if (env) return { key: env, source: 'env' };
  const keyPath = String(opts.keyPath || '').trim();
  const keyFiles = Array.isArray(opts.keyFiles) ? opts.keyFiles : [];
  for (const file of [keyPath, ...keyFiles].filter(Boolean)) {
    const key = readKeyFile(file);
    if (key) return { key, source: file };
  }
  const jsonFiles = Array.isArray(opts.jsonFiles) ? opts.jsonFiles : [];
  for (const file of jsonFiles.filter(Boolean)) {
    const key = readJsonKey(file);
    if (key) return { key, source: file };
  }
  return { key: '', source: '' };
}

/** 一个 JSON 请求，永不抛异常。返回 { ok, status, data, error }。 */
function requestJson(method, url, { headers = {}, body = undefined, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      return finish({ ok: false, status: 0, data: null, error: `BAD_URL(${err && err.message || err})` });
    }
    const lib = target.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const finalHeaders = Object.assign({}, headers);
    if (payload) finalHeaders['content-length'] = String(payload.length);

    const req = lib.request(target, { method, headers: finalHeaders, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch { data = null; }
        const status = res.statusCode || 0;
        if (!data) {
          return finish({ ok: false, status, data: null, error: `BAD_JSON(${text.slice(0, 200)})` });
        }
        if (status < 200 || status >= 300) {
          return finish({ ok: false, status, data, error: `HTTP_${status}${errDetail(data) ? ' ' + errDetail(data) : ''}` });
        }
        return finish({ ok: true, status, data, error: '' });
      });
    });

    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', (err) => finish({ ok: false, status: 0, data: null, error: `NETWORK(${err && err.message || err})` }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 下载产物。跟随最多 3 次跳转（OSS 常见 302），落盘用 .part 再改名。 */
function download(url, outFile, timeoutMs = 300000, redirectLeft = 3) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      return finish({ ok: false, error: `BAD_VIDEO_URL(${err && err.message || err})` });
    }
    const lib = target.protocol === 'https:' ? https : http;
    let req = null;
    req = lib.get(target, { timeout: timeoutMs }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location && redirectLeft > 0) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, target).toString(); } catch { return finish({ ok: false, error: 'BAD_REDIRECT' }); }
        download(next, outFile, timeoutMs, redirectLeft - 1).then(finish);
        return;
      }
      if (code !== 200) {
        res.resume();
        return finish({ ok: false, error: `DOWNLOAD_HTTP_${code}` });
      }
      const part = `${outFile}.part`;
      const ws = fs.createWriteStream(part);
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          try { req.destroy(); } catch { }
          try { ws.destroy(); } catch { }
          finish({ ok: false, error: `VIDEO_TOO_LARGE(${bytes})` });
        }
      });
      res.pipe(ws);
      ws.on('error', (err) => finish({ ok: false, error: `DOWNLOAD_WRITE_FAILED(${err && err.message || err})` }));
      ws.on('finish', () => {
        try {
          fs.renameSync(part, outFile);
          return finish({ ok: true, bytes });
        } catch (err) {
          return finish({ ok: false, error: `DOWNLOAD_RENAME_FAILED(${err && err.message || err})` });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', (err) => finish({ ok: false, error: `DOWNLOAD_FAILED(${err && err.message || err})` }));
  });
}

/**
 * 探视频时长/宽高。服务器上 ffmpeg 目录只有 ffmpeg.exe，没有 ffprobe.exe ——
 * `ffmpeg -i` 不带输出必定报错退出，但元信息会打到 stderr，正好能解析。
 */
function probeVideo(ffmpeg, file) {
  return new Promise((resolve) => {
    if (!ffmpeg || !fs.existsSync(ffmpeg) || !file || !fs.existsSync(file)) return resolve(null);
    let child = null;
    try {
      child = spawn(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true });
    } catch {
      return resolve(null);
    }
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    const timer = setTimeout(() => { try { child.kill(); } catch { } }, 20000);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const dim = err.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
      const dur = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!dim) return resolve(null);
      resolve({
        width: Number(dim[1]),
        height: Number(dim[2]),
        duration: dur ? (Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])) : 0,
      });
    });
  });
}

// --------------------------------------------------------------- 主流程 ----

/**
 * 生成一段 AI 视频并下载到 work/wan-<index>.mp4。
 *
 * @param {object} opts
 *   key        必填，API key（调用方从 secrets 读，本模块只负责用）
 *   prompt     必填，英文画面描述（主体+动作+风格+镜头）
 *   seconds    期望时长；wan 只出 5/10 秒，>5 就请求 10 秒，截断由上层做
 *   size       分辨率，默认 1280*720（已实测可用）
 *   work       临时目录（产物落这里）
 *   index      场次序号，产物文件名 wan-<index>.mp4
 *   timeoutMs  总超时（提交+轮询+下载），默认 480000（8 分钟）
 *   ffmpeg     ffmpeg 路径，用于校验产物时长
 *   onProgress 可选，({status, taskId}) => void，用于写日志/进度
 * @returns {{ok:boolean, file?:string, taskId?:string, ms:number, error?:string}}
 */
async function generateClip(opts = {}) {
  const startedAt = Date.now();
  const prompt = String(opts.prompt || '').trim();
  const key = String(opts.key || '').trim();
  const work = String(opts.work || '').trim();
  const index = opts.index == null ? 'gen' : String(opts.index);
  const size = validSize(opts.size);
  const seconds = clampSeconds(opts.seconds);
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 480000;
  const ffmpeg = String(opts.ffmpeg || '');
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  // 首帧参考图（data URL 或公网 URL）。网关对未知字段"接受但可能忽略"，
  // 是否真的生效由 studio 侧做对照实验验证；这里只负责原样传上去。
  const firstFrameUrl = String(opts.firstFrameUrl || '').trim();

  const fail = (error, extra = {}) => Object.assign({
    ok: false, file: null, taskId: '', ms: Date.now() - startedAt, error: String(error).slice(0, 600),
  }, extra);

  if (!key) return fail('WAN_KEY_MISSING: 没有可用的密钥（检查 config.wanKeyPath / secrets\\wan.key）');
  if (!prompt) return fail('PROMPT_REQUIRED: prompt 不能为空');
  if (!work) return fail('WORK_REQUIRED: 没有临时目录');
  try {
    fs.mkdirSync(work, { recursive: true });
  } catch (err) {
    return fail(`WORK_UNAVAILABLE: ${err && err.message || err}`);
  }

  const file = path.join(work, `wan-${index}.mp4`);
  const queuedAt = Date.now();
  waiting += 1;

  return serialize(async () => {
    const t0 = Date.now();
    const queueMs = t0 - queuedAt;
    const deadline = t0 + timeoutMs;
    let taskId = '';
    let lastStatus = '';
    const done = (value) => Object.assign({ taskId, queueMs }, value, { ms: Date.now() - startedAt });

    // 1) 提交：x-dashscope-async: enable 是必须的，少了它网关会当同步任务处理
    const input = { prompt };
    if (firstFrameUrl) input.first_frame_url = firstFrameUrl;
    const submit = await requestJson('POST', HOST + SUBMIT_PATH, {
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'x-dashscope-async': 'enable',
      },
      body: { model: MODEL, input, parameters: { size, duration: seconds } },
      timeoutMs: 30000,
    });
    if (!submit.ok) {
      return done({ ok: false, file: null, error: `SUBMIT_FAILED: ${submit.error}` });
    }
    const submitOut = (submit.data && submit.data.output) || {};
    taskId = String(submitOut.task_id || (submit.data && submit.data.task_id) || '');
    if (!taskId) {
      return done({ ok: false, file: null, error: `SUBMIT_NO_TASK_ID: ${errDetail(submit.data) || '上游没给 task_id'}` });
    }
    if (onProgress) {
      try { onProgress({ status: 'submitted', taskId, prompt }); } catch { }
    }

    // 2) 轮询：6 秒一次，超时就撤
    let videoUrl = '';
    let unknownCount = 0;
    for (;;) {
      if (Date.now() >= deadline) {
        return done({
          ok: false, file: null,
          error: `WAN_TIMEOUT(${timeoutMs}ms): 轮询没等到 SUCCEEDED（最后一次状态 ${lastStatus || 'unknown'}）`,
        });
      }
      const poll = await requestJson('GET', HOST + TASK_PATH + encodeURIComponent(taskId), {
        headers: { authorization: `Bearer ${key}` },
        timeoutMs: 30000,
      });
      if (!poll.ok) {
        // 单次轮询失败不立刻判死：网关偶尔 5xx，等下一次
        lastStatus = `POLL_ERROR(${poll.error})`;
      } else {
        const out = (poll.data && poll.data.output) || {};
        const status = String(out.task_status || (poll.data && poll.data.task_status) || '').toUpperCase();
        if (status) lastStatus = status;
        if (status === 'SUCCEEDED') {
          videoUrl = String(out.video_url || out.video_url_02 || '');
          if (!videoUrl) return done({ ok: false, file: null, error: 'NO_VIDEO_URL: 任务成功但没给 video_url' });
          break;
        }
        if (status === 'FAILED' || status === 'CANCELED' || status === 'CANCELLED') {
          const detail = errDetail(poll.data);
          return done({ ok: false, file: null, error: `WAN_TASK_${status}${detail ? ': ' + detail : ''}` });
        }
        // UNKNOWN 有时是任务刚落地还没登记，连两次再判死
        if (status === 'UNKNOWN') {
          unknownCount += 1;
          if (unknownCount >= 2) return done({ ok: false, file: null, error: 'WAN_TASK_UNKNOWN: 任务查不到（task_id 可能无效）' });
        } else {
          unknownCount = 0;
        }
      }
      if (onProgress) {
        try { onProgress({ status: lastStatus, taskId }); } catch { }
      }
      const wait = Math.min(POLL_MS, Math.max(1000, deadline - Date.now()));
      await sleep(wait);
    }

    // 3) 下载
    const got = await download(videoUrl, file, Math.min(300000, Math.max(30000, deadline - Date.now())));
    if (!got.ok) {
      return done({ ok: false, file: null, error: `DOWNLOAD_FAILED: ${got.error}` });
    }

    // 4) 校验：>100KB 且 ffmpeg 能读出时长，否则宁可失败也不把坏片段交给拼接
    let bytes = got.bytes || 0;
    try { bytes = fs.statSync(file).size; } catch { bytes = 0; }
    if (bytes < MIN_BYTES) {
      return done({ ok: false, file: null, error: `VIDEO_TOO_SMALL(${bytes} bytes < ${MIN_BYTES})` });
    }
    if (!ffmpeg || !fs.existsSync(ffmpeg)) {
      return done({ ok: false, file: null, error: 'NO_FFMPEG: 没法校验产物时长（config.ffmpeg 不存在）' });
    }
    const info = await probeVideo(ffmpeg, file);
    if (!info || !(info.duration > 0.05)) {
      return done({ ok: false, file: null, error: 'VIDEO_UNREADABLE: ffmpeg 读不出时长，产物不可用' });
    }

    return done({
      ok: true, file, error: null, bytes,
      duration: Number(info.duration.toFixed(2)),
      width: info.width, height: info.height,
      size, seconds, prompt,
      firstFrame: Boolean(firstFrameUrl),
    });
  }).finally(() => { waiting -= 1; });
}

module.exports = {
  HOST,
  MODEL,
  SUBMIT_PATH,
  TASK_PATH,
  POLL_MS,
  MIN_BYTES,
  DEFAULT_SIZE,
  generateClip,
  resolveKey,
  readKeyFile,
  probeVideo,
  queueDepth,
  _internal: { serialize, sleep, clampSeconds, validSize, errDetail },
};
