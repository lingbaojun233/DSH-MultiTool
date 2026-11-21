'use strict';
/**
 * jobs.js -- 视频任务与"可重做配方"的落盘存储。
 *
 * 为什么要单独一层：
 *   - 任务状态（jobs/<jobId>.json）和配方（library/<jobId>.json）是两种东西：
 *     jobs 记"这一次跑到哪、成片在哪"，library 记"当初要做什么、最终分镜是什么"。
 *     前者可以失败、可以重启后作废；后者必须一直在，用户关掉页面/重启服务后
 *     还能一键重跑。
 *   - 两份文件都必须是**原子写**：先写 .tmp 再 rename。渲染过程中进程被 taskkill
 *     是常态（重启验收就会这么做），半截 JSON 会让"重启后还能读到结果"直接失效。
 *
 * 这里只做纯文件 IO + 标题规则，不碰任何业务逻辑，方便单测。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 合法 id：会被直接拼进文件名，所以只放行文件名安全字符。 */
const ID_RE = /^[0-9a-zA-Z_-]{1,80}$/;

function isSafeId(id) {
  return ID_RE.test(String(id || ''));
}

/**
 * 原子写 JSON。
 *
 * rename 在 Windows 上偶尔会撞到 EPERM/EBUSY（杀毒/索引器短暂占用目标文件），
 * 所以先重试几次；还不行就先删目标再改名 —— 宁可丢一小段进度，也不能让
 * "下一次启动读不出任务"。
 */
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
  let lastErr = null;
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      lastErr = err;
      // 大多数失败是目标文件被短暂占用：删掉目标再改名通常一次就过。
      try { fs.unlinkSync(file); } catch { }
    }
  }
  try { fs.unlinkSync(tmp); } catch { }
  throw lastErr || new Error('WRITE_FAILED');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function removeJson(file) {
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

/** 列出目录下所有 .json（忽略 .tmp / 坏文件），按 createdAt 倒序。 */
function listRecords(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const rec = readJson(path.join(dir, name), null);
    if (!rec || typeof rec !== 'object') continue;
    if (!rec.jobId && !rec.id) continue;
    out.push(rec);
  }
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out;
}

function newJobId() {
  // 时间前缀让文件名天然按时间排序，后面随机段防碰撞
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `job-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function firstSentence(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const m = s.match(/^[\s\S]*?[。！？!?；;\n]/);
  return (m ? m[0] : s).replace(/[。！？!?；;\n]+$/g, '').trim();
}

function shortTitle(text, max = 20) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * 配方标题（用户的规则，别改）：
 *   prompt 前 20 字 → script 首句 → scenes[0].text → 未命名 <时间>
 * 故意不看模型返回的标题：模型每次都换一个说法，重跑后列表里会出现两个
 * 看起来不相干的条目。配方标题必须由"用户提交的内容"决定。
 */
function deriveTitle(request, now = new Date()) {
  const body = request || {};
  // 显式标题优先：/v1/project/render 这类"没有 prompt/script"的任务
  // 用项目标题比"未命名 11-21 22:00"有用得多。普通 /v1/jobs 不会带 title。
  const explicit = shortTitle(body.title);
  if (explicit) return explicit;
  const prompt = shortTitle(body.prompt);
  if (prompt) return prompt;
  const sentence = shortTitle(firstSentence(body.script));
  if (sentence) return sentence;
  if (Array.isArray(body.scenes) && body.scenes.length) {
    const first = body.scenes[0] || {};
    const t = shortTitle(first.text || first.narration);
    if (t) return t;
  }
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  return `未命名 ${mm}-${dd} ${hh}:${mi}`;
}

module.exports = {
  ID_RE,
  isSafeId,
  writeJson,
  readJson,
  removeJson,
  listRecords,
  newJobId,
  deriveTitle,
};
