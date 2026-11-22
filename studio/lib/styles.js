'use strict';
/**
 * styles.js -- 视觉风格预设（把 lemo-opuscar 的 STYLE.md 变成渲染器能执行的字段）
 *
 * 为什么要这一层：
 *   Manim 默认是"黑底 + BLUE/YELLOW 随手挑"，一集里每场配色各写各的，看起来像剪贴簿。
 *   风格预设把「整集用一套配色/线宽/字体/节奏」变成一份 JSON，渲染时**机械地**套到
 *   manim 代码与文字卡上 —— 不依赖模型每次都把颜色写对。
 *
 * 字段来源是 lemomo-ai/lemo-opuscar 的 styles/<id>/STYLE.md（散文体，给人和模型读）。
 * 这里只提炼「我们的渲染器真能执行的部分」：颜色、线宽、字体、节奏、机位；
 * 构图/音效/转场语法这类我们做不到的，压成一句 notes 塞进规划提示词当上下文。
 *
 * 设计原则：
 *   - 风格 JSON 坏了不能让渲染挂：任何字段非法都回落到默认值（normalizeStyle）。
 *   - 应用风格必须是**可预测的文本替换**，不是"希望模型照做"：见 applyToManimCode。
 *   - 人设决定默认风格，但缓存按 persona.version 失效（见 resolvePersonaStyle）。
 */
const fs = require('node:fs');
const path = require('node:path');

const HEX = /^#[0-9a-f]{6}$/i;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function hex(v, fallback) {
  return HEX.test(String(v || '')) ? String(v).toLowerCase() : fallback;
}

