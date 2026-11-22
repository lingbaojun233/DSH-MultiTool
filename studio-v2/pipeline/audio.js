'use strict';
/**
 * audio.js -- 配音与节奏。
 *
 * 配音：POST http://127.0.0.1:8770/v1/speak {text, voice}
 *   - voice="" 由 speak 按人设挑音色（v2 不自己猜音色）
 *   - 串行调用（speak 内部也是并发 1），单句超时 150s
 *   - 非 audio/* 一律算失败：strict 模式下这代表 TTS 不可用，整集要 failed
 *
 * 拿到 wav 之后有两条"可选加工"，都是临时文件接力，跳过时只改名：
 *   1) 变调 voicePitch（半音，默认 +1）：asetrate + atempo，时长不变；0 完全跳过
 *   2) 变速 narrationSpeed：atempo，1.0 完全跳过
 * 两步的日志都会带上 scene#N 前缀（由 render.js 的 logger 加）。
 *
 * 节奏（任务书公式）：
 *   场时长 = clamp(max(计划秒数, 旁白时长 + 每场停留, 动画自然时长 × 0.85),
 *                  minSceneSeconds, maxSceneSeconds)
 *   计划秒数是**下限**：用户把 6 秒改成 9 秒，这一场就多停 3 秒。
 *   动画最多压到 0.85×（加速 ≤1/0.85），最多拉到 2×，再长就停末帧。
 */
const fs = require('node:fs');
const path = require('node:path');
const M = require('./manim');
const C = require('./cache');

/** 语速范围与默认值跟 schema.js 保持一致；这里只做防御性夹取。 */
const SPEED_MIN = 0.85;
const SPEED_MAX = 1.25;

/** 音高范围（半音）：0 = 原声，正数升调，负数降调。 */
const PITCH_MIN = -6;
const PITCH_MAX = 6;

function clampSpeed(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, n));
}

function clampPitch(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(PITCH_MAX, Math.max(PITCH_MIN, n));
}

/** 日志里的音高：+1.0 / 0.0 / -1.5。 */
function pitchText(v) {
  const n = Number(v);
  const safe = Number.isFinite(n) ? n : 0;
  return `${safe > 0 ? '+' : ''}${safe.toFixed(1)}`;
}

function parseFailure(body, status) {
  let info = null;
  try { info = JSON.parse(body); } catch { /* 非 JSON */ }
  const detail = info ? String(info.error || info.message || info.detail || '') : String(body || '').slice(0, 300);
  return { status, speakError: detail || `HTTP_${status}`, raw: String(body || '').slice(0, 500) };
}

/**
 * 采样率从输入实测（机器上只有 ffmpeg，没有 ffprobe，沿用 manim.js 的 stderr 解析思路）。
 * 探测不到返回 0，调用方用 22050（speak 现在的输出）兜底，绝不写死成某个 tts 的采样率。
 */
async function probeSampleRate(ffmpeg, file) {
  if (!ffmpeg || !fs.existsSync(file)) return 0;
  const r = await M.run(ffmpeg, ['-hide_banner', '-i', file], 20000);
  const m = /Audio:[^\n]*?(\d{3,6})\s*Hz/i.exec(String(r.err || ''));
  return m ? Number(m[1]) : 0;
}

/**
 * 变调（半音）：asetrate 改播放采样率 = 同时升调和变快，再用 atempo=1/f 把时长拉回来，
 * 净效果是"只升调、不变长"。f = 2^(semitones/12)。
 *
 * - semitones=0 直接改名走人，完全不起 ffmpeg（不重编码）
 * - 失败降级为原音 + 写日志：变调是锦上添花，不能让整集挂掉
 * 默认值取实时采样率实测值，避免把 22050/24000 写死。
 */
