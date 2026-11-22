'use strict';
/**
 * render.js -- 场级渲染池。
 *
 * 一场的完整流水线：
 *   配音（串行，先全部备好）
 *   → 画面（manim / 文字卡 / 表情卡，场级并发 ≤2）
 *   → 节奏（场时长 = clamp(max(计划秒数, 旁白+停留, 自然时长×0.85), 下限, 上限)）
 *   → 表情（从 at 起循环到本场结束；表情卡是 at=0 / 居中 / scale 0.55）
 *   → 边框（只给 manim/文字卡/表情卡）
 *   → 字幕（烧进画面）
 *   → 混音
 * 结果按原下标回填；每场独立临时目录，互不覆盖。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const M = require('./manim');
const T = require('./textcard');
const A = require('./audio');
const St = require('./stickers');
const SC = require('./stickercard');
const F = require('./frame');
const Sub = require('./subtitles');
const C = require('./cache');

const RENDER_CONCURRENCY_MAX = 2;
const FREE_MIN_MB = 1200;

/** 并发上限 2；自由内存低于阈值就降级串行。 */
function effectiveConcurrency(cfg, log) {
  const want = Math.floor(Number(cfg.renderConcurrency) || 2);
  const cap = Math.max(1, Math.min(RENDER_CONCURRENCY_MAX, want));
  const freeMb = Math.round(os.freemem() / 1048576);
  const needMb = Math.max(1, Number(cfg.renderFreeMemMinMb) || FREE_MIN_MB);
  if (cap <= 1) return { limit: 1, freeMb, needMb, reason: `串行渲染（renderConcurrency=${want}）` };
  if (freeMb < needMb) {
    const r = { limit: 1, freeMb, needMb, degraded: true, reason: `可用内存 ${freeMb}MB < ${needMb}MB，本轮串行渲染` };
    if (log) log(r.reason);
    return r;
  }
  return { limit: cap, freeMb, needMb, reason: `渲染并发 ${cap}（可用内存 ${freeMb}MB ≥ ${needMb}MB）` };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function cleanWork(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 占用中就下次再说 */ }
}

function visualKey({ scene, engine, styleKey, cfg }) {
  const visual = engine === 'manim'
    ? (scene.manim && scene.manim.code) || ''
    : engine === 'sticker'
      ? `sticker:${(scene.stickers && scene.stickers[0] && scene.stickers[0].id) || ''}`
      : String(scene.text || '');
  return C.sha1(JSON.stringify([
    // enh-5：白底 + 布局助手 + 标题去重都改变了成片，旧片段缓存必须整体失效
    'visual-v4', 'enh-5', engine,
    visual,
    String(scene.hint || ''),
    String(scene.text || ''),
    // 标题是否重复决定这一场有没有标题，必须进键（两场同标题时不能命中上一场的片段）
    scene.titleRepeat ? 'title-repeat' : 'title-show',
    styleKey,
    Number(scene.seconds) || 0,
    String(scene.image || ''),
    Number(cfg.width), Number(cfg.height), Number(cfg.fps),
  ]), 24);
}

/**
 * 表情签名：id/位置/时间 + GIF 文件的 mtime。
 * mtime 进来是因为 stickerDuration 只做"一轮时长参考"：GIF 换了 → 自然时长变 → speed 变，
 * 片段缓存必须跟着失效（转码缓存键里已经有 speed）。
 */
function stickerSig(scene, cfg) {
  return (Array.isArray(scene.stickers) ? scene.stickers : []).map((s) => {
    let mtime = 0;
    const f = St.resolveFile(s.id, cfg);
    try { if (f) mtime = Math.round(fs.statSync(f).mtimeMs); } catch { /* 文件不可读就按 0 */ }
    return [s.id, s.at, s.duration, s.x, s.y, s.scale, mtime];
  });
}

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function clipKey({ vKey, audioK, scene, style, cfg, frameSig, subSig }) {
  return C.sha1(JSON.stringify([
    // clip-v4：白底配色 + 标题去重（comp-5）改变了片段内容，旧片段缓存整体失效
    'clip-v4', 'comp-5', vKey, audioK || 'silent',
    JSON.stringify(stickerSig(scene, cfg)),
    style.id, frameSig, subSig,
    // 这两个参数会改变片段本身：停留影响场时长，表情一轮影响循环素材的播放速度
    num(cfg.scenePadding, 0.6), num(cfg.stickerDuration, 2),
    Number(cfg.width), Number(cfg.height), Number(cfg.fps),
  ]), 24);
}

