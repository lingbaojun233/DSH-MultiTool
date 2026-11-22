'use strict';
/**
 * plan.js -- 三种输入 → 规范化分镜。
 *
 *   topic  → 让模型写分镜骨架（3~4 场 / 30s）
 *   script → 让模型按原话拆场（旁白必须来自稿子）
 *   scenes → 直接规范化；缺 manim 代码的场再逐场生成
 *
 * 引擎：manim / text / sticker（表情卡）。表现优先级 manim > sticker > text；
 * 代码生成是"一次只问一场"，失败只降级这一场。
 *
 * 代码缓存键（cache.js 实现）：text + hint + style + tool。
 * narration 不进键 —— 旁白只走配音/字幕，不进画面。
 */
const fs = require('node:fs');
const path = require('node:path');
const S = require('../schema');
const CacheLib = require('./cache');
const M = require('./manim');
const Stickers = require('./stickers');

const PERSONA_TTL_MS = 60000;
let personaCache = { at: 0, block: '' };

function logOr(ctx, msg) {
  if (ctx && typeof ctx.log === 'function') ctx.log(msg);
}

function styleKey(style) {
  const s = style || {};
  return `${s.id || 'none'}:${CacheLib.sha1(JSON.stringify([
    s.bg, s.fg, s.accent, s.muted, s.accent2, s.line_width, s.font,
  ]), 10)}`;
}

/** 人设 → 风格：显式 style 永远优先；否则按人设关键词投票，默认白板。 */
async function resolveStyle({ requested, cfg, log }) {
  const styles = (cfg && cfg.styles) || {};
  const id = String(requested || '').trim();
  if (id && styles[id]) return { ...styles[id], source: 'request' };
  if (id) logOr({ log }, `未知风格 ${id}，按人设/默认选择`);
  const now = Date.now();
  if (now - personaCache.at > PERSONA_TTL_MS) {
    personaCache = { at: now, block: '' };
    try {
      const res = await fetch(`${String(cfg.personaUrl).replace(/\/+$/, '')}/v1/persona`, {
        signal: AbortSignal.timeout(Number(cfg.personaTimeoutMs) || 6000),
      });
      const data = await res.json().catch(() => null);
      personaCache.block = String((data && (data.block || data.constitution)) || '');
    } catch (err) {
      if (log) log(`人设读取失败（不阻塞出片）：${String((err && err.message) || err)}`);
    }
  }
  const block = personaCache.block;
  const score = {
    'oscilloscope-math': ['数学', '公式', '方程', '函数', '导数', '微积分', '积分', '几何', '物理', '概率', '定理'],
    blueprint: ['工程', '蓝图', '结构', '系统', '代码', '项目', '设计', '架构', '服务器'],
    whiteboard: ['讲解', '科普', '知识', '概念', '课堂', '白板', '听得懂', '复杂'],
  };
  let best = String(cfg.defaultStyle || 'whiteboard');
  let bestN = 0;
  for (const [sid, words] of Object.entries(score)) {
    if (!styles[sid]) continue;
    let n = 0;
    for (const w of words) if (block.includes(w)) n++;
    if (n > bestN) { bestN = n; best = sid; }
  }
  const picked = styles[best] || Object.values(styles)[0] || { id: 'whiteboard', name: '白板讲解', bg: '#f7f5ef', fg: '#23262c', accent: '#2a5cb3' };
  return { ...picked, source: bestN > 0 ? 'persona' : 'default' };
}