async function applyPitch({ cfg, src, dest, semitones, log }) {
  const st = clampPitch(semitones);
  if (Math.abs(st) < 0.005) {
    fs.renameSync(src, dest);
    return { ok: true, skipped: true, semitones: 0 };
  }
  const probed = await probeSampleRate(cfg.ffmpeg, src);
  const base = probed > 0 ? probed : 22050;
  const f = Math.pow(2, st / 12);
  const rate = Math.round(base * f);
  const atempo = 1 / f;
  const tmp = `${dest}.pitch-${process.pid}-${Date.now()}.wav`;
  const r = await M.run(cfg.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', src,
    '-filter:a', `asetrate=${rate},aresample=${base},atempo=${atempo.toFixed(4)}`,
    '-vn', '-c:a', 'pcm_s16le',
    tmp,
  ], 180000);
  if (r.code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size < 1000) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
    // 降级：原音照常往下走，只是这一集没有升调
    try { fs.renameSync(src, dest); } catch { /* 已经挪过去就算了 */ }
    if (log) {
      log(`音高 ${pitchText(st)} 半音失败，降级为原音：`
        + `asetrate=${rate}, atempo=${atempo.toFixed(4)}（${String(r.err || '').slice(-200)}）`);
    }
    return { ok: false, degraded: true, semitones: 0, sampledRate: base, rate, atempo };
  }
  fs.renameSync(tmp, dest);
  try { fs.rmSync(src, { force: true }); } catch { /* 忽略 */ }
  if (log) log(`音高 ${pitchText(st)} 半音（asetrate ${rate}, atempo ${atempo.toFixed(4)}）`);
  return { ok: true, skipped: false, semitones: st, sampledRate: base, rate, atempo };
}

/**
 * 配音变速：配音拿到之后再跑一遍 atempo（改速度不改音高）。
 * speed=1.0 时跳过重采样，保持"默认值行为和以前完全一致"。
 */
async function applySpeed({ cfg, src, dest, speed, log }) {
  const spd = clampSpeed(speed);
  if (Math.abs(spd - 1) < 0.001) {
    fs.renameSync(src, dest);
    return { ok: true, skipped: true };
  }
  const tmp = `${dest}.spd-${process.pid}-${Date.now()}.wav`;
  const r = await M.run(cfg.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', src,
    '-filter:a', `atempo=${spd.toFixed(3)}`,
    '-vn', '-c:a', 'pcm_s16le',
    tmp,
  ], 180000);
  if (r.code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size < 1000) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
    try { fs.rmSync(src, { force: true }); } catch { /* 忽略 */ }
    return { ok: false, error: `ATEMPO_FAILED: ${String(r.err || '').slice(-300)}` };
  }
  fs.renameSync(tmp, dest);
  try { fs.rmSync(src, { force: true }); } catch { /* 忽略 */ }
  if (log) log(`语速 ${spd.toFixed(2)}× 已应用（atempo）`);
  return { ok: true, skipped: false };
}

