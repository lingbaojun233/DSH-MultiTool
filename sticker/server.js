'use strict';
/**
 * DSH-MultiTool :: sticker（表情包）
 *
 * 目标：让 DSH 能"发一个 GIF 表情"，而不是只发文字。
 *
 * 朴素做法是把 157 个原始 GIF（460MB）直接丢出去，但那样每个都有 4~8MB，
 * 微信/QQ 里发一张要转半天圈，手机端还会被压得糊掉。所以这里分两层：
 *   orig  —— 原始包（只做归档，不对外发）
 *   send  —— 压缩过的"可发送版"（300px/15fps/80 色，约 0.9MB），对外一律发这个
 *
 * 目录：
 *   data\stickers\send\<id>.gif     实际发送的图
 *   data\stickers\catalog.json      id -> {name, mood, tags}，由打包脚本生成
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const DIR = __dirname;
const HOST = '127.0.0.1';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const CFG = Object.assign({
  port: 8773,
  dataDir: 'C:\\Apps\\DSH-MultiTool\\data\\stickers',
  defaultLimit: 60,
  maxLimit: 200,
  ffmpeg: 'C:\\Apps\\DSH-MultiTool\\tools\\ffmpeg\\bin\\ffmpeg.exe',
  // 借视频模块的视觉能力（它持有 key，sticker 不该再存一份）
  videoUrl: 'http://127.0.0.1:8769',
  describeTimeoutMs: 60000,
}, readJson(path.join(DIR, 'config.json'), {}));

const SEND_DIR = path.join(CFG.dataDir, 'send');
const CATALOG_FILE = path.join(CFG.dataDir, 'catalog.json');
const DESCRIBE_FILE = path.join(CFG.dataDir, 'descriptions.json');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.join(DIR, '..', 'logs'), { recursive: true });
    fs.appendFileSync(path.join(DIR, '..', 'logs', 'sticker.log'), line + '\n');
  } catch { }
}

// ---------------------------------------------------------------- 识图 ----

/**
 * 从 GIF 里抽一帧。优先取第 12 帧（约 0.8 秒，绕开开场白），
 * 短图（不足 13 帧）就退回第一帧 —— 否则抽出来是空图，视觉模型会瞎猜。
 */
function extractFrame(gifPath, outPng) {
  return new Promise((resolve) => {
    const tryFrame = (vf, cb) => {
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', gifPath];
      if (vf) args.push('-vf', vf);
      args.push('-frames:v', '1', outPng);
      const child = spawn(CFG.ffmpeg, args, { windowsHide: true });
      let err = '';
      child.stderr.on('data', (d) => { err += d.toString('utf8'); });
      child.on('error', (e) => cb(false, String(e && e.message || e)));
      child.on('close', (code) => {
        const ok = code === 0 && fs.existsSync(outPng) && fs.statSync(outPng).size > 1000;
        cb(ok, err);
      });
    };
    tryFrame('select=eq(n\\,12)', (ok, err1) => {
      if (ok) return resolve({ ok: true, png: outPng });
      tryFrame(null, (ok2, err2) => {
        resolve({ ok: ok2, png: outPng, error: (err2 || err1 || '').slice(0, 200) });
      });
    });
  });
}

function readDescriptions() {
  return readJson(DESCRIBE_FILE, {}) || {};
}