/**
 * 拼一条 ffmpeg 命令：缩放/补边/节奏/表情/边框/字幕/混音一次完成。
 * 返回 { ok, file, error, cues, seconds }。
 */
async function composeScene({
  scene, style, cfg, cache, work, index, rawFile, naturalSeconds,
  audioResult, engine, status, note, log,
}) {
  const W = Number(cfg.width) || 1920;
  const H = Number(cfg.height) || 1080;
  const fps = Number(cfg.fps) || 30;
  const target = A.sceneSeconds({
    planned: scene.seconds,
    narrationSeconds: audioResult ? audioResult.duration : 0,
    naturalSeconds,
    cfg,
  });
  const cues = Sub.buildSceneCues(scene.narration, Math.min(target, audioResult ? Math.max(0.5, audioResult.duration) : target), cfg);
  const srtFile = path.join(work, 'subs.srt');
  const subOn = Boolean(cfg.subtitles && cfg.subtitles.enabled) && cues.length > 0;
  if (subOn) fs.writeFileSync(srtFile, Sub.toSrt(cues, 0), 'utf8');

  // 表情卡：这一场唯一的表情放大到 0.55、at=0 居中循环；x/y=0.5 在 prepare 的
  // x*(W-tw) / y*(H-th) 坐标下正好是屏幕正中（底边字幕带不参与，居中不受影响）。
  const stickerList = engine === 'sticker'
    ? (Array.isArray(scene.stickers) ? scene.stickers.slice(0, 1).map((s) => ({
      ...s, at: 0, x: 0.5, y: 0.5, scale: SC.STICKER_CARD_SCALE,
    })) : [])
    : scene.stickers;
  const prep = await St.prepare({
    stickers: stickerList,
    sceneSeconds: target,
    cfg,
    cache,
    work,
    index,
    baseLabel: 'vbase',
    inputStart: 2,
    log,
  });

  const filters = [];
  const natural = Math.max(0.1, Number(naturalSeconds) || 0.1);
  let rate = '';
  let freeze = 0;
  if (natural > target + 0.01) {
    // 压缩：target 已经 >= natural×0.85，所以最多加速 1.17 倍
    const speed = natural / target;
    rate = `setpts=PTS/${speed.toFixed(5)}`;
  } else if (target > natural + 0.01) {
    // 拉伸最多 2 倍，剩下停末帧
    const slow = Math.min(Number(cfg.animStretchCeil) || 2, target / natural);
    rate = `setpts=PTS*${slow.toFixed(5)}`;
    freeze = Math.max(0, target - natural * slow);
  }
  const baseChain = [
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `fps=${fps}`,
    'format=yuv420p',
  ];
  if (rate) baseChain.push(rate);
  if (freeze > 0.04) baseChain.push(`tpad=stop_mode=clone:stop_duration=${freeze.toFixed(3)}`);
  baseChain.push(`trim=duration=${target.toFixed(3)}`, 'setpts=PTS-STARTPTS');
  filters.push(`${baseChain.join(',')}[vbase]`);

  let label = 'vbase';
  if (prep.changed) {
    filters.push(...prep.filters);
    label = prep.outLabel;
  }

  const frameChain = F.filterChain(cfg.frame, engine, scene);
  if (frameChain) {
    filters.push(`[${label}]${frameChain}[vframe]`);
    label = 'vframe';
  }
  if (subOn) {
    const fsStyle = Sub.forceStyle(cfg.subtitles, H);
    filters.push(`[${label}]subtitles=subs.srt:force_style='${fsStyle}'[vsub]`);
    label = 'vsub';
  }
  // 音频统一重采样到 44.1k 立体声，保证 concat -c copy 能直接拼
  filters.push('[1:a]apad,atrim=duration=' + target.toFixed(3) + ',asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]');

  const out = path.join(work, `scene-${index}.mp4`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', rawFile];
  if (audioResult && audioResult.file) args.push('-i', audioResult.file);
  else args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
  // 表情输入永远循环：-stream_loop -1 让 webm 从头接上，配合 overlay 的 enable 从 at 一直播到本场结束
  for (const f of prep.inputs) {
    const file = typeof f === 'string' ? f : f.file;
    if (typeof f === 'object' && f.loop) args.push('-stream_loop', '-1');
    args.push('-c:v', 'libvpx-vp9', '-i', file);
  }
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', `[${label}]`, '-map', '[aout]',
    '-t', target.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart', out,
  );

  const started = Date.now();
  const r = await M.run(cfg.ffmpeg, args, 600000, { cwd: work });
  const composeMs = Date.now() - started;
  if (r.code !== 0 || !fs.existsSync(out)) {
    return {
      ok: false,
      error: `COMPOSE_FAILED: ${String(r.err || '').slice(-500)}`,
      seconds: target, cues, engine, status: 'failed', note,
    };
  }
  return {
    ok: true, file: out, seconds: target, cues, composeMs,
    engine, status, note, stickerApplied: prep.applied.length,
    stickerSkipped: prep.skipped,
  };
}