/** 合成一句旁白并落盘；成功返回 { ok, file, ms, cached }。 */
async function speakToFile({ text, voice, speed, cfg, file, log }) {
  if (!String(text || '').trim()) return { ok: true, file: null, ms: 0, cached: false };
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) {
    return { ok: true, file, ms: 0, cached: true };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(cfg.speakTimeoutMs) || 150000);
  const started = Date.now();
  try {
    const res = await fetch(`${String(cfg.speakUrl).replace(/\/+$/, '')}/v1/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text: String(text), voice: String(voice || '') }),
      signal: ctrl.signal,
    });
    const ct = String(res.headers.get('content-type') || '');
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const f = parseFailure(body, res.status);
      if (log) log(`speak 失败 HTTP ${res.status}：${f.speakError} ${f.raw}`);
      return {
        ok: false, status: res.status, ms: Date.now() - started,
        error: `VOICE_UNAVAILABLE: speak HTTP ${res.status}（${f.speakError}）`,
        detail: f.raw,
      };
    }
    if (!ct.toLowerCase().startsWith('audio/')) {
      const body = await res.text().catch(() => '');
      const f = parseFailure(body, res.status);
      if (log) log(`speak 返回非音频 ${ct}：${f.speakError}`);
      return {
        ok: false, status: res.status, ms: Date.now() - started,
        error: `VOICE_UNAVAILABLE: speak 返回 ${ct || 'unknown'} 而不是音频（${f.speakError}）`,
        detail: f.raw,
      };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) {
      return { ok: false, status: res.status, ms: Date.now() - started, error: 'VOICE_UNAVAILABLE: 音频字节过短' };
    }
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, buf);
    // 先变调、再变速：两步都是"临时文件 → 正式文件"的接力，
    // 任一步跳过就只是改名，不额外重编码。
    const pitched = `${file}.pitched-${process.pid}-${Date.now()}.wav`;
    const pt = await applyPitch({ cfg, src: tmp, dest: pitched, semitones: cfg.voicePitch, log });
    const sp = await applySpeed({ cfg, src: pitched, dest: file, speed, log });
    if (!sp.ok) {
      return { ok: false, status: res.status, ms: Date.now() - started, error: `VOICE_UNAVAILABLE: ${sp.error}` };
    }
    const ms = Date.now() - started;
    if (log) log(`配音完成 ${(ms / 1000).toFixed(1)}s（${buf.length} 字节）`);
    return {
      ok: true, file, ms, cached: false, bytes: buf.length, speed: clampSpeed(speed),
      pitch: clampPitch(cfg.voicePitch), pitchApplied: pt.ok && !pt.skipped,
      pitchDegraded: Boolean(pt && pt.degraded), pitchRate: pt.rate || 0, pitchAtempo: pt.atempo || 0,
    };
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (log) log(`speak 调用异常：${msg}`);
    return {
      ok: false, status: 0, ms: Date.now() - started,
      error: `VOICE_UNAVAILABLE: speak 调用异常（${msg}）`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 旁白音频的缓存键：和"文本 + 音色 + 语速 + 音高"有关，和画面/标题无关。
 * 音高必须进键：否则把 voicePitch 从 0 改成 1 会命中旧音频，听起来像"没生效"。
 */
function audioKey(text, voice, speed, pitch) {
  const spd = clampSpeed(speed).toFixed(2);
  const pit = clampPitch(pitch).toFixed(2);
  return C.sha1(`audio-v2|${String(voice || '')}|${spd}|${pit}|${String(text || '')}`, 24);
}

/**
 * 确保这一场的旁白音频存在（命中缓存就读文件，不重合成）。
 * 返回 { ok, file|null, cached, duration, ms, error }。
 */
async function ensureSpeech({ scene, voice, cfg, cache, log }) {
  const text = String(scene.narration || '').trim();
  if (!text) return { ok: true, file: null, cached: false, duration: 0, ms: 0 };
  const speed = clampSpeed(cfg.narrationSpeed);
  const pitch = clampPitch(cfg.voicePitch);
  const k = audioKey(text, voice, speed, pitch);
  const file = cache.audioFile(k);
  const before = fs.existsSync(file);
  const r = await speakToFile({ text, voice, speed, cfg, file, log });
  if (!r.ok) return { ...r, duration: 0, key: k };
  const info = r.file ? await M.probeMedia(cfg.ffmpeg, r.file) : null;
  const duration = info && info.duration > 0 ? info.duration : Math.max(1, text.length / 4.2);
  if (log) log(`旁白 ${duration.toFixed(2)}s（语速 ${speed.toFixed(2)}×，音高 ${pitchText(pitch)} 半音）`);
  return {
    ok: true, file: r.file, key: k, cached: before || r.cached || false,
    duration, ms: r.ms || 0, pitch, pitchDegraded: Boolean(r.pitchDegraded),
  };
}

/**
 * 场时长 = clamp(max(计划秒数, 旁白 + 每场停留, 动画自然时长 × 0.85), 下限, 上限)。
 * 计划秒数是下限（以前没有旁白才用，导致面板改秒数没效果）。
 * pad 来自 scenePadding（0~3 秒，默认 0.6），是旁白说完后画面额外停留的时间。
 */
function sceneSeconds({ planned, narrationSeconds, naturalSeconds, cfg }) {
  const pad = Number(cfg.scenePadding);
  const safePad = Number.isFinite(pad) ? Math.max(0, Math.min(3, pad)) : 0.6;
  const floor = Number(cfg.animCompressFloor) || 0.85;
  const minSec = Number(cfg.minSceneSeconds) || 2;
  const maxSec = Number(cfg.maxSceneSeconds) || 30;
  const natural = Math.max(0.5, Number(naturalSeconds) || 0);
  const narr = Math.max(0, Number(narrationSeconds) || 0);
  const want = Math.max(Number(planned) || minSec, narr + safePad, natural * floor);
  const target = Math.max(minSec, Math.min(maxSec, want));
  return Math.round(target * 100) / 100;
}

module.exports = {
  ensureSpeech, sceneSeconds, audioKey, speakToFile,
  clampSpeed, clampPitch, applyPitch, probeSampleRate,
};
