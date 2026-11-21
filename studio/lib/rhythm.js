'use strict';
/**
 * rhythm.js -- 让"旁白 / 画面 / 动画"在时间轴上严丝合缝的三件事。
 *
 * 用户的原话是："图文对上，意思是节奏对上，而不是说分镜画面和文字没对上。"
 * 翻译成可执行的规则就是三条：
 *
 *   1) **场时长 = max(旁白时长 + 小尾巴, 动画自然时长 × 压缩下限)**（pad 默认 0.6s，下限 0.85）。
 *      以前是 `max(计划秒数, 旁白+0.6)`：规划写 8 秒、旁白只有 3 秒时，这一场就白留 5 秒空画面，
 *      观众看到"人早说完了画面还在那杵着"。现在一律以旁白为准（repadPlan）。
 *      第二项是"别让动画赶"的兜底：动画自然时长 × 0.85 比旁白+pad 更长时，
 *      宁可这一场多一两秒，也不把画面压成快进（用户实测："动画没跟上"）。
 *
 *   2) **动画时长对齐场时长，但压缩有下限**。manim 脚本里各段 run_time 之和是模型随手写的，
 *      跟旁白没关系；渲染前把脚本时长**拉伸/压缩**到本场秒数：
 *      拉伸上限 2 倍（再慢就成幻灯片），剩下的差额用结尾 self.wait 补；
 *      压缩下限 0.85（最多快 15%，观众不会觉得"抢"）—— 放不下是因为场时长已经由 (1) 按
 *      自然时长 × 0.85 兜过一次，正常情况下对齐后恰好等于场时长，不会触发更狠的压缩。
 *
 *   3) **语速 1.00（不加速）+ 裁掉两头静音**。TTS 的输出句首常带 200~300ms、句尾 200~600ms
 *      静音：句首会让字幕比人声早出现，句尾会让"说完到切画面"多出半拍。
 *      只做 areverse/silenceremove/areverse 两头裁剪；语速已经是 1.0 时**跳过 atempo**，
 *      避免无谓的重采样（1.10 那版被用户吐槽"讲话太快"）。
 *      这些都在**缓存落盘前**做一次，所以后面的时长测量、字幕对齐拿到的都是最终音频。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

function sha1(text, len = 16) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, len);
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------- 小工具 ----

/** 从 WAV 头算毫秒（无 ffprobe 依赖；解不出来返回 0）。 */
function wavMs(buf) {
  if (!buf || buf.length < 44) return 0;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let byteRate = 0;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) byteRate = buf.readUInt32LE(body + 8);
    else if (id === 'data') {
      dataSize = (size === 0 || size === 0xFFFFFFFF || body + size > buf.length) ? buf.length - body : size;
      break;
    }
    if (size <= 0) break;
    offset = body + size + (size % 2);
  }
  if (!byteRate || !dataSize) return 0;
  return Math.round((dataSize / byteRate) * 1000);
}

function run(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); } catch (err) {
      resolve({ code: -1, stderr: String((err && err.message) || err) });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { } }, Math.max(1000, timeoutMs));
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: String((e && e.message) || e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}

// -------------------------------------------------- 1) 场时长 = 旁白 + 尾巴 ----

// 动画压缩下限：场时长最多只能把动画压到自然时长的 85%（=最多快 15%）。
// 以前是 0.5：6 秒动画塞成 3 秒，观感就是"抢"。放不下时由 repadPlan 加长这一场。
const ANIM_COMPRESS_FLOOR = 0.85;
// 动画拉伸上限：2 倍。再慢就成幻灯片，不如用结尾 self.wait 补。
const ANIM_STRETCH_CAP = 2;