/**
 * 渲染一场（含缓存命中）。
 * 返回 { ok, file, seconds, cues, engine, status, note, cached }。
 */
async function renderOne({ scene, index, style, voice, cfg, cache, row, ctx, warn }) {
  const log = (m) => ctx.log(`scene#${index} ${m}`);
  let engine = scene.tool === 'text' ? 'text' : scene.tool === 'sticker' ? 'sticker' : 'manim';
  let status = 'ready';
  let note = '';
  // 表情卡没有表情 → 降级文字卡（plan 阶段已判过一次，这里是直接提交分镜时的兜底）
  if (engine === 'sticker' && !(Array.isArray(scene.stickers) && scene.stickers.length)) {
    engine = 'text';
    status = 'degraded';
    note = '表情卡没有表情，降级文字卡';
    log(note);
    if (warn) warn(`第 ${index + 1} 场：${note}`);
  }
  const skey = require('./plan').styleKey(style);
  const frameSig = F.signature(cfg.frame);
  const subSig = C.sha1(JSON.stringify([cfg.subtitles]), 12);
  const vKey = visualKey({ scene, engine, styleKey: skey, cfg });
  // 音频键必须和 ensureSpeech 算的一致（含音高），否则改 voicePitch 会命中旧片段
  const audioK = scene.narration ? A.audioKey(scene.narration, voice, cfg.narrationSpeed, cfg.voicePitch) : 'silent';
  const cKey = clipKey({ vKey, audioK, scene, style, cfg, frameSig, subSig });

  // 先看画面片段缓存：命中连 manim/ffmpeg 都不用起
  const hit = cache.getClip(cKey);
  if (hit) {
    log(`命中画面片段缓存（${cKey}，${hit.seconds}s，${hit.engine}）`);
    return {
      ok: true, file: hit.file, seconds: hit.seconds, cues: hit.cues || [],
      engine: hit.engine || engine, status: hit.status || 'ready',
      note: hit.note || '', cached: true, ms: 0,
    };
  }

  const work = path.join(ctx.workDir, `s${index}`);
  fs.mkdirSync(work, { recursive: true });
  const started = Date.now();
  let visual = null;

  if (engine === 'text') {
    log('文字卡渲染中');
    visual = await T.renderTextCard({ scene, style, cfg, work, index, log });
    if (!visual.ok) {
      return { ok: false, error: visual.error, status: 'failed', note: visual.error, engine, ms: Date.now() - started };
    }
  } else if (engine === 'sticker') {
    log(`表情卡渲染中（表情 ${scene.stickers[0].id} 居中循环，不调用 manim）`);
    visual = await SC.renderStickerCard({ scene, style, cfg, work, index, log });
    if (!visual.ok) {
      // 表情卡失败也不整场作废：降级文字卡，记一条警告
      status = 'degraded';
      note = `表情卡失败降级文字卡：${String(visual.error || '').slice(0, 160)}`;
      log(note);
      if (warn) warn(`第 ${index + 1} 场：${note}`);
      visual = await T.renderTextCard({ scene, style, cfg, work, index, log });
      if (!visual.ok) {
        return { ok: false, error: visual.error, status: 'failed', note, engine: 'text', ms: Date.now() - started };
      }
    }
  } else {
    const code = scene.manim && scene.manim.code;
    // 手改代码：渲染失败时既不贴错误让模型改（会改掉用户的结构），也不降级文字卡
    const lockedCode = Boolean(scene.manim && scene.manim.locked && code);
    if (!code) {
      status = 'degraded';
      note = 'manim 没有代码，降级文字卡';
      log(note);
      if (warn) warn(`第 ${index + 1} 场：${note}`);
      visual = await T.renderTextCard({ scene, style, cfg, work, index, log });
      if (!visual.ok) return { ok: false, error: visual.error, status: 'failed', note, engine: 'text', ms: Date.now() - started };
    } else {
      const enhanced = M.enhanceCode(code, scene, style, cfg, { locked: lockedCode });
      if (enhanced.notes.length) log(`代码增强：${enhanced.notes.join('，')}`);
      if (scene.titleRepeat && !lockedCode) log('标题与上一场相同，跳过标题动画');
      // 静态 lint（第二层）：只记警告，不阻塞渲染
      const lint = M.lintManim(enhanced.code, scene);
      if (lint.fatal) log(`布局 lint 无法解析代码（${lint.fatal}），继续渲染`);
      for (const w of lint.warnings) {
        log(`布局 lint：${w}`);
        if (warn) warn(`第 ${index + 1} 场布局：${w}`);
      }
      const budgetSeconds = Math.max(Number(scene.seconds) || 4, Number(row.audioDuration) + 0.6);
      log('manim 渲染中');
      let mr = await M.renderManim({
        cfg, work, index, code: enhanced.code, sceneName: scene.manim.scene,
        seconds: budgetSeconds, log,
      });
      // 第三层：渲染时的几何自检（LAYOUT_OVERLAP）——只报告，不降级
      if (mr.ok && Array.isArray(mr.layout) && mr.layout.length) {
        log(`布局自检：${mr.layout.length} 处文字压线`);
        if (warn) warn(`第 ${index + 1} 场布局自检：${mr.layout.length} 处文字压线（${mr.layout.slice(0, 3).join('；')}）`);
      }
      if (!mr.ok && ctx.repair && !lockedCode) {
        log(`manim 失败（${mr.error}）：${String(mr.detail || '').slice(-400)}`);
        log('贴错误让模型修一次');
        const fixed = await ctx.repair({
          scene, style, code: enhanced.code, detail: mr.detail || mr.error, cfg, index,
        });
        if (fixed) {
          const one = await M.renderManim({
            cfg, work, index, code: M.enhanceCode(fixed.code, scene, style, cfg).code,
            sceneName: fixed.scene, seconds: budgetSeconds, log,
          });
          if (one.ok) {
            mr = one;
            note = 'manim 失败后自愈成功';
            log(note);
          } else {
            log(`自愈后仍失败：${one.error}`);
          }
        }
      }
      if (!mr.ok) {
        if (lockedCode) {
          // 手改代码失败：整条任务失败，把 stderr 尾部原样留给用户看，不降级
          const rawTail = String(mr.detail || mr.error || '').slice(-1200);
          const noteText = `手改代码渲染失败（${mr.error}）：${rawTail}`;
          log(`手改代码渲染失败，不降级、不自愈：${String(mr.detail || mr.error || '').slice(-300)}`);
          if (warn) warn(`第 ${index + 1} 场手改代码渲染失败（${mr.error}）`);
          return {
            ok: false,
            error: `手改代码渲染失败（第 ${index + 1} 场，${mr.error}）`,
            status: 'failed',
            note: noteText.slice(0, 2400),
            engine,
            lockedFailed: true,
            ms: Date.now() - started,
          };
        }
        status = 'degraded';
        note = `manim 失败降级文字卡：${String(mr.error || '').slice(0, 160)}`;
        log(note);
        if (warn) warn(`第 ${index + 1} 场：${note}`);
        visual = await T.renderTextCard({ scene, style, cfg, work, index, log });
        if (!visual.ok) {
          return { ok: false, error: visual.error, status: 'failed', note, engine: 'text', ms: Date.now() - started };
        }
      } else {
        visual = { ok: true, file: mr.file, naturalSeconds: mr.naturalSeconds, engine: 'manim', ms: mr.ms };
        note = note || 'manim';
      }
    }
  }

  const audioResult = row.audio;
  const composed = await composeScene({
    scene, style, cfg, cache, work, index,
    rawFile: visual.file,
    naturalSeconds: visual.naturalSeconds,
    audioResult,
    engine: visual.engine || engine,
    status, note, log,
  });
  const ms = Date.now() - started;
  if (!composed.ok) {
    log(`合成失败：${composed.error}`);
    return { ...composed, ok: false, engine, ms };
  }
  // 只有完全成功的片段才进缓存；降级片段不缓存，下次 redo 可以再试
  if (composed.status === 'ready') {
    cache.setClip(cKey, {
      seconds: composed.seconds,
      cues: composed.cues,
      engine: composed.engine,
      status: composed.status,
      note: composed.note,
      narrationMs: Math.round((audioResult ? audioResult.duration : 0) * 1000),
      at: new Date().toISOString(),
    }, composed.file);
    log(`画面片段已缓存（${cKey}，${composed.seconds}s，合成 ${composed.composeMs}ms）`);
  } else {
    log(`降级片段不入缓存（status=${composed.status}）`);
  }
  if (composed.stickerApplied) log(`表情叠加 ${composed.stickerApplied} 个`);
  if (composed.stickerSkipped && composed.stickerSkipped.length) {
    log(`表情跳过：${composed.stickerSkipped.map((x) => `${x.id}（${x.reason}）`).join('，')}`);
  }
  return {
    ok: true, file: composed.file, seconds: composed.seconds, cues: composed.cues,
    engine: composed.engine, status: composed.status, note: composed.note,
    cached: false, ms,
  };
}

