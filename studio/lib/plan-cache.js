'use strict';
/**
 * 规划缓存（plan cache）：把"模型写出来的规划结果"按内容哈希存下来，第二次同输入零调用。
 *
 * 两层，粒度不同：
 *   1) 场级（scenes/）—— 一段 manim 代码只依赖「这一场画什么 + 风格 + 引擎」。
 *      同一份稿子第二次做、只改其中一句，都能只补改掉的那几场。
 *   2) 骨架级（skeletons/）—— （主题或稿子, 秒数, 风格）→ 整份分镜数组
 *      （title + 每场的 text/narration/seconds/visual_hint…），省掉"拆场/写骨架"那一次调用。
 *
 * 为什么用"一条一个文件"而不是一个 scenes.jsonl：
 *   - 淘汰按**最后使用时间**，单文件方案要靠改写整个文件来更新使用时间；这里直接
 *     用文件 mtime 当 LRU 时间戳（命中时 utimes），淘汰时按 mtime 排序删，最简单。
 *   - 一条坏了只坏一条：JSON 解析失败就删掉这一个文件，别的条目不受影响。
 *   - 写入走「临时文件 + rename」，进程被杀不会留下半截 JSON。
 *
 * 键的设计（和 server.js 里的调用一一对应）：
 *   scene    = sha1( normalize(hint) + '|' + styleSign + '|' + kind )
 *   skeleton = sha1( normalize(text) + '|' + seconds  + '|' + styleSign + '|' + extra )
 *   normalize = trim + 压缩连续空白成一个空格 + 英文小写
 *   styleSign = S.signature(style)（第一位就是风格 id，配色/线宽/字体变了也会换键）
 *   extra     = 模式（prompt/script）+ 语气行 —— 换人设语气要重新拆场
 *
 * 关掉（config.json 的 planCache:false）时所有方法都是空操作，行为与加缓存之前完全一致。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_TTL_DAYS = 30;
const DEFAULT_MAX_ENTRIES = 500;
// 清理节流：每次 put 都全量扫盘没必要，30 秒最多扫一次
const SWEEP_INTERVAL_MS = 30 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** trim + 压缩空白 + 英文小写（中文不受影响）。 */
function normalizeText(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().toLowerCase();
}

function sha1(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex');
}

/** 场级键。hint 已经是缓存材料（visual_hint，或没有时用标题+旁白拼出来的）。 */
function sceneKey(input) {
  const it = input || {};
  return sha1(`${normalizeText(it.hint)}|${String(it.style == null ? '' : it.style)}|${String(it.kind == null ? '' : it.kind)}`);
}

/** 骨架级键。 */
function skeletonKey(input) {
  const it = input || {};
  const seconds = Number(it.seconds);
  return sha1([
    normalizeText(it.text),
    Number.isFinite(seconds) ? String(Math.round(seconds * 1000) / 1000) : '0',
    String(it.style == null ? '' : it.style),
    normalizeText(it.extra),
  ].join('|'));
}

/** 日志里用的短哈希（6 位，和任务书里的 "hint 哈希 ab12cd" 对齐）。 */
function shortHash(hash) {
  return String(hash || '').slice(0, 6);
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { }
}

function rmFile(file) {
  try { fs.rmSync(file, { force: true }); } catch { }
}

/**
 * 建一个缓存实例。
 * @param {{dir?:string, enabled?:boolean, ttlDays?:number, maxEntries?:number, log?:Function}} opts
 */