/** 只输 JSON 的模型调用；解析失败会把原输出贴回去再要一次。 */
async function askJson(prompt, cfg, log) {
  const call = async (text) => {
    const headers = { 'content-type': 'application/json; charset=utf-8' };
    try {
      const token = fs.readFileSync(String(cfg.internalTokenFile || ''), 'utf8').trim();
      if (token) headers['x-dsh-internal'] = token;
    } catch { /* 没有内部 token 就按无鉴权调用 */ }
    // io 的内部通道要求 x-dsh-user > 0（用户 id 由调用方给出；v2 固定 1）
    headers['x-dsh-user'] = String(Number(cfg.defaultUserId) || 1);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Number(cfg.ioTimeoutMs) || 180000);
    try {
      const res = await fetch(`${String(cfg.ioUrl).replace(/\/+$/, '')}/v1/input`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text, sessionId: 'studio-v2-plan', persona: false }),
        signal: ctrl.signal,
      });
      const textBody = await res.text();
      let data = null;
      try { data = JSON.parse(textBody); } catch { /* 非 JSON */ }
      if (!res.ok || !data || data.ok === false) {
        return { ok: false, error: `IO_FAILED(${res.status})`, detail: String((data && data.error) || textBody).slice(0, 300) };
      }
      return { ok: true, answer: String(data.answer || '') };
    } catch (err) {
      return { ok: false, error: `IO_ERROR(${String((err && err.message) || err)})` };
    } finally {
      clearTimeout(timer);
    }
  };

  const parse = (s) => {
    let t = String(s || '').trim();
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
  };

  const first = await call(prompt);
  if (!first.ok) return { ok: false, error: first.error, detail: first.detail };
  const one = parse(first.answer);
  if (one) return { ok: true, json: one, repaired: false };
  const repair = `${prompt}\n\n你上一次的输出不是合法 JSON（开头如下）：\n${String(first.answer).slice(0, 300)}\n\n现在只输出 JSON，第一个字符必须是 {。`;
  const second = await call(repair);
  if (second.ok) {
    const two = parse(second.answer);
    if (two) return { ok: true, json: two, repaired: true };
  }
  return { ok: false, error: 'PLAN_NOT_JSON', detail: String(first.answer).slice(0, 400) };
}

function sceneCountHint(total) {
  const t = Math.max(1, Number(total) || 30);
  if (t <= 30) return { min: 3, max: 4, per: '每场 7~10 秒' };
  if (t <= 60) return { min: 4, max: 6, per: '每场 8~15 秒' };
  if (t <= 120) return { min: 6, max: 9, per: '每场 10~20 秒' };
  const n = Math.max(8, Math.round(t / 15));
  return { min: Math.max(8, n - 2), max: n + 2, per: '每场 15 秒左右' };
}

function stylePrompt(style) {
  const s = style || {};
  return [
    `## 视觉风格：${s.name || s.id || '白板讲解'}`,
    `- 背景 ${s.bg}；主色 ${s.accent}；字色 ${s.fg}；次要色 ${s.muted}；强调色 ${s.accent2}`,
    `- 线宽 ${s.line_width || 3}；${s.notes || ''}`,
    '- 颜色只从这五个里选，不要自己加色；不要设背景色（渲染器注入）。',
  ].join('\n');
}

function stickerPromptLines(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return [];
  const list = candidates.map((s) => `${s.id}=${s.name}`).join('，');
  return [
    '',
    '## 表情包（可选）',
    '- **每场最多 1 个，整集 1~3 场有表情**；多给的会被裁掉（只留第一个）。',
    '- 情绪点（吐槽/惊讶/结论/自嘲）用普通场的小表情；介绍自己/情绪表达可以整场只用表情。',
    '- 表情卡：这一场 `tool:"sticker"` + 1 个 stickers，不画图，正中放一个大表情（占屏约一半）。',
    // 不写 duration：留给全局 stickerDuration（设置页可调，现在是一轮循环时长的参考）
    '- 普通场的 stickers：[{"id":"<列表里的 id>","at":1.2,"x":0.82,"y":0.12,"scale":0.3}]',
    '- at 放在中后段；x/y 是 0~1，底部 1/5 是字幕带（y 最大 0.68）；scale 0.25~0.38。',
    `- 可用表情：${list}`,
  ];
}