/**
 * 把"旁白实测时长"重新铺到每场时长上（纯函数，好测）。
 *
 * 规则：
 *   - 有旁白的场：seconds = clamp(max(旁白 + pad, 动画自然时长 × 压缩下限), minScene, MAX)
 *     —— 第一项保证话说完还有一口气，第二项保证动画不被压成快进。
 *   - 没旁白的场（静音场/纯文字卡）：seconds = max(原计划秒数, 动画自然时长 × 压缩下限)，
 *     同样只做 min/max 夹取。
 *   - 场时长**绝不低于旁白 + 0.15**（宁可这场略长，也不能把话截一半）。
 *   - 动画兜底不允许把单场撑过 maxScene + 2 秒：真遇到巨长的动画，宁可轻微超一点压缩下限，
 *     也不能出现 20 秒的静止画面（上限被撑开时会把 animClamped 标记出来，日志里能看见）。
 *   - 总时长超 maxTotalSeconds 时，只压缩"下限以上的部分"（长旁白的场不被扁平砍短）。
 *
 * @returns 新的 plan（不改传入对象），每场带 seconds / actualSeconds / narrationMs / pad
 */
function repadPlan(plan, narrationMs, cfg) {
  const C = cfg || {};
  const list = Array.isArray(narrationMs) ? narrationMs : [];
  const pad = clamp(num(C.narrationPad, 0.6), 0.2, 0.8);
  const minSec = num(C.minSceneSeconds, 2);
  const maxScene = num(C.maxSceneSeconds, 10);
  const animFloor = clamp(num(C.animCompressFloor, ANIM_COMPRESS_FLOOR), 0.5, 1);
  const fade = num(C.fade, 0.4);
  const cap = num(C.maxTotalSeconds, 900);
  const round2 = (v) => Number(v.toFixed(2));

  const scenes = ((plan && plan.scenes) || []).map((s, i) => {
    const raw = num(list[i], 0);
    const ms = raw > 0 ? Math.round(raw) : num(s.narrationMs, 0);
    const speak = ms > 0 ? ms / 1000 : 0;
    const planned = Math.max(minSec, num(s.seconds, minSec));
    // 动画自然时长（渲染前按 manim 脚本估的，见 server.js 的 animNaturalSeconds）。
    // 有它才有"动画不被压成快进"这条兜底；没有就是旧的"只看旁白"行为。
    const animNat = Math.max(0, num(s.animNaturalSeconds, 0));
    const animWant = animNat > 0 ? round2(animNat * animFloor) : 0;
    const ceil = Math.max(maxScene, Math.min(animWant, maxScene + 2));
    let seconds;
    if (speak > 0) {
      seconds = Math.max(speak + pad, animWant);
    } else {
      seconds = Math.max(planned, animWant);
    }
    seconds = clamp(seconds, minSec, ceil);
    if (seconds < speak + 0.15) seconds = Math.min(ceil, speak + 0.15);
    return Object.assign({}, s, {
      seconds: round2(seconds),
      actualSeconds: round2(seconds),
      narrationMs: ms,
      narrationPad: speak > 0 ? round2(seconds - speak) : 0,
      // 只用于日志/报告：这一场为了"动画不赶"多留了多少秒
      animNaturalSeconds: animNat,
      animWantedSeconds: animWant,
      animClamped: animWant > ceil + 0.05,
      animExtraSeconds: speak > 0 ? Math.max(0, round2(seconds - (speak + pad))) : 0,
    });
  });


  const gaps = Math.max(0, fade) * Math.max(0, scenes.length - 1);
  const sum = () => scenes.reduce((a, s) => a + num(s.seconds, 0), 0);
  let span = sum() - gaps;
  if (cap > 0 && span > cap + 1e-6) {
    const floors = scenes.map((s) => {
      const speak = num(s.narrationMs, 0) / 1000;
      const floor = speak > 0 ? Math.max(minSec, speak + 0.2) : minSec;
      return round2(Math.min(num(s.seconds, 0), floor));
    });
    const floorSum = floors.reduce((a, b) => a + b, 0);
    const room = cap + gaps - floorSum;
    const extra = sum() - floorSum;
    const k = extra > 1e-9 && room > 0 ? clamp(room / extra, 0, 1) : 0;
    scenes.forEach((s, i) => {
      const v = floors[i] + (num(s.seconds, 0) - floors[i]) * k;
      s.seconds = round2(Math.max(floors[i], v));
      s.actualSeconds = s.seconds;
      s.narrationPad = s.narrationMs > 0 ? round2(s.seconds - s.narrationMs / 1000) : 0;
    });
    span = sum() - gaps;
  }
  const totalSeconds = Number(Math.max(0.5, span).toFixed(2));
  return Object.assign({}, plan, {
    scenes,
    totalSeconds,
    overBudget: cap > 0 ? totalSeconds > cap + 0.05 : false,
    narrationPadSec: pad,
  });
}