/** 相对亮度（sRGB 近似）。用来判断"这个底色上该写深字还是浅字"。 */
function luminance(h) {
  const s = String(h || '').replace('#', '');
  if (s.length !== 6) return 0;
  const ch = [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** 两个 #rrggbb 之间线性插值，t=0 取 a、t=1 取 b */
function mix(a, b, t) {
  const pa = String(a).replace('#', '');
  const pb = String(b).replace('#', '');
  if (pa.length !== 6 || pb.length !== 6) return hex(a, '#101a33');
  const k = Math.min(1, Math.max(0, Number(t) || 0));
  let out = '#';
  for (let i = 0; i < 6; i += 2) {
    const va = parseInt(pa.slice(i, i + 2), 16);
    const vb = parseInt(pb.slice(i, i + 2), 16);
    out += Math.round(va + (vb - va) * k).toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * 归一化一份风格。id 一律以文件名/入参为准 —— JSON 里写错 id 时不能出现
 * "两边 id 不一致导致按 id 查不到"这种鬼问题。
 */
function normalizeStyle(raw, id) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const bg = hex(r.bg, '#101a33');
  // 底色偏亮（白板）时，没给 fg 就用深墨；底色偏暗时用浅字。省得每份 JSON 都得写 fg。
  const autoFg = luminance(bg) > 0.4 ? '#23262c' : '#f2f6ff';
  return {
    id: String(id || r.id || 'default').replace(/[^a-z0-9-_]/gi, '').slice(0, 40) || 'default',
    name: String(r.name || id || '默认风格').slice(0, 40),
    source: String(r.source || '').slice(0, 160),
    bg,
    fg: hex(r.fg, autoFg),
    accent: hex(r.accent, '#4dff88'),
    muted: hex(r.muted, mix(bg, autoFg, 0.45)),
    accent2: hex(r.accent2, hex(r.accent, '#4dff88')),
    line_width: Math.min(12, Math.max(1, Number(r.line_width) || 3)),
    glow: Boolean(r.glow),
    font: String(r.font || 'Microsoft YaHei').slice(0, 60),
    math_font: String(r.math_font || '').slice(0, 60),
    motion: String(r.motion || 'slow').slice(0, 20),
    camera: String(r.camera || 'static').slice(0, 20),
    bg_mix: Math.min(0.9, Math.max(0, r.bg_mix == null ? 0.2 : Number(r.bg_mix) || 0)),
    grid: Boolean(r.grid),
    notes: String(r.notes || '').slice(0, 400),
  };
}

/**
 * 读 styles/ 下所有 *.json。
 * 每次调用重新读盘（只有几个小文件，读一次几毫秒），换来"改了 JSON 不用重启服务"。
 */
function loadStyles(dir) {
  const list = [];
  const errors = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.json$/i.test(n)).sort(); } catch { names = []; }
  for (const name of names) {
    const file = path.join(dir, name);
    const raw = readJson(file, null);
    if (!raw) { errors.push({ file: name, error: 'BAD_JSON' }); continue; }
    list.push(normalizeStyle(raw, path.basename(name, path.extname(name))));
  }
  const byId = {};
  for (const s of list) byId[s.id] = s;
  return { list, byId, errors };
}

function getStyle(dir, id) {
  const idx = loadStyles(dir);
  return idx.byId[String(id || '')] || null;
}

/** 风格对画面的"签名"：进画面缓存键，换风格必须重渲（否则会复用旧配色片段）。 */
function signature(style) {
  if (!style) return null;
  const s = normalizeStyle(style, style.id);
  return [s.id, s.bg, s.fg, s.accent, s.muted, s.accent2, s.line_width, s.font, s.bg_mix].join('|');
}

/** 文字卡用的配色：底色取风格底色，第二个色按 bg_mix 往主色偏，字色取 fg。 */
function textPalette(style) {
  const s = normalizeStyle(style || {}, style && style.id);
  return {
    bg: { c0: s.bg, c1: mix(s.bg, s.accent, s.bg_mix) },
    textColor: s.fg,
    accent: s.accent,
    muted: s.muted,
  };
}

/**
 * 生成"风格约束"提示词块。
 * 这段是给规划/写脚本的模型看的，所以写成人话 + 明确到能照着写代码。
 */
function promptBlock(style) {
  const s = normalizeStyle(style || {}, style && style.id);
  const lines = [
    '## 视觉风格（整集统一，必须照做）',
    `- 风格：${s.name}${s.source ? `（取自 ${s.source}）` : ''}`,
    `- 背景：${s.bg}；主元素/曲线：${s.accent}；文字：${s.fg}；次要/网格：${s.muted}；强调（尽量只出现一次）：${s.accent2}`,
    `- 线宽统一 stroke_width=${s.line_width}；${s.glow ? '允许发光/光晕感（主线用亮色、网格用暗色即可）' : '不要发光、不要投影，素色平涂'}`,
    `- 中文一律 Text(..., font="${s.font}")；公式用 MathTex（LaTeX 已装，模板默认就够）`,
    '- 字重/字号：标题 font_size ≥ 44 且必须 weight=BOLD；正文/标注 font_size ≥ 32 —— 不加 BOLD 的标题在成片里会细得看不清',
    `- 节奏：${s.motion}；机位：${s.camera}`,
  ];
  if (s.grid) lines.push('- 可以画一层很淡的网格（NumberPlane，stroke_opacity=0.15），它是背景不是主角');
  if (s.notes) lines.push(`- 风格要点：${s.notes}`);
  lines.push('- 颜色**只用上面这几个**，不要出现别的色；也不要用 BLACK 当背景（背景由渲染器统一设定）');
  return lines.join('\n');
}

/**
 * 把风格机械地套进模型写的 manim 脚本。
 *
 * 为什么不只靠提示词：模型十次有三次会把颜色写成 BLUE/WHITE，或者干脆不设背景。
 * 与其每次渲染出半套配色，不如在这里做确定性替换：
 *   1) 颜色令牌（BLUE/WHITE/GREY/YELLOW…）→ 风格色（带引号的十六进制）
 *   2) 背景色 → self.camera.background_color（插在 construct 第一行）
 *   3) 显式写了的 stroke_width / font 覆盖成风格值
 * 替换只认"整词"，`Text("WHITE")` 里的字符串字面量有可能被改到，
 * 但那种写法本来就会把颜色名写进画面，改了也不影响画面正确性。
 */
const COLOR_TOKENS = [
  { re: /\b(BLUE|TEAL|GREEN|BLUE_B|TEAL_B|GREEN_B|BLUE_C|TEAL_C|GREEN_C|BLUE_D|TEAL_D|GREEN_D|BLUE_E|TEAL_E|GREEN_E)\b/g, slot: 'accent' },
  { re: /\b(YELLOW|GOLD|ORANGE|RED|MAROON|YELLOW_B|GOLD_B|ORANGE_B|RED_B|YELLOW_C|GOLD_C|ORANGE_C|RED_C|YELLOW_D|GOLD_D|ORANGE_D|RED_D|YELLOW_E|GOLD_E|ORANGE_E|RED_E)\b/g, slot: 'accent2' },
  { re: /\b(WHITE|LIGHT_GREY|LIGHT_GRAY)\b/g, slot: 'fg' },
  { re: /\b(GREY|GRAY|GREY_B|GRAY_B|GREY_C|GRAY_C|GREY_D|GRAY_D|GREY_E|GRAY_E|DARK_GREY|DARK_GRAY)\b/g, slot: 'muted' },
];

function applyToManimCode(code, style) {
  const s = normalizeStyle(style || {}, style && style.id);
  let src = String(code == null ? '' : code);
  const applied = { colors: 0, background: false, stroke: 0, font: 0 };

  for (const tok of COLOR_TOKENS) {
    src = src.replace(tok.re, () => { applied.colors += 1; return `"${s[tok.slot]}"`; });
  }

  // 背景：已经有就改成风格色，没有就插到 construct 的第一行
  const bgLine = `self.camera.background_color = "${s.bg}"`;
  if (/self\.camera\.background_color\s*=/.test(src)) {
    src = src.replace(/self\.camera\.background_color\s*=\s*[^\n]*/g, bgLine);
    applied.background = true;
  } else {
    const withIndent = src.replace(
      /(def\s+construct\s*\(\s*self\s*\)\s*:[ \t]*\n)([ \t]*)/,
      (m, head, indent) => { applied.background = true; return `${head}${indent}${bgLine}\n\n${indent}`; }
    );
    if (applied.background) {
      src = withIndent;
    } else {
      // 一行写完的 construct（少见）：退化成插在冒号后面
      const one = src.replace(/(def\s+construct\s*\(\s*self\s*\)\s*:)/, (m) => `${m} ${bgLine};`);
      if (one !== src) { src = one; applied.background = true; }
    }
  }

  src = src.replace(/stroke_width\s*=\s*\d+(?:\.\d+)?/g, () => { applied.stroke += 1; return `stroke_width=${s.line_width}`; });
  src = src.replace(/\bfont\s*=\s*("([^"]*)"|'([^']*)')/g, () => { applied.font += 1; return `font="${s.font}"`; });

  return { code: src, applied, style: s };
}

// --------------------------------------------------------------- 人设 → 风格 --

/**
 * 人设关键词 → 风格。顺序即优先级：同分时排在前面的赢。
 * 关键词是"命中就加分"，一份人设里往往同时出现多个词，所以按命中数投票，
 * 不比单条规则更长 —— 单人设里"温柔/陪伴"出现 5 次、'数学' 1 次，多数派才对。
 */
const PERSONA_RULES = [
  {
    id: 'oscilloscope-math',
    why: '数学/公式',
    words: ['数学', '公式', '方程', '函数', '微积分', '导数', '积分', '几何', '向量', '证明', '定理', '物理', '概率', '矩阵', 'math', 'formula', 'equation'],
  },
  {
    id: 'blueprint',
    why: '理性/严谨',
    words: ['理性', '严谨', '逻辑', '工程', '结构', '系统', '原理', '机制', '参数', '拆解', '技术', '精确', '推导', '架构', 'blueprint'],
  },
  {
    id: 'whiteboard',
    why: '温柔/叙事',
    words: ['温柔', '叙事', '故事', '陪伴', '情感', '聊天', '轻松', '童话', '日常', '治愈', '软', '可爱', '黏人', '暖'],
  },
];

/**
 * 按关键词给人设打票。返回 { id, reason, scores }。
 * block 为空/没有关键词 → 返回 null（交给调用方用默认风格），而不是硬套一个。
 */
function mapPersonaToStyle(block, styleIds) {
  const text = String(block || '').toLowerCase();
  if (!text.trim()) return null;
  const scores = {};
  const hits = {};
  for (const rule of PERSONA_RULES) {
    let n = 0;
    const found = [];
    for (const w of rule.words) {
      // 中文没有词边界，直接数出现次数；英文用词边界，避免 'math' 命中 'mathematics' 之外的东西
      const re = /^[a-z]+$/.test(w)
        ? new RegExp(`\\b${w}\\b`, 'g')
        : new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      const m = text.match(re);
      if (m && m.length) { n += m.length; found.push(`${w}x${m.length}`); }
    }
    scores[rule.id] = n;
    hits[rule.id] = found;
  }
  const avail = Array.isArray(styleIds) && styleIds.length ? styleIds : PERSONA_RULES.map((r) => r.id);
  let best = null;
  for (const rule of PERSONA_RULES) {
    if (!avail.includes(rule.id)) continue;
    if (!best || scores[rule.id] > scores[best.id]) best = rule;
  }
  if (!best || scores[best.id] <= 0) return null;
  const reason = `人设关键词命中「${best.why}」(${hits[best.id].slice(0, 6).join('、')}) → ${best.id}`;
  return { id: best.id, reason, scores, hits };
}

/**
 * 解析"这次该用哪个风格"：
 *   1) 显式指定（项目 JSON 的 style / 请求里的 style）优先，不查人设
 *   2) 否则读 persona，按 version 判断缓存是否失效；版本没变直接用缓存
 *   3) persona 连不上 → 用缓存（哪怕是旧版本）；没缓存 → 默认风格
 *
 * 返回 { style, id, reason, source, personaVersion }。source ∈ explicit|cache|persona|fallback
 */
async function resolvePersonaStyle(opts = {}) {
  const { stylesDir, personaUrl, cacheFile, fallbackId = 'whiteboard', timeoutMs = 6000 } = opts;
  const idx = loadStyles(stylesDir);
  const ids = idx.list.map((s) => s.id);
  const fallback = () => {
    const id = ids.includes(fallbackId) ? fallbackId : (ids[0] || 'whiteboard');
    return { style: idx.byId[id] || normalizeStyle({}, id), id, reason: `默认风格（未指定，且人设不可用）→ ${id}`, source: 'fallback', personaVersion: 0 };
  };

  if (opts.styleId) {
    const hit = idx.byId[String(opts.styleId)];
    if (hit) return { style: hit, id: hit.id, reason: `显式指定 → ${hit.id}`, source: 'explicit', personaVersion: 0 };
  }
  if (!personaUrl) return fallback();

  const cached = readJson(cacheFile, null);
  let data = null;
  try {
    const res = await fetch(`${String(personaUrl).replace(/\/+$/, '')}/v1/persona`, {
      signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 6000)),
    });
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = null; }
  } catch { data = null; }

  const block = data && (data.block || (data.persona && data.persona.block) || data.constitution);
  const version = data && Number.isFinite(Number(data.version)) ? Number(data.version) : 0;

  if (!block) {
    // 人设服务连不上/没内容：缓存能用就用缓存，别让一次抖动把整集配色换掉
    if (cached && cached.styleId && idx.byId[cached.styleId]) {
      const s = idx.byId[cached.styleId];
      return { style: s, id: s.id, reason: `${cached.reason || '人设缓存'}（人设暂不可用，沿用 v${cached.version} 的选择）`, source: 'cache', personaVersion: cached.version || 0, stale: true };
    }
    return fallback();
  }

  if (cached && cached.styleId && idx.byId[cached.styleId] && Number(cached.version) === version) {
    const s = idx.byId[cached.styleId];
    return { style: s, id: s.id, reason: cached.reason || `人设缓存 → ${s.id}`, source: 'cache', personaVersion: version };
  }

  const mapped = mapPersonaToStyle(block, ids);
  if (!mapped) return fallback();
  const s = idx.byId[mapped.id];
  if (!s) return fallback();
  const payload = { version, styleId: s.id, reason: mapped.reason, scores: mapped.scores, at: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 1), 'utf8');
    fs.renameSync(tmp, cacheFile);
  } catch { /* 缓存写不了只是慢一点（每次都重算），不该影响出片 */ }
  return { style: s, id: s.id, reason: mapped.reason, source: 'persona', personaVersion: version, scores: mapped.scores };
}

module.exports = {
  loadStyles, getStyle, normalizeStyle, signature, textPalette, promptBlock,
  applyToManimCode, mapPersonaToStyle, resolvePersonaStyle, mix, luminance, hex,
  PERSONA_RULES,
};