function skeletonPrompt(topic, total, style, candidates) {
  const hint = sceneCountHint(total);
  return [
    '只输出 JSON，第一个字符必须是 {，不要解释。',
    `给这个主题写分镜：${topic}`,
    `总时长约 ${total} 秒。`,
    '{"title":"标题","scenes":[{"text":"这一场标题（≤14字）","narration":"旁白（≤30字，口语）","seconds":8,"tool":"manim","visual":"manim","hint":"这一场画面画什么（一句话，具体到图形/公式/动作）"}]}',
    '',
    '## 引擎有三种：manim / text / sticker（表情卡）',
    '- tool 只能是 manim、text、sticker；**至少 3 场 manim**（前 3 场优先 manim），text 只给开场/转场/一句结论，整集最多 1 场。',
    '- tool:"sticker" 是表情卡：这一场不画图，底色 + 正中一个表情包循环播；介绍自己/情绪表达类场景优先用它。',
    '- **第一场如果是"我是谁 / 自我介绍"这种，直接放一个表情包（tool:"sticker"），不要画角色**。',
    '- 讲到公式、坐标、曲线、变化过程、对比大小的场次必须 manim。',
    '- 不要写 plot / draw / html / aivideo：这些引擎已删除，写了也会被改成文字卡。',
    '',
    `## 拆场`,
    `- 场数 ${hint.min}~${hint.max} 场；${hint.per}；加起来接近 ${total} 秒。`,
    '- 一场只讲一个意思；宁可少几场、每场讲透，不要一场只闪 3 秒。',
    '- narration 是给人听的：口语、一句一个意思，下一场接上一场。',
    '- hint 要写成"别人照着就能画"的一句话：画什么图形、标什么量、做什么动作。',
    '- **hint 里不要写"画一条鲸鱼 / 画大肥鱼本人 / 画一个角色"**：角色由表情包承担。',
    '- 不要出现 markdown、不要解释你的做法。',
    '',
    stylePrompt(style),
    ...stickerPromptLines(candidates),
  ].join('\n');
}

function scriptPrompt(script, total, style, candidates) {
  const hint = sceneCountHint(total);
  return [
    '只输出 JSON，第一个字符必须是 {，不要解释。',
    `把下面这份稿子拆成分镜。总时长约 ${total} 秒，拆 ${hint.min}~${hint.max} 场，${hint.per}。`,
    '{"title":"标题","scenes":[{"text":"这一场的标题（≤14字）","narration":"这一场念的旁白（稿子原话截取，≤40字）","seconds":8,"visual":"manim","hint":"这一场画面画什么（一句话，具体到图形/公式/动作）","tool":"manim"}]}',
    '',
    '## 原话优先（最重要）',
    '- narration 必须是稿子里**出现过的话**：可以删字、截断、调顺序，但不要换说法、不要润色。',
    '- text 从这句原话里抽短标题，≤14 字，不要另起一句。',
    '',
    '## 拆场',
    '- 一场只讲一个意思；宁可少几场、每场讲透。',
    '- 至少 80% 的场次 manim；text 只给开场/转场/一句结论。',
    '- tool:"sticker" 是表情卡：整场不画图、正中一个大表情；开场自我介绍 / 纯情绪的一两句优先用它。',
    '- hint 写成"别人照着就能画"的一句话；**不要写画角色/画大肥鱼**。',
    '- 场数不超过 ' + hint.max + '；加起来接近 ' + total + ' 秒。',
    '- 不要 markdown、不要解释。',
    '',
    stylePrompt(style),
    '',
    '## 稿子',
    String(script || '').slice(0, 6000),
    ...stickerPromptLines(candidates),
  ].join('\n');
}