/** 让视觉模型描述一张表情。结果按 id 缓存：同一张图不该反复花钱。 */
async function describeSticker(id, force) {
  const cache = readDescriptions();
  if (!force && cache[id] && cache[id].text) {
    return { ok: true, id, description: cache[id].text, cached: true, at: cache[id].at };
  }
  const gif = path.join(SEND_DIR, `${id}.gif`);
  if (!fs.existsSync(gif)) return { ok: false, error: 'NOT_FOUND' };

  const work = path.join(os.tmpdir(), `sticker-${id}-${Date.now()}.png`);
  const frame = await extractFrame(gif, work);
  if (!frame.ok) return { ok: false, error: 'FRAME_EXTRACT_FAILED', detail: frame.error };

  let dataUrl;
  try {
    dataUrl = 'data:image/png;base64,' + fs.readFileSync(work).toString('base64');
  } finally {
    try { fs.unlinkSync(work); } catch { }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CFG.describeTimeoutMs);
  try {
    const res = await fetch(`${CFG.videoUrl}/v1/look`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: dataUrl,
        prompt: '用一句中文描述这张表情图：里面画的是什么、什么情绪/动作、图上有没有字。不要客套，不超过 40 字。',
      }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok || !data.description) {
      return { ok: false, error: (data && data.error) || `look HTTP ${res.status}` };
    }
    cache[id] = { text: data.description, at: new Date().toISOString(), model: data.model || '' };
    try { fs.writeFileSync(DESCRIBE_FILE, JSON.stringify(cache, null, 1), 'utf8'); } catch { }
    log(`described ${id}: ${data.description}`);
    return { ok: true, id, description: data.description, cached: false, model: data.model };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ 目录 ----

let catalog = { items: [], byId: new Map(), builtAt: 0 };

/**
 * 扫描 send\ 建目录。catalog.json 里有人写好的名字就用它，
 * 没有就退化成用 id 当名字 —— 不要因为缺一份元数据就让整个模块不工作。
 */
function buildCatalog() {
  fs.mkdirSync(SEND_DIR, { recursive: true });
  const meta = readJson(CATALOG_FILE, null);
  const metaById = new Map();
  if (meta && Array.isArray(meta.items)) {
    for (const it of meta.items) if (it && it.id) metaById.set(String(it.id), it);
  }

  const items = [];
  const byId = new Map();
  let files = [];
  try { files = fs.readdirSync(SEND_DIR); } catch { files = []; }
  for (const file of files) {
    if (!/\.gif$/i.test(file)) continue;
    const id = file.replace(/\.gif$/i, '');
    const m = metaById.get(id) || {};
    const stat = fs.statSync(path.join(SEND_DIR, file));
    const item = {
      id,
      name: String(m.name || file),
      mood: String(m.mood || ''),
      tags: Array.isArray(m.tags) ? m.tags.slice(0, 8) : [],
      bytes: stat.size,
      mtime: stat.mtimeMs,
    };
    items.push(item);
    byId.set(id, item);
  }
  items.sort((a, b) => (a.mood || a.name).localeCompare(b.mood || b.name, 'zh'));
  catalog = { items, byId, builtAt: Date.now() };
  log(`catalog built: ${items.length} stickers, ${Math.round(items.reduce((a, x) => a + x.bytes, 0) / 1048576)}MB`);
  return catalog;
}

// 用户怎么说 → 表情里怎么叫。没有这张表，"开心"就匹配不到表情「笑」。
const SYNONYMS = {
  开心: ['笑', '庆祝', '加油', '期待', '干杯', '点赞', '舞蹈', '爱心'],
  高兴: ['笑', '庆祝', '加油', '干杯'],
  快乐: ['笑', '庆祝', '舞蹈'],
  笑: ['笑', '舔舔', '摇头'],
  难过: ['哭', '害怕', '紧张', '自我安慰'],
  伤心: ['哭', '死亡', '自我安慰'],
  委屈: ['哭', '害怕', '问号'],
  生气: ['生气', '打字(生气)', '小丑', '摇头', '敲头'],
  烦: ['生气', '打字(恼怒)', '头晕', '叹气'],
  无语: ['问号', '呆', '摇头', '汗'],
  问号: ['问号', '呆'],
  睡觉: ['睡觉', '工作(小睡)', '催眠'],
  困: ['睡觉', '工作(小睡)', '催眠'],
  累: ['工作(疲倦)', '睡觉', '死亡', '自我安慰'],
  上班: ['工作', '停止工作', '带薪拉屎', '坐牢', '打字'],
  打工: ['工作', '停止工作', '带薪拉屎', '坐牢'],
  不想上班: ['停止工作', '坐牢', '带薪拉屎', '工作(疲倦)', '死亡'],
  摸鱼: ['带薪拉屎', '坐牢', '打游戏', '睡觉'],
  下班: ['停止工作', '庆祝', '干杯'],
  喜欢: ['爱心', '情书', '玫瑰', '摸头', '被击中(爱心)'],
  爱: ['爱心', '情书', '玫瑰'],
  比心: ['爱心', '被击中(爱心)'],
  谢谢: ['爱心', '鞠躬', '点头', '礼物'],
  你好: ['打招呼', '点头'],
  打招呼: ['打招呼'],
  再见: ['打招呼', '摇头'],
  吃: ['吃', '馋', '奶酪糊脸'],
  饿: ['吃', '馋', '死亡'],
  馋: ['馋', '吃'],
  喝: ['喝', '干杯', '摇可乐'],
  钱: ['钱', '要米', '拿走我的钱', '红包'],
  穷: ['要米', '拿走我的钱', '钱'],
  红包: ['红包', '钱', '礼物'],
  恭喜: ['庆祝', '蛋糕', '礼物', '红包', '干杯'],
  庆祝: ['庆祝', '蛋糕', '礼物', '荧光棒'],
  生日: ['蛋糕', '庆祝', '礼物'],
  加油: ['加油', '点赞', '荧光棒', '期待'],
  鼓励: ['加油', '点赞', '摸头'],
  无语了: ['问号', '呆', '汗'],
  震惊: ['惊吓', '叹号', '问号'],
  害怕: ['害怕', '惊吓', '紧张'],
  紧张: ['紧张', '汗', '打字(恼怒)'],
  思考: ['思考', '正在思考', '呆'],
  打游戏: ['打游戏', '驾驶', '手柄'],
  音乐: ['唱歌', '吉他', '跳舞', '舞蹈'],
  唱歌: ['唱歌', '吉他'],
  跳舞: ['跳舞', '舞蹈(散味)'],
  点赞: ['点赞', '反向点赞', '加油'],
  摸头: ['摸头', '爱心'],
  刀: ['刀', '撬棍', '枪'],
  死: ['死亡', '小丑', '坐牢'],
  可以: ['点赞', '点头', '到达'],
  好的: ['点赞', '点头'],
};

/** 把一句话拆成"要去找的表情词"：原词 + 同义词 + 分词 */
function expandQuery(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const terms = new Set([q]);
  for (const [key, list] of Object.entries(SYNONYMS)) {
    if (q.includes(key) || key.includes(q)) {
      for (const t of list) terms.add(t);
    }
  }
  // 中文没有空格，按 2 字滑窗再兜一层（"我今天不想上班" → "不想" "想上" "上班"）
  if (q.length >= 4) {
    for (let i = 0; i + 2 <= q.length; i++) terms.add(q.slice(i, i + 2));
  }
  return [...terms];
}

/** 关键词打分：表情名是中文，直接做子串命中就够了，不需要模型。 */
function scoreItem(item, query) {
  const q = String(query || '').trim();
  if (!q) return 1;
  const hay = `${item.mood} ${item.name} ${item.tags.join(' ')}`.toLowerCase();
  let best = 0;
  const terms = expandQuery(q);

  for (let i = 0; i < terms.length; i++) {
    const t = String(terms[i]).toLowerCase();
    if (!t) continue;
    let s = 0;
    if (item.mood.toLowerCase() === t) s = 3;
    else if (item.mood.toLowerCase().startsWith(t)) s = 2;
    else if (hay.includes(t)) s = 1;
    // 单字太容易误命中（"笑"能命中"笑话"），只给很低的分
    if (!s && t.length === 1) continue;
    // 同义词表里越靠前越优先："开心"该先想到「笑」，而不是同分的「点赞」
    s *= Math.max(0.5, 1 - i * 0.08);
    if (s > best) best = s;
  }
  if (best) return best;

  // 最后兜底：逐字命中比例过半，给一个很低的分数
  let hits = 0;
  for (const ch of q) if (ch.trim() && hay.includes(ch)) hits += 1;
  return hits >= Math.ceil(q.length * 0.6) ? 0.4 : 0;
}

// ------------------------------------------------------------------ http ---

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/v1/health') {
      if (!catalog.items.length) buildCatalog();
      return json(res, 200, {
        ok: true,
        count: catalog.items.length,
        bytes: catalog.items.reduce((a, x) => a + x.bytes, 0),
        sendDir: SEND_DIR,
        catalog: fs.existsSync(CATALOG_FILE),
      });
    }

    if (req.method === 'GET' && p === '/v1/reload') {
      buildCatalog();
      return json(res, 200, { ok: true, count: catalog.items.length });
    }

    if (req.method === 'GET' && p === '/v1/list') {
      if (!catalog.items.length) buildCatalog();
      const q = url.searchParams.get('q') || '';
      const limit = Math.min(CFG.maxLimit, Math.max(1, Number(url.searchParams.get('limit')) || CFG.defaultLimit));
      const scored = catalog.items
        .map((it) => ({ it, s: scoreItem(it, q) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => (b.s - a.s) || (a.it.mood || a.it.name).localeCompare(b.it.mood || b.it.name, 'zh'))
        .slice(0, limit)
        .map((x) => x.it);
      return json(res, 200, { ok: true, total: catalog.items.length, count: scored.length, items: scored });
    }

    // 按心情/一句话挑一张（给聊天用）
    if (req.method === 'GET' && p === '/v1/pick') {
      if (!catalog.items.length) buildCatalog();
      const q = url.searchParams.get('q') || url.searchParams.get('mood') || '';
      const scored = catalog.items
        .map((it) => ({ it, s: scoreItem(it, q) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s);
      if (!scored.length) return json(res, 200, { ok: false, error: 'NO_MATCH', items: catalog.items.slice(0, 3) });
      const top = scored[0].it;
      return json(res, 200, { ok: true, sticker: top, candidates: scored.slice(0, 5).map((x) => x.it) });
    }

    // 识图：没有表情名（外部传来的图）时靠它，结果会缓存
    if ((req.method === 'GET' || req.method === 'POST') && p === '/v1/describe') {
      const id = String(url.searchParams.get('id') || '');
      if (!/^[0-9a-f]{6,40}$/i.test(id)) return json(res, 400, { ok: false, error: 'BAD_ID' });
      const force = url.searchParams.get('force') === '1';
      const r = await describeSticker(id, force);
      return json(res, 200, r);
    }

    if (req.method === 'GET' && p === '/v1/gif') {
      const id = String(url.searchParams.get('id') || '');
      if (!/^[0-9a-f]{6,40}$/i.test(id)) return json(res, 400, { ok: false, error: 'BAD_ID' });
      const file = path.join(SEND_DIR, `${id}.gif`);
      if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: 'NOT_FOUND' });
      const stat = fs.statSync(file);
      res.writeHead(200, {
        'content-type': 'image/gif',
        'content-length': stat.size,
        // 表情不变，可以放心缓存
        'cache-control': 'public, max-age=604800',
      });
      return fs.createReadStream(file).pipe(res);
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    log('ERROR ' + (err && err.stack || err));
    return json(res, 500, { ok: false, error: String(err && err.message || err) });
  }
});

server.listen(CFG.port, HOST, () => {
  buildCatalog();
  log(`sticker on http://${HOST}:${CFG.port}  send=${SEND_DIR}`);
});
