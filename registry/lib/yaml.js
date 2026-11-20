'use strict';

/**
 * 极简 YAML 解析器（零依赖），只覆盖 module.yaml 需要的子集：
 *   - `key: value`
 *   - 两层嵌套：`entry:` 下一行缩进 2 格的 `type: cmd`
 *   - 字符串去引号（"..." / '...'），最小转义
 *   - 整数、布尔转换
 *   - `#` 整行注释、空行跳过
 * 不支持：列表、行内注释、多行字符串、三层及以上嵌套、锚点/别名/合并键。
 *
 * 无法解析的行一律抛出带行号的错误：err.line 为 1 基行号，err.name 为 YamlParseError。
 */

const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:[ \t]*(.*)$/;
const INT_VALUE = /^[+-]?\d+$/;
const BOOL_VALUE = /^(true|false)$/i;
const INDENT = /^[ \t]*/;

function parseError(lineNo, detail) {
  const err = new Error(`第 ${lineNo} 行：${detail}`);
  err.name = 'YamlParseError';
  err.line = lineNo;
  return err;
}

function isSkippable(line) {
  return /^\s*$/.test(line) || /^\s*#/.test(line);
}

function indentOf(line) {
  return INDENT.exec(line)[0];
}

function nextContentIndex(lines, from) {
  for (let i = from; i < lines.length; i += 1) {
    if (!isSkippable(lines[i])) return i;
  }
  return -1;
}

function unescapeDouble(value) {
  const map = { '"': '"', '\\': '\\', n: '\n', t: '\t', r: '\r' };
  return value.replace(/\\(["\\ntr])/g, (whole, ch) => (
    Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : whole
  ));
}

/** 解析单个标量；返回 { empty, value }。 */
function parseScalar(rawValue, lineNo) {
  const value = String(rawValue).trim();
  if (value === '') return { empty: true, value: '' };

  const quote = value[0];
  if (quote === '"' || quote === "'") {
    if (value.length < 2 || value[value.length - 1] !== quote) {
      throw parseError(lineNo, `引号未闭合：${JSON.stringify(value)}`);
    }
    const inner = value.slice(1, -1);
    return {
      empty: false,
      value: quote === '"' ? unescapeDouble(inner) : inner.replace(/''/g, "'"),
    };
  }

  if (INT_VALUE.test(value)) {
    const num = Number(value);
    return { empty: false, value: Number.isSafeInteger(num) ? num : value };
  }
  if (BOOL_VALUE.test(value)) {
    return { empty: false, value: value.toLowerCase() === 'true' };
  }
  return { empty: false, value };
}

/**
 * @param {string} text YAML 文本
 * @returns {object} 解析后的普通对象
 * @throws {Error} 带 line 属性的解析错误
 */
function parse(text) {
  const source = text === undefined || text === null ? '' : String(text);
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const root = {};
  /** @type {{key: string, target: object}|null} 当前可容纳 2 格缩进子键的上级键 */
  let section = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isSkippable(line)) continue;

    const pad = indentOf(line);
    if (pad.includes('\t')) throw parseError(i + 1, '缩进只能用空格，不能用 Tab');
    if (pad.length !== 0 && pad.length !== 2) {
      throw parseError(i + 1, `缩进 ${pad.length} 格不受支持（只支持 0 或 2 格）`);
    }

    const body = line.slice(pad.length);
    const matched = KEY_LINE.exec(body);
    if (!matched) {
      throw parseError(i + 1, `无法解析的内容：${JSON.stringify(body)}（期望 key: value）`);
    }

    const key = matched[1];
    const target = pad.length === 0 ? root : (section ? section.target : null);
    if (target === null) throw parseError(i + 1, `缩进 2 格的键 ${JSON.stringify(key)} 没有上级键`);
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      throw parseError(i + 1, `重复的键 ${JSON.stringify(key)}`);
    }

    const scalar = parseScalar(matched[2], i + 1);

    if (scalar.empty) {
      // 空值：下一非空行若再缩进 2 格，则本键是嵌套段；否则是空字符串。
      const next = nextContentIndex(lines, i + 1);
      const nested = next !== -1 && indentOf(lines[next]).length === pad.length + 2;
      if (nested) {
        if (pad.length !== 0) throw parseError(next + 1, '不支持三层嵌套（最多两层）');
        const child = {};
        target[key] = child;
        section = { key, target: child };
      } else {
        target[key] = '';
        if (pad.length === 0) section = null;
      }
      continue;
    }

    target[key] = scalar.value;
    if (pad.length === 0) section = null;
  }

  return root;
}

module.exports = { parse };
