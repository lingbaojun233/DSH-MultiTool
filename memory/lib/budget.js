'use strict';

/**
 * Token 预算：估算与打包。写读同源，保证"返回不超预算"这条验收可复现。
 * 纯函数、无依赖；估算保守（宁可多算，不可少算）。
 */

const DEFAULT_BUDGET = { maxItems: 8, maxTokens: 1200 };
const CEILING = { maxItems: 32, maxTokens: 4000 };
const ITEM_MAX_TOKENS = 120; // 单条输出上限，需求 3.3

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

function clampBudget(raw) {
  const maxItems = Math.min(CEILING.maxItems, Math.max(1, Number(raw && raw.maxItems) || DEFAULT_BUDGET.maxItems));
  const maxTokens = Math.min(CEILING.maxTokens, Math.max(50, Number(raw && raw.maxTokens) || DEFAULT_BUDGET.maxTokens));
  return { maxItems, maxTokens };
}

/** 截断到指定 token 数以内（软截断，尽量落在字符边界）。 */
function clipToTokens(text, maxTokens) {
  const value = String(text || '');
  if (estimateTokens(value) <= maxTokens) return value;
  let clipped = '';
  for (const ch of value) {
    if (estimateTokens(clipped + ch) > maxTokens - 1) break;
    clipped += ch;
  }
  return `${clipped}…`;
}

/**
 * 按分数降序打包，同时满足条数与 token 双上限。
 * 放不下的条目会被跳过并置 truncated=true。
 */
function pack(items, rawBudget, textOf) {
  const budget = clampBudget(rawBudget);
  const chosen = [];
  let tokens = 0;
  let truncated = false;

  for (const item of items) {
    if (chosen.length >= budget.maxItems) {
      truncated = true;
      break;
    }
    const text = clipToTokens(textOf(item), ITEM_MAX_TOKENS);
    const cost = estimateTokens(text);
    if (tokens + cost > budget.maxTokens) {
      truncated = true;
      continue;
    }
    tokens += cost;
    chosen.push({ ...item, text, tokens: cost });
  }

  return { items: chosen, used: { count: chosen.length, tokens }, budget, truncated };
}

module.exports = { estimateTokens, clampBudget, clipToTokens, pack, DEFAULT_BUDGET, CEILING, ITEM_MAX_TOKENS };