function createPlanCache(opts = {}) {
  const state = {
    dir: '',
    enabled: true,
    ttlDays: DEFAULT_TTL_DAYS,
    maxEntries: DEFAULT_MAX_ENTRIES,
    log: typeof opts.log === 'function' ? opts.log : () => { },
    lastSweep: 0,
    // 命中率只在进程内统计（重启归零）：它衡量的是"这台机器跑起来的这半天里省了多少调用"，
    // 落盘会把上一个版本/上一次实验的数字混进来，反而看不出当前效果。
    counts: { scene: { hit: 0, miss: 0, put: 0 }, skeleton: { hit: 0, miss: 0, put: 0 } },
  };

  function dirFor(kind) {
    return path.join(state.dir, kind === 'skeleton' ? 'skeletons' : 'scenes');
  }

  function bump(kind, field) {
    const slot = state.counts[kind === 'skeleton' ? 'skeleton' : 'scene'];
    if (slot) slot[field] += 1;
  }

  function configure(o = {}) {
    if (o.dir != null) state.dir = String(o.dir || '');
    if (o.enabled != null) state.enabled = o.enabled !== false;
    if (o.ttlDays != null) state.ttlDays = Math.max(0, Number(o.ttlDays) || 0);
    if (o.maxEntries != null) state.maxEntries = Math.max(1, Math.floor(Number(o.maxEntries) || DEFAULT_MAX_ENTRIES));
    if (typeof o.log === 'function') state.log = o.log;
    if (state.dir) {
      ensureDir(dirFor('scene'));
      ensureDir(dirFor('skeleton'));
    }
    state.lastSweep = 0;
    return state;
  }

  function ttlMs() {
    // ttlDays <= 0 当成"永不过期"：0 天通常是想关掉缓存，那应该用 planCache:false，
    // 让它顺带在下一毫秒全部失效会让人以为"缓存坏了"。
    return state.ttlDays > 0 ? state.ttlDays * DAY_MS : 0;
  }

  function filePath(kind, key) {
    return path.join(dirFor(kind), `${key}.json`);
  }

  /** 读一条。返回记录对象或 null；顺带维护 mtime(=最后使用时间)、过期删除、坏文件删除。 */
  function readEntry(kind, key) {
    if (!state.enabled || !state.dir) return null;
    const file = filePath(kind, key);
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { bump(kind, 'miss'); return null; }
    let rec = null;
    try { rec = JSON.parse(raw); } catch { rmFile(file); bump(kind, 'miss'); return null; }
    // 内容损坏 / 键对不上（比如文件被外部换过）：当没命中，删掉重来
    if (!rec || typeof rec !== 'object' || rec.key !== key) {
      rmFile(file);
      bump(kind, 'miss');
      return null;
    }
    const ttl = ttlMs();
    if (ttl > 0) {
      let age = 0;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { age = 0; }
      if (age > ttl) {
        rmFile(file);
        bump(kind, 'miss');
        return null;
      }
    }
    // 命中即"使用"：把 mtime 推到现在，LRU 淘汰才不会先把常读的条目踢掉
    try {
      const now = new Date();
      fs.utimesSync(file, now, now);
    } catch { }
    bump(kind, 'hit');
    return rec;
  }

  function writeEntry(kind, key, payload) {
    if (!state.enabled || !state.dir) return false;
    if (!key || !payload) return false;
    const dir = dirFor(kind);
    ensureDir(dir);
    const file = path.join(dir, `${key}.json`);
    const rec = Object.assign({ v: 1, key, kind: kind === 'skeleton' ? 'skeleton' : 'scene' }, payload, {
      savedAt: new Date().toISOString(),
    });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(rec), 'utf8');
      fs.renameSync(tmp, file);
    } catch {
      rmFile(tmp);
      return false;
    }
    bump(kind, 'put');
    // 超量/过期清理挂在写路径上（读路径不扫盘，命中要快）
    maybeSweep();
    return true;
  }

  /** 列出某个目录下的条目 [file, mtimeMs, bytes]。 */
  function listFiles(kind) {
    const dir = dirFor(kind);
    let names = null;
    try { names = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) continue;
        out.push({ file, mtimeMs: st.mtimeMs, bytes: st.size, kind });
      } catch { }
    }
    return out;
  }

  /** 过期删除 + 超量按最后使用时间淘汰（两层共用一个条目上限）。 */
  function sweep() {
    state.lastSweep = Date.now();
    if (!state.dir) return { expired: 0, evicted: 0 };
    const ttl = ttlMs();
    const now = Date.now();
    let expired = 0;
    const alive = [];
    for (const kind of ['scene', 'skeleton']) {
      for (const it of listFiles(kind)) {
        if (ttl > 0 && now - it.mtimeMs > ttl) {
          rmFile(it.file);
          expired += 1;
        } else {
          alive.push(it);
        }
      }
    }
    let evicted = 0;
    if (alive.length > state.maxEntries) {
      alive.sort((a, b) => a.mtimeMs - b.mtimeMs); // 最久没用的先删
      for (const it of alive.slice(0, alive.length - state.maxEntries)) {
        rmFile(it.file);
        evicted += 1;
      }
    }
    if (expired || evicted) {
      state.log(`规划缓存清理：过期 ${expired} 条，超量淘汰 ${evicted} 条（上限 ${state.maxEntries} 条）`);
    }
    return { expired, evicted };
  }

  function maybeSweep() {
    if (Date.now() - state.lastSweep < SWEEP_INTERVAL_MS) return;
    try { sweep(); } catch { }
  }

  // ---- 场级 ----
  function getScenePlan(input) {
    const it = input || {};
    const key = sceneKey(it);
    const rec = readEntry('scene', key);
    if (!rec || typeof rec.code !== 'string' || !rec.code.trim()) return null;
    return { code: rec.code, scene: rec.scene || null, note: rec.note || '', key };
  }

  function putScenePlan(input) {
    const it = input || {};
    if (typeof it.code !== 'string' || !it.code.trim()) return false;
    return writeEntry('scene', sceneKey(it), {
      hint: String(it.hint == null ? '' : it.hint).slice(0, 2000),
      style: String(it.style == null ? '' : it.style),
      kind: String(it.kind == null ? '' : it.kind),
      code: it.code,
      scene: it.scene || null,
      note: it.note == null ? '' : String(it.note).slice(0, 300),
    });
  }

  /** 删掉某一场的缓存（缓存里的代码被安全闸门拒收时用）。 */
  function dropScenePlan(input) {
    if (!state.enabled || !state.dir) return false;
    const file = filePath('scene', sceneKey(input || {}));
    try { fs.rmSync(file, { force: true }); return true; } catch { return false; }
  }

  // ---- 骨架级 ----
  function getSkeleton(input) {
    const key = skeletonKey(input || {});
    const rec = readEntry('skeleton', key);
    if (!rec || !Array.isArray(rec.scenes) || !rec.scenes.length) return null;
    return { title: String(rec.title || ''), scenes: rec.scenes, key };
  }

  function putSkeleton(input) {
    const it = input || {};
    if (!Array.isArray(it.scenes) || !it.scenes.length) return false;
    return writeEntry('skeleton', skeletonKey(it), {
      text: String(it.text == null ? '' : it.text).slice(0, 4000),
      seconds: Number(it.seconds) || 0,
      style: String(it.style == null ? '' : it.style),
      extra: String(it.extra == null ? '' : it.extra).slice(0, 2000),
      title: String(it.title || '').slice(0, 120),
      scenes: it.scenes,
    });
  }

  function dropSkeleton(input) {
    if (!state.enabled || !state.dir) return false;
    try { fs.rmSync(filePath('skeleton', skeletonKey(input || {})), { force: true }); return true; } catch { return false; }
  }

  /** 观测用：条目数、字节数、命中率。 */
  function stats() {
    const sceneFiles = state.dir ? listFiles('scene') : [];
    const skeletonFiles = state.dir ? listFiles('skeleton') : [];
    const bytes = sceneFiles.reduce((a, f) => a + f.bytes, 0) + skeletonFiles.reduce((a, f) => a + f.bytes, 0);
    const rate = (slot) => {
      const total = slot.hit + slot.miss;
      return total ? Math.round((slot.hit / total) * 1000) / 1000 : 0;
    };
    return {
      ok: true,
      enabled: state.enabled,
      dir: state.dir,
      ttlDays: state.ttlDays,
      maxEntries: state.maxEntries,
      scenes: sceneFiles.length,
      skeletons: skeletonFiles.length,
      entries: sceneFiles.length + skeletonFiles.length,
      bytes,
      hitRate: { scene: rate(state.counts.scene), skeleton: rate(state.counts.skeleton) },
      hits: { scene: state.counts.scene.hit, skeleton: state.counts.skeleton.hit },
      misses: { scene: state.counts.scene.miss, skeleton: state.counts.skeleton.miss },
      puts: { scene: state.counts.scene.put, skeleton: state.counts.skeleton.put },
    };
  }

  /** 清空两层缓存（DELETE /v1/plan-cache）。命中率计数一起归零。 */
  function clear() {
    const before = stats();
    if (state.dir) {
      for (const kind of ['scene', 'skeleton']) {
        const dir = dirFor(kind);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
        ensureDir(dir);
      }
    }
    state.counts.scene = { hit: 0, miss: 0, put: 0 };
    state.counts.skeleton = { hit: 0, miss: 0, put: 0 };
    state.lastSweep = Date.now();
    return { removed: before.entries, bytes: before.bytes, scenes: before.scenes, skeletons: before.skeletons };
  }

  configure(opts);

  return {
    configure, stats, clear, sweep,
    getScenePlan, putScenePlan, dropScenePlan,
    getSkeleton, putSkeleton, dropSkeleton,
    // 给 server.js 打日志用
    state,
  };
}

module.exports = {
  createPlanCache,
  normalizeText,
  sceneKey,
  skeletonKey,
  shortHash,
  DEFAULT_TTL_DAYS,
  DEFAULT_MAX_ENTRIES,
};
