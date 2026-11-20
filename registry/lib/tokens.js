'use strict';

/**
 * token 估算（与 memory/lib/budget.js 的 estimateTokens 算法一致，独立实现，不跨模块引用）。
 *
 * 规则：
 *   - 中日韩字符（U+4E00-9FFF、U+3400-4DBF、U+F900-FAFF）每个 1.1 token
 *   - 其余字符每 4 个 1 token
 *   - 总数向上取整
 *
 * 纯函数、零依赖，保证 catalog 的 token 数字可复现。
 */

const CJK_RANGES = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
];

function isCjk(code) {
  for (const [lo, hi] of CJK_RANGES) {
    if (code >= lo && code <= hi) return true;
  }
  return false;
}

/**
 * @param {string} text 任意文本（null/undefined 视为空）
 * @returns {number} 非负整数 token 估算
 */
function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of String(text)) {
    if (isCjk(ch.codePointAt(0))) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 1.1 + other / 4);
}

module.exports = { estimateTokens };