// ------------------------------------------------ 2) 语速 + 裁尾巴静音 ----

/**
 * 量一段音频"开头静音"和"结尾静音"的毫秒数。
 *
 * 为什么两头都要量：
 *   - 开头静音决定字幕的**偏移**。BreezeBlue 每条音频开头有 200~300ms 静音，
 *     不把它算进偏移，字幕就会比人声早 0.3 秒出现（观众读到"第二个点"时还没开口）。
 *   - 结尾静音决定字幕能铺到哪。句末的静音不该算进"这句话的时长"，
 *     否则字会被人为拉长，跟人声对不上。
 */
async function measureSilence(file, ffmpeg, opts = {}) {
  const noise = String(opts.noise || '-40dB');
  const minDur = num(opts.minDur, 0.05);
  const r = await run(ffmpeg, [
    '-hide_banner', '-i', file, '-af', `silencedetect=noise=${noise}:d=${minDur}`, '-f', 'null', '-',
  ], 60000);
  const err = String(r.stderr || '');
  const totalMs = (() => {
    const m = /time=(\d+):(\d+):([\d.]+)/.exec(err);
    return m ? Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) : 0;
  })();
  const starts = [...err.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...err.matchAll(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)]
    .map((m) => ({ end: Number(m[1]), dur: Number(m[2]) }));
  let leadMs = 0;
  let tailMs = 0;
  const first = starts.length ? starts[0] : null;
  const firstEnd = ends.length ? ends[0] : null;
  if (first != null && first <= 0.05) leadMs = Math.round(((firstEnd ? firstEnd.end : totalMs / 1000) - first) * 1000);
  const lastStart = starts.length ? starts[starts.length - 1] : null;
  const lastEnd = ends.length ? ends[ends.length - 1].end : null;
  const endSec = lastEnd != null ? lastEnd : totalMs / 1000;
  if (lastStart != null && Math.abs(endSec - totalMs / 1000) < 0.12) {
    tailMs = Math.round((endSec - lastStart) * 1000);
  }
  return { totalMs, leadMs: Math.max(0, leadMs), tailMs: Math.max(0, tailMs) };
}

/**
 * 旁白后期：裁掉两头的静音（语速 ≠1 时才额外做 atempo），原地产出一个新 wav，返回新时长。
 *
 * 为什么默认不再 atempo：用户实测"语速 1.10 反而讲太快了"。BB 接口没有语速参数，
 * 之前用 atempo 提速是纯 ffmpeg 侧的补救；现在 narrationSpeed 回到 1.00，
 * **1.0 时直接跳过 atempo** —— 不做无谓的重采样（16k/24k 源上反复重采样会有轻微毛刺），
 * 只留"裁掉句首 200~300ms / 句尾 200~600ms 静音"这一件真问题。
 *
 * 为什么两头都裁：句首静音会让字幕比人声早出现；
 * 句尾静音会让"说完到切画面"多出半拍 —— 节奏就是这么散掉的。
 * 裁完再量一次首/尾静音，把 leadMs 交给字幕模块当偏移。
 *
 * @returns 与传入 got 同形状的对象（wav/ms/leadMs 换成处理后的），失败原样返回
 */
