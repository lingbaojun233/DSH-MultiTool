'use strict';

/**
 * 规则预取：用户这句话强命中某模块的触发条件时，直接把它的 README 放进上下文。
 *
 * 为什么需要它：实测中模型从不调用 `read`，而是自己 ls/find 翻文件——
 * 翻出来的内容是碎片，还会产生"我读过文档了"的幻觉。与其指望它自觉，
 * 不如在命中明确时把用法直接给它。
 *
 * 判据刻意保守：只用 when 的字符二元组 + 模块名，命中率不足就不触发，
 * 宁可让模型回到目录里自己决定。
 */

const fs = require('node:fs');
const path = require('node:path');
const { estimateTokens } = require('./tokens.js');

const THRESHOLD = 0.34; // when 二元组命中比例下限
const MAX_MODULES = 1; // 一次最多预取一个，避免上下文膨胀

function bigrams(text) {
  const chars = [...String(text || '').replace(/[\s\p{P}]/gu, '')];
  const out = new Set();
  for (let i = 0; i < chars.length - 1; i += 1) out.add(chars[i] + chars[i + 1]);
  return out;
}

function scoreModule(module, text) {
  const haystack = bigrams(text);
  if (!haystack.size) return { score: 0, hits: 0, total: 0 };
  const trigger = bigrams(module.when);
  let hits = 0;
  for (const gram of trigger) if (haystack.has(gram)) hits += 1;
  const ratio = trigger.size ? hits / trigger.size : 0;
  // 直接点名模块，视为强信号
  const named = String(text || '').toLowerCase().includes(String(module.name || '').toLowerCase());
  return { score: named ? Math.min(1, ratio + 0.4) : ratio, hits, total: trigger.size, named };
}

/**
 * @param {string} text 用户这句话
 * @param {string} modulesRoot modules 目录
 * @param {{scope?: string, threshold?: number}} [options]
 * @returns {{matched: boolean, module?: string, score?: number, content?: string, tokens?: number, candidates?: object[]}}
 */
function prefetch(text, modulesRoot, options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : THRESHOLD;
  const wantedScope = options.scope || null;

  let names = [];
  try {
    names = fs.readdirSync(modulesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { matched: false, reason: 'modules dir missing' };
  }

  const candidates = [];
  for (const dirName of names) {
    const yamlPath = path.join(modulesRoot, dirName, 'module.yaml');
    if (!fs.existsSync(yamlPath)) continue;
    let raw;
    try {
      raw = require('./yaml.js').parse(fs.readFileSync(yamlPath, 'utf8'));
    } catch {
      continue;
    }
    const scope = typeof raw.scope === 'string' ? raw.scope.trim().toLowerCase() : 'both';
    if (wantedScope && scope !== 'both' && scope !== wantedScope) continue;

    const module = { name: raw.name || dirName, when: raw.when || '', dir: dirName };
    const scored = scoreModule(module, text);
    if (scored.score > 0) candidates.push({ ...module, ...scored });
  }

  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const top = candidates[0];

  if (!top || top.score < threshold) {
    return { matched: false, reason: 'below threshold', candidates: candidates.slice(0, 3) };
  }

  const readmePath = path.join(modulesRoot, top.dir, 'README.md');
  let content = '';
  try {
    content = fs.readFileSync(readmePath, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return { matched: false, reason: 'readme missing', candidates: candidates.slice(0, 3) };
  }

  return {
    matched: true,
    module: top.name,
    score: Number(top.score.toFixed(3)),
    content,
    tokens: estimateTokens(content),
    candidates: candidates.slice(0, 3),
  };
}

module.exports = { prefetch, scoreModule, THRESHOLD, MAX_MODULES };