/** 单场 manim 代码提示词：只画必须精确的示意图/公式，不画角色。 */
function visualPrompt(scene, style, cfg) {
  const hint = String(scene.hint || '').trim();
  const reservePx = Number(cfg.subtitles && cfg.subtitles.reservedPx) || 200;
  const unitPx = (Number(cfg.height) || 1080) / 8;
  const reserveUnits = Math.ceil((reservePx / unitPx) * 10) / 10;
  const head = [
    '只输出 JSON，第一个字符必须是 {，不要解释。',
    `要画这一场：标题「${scene.text}」`,
    `这一场要演 ${Number(scene.seconds) || 8} 秒。`,
    '',
    '输出形状：{"manim":{"scene":"ClassName","code":"from manim import *\\nclass ClassName(Scene):\\n    def construct(self):\\n        ..."}}',
    '',
  ];
  if (hint) {
    head.push(
      '## 用户指定的画面（最高优先级，必须照着画）',
      hint.slice(0, 600),
      '',
      '把这段翻译成 manim 动画：图形、元素、动作、先后顺序都要对上，不要只画个标题糊过去。',
      '如果这段写的是"画一只鲸鱼/画大肥鱼本人/画角色"，角色部分忽略：角色由表情包出场，你只画其余元素。',
      '',
    );
  }
  const body = [
    '## 脚本硬约束（违反会被拒收，直接降级成文字卡）',
    '- 只写 `from manim import *` + 一个 `class <英文类名>(Scene):` 和 `def construct(self):`；manim.scene 必须与类名逐字一致',
    '- import 只允许 manim 和 numpy；其它一律不许',
    '- **禁止**：读写文件、网络、subprocess、open()、eval()、exec()、__import__、Scene.embed',
    '- 代码 ≤60 行，单类，不要 __main__',
    '',
    '## 允许用的东西',
    '- 文字：Text（中文必须 Text("…", font="Microsoft YaHei")）；公式：MathTex（LaTeX 已装）',
    '- **标题必须醒目**：标题 Text 写 font_size=52（不得低于 44）、weight=BOLD，放在顶部 .to_edge(UP, buff=0.5)',
    '- **正文也要能看清**：正文 Text 的 font_size 不低于 32；不要用默认字号摆一大段小字',
    '- 图形：Axes、NumberPlane、Line、Arrow、Dot、Circle、Rectangle、Polygon、SurroundingRectangle、VGroup、NumberLine、axes.plot',
    '- 动作：Write、Create、FadeIn、Transform、ReplacementTransform、GrowArrow、Rotate、Indicate、.animate、VGroup.arrange、self.wait',
    `- **底部 ${reservePx}px（约 ${reserveUnits} 个坐标单位）是字幕带，不许放任何内容**；要贴底写 .to_edge(DOWN, buff=${reserveUnits})`,
    '',
    '## 必须避开的坑',
    '- 坐标轴不要 include_numbers=True；不要用 DecimalNumber / Integer，要数字用 Text 手标',
    '- **MathTex 参数不要再包 $**：写 MathTex(r"\\frac{dy}{dx}")，不要写 MathTex(r"$\\frac{dy}{dx}$")',
    '- 不要设背景色、不要 import 颜色表：背景和配色由渲染器注入',
    '- run_time 加起来贴近本场秒数；结尾 self.wait(0.4) 收住；Axes 的 y_length 不超过 5.0',
    '',
    stylePrompt(style),
  ];
  return head.concat(body).join('\n');
}

/**
 * 决定这一场最终用哪个引擎（auto 在这里收口，其它模块不再判断）。
 * 表情卡要求"tool:'sticker' 且该场有 stickers[0]"；没有表情就降级 text。
 */
function decideTool(scene) {
  const hasSticker = Array.isArray(scene.stickers) && scene.stickers.length > 0;
  if (scene.tool === 'sticker') return hasSticker ? 'sticker' : 'text';
  if (scene.tool === 'manim' || scene.tool === 'text') return scene.tool;
  if (scene.manim && scene.manim.code) return 'manim';
  if (scene.hint) return 'manim';
  if (!scene.text && !scene.narration) return 'text';
  // v2 默认画动画：没有公式线索也先试 manim，失败才降文字卡
  return 'manim';
}