/**
 * 渲染全部场次。
 * onProgress({ phase, done, total, label }) 由 server 转成任务字段。
 * 返回 { ok, entries, warnings, error }。
 */
async function renderScenes({ scenes, style, voice, cfg, cache, job, ctx, onProgress }) {
  const warnings = Array.isArray(job.warnings) ? job.warnings : [];
  // 同一条警告（plan 阶段的 lint 与这里的 lint 可能重复）只留一份
  const warn = (m) => { if (!warnings.includes(m)) warnings.push(m); };
  const total = scenes.length;
  const workDir = path.join(ctx.workDir, job.id);
  fs.mkdirSync(workDir, { recursive: true });

  // 1) 配音：串行，单句 150s；任何一句失败都按"整集失败"处理
  const rows = [];
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    if (onProgress) onProgress({ phase: 'voice', done: i, total, label: `配音 ${i + 1}/${total}` });
    let audio;
    try {
      audio = await A.ensureSpeech({ scene, voice, cfg, cache, log: (m) => ctx.log(`scene#${i} ${m}`) });
    } catch (err) {
      const msg = `VOICE_UNAVAILABLE: ${String((err && err.message) || err)}（第 ${i + 1} 场）`;
      scene.status = 'failed';
      scene.note = msg.slice(0, 300);
      return { ok: false, error: msg, warnings, entries: [] };
    }
    if (!audio.ok) {
      const msg = `${String(audio.error || 'VOICE_UNAVAILABLE')}（第 ${i + 1} 场）`;
      scene.status = 'failed';
      scene.note = msg.slice(0, 300);
      ctx.log(`scene#${i} 配音失败：${msg}`);
      return { ok: false, error: msg, warnings, entries: [] };
    }
    rows.push({ index: i, scene, audio, audioDuration: audio.duration || 0 });
    ctx.log(`scene#${i} 配音${audio.cached ? '命中缓存' : '完成'} ${(audio.duration || 0).toFixed(2)}s`);
  }

  // 2) 画面：场级并发 2（内存不足自动串行）
  const conc = effectiveConcurrency(cfg, ctx.log);
  ctx.log(conc.reason);
  let done = 0;
  const entries = await mapLimit(rows, conc.limit, async (row) => {
    const i = row.index;
    if (onProgress) {
      onProgress({ phase: 'render', done, total, label: `第 ${i + 1}/${total} 场渲染中（${row.scene.tool}）` });
    }
    let r;
    try {
      r = await renderOne({
        scene: row.scene, index: i, style, voice, cfg, cache, row,
        ctx: { ...ctx, workDir }, warn,
      });
    } catch (err) {
      r = { ok: false, error: String((err && err.message) || err), status: 'failed' };
    }
    done += 1;
    if (onProgress) onProgress({ phase: 'render', done, total, label: `已完成 ${done}/${total} 场` });
    if (!r.ok) {
      row.scene.status = 'failed';
      // 手改代码失败：note 里放 stderr 尾部，面板/任务页直接看得到错在哪一行
      row.scene.note = String(r.note || r.error || '渲染失败').slice(0, 2400);
      ctx.log(`scene#${i} 渲染失败：${r.error}`);
      warn(`第 ${i + 1} 场渲染失败：${String(r.error || '').slice(0, 160)}`);
      return { index: i, ok: false, ...r };
    }
    ctx.log(`scene#${i} 完成 ${r.engine}${r.status === 'degraded' ? '（降级）' : ''} ${Number(r.seconds).toFixed(2)}s${r.cached ? '（缓存）' : `（${(r.ms / 1000).toFixed(1)}s）`}`);
    row.scene.status = r.status;
    row.scene.note = r.note || '';
    return { index: i, ok: true, ...r };
  });

  const out = entries.filter((e) => e && e.ok).sort((a, b) => a.index - b.index);
  // 手改代码挂了：整条任务算失败（用户改的代码，失败就该让他看到错，不跳过、不降级）
  const lockedFail = entries.find((e) => e && !e.ok && e.lockedFailed);
  if (lockedFail) {
    return {
      ok: false,
      error: String(lockedFail.error || 'LOCKED_CODE_FAILED'),
      warnings,
      entries: [],
    };
  }
  if (!out.length) {
    return { ok: false, error: 'ALL_SCENES_FAILED', warnings, entries: [] };
  }
  if (out.length < scenes.length) {
    warn(`有 ${scenes.length - out.length} 场没有画面，已跳过`);
  }
  return { ok: true, entries: out, warnings, workDir };
}

