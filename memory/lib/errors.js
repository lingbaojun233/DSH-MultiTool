'use strict';

/**
 * 结构化错误。对外只返回 JSON：{ ok:false, code, message, hint }，
 * 不用自然语言报错，方便调用方（模型/脚本）稳定处理。
 */

const CODES = {
  E_BAD_REQUEST: '请求参数不合法',
  E_NO_EVIDENCE: '缺少证据定位（evidence）',
  E_NOT_FOUND: '目标不存在',
  E_RATE_LIMIT: '触发频率限制',
  E_IMMUTABLE: '该字段不可变',
  E_DB: '数据库错误',
  E_INTERNAL: '内部错误',
};

class MemoryError extends Error {
  constructor(code, message, hint) {
    super(message || CODES[code] || code);
    this.code = code;
    this.hint = hint || '';
  }
}

function fail(code, message, hint) {
  return { ok: false, code, message: message || CODES[code] || code, hint: hint || '' };
}

function toResponse(err) {
  if (err instanceof MemoryError) return fail(err.code, err.message, err.hint);
  return fail('E_INTERNAL', err && err.message ? err.message : String(err));
}

module.exports = { MemoryError, CODES, fail, toResponse };