async function polishSpeech(got, opts = {}) {
  if (!got || !got.wav || !fs.existsSync(got.wav)) return got;
  const o = opts || {};
  const log = typeof o.log === 'function' ? o.log : () => { };
  const speed = clamp(num(o.speed, 1.0), 0.9, 1.5);
  // 1.0（含 0.995~1.005 的浮点抖动）不重采样：atempo=1.000 也会走一遍滤镜链，白掉音质
  const useAtempo = Math.abs(speed - 1) >= 0.005;
  const trimDb = String(o.trimThreshold || '-45dB');
  const trimKeep = clamp(num(o.trimKeep, 0.03), 0, 0.2);
  const text = String((o.scene && o.scene.narration) || '');
  const voice = String(o.voice || '');
  const cdir = o.cdir;
  if (!cdir) return got;
  const originalMs = num(got.ms, 0) || wavMs(safeRead(got.wav)) || 0;
  if (!(originalMs > 0)) return got;

  const fast = useAtempo ? speed : 1;
  const out = path.join(cdir, `pol-${sha1(`${text}|${voice}|${fast.toFixed(3)}|${trimDb}|${trimKeep}`, 16)}.wav`);
  const measure = async (file) => {
    if (typeof o.measureMs === 'function') {
      const ms = await o.measureMs(file);
      if (ms > 0) return ms;
    }
    return wavMs(safeRead(file));
  };

  if (fs.existsSync(out) && fs.statSync(out).size > 1000) {
    const ms = await measure(out);
    if (ms > 200) {
      const sil = await measureSilence(out, o.ffmpeg).catch(() => ({ leadMs: 0, tailMs: 0 }));
      // 命中缓存：不再跑 ffmpeg 合成，但日志照样打（排查"这一场为什么这么快"时要能看见）
      const shrink = num(got.ms, 0) > 0 ? (1 - ms / got.ms) * 100 : 0;
      log(`scene#${o.index == null ? '?' : o.index} 旁白复用后期（${useAtempo ? `语速 ${fast}` : '不加速，只裁静音'}）：${Math.round(got.ms)}ms -> ${ms}ms（${shrink.toFixed(1)}%）`);
      return Object.assign({}, got, {
        wav: out, ms, speed: fast, originalMs: num(got.ms, 0),
        tailTrimmedMs: Math.round(num(got.ms, 0) / fast - ms),
        leadMs: sil.leadMs || 0, tailMs: sil.tailMs || 0,
      });
    }
  }

  // 顺序很关键：先 atempo（如果语速确实变了），再倒放裁掉"句尾静音"，倒回来，最后裁掉"句首静音"。
  // 两头都裁的理由：句首静音会让字幕比人声早出现（200~300ms 的空等），
  // 句尾静音会让"说完到切画面"多出半拍。start_silence 各留 30ms，
  // 一刀切到最后一个采样点会听着像被掐断。
  const trimFilters = [
    'areverse',
    `silenceremove=start_periods=1:start_duration=0:start_threshold=${trimDb}:start_silence=${trimKeep}`,
    'areverse',
    `silenceremove=start_periods=1:start_duration=0:start_threshold=${trimDb}:start_silence=${trimKeep}`,
  ];
  const filters = (useAtempo ? [`atempo=${fast.toFixed(3)}`] : []).concat(trimFilters).join(',');
  const r = await run(o.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', got.wav, '-filter:a', filters, '-acodec', 'pcm_s16le', out,
  ], 120000);
  if (r.code !== 0 || !fs.existsSync(out)) {
    log(`scene#${o.index == null ? '?' : o.index} 旁白后期失败，保持原速原长（不影响出片）：${String(r.stderr || '').slice(-160)}`);
    return got;
  }
  const ms = await measure(out);
  if (!(ms > 200)) {
    log(`scene#${o.index == null ? '?' : o.index} 旁白后期把音频裁没了（${ms}ms），保持原样`);
    try { fs.unlinkSync(out); } catch { }
    return got;
  }
  const afterAtempo = useAtempo ? Math.round(originalMs / fast) : originalMs;
  const sil = await measureSilence(out, o.ffmpeg).catch(() => ({ leadMs: 0, tailMs: 0 }));
  log(`scene#${o.index == null ? '?' : o.index} 旁白 ${originalMs}ms -> `
    + (useAtempo ? `atempo ${fast} 后 ${afterAtempo}ms -> ` : '不加速（语速 1.0，跳过 atempo）-> ')
    + `两头裁剪后 ${ms}ms（总缩短 ${((1 - ms / originalMs) * 100).toFixed(1)}%，`
    + `尾静音 ${Math.max(0, afterAtempo - ms - (sil.leadMs || 0))}ms，`
    + `首静音 ${sil.leadMs || 0}ms 已裁）`);
  return Object.assign({}, got, {
    wav: out, ms, speed: fast, originalMs,
    atempoMs: afterAtempo,
    atempoApplied: useAtempo,
    tailTrimmedMs: Math.max(0, afterAtempo - ms - (sil.leadMs || 0)),
    leadMs: sil.leadMs || 0,
    tailMs: sil.tailMs || 0,
  });
}