async function generateCode({ scene, style, cfg, cache, ctx, index }) {
  const materials = {
    text: scene.text,
    hint: scene.hint,
    style: styleKey(style),
    tool: 'manim',
  };
  const hit = cache.getCode(materials);
  if (hit) {
    logOr(ctx, `scene#${index} 命中场级代码缓存（${hit.key}）`);
    return { ok: true, code: hit.code, scene: hit.scene || null, cacheHit: true };
  }
  const started = Date.now();
  logOr(ctx, `scene#${index} 生成代码（模型调用）：text="${String(scene.text).slice(0, 20)}" hint="${String(scene.hint).slice(0, 40)}"`);
  const r = await askJson(visualPrompt(scene, style, cfg), cfg, ctx.log);
  const ms = Date.now() - started;
  if (!r.ok) {
    logOr(ctx, `scene#${index} 生成代码失败（${(ms / 1000).toFixed(1)}s）：${r.error} ${String(r.detail || '').slice(0, 160)}`);
    return { ok: false, error: r.error, detail: r.detail, ms };
  }
  const manim = r.json && r.json.manim;
  const code = manim && typeof manim.code === 'string' ? manim.code.trim() : '';
  if (!code) {
    logOr(ctx, `scene#${index} 生成代码失败：模型没给 manim.code`);
    return { ok: false, error: 'NO_CODE', ms };
  }
  const clean = M.stripMathDelims(code);
  const unsafe = M.checkCode(clean);
  if (unsafe) {
    logOr(ctx, `scene#${index} 生成代码被安全闸门拒收：${unsafe}`);
    return { ok: false, error: `UNSAFE_CODE:${unsafe}`, ms };
  }
  cache.setCode(materials, clean, manim.scene || null);
  logOr(ctx, `scene#${index} 生成代码完成 ${(ms / 1000).toFixed(1)}s（已写代码缓存）`);
  return { ok: true, code: clean, scene: manim.scene || null, ms, cacheHit: false };
}

/** 让模型修一次坏代码；失败返回 null。 */
async function repairManim({ scene, style, code, detail, cfg, ctx, index }) {
  const prompt = [
    '只输出 JSON，第一个字符必须是 {，不要解释。',
    '下面这段 manim 代码渲染失败了，请修好它。只改坏的地方，不要换主题。',
    `标题：「${scene.text}」`,
    '',
    '## 报错尾部',
    String(detail || '').slice(-700),
    '',
    '## 当前代码',
    String(code || '').slice(0, 6000),
    '',
    '## 输出形状',
    '{"manim":{"scene":"ClassName","code":"from manim import *\\n..."}}',
    '',
    '硬约束：import 只允许 manim/numpy；禁止文件/网络/subprocess/open/eval/exec；中文 Text 用 font="Microsoft YaHei"；标题 font_size>=44 且 weight=BOLD；MathTex 参数不要包 $。',
    '',
    stylePrompt(style),
  ].join('\n');
  logOr(ctx, `scene#${index} manim 失败，贴错误让模型修一次`);
  const r = await askJson(prompt, cfg, ctx.log);
  if (!r.ok) {
    logOr(ctx, `scene#${index} 自愈失败：${r.error}`);
    return null;
  }
  const manim = r.json && r.json.manim;
  const fixed = manim && typeof manim.code === 'string' ? M.stripMathDelims(manim.code.trim()) : '';
  if (!fixed) return null;
  const unsafe = M.checkCode(fixed);
  if (unsafe) {
    logOr(ctx, `scene#${index} 自愈后的代码仍被拒收：${unsafe}`);
    return null;
  }
  logOr(ctx, `scene#${index} 自愈代码已生成`);
  return { code: fixed, scene: manim.scene || null };
}

/** 简单并发池：按原下标回填。 */
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