/** 拼集：所有场片段编码参数一致，直接 -c copy。 */
async function concatScenes({ entries, outFile, cfg, log }) {
  if (!entries.length) return { ok: false, error: 'NO_CLIPS' };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  if (entries.length === 1) {
    fs.copyFileSync(entries[0].file, outFile);
    return { ok: true, file: outFile, ms: 0 };
  }
  const list = path.join(path.dirname(outFile), 'concat.txt');
  const lines = entries.map((e) => `file '${String(e.file).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(list, lines.join('\n') + '\n', 'utf8');
  const started = Date.now();
  const r = await M.run(cfg.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', list,
    '-c', 'copy', '-movflags', '+faststart', outFile,
  ], 600000);
  const ms = Date.now() - started;
  if (r.code !== 0 || !fs.existsSync(outFile)) {
    if (log) log(`-c copy 拼接失败，改重编码：${String(r.err || '').slice(-200)}`);
    const r2 = await M.run(cfg.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', list,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
      '-movflags', '+faststart', outFile,
    ], 600000);
    if (r2.code !== 0) return { ok: false, error: `CONCAT_FAILED: ${String(r2.err || r.err || '').slice(-300)}` };
  }
  try { fs.rmSync(list, { force: true }); } catch { /* 忽略 */ }
  return { ok: true, file: outFile, ms: Date.now() - started };
}

module.exports = {
  renderScenes, renderOne, composeScene, concatScenes,
  effectiveConcurrency, visualKey, clipKey, cleanWork,
};