function safeRead(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}

// ------------------------------------------------------ 3) 渲染画质档 ----

const QUALITY_MAP = {
  high: { quality: '-qh', label: 'high', scale: 1 },
  medium: { quality: '-qm', label: 'medium', scale: 1 },
  low: { quality: '-ql', label: 'low', scale: 0.5 },
};

/**
 * renderQuality → manim 的 -q 档 + 实际渲染分辨率。
 *
 * 为什么 low 还要把分辨率砍半：manim 的 -ql 本身只是"默认 854x480 / 15fps"，
 * 而 renderManim 会显式传 `-r W,H --fps F` 把它覆盖掉 —— 于是 -ql 和 -qm **渲出来一模一样快**，
 * 白亏一个档位。草稿档必须真的少画 3/4 的像素（960x540），最后 normalizeClip 再放大回 1080p。
 *
 * renderQuality 没配时退回老的 manimQuality（保持旧行为，别人的配置不受影响）。
 */
function qualityPlan({ renderQuality, manimQuality, w, h, fps } = {}) {
  const level = String(renderQuality || '').toLowerCase();
  const hit = QUALITY_MAP[level];
  const baseW = Math.max(64, num(w, 1920));
  const baseH = Math.max(64, num(h, 1080));
  const baseFps = Math.max(1, num(fps, 30));
  if (!hit) {
    return {
      quality: String(manimQuality || '-qm'), level: 'legacy',
      w: baseW, h: baseH, fps: baseFps, scale: 1, draft: false,
    };
  }
  const scale = hit.scale;
  // 宽高取偶数：libx264 / yuv420p 要求偶数，奇数会直接报错
  const even = (v) => Math.max(64, Math.round(v / 2) * 2);
  return {
    quality: hit.quality, level: hit.label,
    w: scale === 1 ? baseW : even(baseW * scale),
    h: scale === 1 ? baseH : even(baseH * scale),
    fps: baseFps,
    scale, draft: scale < 1,
  };
}

// ------------------------------------------- 4) manim 动画时长对齐旁白 ----

