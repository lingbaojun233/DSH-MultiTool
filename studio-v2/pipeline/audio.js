'use strict';
/**
 * audio.js -- 配音与节奏。
 *
 * 配音：POST http://127.0.0.1:8770/v1/speak {text, voice}
 *   - voice="" 由 speak 按人设挑音色（v2 不自己猜音色）
 *   - 串行调用（speak 内部也是并发 1），单句超时 150s
 *   - 非 audio/* 一律算失败：strict 模式下这代表 TTS 不可用，整集要 failed
 *
 * 节奏（任务书公式）：
 *   场时长 = max(旁白时长 + 0.6, 动画自然时长 × 0.85)
 *   动画最多压到 0.85×（加速 ≤1/0.85），最多拉到 2×，再长就停末帧。
 */
const fs = require('node:fs');
const path = require('node:path');
const M = require('./manim');
const C = require('./cache');

function parseFailure(body, status) {
  let info = null;
  try { info = JSON.parse(body); } catch { /* 非 JSON */ }
  const detail = info ? String(info.error || info.message || info.detail || '') : String(body || '').slice(0, 300);
  return { status, speakError: detail || `HTTP_${status}`, raw: String(body || '').slice(0, 500) };
}

/** 合成一句旁白并落盘；成功返回 { ok, file, ms, cached }。 */
async function speakToFile({ text, voice, cfg, file, log }) {
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
    fs.renameSync(tmp, file);
    const ms = Date.now() - started;
    if (log) log(`配音完成 ${(ms / 1000).toFixed(1)}s（${buf.length} 字节）`);
    return { ok: true, file, ms, cached: false, bytes: buf.length };
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

/** 旁白音频的缓存键：只和"文本 + 音色"有关，和画面/标题无关。 */
function audioKey(text, voice) {
  return C.sha1(`audio-v2|${String(voice || '')}|${String(text || '')}`, 24);
}

/**
 * 确保这一场的旁白音频存在（命中缓存就读文件，不重合成）。
 * 返回 { ok, file|null, cached, duration, ms, error }。
 */
async function ensureSpeech({ scene, voice, cfg, cache, log }) {
  const text = String(scene.narration || '').trim();
  if (!text) return { ok: true, file: null, cached: false, duration: 0, ms: 0 };
  const k = audioKey(text, voice);
  const file = cache.audioFile(k);
  const before = fs.existsSync(file);
  const r = await speakToFile({ text, voice, cfg, file, log });
  if (!r.ok) return { ...r, duration: 0, key: k };
  const info = r.file ? await M.probeMedia(cfg.ffmpeg, r.file) : null;
  const duration = info && info.duration > 0 ? info.duration : Math.max(1, text.length / 4.2);
  return {
    ok: true, file: r.file, key: k, cached: before || r.cached || false,
    duration, ms: r.ms || 0,
  };
}

/**
 * 场时长：max(旁白 + 0.6, 动画自然时长 × 0.85)。
 * 没有旁白时退回计划秒数（不能凭空把动画压到 0.85 倍）。
 * 结果再夹在 minSceneSeconds / maxSceneSeconds 里，并保证动画压缩不超过下限。
 */
function sceneSeconds({ planned, narrationSeconds, naturalSeconds, cfg }) {
  const pad = Number(cfg.narrationPad) || 0.6;
  const floor = Number(cfg.animCompressFloor) || 0.85;
  const minSec = Number(cfg.minSceneSeconds) || 2;
  const maxSec = Number(cfg.maxSceneSeconds) || 30;
  const natural = Math.max(0.5, Number(naturalSeconds) || 0);
  const narr = Math.max(0, Number(narrationSeconds) || 0);
  let target;
  if (narr > 0) target = Math.max(narr + pad, natural * floor);
  else target = Math.max(Number(planned) || minSec, natural * floor);
  target = Math.max(minSec, Math.min(maxSec, target));
  // 低于动画压缩下限就抬回下限，宁可这场长一点，也不让画面赶
  if (target < natural * floor) target = natural * floor;
  return Math.round(target * 100) / 100;
}

module.exports = { ensureSpeech, sceneSeconds, audioKey, speakToFile };
