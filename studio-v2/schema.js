'use strict';
/**
 * schema.js -- v2 唯一的场景/任务字段定义。
 *
 * 全项目只有这里知道"场景长什么样"：
 *   - 输入（面板/旧项目/模型）先过 normalizeScene()，别名在这里收口（visual_hint/kind/visual）；
 *   - 其它模块只读规范化之后的字段，不再各自写白名单。
 *
 * 场景契约（唯一真相）：
 *   { text, narration, seconds, hint, tool, stickers, image, manim, status, note }
 */

const crypto = require('node:crypto');

const TOOLS = new Set(['manim', 'text', 'auto']);
const STATUSES = new Set(['pending', 'ready', 'degraded', 'failed']);
const STICKER_ID_RE = /^[0-9a-f]{6,40}$/i;

function str(v, max) {
  const s = v == null ? '' : String(v);
  return max && s.length > max ? s.slice(0, max) : s;
}

function clampNum(v, lo, hi, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}

/** 单个表情的规范化：位置/大小/时间都夹在安全范围内，id 不合法就丢掉。 */
function normalizeSticker(raw, index) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const id = str(r.id, 40).trim().toLowerCase();
  if (!STICKER_ID_RE.test(id)) return null;
  return {
    id,
    at: round2(clampNum(r.at, 0, 60, 1.2)),
    duration: round2(clampNum(r.duration, 0.6, 8, 1.8)),
    x: round2(clampNum(r.x, 0, 1, 0.82)),
    y: round2(clampNum(r.y, 0, 1, 0.12)),
    scale: round2(clampNum(r.scale, 0.1, 1, 0.3)),
    index: Number.isInteger(index) ? index : 0,
  };
}

/** 引擎判定只在这里做一次；显式 tool 优先，其次旧字段 kind/visual。 */
function normalizeTool(raw, hasCode) {
  const tool = str(raw.tool, 12).trim().toLowerCase();
  if (TOOLS.has(tool)) return tool;
  const kind = str(raw.kind, 12).trim().toLowerCase();
  const visual = str(raw.visual, 12).trim().toLowerCase();
  if (kind === 'manim' || visual === 'manim') return 'manim';
  if (kind === 'text' || visual === 'text') return 'text';
  if (hasCode) return 'manim';
  return 'auto';
}

/**
 * 唯一入口：任何来源的分镜都必须先过这里。
 * 返回的每个字段都可序列化，且不会再出现别名。
 */
function normalizeScene(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};

  let text = str(r.text, 80).trim();
  let narration = str(r.narration, 400).trim();
  // 内容兜底：只有旁白没有标题时，用旁白开头当标题（面板上不至于空着）
  if (!text && narration) text = narration.slice(0, 14);

  const seconds = round2(clampNum(r.seconds, 2, 30, 8));
  const hint = str(r.hint != null ? r.hint : (r.visual_hint != null ? r.visual_hint : r.prompt), 600).trim();

  let manim = null;
  if (r.manim && typeof r.manim === 'object' && typeof r.manim.code === 'string' && r.manim.code.trim()) {
    manim = {
      code: str(r.manim.code, 16000),
      scene: str(r.manim.scene, 80).trim() || null,
    };
  }

  const rawStickers = Array.isArray(r.stickers) ? r.stickers.slice(0, 3) : [];
  const stickers = rawStickers
    .map((s, i) => normalizeSticker(s, i))
    .filter(Boolean);

  const image = r.image == null || r.image === '' ? null : str(r.image, 300);

  const tool = normalizeTool(r, Boolean(manim));
  const status = STATUSES.has(str(r.status, 16)) ? str(r.status, 16) : 'pending';
  const note = str(r.note, 300).trim();

  return { text, narration, seconds, hint, tool, stickers, image, manim, status, note };
}

function normalizeScenes(list, maxScenes) {
  const arr = Array.isArray(list) ? list : [];
  const cap = Math.max(1, Number(maxScenes) || 80);
  return arr.slice(0, cap).map(normalizeScene).filter((s) => s.text || s.narration || s.hint);
}

/**
 * 任务请求的唯一白名单。三种输入互斥，scenes 优先。
 * 这里只做字段收口，不判断 IO；server.js 再决定 400 还是入队。
 */
function normalizeRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  const scenes = Array.isArray(b.scenes) ? normalizeScenes(b.scenes) : [];
  return {
    topic: str(b.topic, 2000).trim(),
    script: str(b.script, 20000).trim(),
    scenes,
    seconds: round2(clampNum(b.seconds, 2, 900, 30)),
    style: str(b.style, 60).trim(),
    voice: b.voice == null ? '' : str(b.voice, 80).trim(),
    fresh: b.fresh === true,
  };
}

function nowIso() {
  return new Date().toISOString();
}

/** 任务 id：短、按时间可排序、不会撞。 */
function newJobId() {
  return `j${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

/** 任务记录的定义也只在这里：server.js 用空记录起步，之后只补运行期字段。 */
function newJob(request) {
  const id = newJobId();
  const total = Array.isArray(request.scenes) ? request.scenes.length : 0;
  return {
    id,
    status: 'queued',
    phase: 'queued',
    label: '排队中',
    title: '',
    done: 0,
    total,
    createdAt: Date.now(),
    startedAt: 0,
    finishedAt: 0,
    elapsedMs: 0,
    ms: 0,
    bytes: 0,
    videoUrl: '',
    srtUrl: '',
    warnings: [],
    error: null,
    scenes: [],
    request,
  };
}

module.exports = {
  TOOLS,
  STATUSES,
  normalizeScene,
  normalizeScenes,
  normalizeRequest,
  newJob,
  newJobId,
  nowIso,
  clampNum,
  round2,
};