const RE_RUN_TIME = /run_time\s*=\s*([0-9]*\.?[0-9]+)/g;
const RE_WAIT = /self\.wait\(\s*([0-9]*\.?[0-9]+)?\s*\)/g;
const RE_PLAY = /self\.play\(/g;

/**
 * 估一段 manim 脚本演多久（秒）。不执行代码，只数数：
 *   总时长 = Σ run_time + Σ self.wait(x) + 没有 run_time 的 self.play 按 1.0 秒计
 * manim 的默认 run_time 就是 1.0，所以这个估算和实际渲染出来的时长通常差 <0.1 秒。
 */
function estimateCodeSeconds(code) {
  const s = String(code || '');
  let total = 0;
  let runTimes = 0;
  let m;
  RE_RUN_TIME.lastIndex = 0;
  while ((m = RE_RUN_TIME.exec(s))) { total += num(m[1], 0); runTimes += 1; }
  RE_WAIT.lastIndex = 0;
  while ((m = RE_WAIT.exec(s))) { total += m[1] == null ? 1.0 : num(m[1], 0); }
  const plays = (s.match(RE_PLAY) || []).length;
  // 每个 self.play 若带了自己的 run_time(s)，上面已经计过；剩下的按 manim 默认 1.0 计
  total += Math.max(0, plays - runTimes) * 1.0;
  return Math.round(total * 1000) / 1000;
}

function scaleNumbers(code, k) {
  const round = (v) => {
    const out = Math.round(v * k * 1000) / 1000;
    return Number.isFinite(out) && out > 0.01 ? String(out) : '0.01';
  };
  let out = String(code).replace(RE_RUN_TIME, (all, v) => `run_time=${round(num(v, 1))}`);
  out = out.replace(RE_WAIT, (all, v) => `self.wait(${round(v == null ? 1.0 : num(v, 1))})`);
  return out;
}

/**
 * 把 manim 脚本的动画总时长对齐到 targetSeconds（= 这一场的秒数）。
 *
 * 策略（按观感优先）：
 *   - 脚本太短（T < target）：优先**拉伸**动画（run_time × k，k ≤ 2.0）——
 *     慢一点比"演完了画面冻结 3 秒"好看得多；拉伸完还差的部分用结尾 self.wait 补。
 *   - 脚本太长（T > target）：压缩，但**不低于 floor（默认 0.85，最多快 15%）**。
 *     0.5 倍那版会被用户看出来"抢"：6 秒动画压成 3 秒就是快进。
 *     触发下限后不再更狠地压，超出的部分交给 normalizeClip 截（同时 repadPlan 已经把
 *     场时长按"自然时长 × 0.85"兜过底，正常情况到不了这一步）。
 *   - target 不可信（≤0.5 秒）或脚本没动画：原样返回。
 *
 * 只改 run_time= 和 self.wait(...) 里的数字，**不动结构**：
 * 这样 style 注入、安全闸门、失败后"把报错贴回模型修一次"那条路都照旧。
 *
 * @returns {code, before, after, action, factor, floorHit}
 */
function alignManimCode(code, targetSeconds, compressFloor) {
  const src = String(code || '');
  const target = num(targetSeconds, 0);
  const floor = clamp(num(compressFloor, ANIM_COMPRESS_FLOOR), 0.5, 1);
  const before = estimateCodeSeconds(src);
  if (!src.trim() || !(target > 0.5) || !(before > 0.05)) {
    return { code: src, before, after: before, action: 'skip', factor: 1, floorHit: false };
  }
  const diff = target - before;
  if (Math.abs(diff) < 0.12) {
    return { code: src, before, after: before, action: 'none', factor: 1, floorHit: false };
  }

  if (diff > 0) {
    // 太短：拉伸动画（最多 2 倍），剩下的用结尾 wait 补
    const k = Math.min(ANIM_STRETCH_CAP, target / before);
    let out = k > 1.02 ? scaleNumbers(src, k) : src;
    const afterStretch = estimateCodeSeconds(out);
    const rest = Math.round((target - afterStretch) * 1000) / 1000;
    if (rest > 0.1) {
      const lastWait = /self\.wait\(\s*[0-9]*\.?[0-9]+\s*\)(?![\s\S]*self\.wait\()/.exec(out);
      if (lastWait) {
        const cur = num(/self\.wait\(\s*([0-9]*\.?[0-9]+)/.exec(lastWait[0])[1], 0);
        out = out.replace(lastWait[0], `self.wait(${Math.round((cur + rest) * 1000) / 1000})`);
      } else {
        // 追加在 construct 末尾（缩进 8 空格 = construct 体内）；文件末尾补换行
        out = `${out.replace(/\s*$/, '')}\n        self.wait(${rest})\n`;
      }
    }
    return {
      code: out, before, after: estimateCodeSeconds(out),
      action: rest > 0.1 ? (k > 1.02 ? 'stretch+wait' : 'wait') : 'stretch',
      factor: k, floorHit: false,
    };
  }

  // 太长：压缩，但不低于 floor（默认 0.85，最多快 15%）
  const want = target / before;
  const k = Math.max(floor, want);
  const out = scaleNumbers(src, k);
  return {
    code: out, before, after: estimateCodeSeconds(out), action: 'compress', factor: k,
    // floorHit=true 说明"按 0.85 压完还是比这一场长"，多出来的会被 normalizeClip 截掉。
    // 0.01 的容差：场时长本来就是按 自然×0.85 算出来的，四舍五入后 want 可能差 1e-3，
    // 那不是"压不动"，是浮点噪声 —— 误报会让人以为每场都被截掉一截。
    floorHit: want < floor - 0.01,
  };
}

module.exports = {
  wavMs,
  repadPlan,
  polishSpeech,
  measureSilence,
  qualityPlan,
  QUALITY_MAP,
  estimateCodeSeconds,
  alignManimCode,
  scaleNumbers,
  clamp,
  ANIM_COMPRESS_FLOOR,
  ANIM_STRETCH_CAP,
};
