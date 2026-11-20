'use strict';

/**
 * Deterministic token estimate. Deliberately conservative and dependency-free:
 * writer and reader must agree on it, so it never asks a real tokenizer.
 */
function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0xf900 && code <= 0xfaff)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk * 1.1 + other / 4);
}

/** Crude term extraction: latin words + CJK bigrams. */
function extractTerms(text) {
  const found = new Set();
  const lower = String(text || '').toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_]{2,}/g)) found.add(m[0]);
  const runs = lower.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of runs) {
    if (run.length === 1) found.add(run);
    for (let i = 0; i < run.length - 1; i += 1) found.add(run.slice(i, i + 2));
  }
  return [...found];
}

module.exports = { estimateTokens, extractTerms };