/** 场景里已经带了旧代码时，判断它是否还配得上当前标题（redo 用）。 */
function codeMatchesText(code, text) {
  const clean = (s) => String(s || '').replace(/[\s，。！？、；：,.!?;:'"「」『』（）()\-—]/g, '');
  const t = clean(text);
  if (!t) return true;
  return clean(code).includes(t);
}

/**
 * 主入口：
 *   req      normalizeRequest 之后的对象
 *   opts.redo  重做：客户端回传的旧代码只有在标题仍匹配时才沿用
 * 返回 { ok, title, scenes, warnings, style }
 */
async function plan({ req, cfg, cache, redo, ctx }) {
  const warnings = [];
  const log = (m) => logOr(ctx, m);
  const style = await resolveStyle({ requested: req.style, cfg, log });
  log(`规划开始：${req.scenes.length ? `分镜 ${req.scenes.length} 场` : req.script ? '稿子模式' : '主题模式'}，${req.seconds}s，风格 ${style.id}（${style.source}）`);

  let scenes = [];
  let title = '';

  if (req.scenes.length) {
    scenes = req.scenes.map((s, index) => S.normalizeScene(s, { index, log }));
    title = String(scenes[0] && scenes[0].text || '').trim();
  } else {
    const kind = req.script ? 'script' : 'topic';
    const input = req.script || req.topic;
    const candidates = await Stickers.fetchCandidates(cfg, 8).catch(() => []);
    if (candidates.length) log(`表情候选 ${candidates.length} 个：${candidates.map((s) => `${s.id}=${s.name}`).join('，')}`);
    const materials = {
      kind,
      input,
      seconds: req.seconds,
      style: styleKey(style),
      tone: '',
    };
    let skeleton = req.fresh ? null : cache.getSkeleton(materials);
    if (skeleton) {
      log(`分镜骨架命中缓存（${skeleton.scenes.length} 场，跳过写骨架调用）`);
    } else {
      const prompt = kind === 'script'
        ? scriptPrompt(req.script, req.seconds, style, candidates)
        : skeletonPrompt(req.topic, req.seconds, style, candidates);
      const started = Date.now();
      log(`写分镜骨架（模型调用，${kind}）`);
      const r = await askJson(prompt, cfg, log);
      if (!r.ok) return { ok: false, error: `PLAN_FAILED: ${r.error}`, detail: r.detail, warnings };
      log(`写分镜骨架完成 ${((Date.now() - started) / 1000).toFixed(1)}s`);
      const rawScenes = Array.isArray(r.json.scenes) ? r.json.scenes : [];
      if (!rawScenes.length) return { ok: false, error: 'NO_SCENES', warnings };
      title = String(r.json.title || '').trim();
      // 只写结构合格的骨架；缓存里存原始字段，取出时仍过 normalizeScene
      if (!req.fresh) cache.setSkeleton(materials, title, rawScenes.slice(0, Number(cfg.maxScenes) || 80));
      skeleton = { title, scenes: rawScenes };
    }
    title = String(skeleton.title || title || '').trim();
    scenes = S.normalizeScenes(skeleton.scenes, cfg.maxScenes, log);
  }

  if (!scenes.length) return { ok: false, error: 'NO_SCENES', warnings };

  // auto → 具体引擎（只在这里收口）；表情卡缺表情时降级 text 并写日志
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const want = s.tool;
    s.tool = decideTool(s);
    if (want === 'sticker' && s.tool !== 'sticker') {
      s.status = 'degraded';
      s.note = '表情卡没有表情，降级文字卡';
      log(`scene#${i} 表情卡没有表情（stickers 为空），降级文字卡`);
      warnings.push(`第 ${i + 1} 场：表情卡没有表情，已降级文字卡`);
    }
  }

  // 30~40 秒的集至少 3 场 manim（任务书验收 A）；模型标成 text 的场这里补足
  const manimCount = scenes.filter((s) => s.tool === 'manim').length;
  if (!req.scenes.length && scenes.length >= 3 && manimCount < 3) {
    let need = 3 - manimCount;
    for (const s of scenes) {
      if (need <= 0) break;
      if (s.tool !== 'text') continue;
      s.tool = 'manim';
      s.note = '为满足至少 3 场 manim，规划阶段改判';
      need--;
      log(`scene#? 原 text 场改为 manim（保证 ≥3 场动画）：${s.text}`);
    }
    warnings.push('规划模型给的 manim 少于 3 场，已把部分 text 场改回 manim');
  }

  // 已有代码的场：初始提交直接沿用；redo 时先和"当前 text/hint 对应的缓存"对账，
  // 缓存里的代码优先（标题改了 → 键变 → 必然重新生成），同时允许标题仍匹配的手改代码。
  const jobs = [];
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    if (s.tool !== 'manim') {
      s.status = 'ready';
      s.note = s.note || '文字卡';
      continue;
    }
    if (redo && s.manim && s.manim.code) {
      const cached = cache.getCode({
        text: s.text, hint: s.hint, style: styleKey(style), tool: 'manim',
      });
      if (cached && cached.code === s.manim.code) {
        log(`scene#${i} 旧代码与当前缓存一致，沿用`);
      } else if (cached && !codeMatchesText(s.manim.code, s.text)) {
        log(`scene#${i} 标题已变，旧代码不沿用（改用当前键的缓存代码）`);
        s.manim = { code: cached.code, scene: cached.scene || null };
      } else if (!cached && !codeMatchesText(s.manim.code, s.text)) {
        log(`scene#${i} 标题已变且当前键无缓存，重新生成代码`);
        s.manim = null;
      }
    }
    if (s.manim && s.manim.code) {
      const unsafe = M.checkCode(M.stripMathDelims(s.manim.code));
      if (unsafe) {
        log(`scene#${i} 客户端给的代码被安全闸门拒收（${unsafe}），重新生成`);
        s.manim = null;
      }
    }
    if (!s.manim || !s.manim.code) jobs.push({ index: i, scene: s });
  }

  const concurrency = Math.max(1, Number(cfg.plan && cfg.plan.codeConcurrency) || 2);
  const results = await mapLimit(jobs, concurrency, async (job) => {
    return generateCode({
      scene: job.scene, style, cfg, cache, ctx, index: job.index,
    });
  });

  for (let k = 0; k < jobs.length; k++) {
    const i = jobs[k].index;
    const s = scenes[i];
    const r = results[k];
    if (r && r.ok) {
      s.manim = { code: r.code, scene: r.scene || null };
      s.status = 'pending';
      s.note = r.cacheHit ? '代码命中缓存' : '代码已生成';
    } else {
      s.tool = 'text';
      s.manim = null;
      s.status = 'degraded';
      s.note = `代码生成失败，降级文字卡：${(r && r.error) || 'UNKNOWN'}`;
      warnings.push(`第 ${i + 1} 场：${s.note}`);
      log(`scene#${i} manim 失败，降级为文字卡：${(r && r.error) || 'UNKNOWN'}`);
    }
  }

  // 标题：显式分镜没有 title 字段，就用第一场标题（redo 改标题后立刻反映到任务/日志）
  if (!title) title = String(scenes[0].text || '').trim();
  if (redo) title = String(scenes[0].text || title).trim();
  log(`规划完成：${scenes.length} 场，manim ${scenes.filter((s) => s.tool === 'manim').length} 场，`
    + `sticker ${scenes.filter((s) => s.tool === 'sticker').length} 场，text ${scenes.filter((s) => s.tool === 'text').length} 场，标题「${title}」`);
  return { ok: true, title, scenes, warnings, style };
}

module.exports = {
  plan, askJson, resolveStyle, repairManim, styleKey, decideTool, visualPrompt,
  skeletonPrompt, scriptPrompt, generateCode,
};
