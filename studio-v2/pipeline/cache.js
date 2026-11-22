'use strict';
/**
 * cache.js -- 三层缓存 + 配音缓存。
 *
 *   1) code      场级 manim 代码：键 = text + hint + style + tool（narration 不进键）
 *   2) skeleton  整集分镜骨架：键 = 输入 + 秒数 + 风格 + 语气
 *   3) clip      画面片段：已经带表情/边框/字幕/配音的最终场片段
 *   4) audio     旁白音频（辅助层，让"只改标题"时不用重新念）
 *
 * 所有键都用 sha1(JSON)，文件名里只出现十六进制；条目内容再带一份材料，
 * 排查"为什么命中/没命中"时不用猜。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sha1(value, len = 24) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, len);
}

function key(parts) {
  return sha1(JSON.stringify(parts), 24);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

class Cache {
  constructor(root) {
    this.root = root;
    this.dirs = {
      code: path.join(root, 'code'),
      skeleton: path.join(root, 'skeleton'),
      clip: path.join(root, 'clip'),
      audio: path.join(root, 'audio'),
      sticker: path.join(root, 'sticker'),
    };
    for (const d of Object.values(this.dirs)) ensureDir(d);
  }

  file(kind, name, ext) {
    return path.join(this.dirs[kind], `${name}${ext}`);
  }

  getJson(kind, name) {
    return readJson(this.file(kind, name, '.json'), null);
  }

  setJson(kind, name, obj) {
    writeJsonAtomic(this.file(kind, name, '.json'), obj);
  }

  /** 场级代码缓存：材料必须含 text + hint + style + tool，narration 显式不参与。 */
  codeKey(materials) {
    return key([
      'code-v2',
      String(materials.text || ''),
      String(materials.hint || ''),
      String(materials.style || ''),
      String(materials.tool || 'manim'),
    ]);
  }

  getCode(materials) {
    const k = this.codeKey(materials);
    const entry = this.getJson('code', k);
    if (!entry || !entry.code) return null;
    return { ...entry, key: k };
  }

  setCode(materials, code, scene) {
    const k = this.codeKey(materials);
    this.setJson('code', k, {
      key: k,
      code,
      scene: scene || null,
      materials,
      at: new Date().toISOString(),
    });
    return k;
  }

  skeletonKey(materials) {
    return key([
      'skeleton-v2',
      String(materials.kind || ''),
      String(materials.input || ''),
      Number(materials.seconds) || 0,
      String(materials.style || ''),
      String(materials.tone || ''),
    ]);
  }

  getSkeleton(materials) {
    const k = this.skeletonKey(materials);
    const entry = this.getJson('skeleton', k);
    if (!entry || !Array.isArray(entry.scenes) || !entry.scenes.length) return null;
    return { ...entry, key: k };
  }

  setSkeleton(materials, title, scenes) {
    const k = this.skeletonKey(materials);
    this.setJson('skeleton', k, {
      key: k, title, scenes, materials, at: new Date().toISOString(),
    });
    return k;
  }

  /** 最终场片段：缓存里是带配音/字幕/边框的成片片段，命中即可直接拼。 */
  getClip(k) {
    const mp4 = this.file('clip', k, '.mp4');
    const meta = this.getJson('clip', k);
    if (!meta || !meta.file || !fs.existsSync(mp4)) return null;
    return { ...meta, file: mp4, key: k };
  }

  setClip(k, meta, srcFile) {
    const mp4 = this.file('clip', k, '.mp4');
    const tmp = `${mp4}.tmp-${process.pid}-${Date.now()}`;
    fs.copyFileSync(srcFile, tmp);
    fs.renameSync(tmp, mp4);
    writeJsonAtomic(this.file('clip', k, '.json'), { ...meta, file: mp4, key: k });
    return mp4;
  }

  audioFile(k) {
    return this.file('audio', k, '.wav');
  }

  hasAudio(k) {
    try {
      return fs.statSync(this.audioFile(k)).size > 1000;
    } catch {
      return false;
    }
  }

  clipPath(k) {
    return this.file('clip', k, '.mp4');
  }
}

module.exports = { Cache, key, sha1, ensureDir, readJson, writeJsonAtomic };
