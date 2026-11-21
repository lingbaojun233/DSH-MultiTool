'use strict';
/**
 * 人设 → 音色 决策器（speak 模块）
 *
 * 目标：语音用哪个嗓子，不该由调用方拍脑袋，而该由「她是谁」决定。
 * 记忆模块的 /v1/persona 给了人格块（block）和版本号（version），
 * 这里把人设读成一份"声音画像"（性别倾向/年龄感/情绪色调），
 * 再拿它去和 BreezeBlue 的音色清单（name/labels/tone）逐条打分。
 *
 * 为什么默认用关键词而不是大模型：
 *   1) 音色选择是个"分类"问题，不是"表达"问题。人设里"少女/冷静/活泼"这些人格词，
 *      本来就是要映射到 gender/age/tone 三个维度，关键词表能覆盖，且可解释。
 *   2) 走 io 的 /v1/input 需要内部令牌 + 用户 id，而且 io 每轮会把对话写进记忆
 *      （/v1/input 没有关闭记录的开关）。为了挑个音色往主人的记忆里塞两条事件，
 *      是污染。关键词方案零副作用。
 *   3) 云 TTS 已经要等 10 秒，切人设时再多等 10~30 秒的模型往返，体验不划算。
 *   模型路径（decideWithModel）仍然实现了，config 里 personaVoice.useModel=true 才走，
 *   并且解析不出合法 voice_id 时一律自动退回关键词 —— 两条路都不抛异常。
 *
 * 缓存：{version, voiceId, name, reason, at, method, source}
 *   version 未变 → 直接返回缓存，省掉重算（/v1/voice 第二次调用因此很快）。
 */

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------- 词表

// 性别线索。'其他' 里的"他"不算男性线索，扫描前会被剔掉。
const GENDER_WORDS = {
  female: ['少女', '女孩', '女生', '姑娘', '妹子', '姐姐', '妹妹', '女声', '女性', '鲸鱼娘', '娘', '她', '闺蜜', '小姐', '姐'],
  male: ['少年', '男孩', '男生', '汉子', '大叔', '先生', '男声', '男性', '他', '哥们', '哥'],
};

// 年龄感线索。数字必须带"岁"——"六十字以内"这种字数限制不是年龄，
// 之前裸词表把"六十"当成年长线索，把鲸鱼娘判成了老年嗓。
const AGE_WORDS = {
  child: ['萝莉', '稚气', '小孩', '孩子', '童声', '小朋友', '娃娃'],
  young: ['少女', '女孩', '年轻', '青春', '学生', '十六岁', '十七岁', '十八岁', '二十岁', '少年', '元气', '少女感', '女高中生', '小姑娘'],
  middle_aged: ['成熟', '中年', '大叔', '成年', '职场', '稳重', '三十岁', '四十岁', '阿姨', '大姐', '老师'],
  old: ['老人', '苍老', '老年', '爷爷', '奶奶', '五十岁', '六十岁', '长者'],
};

// 情绪/说话方式线索 → 音色库里的 tone 词
const TONE_WORDS = {
  playful: ['活泼', '俏皮', '调皮', '顽皮', '古灵精怪', '爱闹', '爱笑', '撒娇', '可爱', '傲娇', '嘻', '玩心', '逗'],
  energetic: ['元气', '活力', '热情', '兴奋', '激情', '精力', '冲劲', '有劲'],
  bright: ['清脆', '清亮', '明亮', '甜', '爽朗', '亮堂', '开朗'],
  gentle: ['温柔', '体贴', '暖心', '温软', '柔软', '安抚', '包容', '心软', '宠'],
  friendly: ['亲切', '友好', '亲近', '好相处', '热络'],
  calm: ['冷静', '理性', '平静', '淡定', '克制', '从容', '不慌', '沉稳', '沉静', '镇定'],
  measured: ['平稳', '有条理', '节奏感', '慢条斯理', '不紧不慢', '匀速'],
  steady: ['稳', '沉着', '可靠', '踏实'],
  precise: ['精确', '准确', '精准', '咬字', '清晰', '字正腔圆', '严谨'],
  refined: ['优雅', '端庄', '知性', '文雅', '讲究', '得体'],
  articulate: ['口齿', '表达清楚', '条理', '能说', '健谈'],
  authoritative: ['权威', '专业', '老师', '坚定', '命令', '气场', '有主见', '掌控'],
  reflective: ['深思', '思考', '哲学', '反思', '睿智', '内省'],
};

// 相互打架的 tone：人设要 calm，就不能挑一个 energetic/playful 的嗓门
const TONE_OPPOSITES = [
  ['calm', 'energetic'],
  ['calm', 'playful'],
  ['calm', 'passionate'],
  ['measured', 'urgent'],
  ['gentle', 'authoritative'],
];

// 数值人格（traits）到 tone 的映射：性格维度够极端才补一条，避免 60 分的中庸值也来抢戏
const TRAIT_RULES = [
  { key: 'playfulness', min: 65, tones: ['playful'] },
  { key: 'warmth', min: 75, tones: ['gentle', 'friendly'] },
  { key: 'caution', min: 65, tones: ['calm', 'measured'] },
  { key: 'directness', min: 75, tones: ['precise'] },
];

const AGE_NEIGHBORS = {
  child: ['young'],
  young: ['child', 'middle_aged'],
  middle_aged: ['young', 'old'],
  old: ['middle_aged'],
};

// 打分权重。语义分（100/34/22/12）都远大于兜底哈希（<1），
// 所以同分时只会在"语义完全一样"的音色之间做稳定排序。
const W = {
  language: 100,
  languageMiss: -80,
  gender: 34,
  genderMiss: -22,
  age: 22,
  ageNear: 9,
  ageFar: -6,
  tone: 12,
  toneClash: -6,
};

// ---------------------------------------------------------------- 小工具

function asArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).toLowerCase()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,;|]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (typeof v === 'object') return Object.keys(v).map((k) => String(k).toLowerCase()).filter(Boolean);
  return [];
}

function hash01(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

function countWords(text, words) {
  let n = 0;
  const hits = [];
  for (const w of words) {
    let from = 0;
    let c = 0;
    for (;;) {
      const at = text.indexOf(w, from);
      if (at < 0) break;
      c += 1;
      from = at + w.length;
    }
    if (c > 0) {
      n += c;
      hits.push(w);
    }
  }
  return { n, hits };
}

// ---------------------------------------------------------------- 音色清单归一化

/**
 * 把 BreezeBlue /v1/voices 的原样对象（voice_id/labels/tone/...）或已归一化的对象，
 * 统一成决策器认识的形状。labels 在这批音色里基本是空对象，所以 tone/tags 才是主力。
 */
function normalizeVoices(raw) {
  const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.voices) ? raw.voices : []);
  return arr.map((v) => {
    const labels = v && typeof v.labels === 'object' && v.labels ? v.labels : {};
    const tones = asArray(v.tones || v.tone || labels.tone || labels.description);
    const tags = asArray(v.tags || labels.tags);
    return {
      voiceId: String(v.voiceId || v.voice_id || ''),
      name: String(v.name || ''),
      language: String(v.language || v.language_code || '').toLowerCase(),
      gender: String(v.gender || labels.gender || '').toLowerCase(),
      age: String(v.age || labels.age || '').toLowerCase(),
      tones,
      tags,
      description: String(v.description || ''),
    };
  }).filter((v) => v.voiceId);
}

// ---------------------------------------------------------------- 人设画像（纯函数）

/**
 * 从人格块里读出一份"声音画像"。
 * 纯函数：同样的 block/traits 一定得到同样的 profile，方便测试与复盘。
 */
function personaProfile(block, traits) {
  const text = String(block || '')
    .replace(/其他/g, '')       // "其他"里的"他"不是男性线索
    .replace(/他们/g, '他们')   // 保留
    .toLowerCase();

  const genderCounts = {
    female: countWords(text, GENDER_WORDS.female),
    male: countWords(text, GENDER_WORDS.male),
  };
  let gender = '';
  if (genderCounts.female.n > genderCounts.male.n) gender = 'female';
  else if (genderCounts.male.n > genderCounts.female.n) gender = 'male';

  let age = '';
  let ageBest = 0;
  for (const [key, words] of Object.entries(AGE_WORDS)) {
    const c = countWords(text, words);
    if (c.n > ageBest) { ageBest = c.n; age = key; }
  }

  const tones = [];
  const toneHits = {};
  for (const [tone, words] of Object.entries(TONE_WORDS)) {
    const c = countWords(text, words);
    if (c.n > 0) {
      tones.push(tone);
      toneHits[tone] = c.hits;
    }
  }

  // 数值人格补充：关键词没覆盖到的维度，用 traits 兜一层
  const traitHits = [];
  const t = traits && typeof traits === 'object' ? traits : {};
  for (const rule of TRAIT_RULES) {
    const v = Number(t[rule.key]);
    if (Number.isFinite(v) && v >= rule.min) {
      for (const tone of rule.tones) {
        if (!tones.includes(tone)) {
          tones.push(tone);
          toneHits[tone] = [`${rule.key}=${v}`];
          traitHits.push(`${rule.key}=${v}`);
        }
      }
    }
  }

  return {
    gender,
    age,
    tones,
    toneHits,
    genderHits: gender === 'female' ? genderCounts.female.hits.slice(0, 6)
      : gender === 'male' ? genderCounts.male.hits.slice(0, 6) : [],
    ageHits: age ? countWords(text, AGE_WORDS[age]).hits.slice(0, 6) : [],
    traitHits,
  };
}

function describeProfile(p) {
  const bits = [];
  if (p.gender) bits.push(p.gender === 'female' ? '女声' : '男声');
  if (p.age) bits.push({ child: '童声', young: '年轻', middle_aged: '中年', old: '年长' }[p.age] || p.age);
  if (p.tones.length) bits.push(p.tones.slice(0, 4).join('+'));
  return bits.join('/') || '中性';
}

// ---------------------------------------------------------------- 打分与决策（纯函数）

function scoreVoice(voice, profile) {
  let score = 0;
  const hits = [];

  if (profile.language) {
    if (voice.language === profile.language) { score += W.language; hits.push(`language=${voice.language}`); }
    else score += W.languageMiss;
  }

  if (profile.gender) {
    if (voice.gender === profile.gender) { score += W.gender; hits.push(`gender=${voice.gender}`); }
    else if (voice.gender) score += W.genderMiss;
  }

  if (profile.age) {
    if (voice.age === profile.age) { score += W.age; hits.push(`age=${voice.age}`); }
    else if (voice.age && (AGE_NEIGHBORS[profile.age] || []).includes(voice.age)) score += W.ageNear;
    else if (voice.age) score += W.ageFar;
  }

  for (const tone of profile.tones) {
    if (voice.tones.includes(tone)) { score += W.tone; hits.push(tone); }
  }

  for (const [a, b] of TONE_OPPOSITES) {
    if (profile.tones.includes(a) && voice.tones.includes(b)) score += W.toneClash;
    if (profile.tones.includes(b) && voice.tones.includes(a)) score += W.toneClash;
  }

  score += hash01(voice.voiceId) * 0.9; // 稳定兜底：同分时不随清单顺序抖动
  return { score, hits };
}

/**
 * 关键词决策：人设 + 音色清单 → {voiceId, name, reason, ...}
 * 纯函数，不读文件不发网络，验收时可直接喂两段人设文本对比结果。
 *
 * opts: {language:'zh', traits:{...}, limit:3}
 */
function decideByKeywords(block, voices, opts = {}) {
  const list = normalizeVoices(voices);
  const language = String(opts.language || 'zh').toLowerCase();
  const profile = personaProfile(block, opts.traits);

  // 语言先过滤：中文人设配英文嗓子，出来的是外国口音的中文，直接不进候选。
  let pool = list.filter((v) => v.language === language);
  let languageNote = `${language} 音色池 ${pool.length} 个`;
  if (pool.length === 0) {
    pool = list;
    languageNote = `没有 ${language} 音色，退回全部 ${list.length} 个`;
  }

  const scored = pool.map((v) => {
    const s = scoreVoice(v, Object.assign({}, profile, { language }));
    return { voice: v, score: s.score, hits: s.hits };
  }).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.voice.voiceId.localeCompare(b.voice.voiceId);
  });

  if (!scored.length) {
    return { voiceId: '', name: '', reason: '音色清单为空，无法决策', profile, method: 'keyword', candidates: [] };
  }

  const top = scored[0];
  const runnerUp = scored.slice(1, 3).map((s) => `${s.voice.name}(${s.voice.voiceId}) ${s.score.toFixed(1)}`);
  const reason = [
    `人设画像：${describeProfile(profile)}`,
    profile.genderHits.length ? `性别线索(${profile.genderHits.join('/')})` : '',
    profile.ageHits.length ? `年龄线索(${profile.ageHits.join('/')})` : '',
    profile.tones.length ? `色调(${profile.tones.map((k) => `${k}:${(profile.toneHits[k] || []).slice(0, 2).join('/')}`).join(' ')})` : '',
    `选中「${top.voice.name}」${top.voice.voiceId}，命中 ${top.hits.join('+') || '无'}，得分 ${top.score.toFixed(1)}`,
    `次选：${runnerUp.join(' / ') || '无'}`,
    languageNote,
  ].filter(Boolean).join('；');

  return {
    voiceId: top.voice.voiceId,
    name: top.voice.name,
    reason,
    method: 'keyword',
    score: Number(top.score.toFixed(1)),
    profile,
    candidates: scored.slice(0, 3).map((s) => ({ voiceId: s.voice.voiceId, name: s.voice.name, score: Number(s.score.toFixed(1)) })),
  };
}

// ---------------------------------------------------------------- 模型决策（可选，默认关闭）

function formatVoiceCatalog(voices) {
  return voices.map((v) => {
    const bits = [`${v.voiceId}`, v.name];
    if (v.language) bits.push(`lang=${v.language}`);
    if (v.gender) bits.push(`gender=${v.gender}`);
    if (v.age) bits.push(`age=${v.age}`);
    if (v.tones.length) bits.push(`tone=${v.tones.join(',')}`);
    return `- ${bits.join(' | ')}`;
  }).join('\n');
}

function buildModelPrompt(block, voices, opts = {}) {
  const language = String(opts.language || 'zh').toLowerCase();
  const pool = voices.filter((v) => !language || v.language === language);
  const list = pool.length ? pool : voices;
  return [
    '你是语音合成系统的选角器。下面是一份人格设定，和一批可用音色。',
    '请挑一个最贴合这个人格的声音。只输出一行 JSON，不要任何解释、不要 Markdown：',
    '{"voice_id":"voc_xxx","reason":"不超过40字的中文理由"}',
    '',
    '[人格设定]',
    String(block || '').slice(0, 2200),
    '',
    '[可用音色]（voice_id | 名字 | 语言 | 性别 | 年龄感 | 音色标签）',
    formatVoiceCatalog(list),
  ].join('\n');
}

/** 从模型自由发挥的回答里挖出第一个 JSON 对象，并校验 voice_id 是否在清单里。 */
function parseModelChoice(answer, voices) {
  const text = String(answer || '');
  const list = normalizeVoices(voices);
  const byId = new Map(list.map((v) => [v.voiceId, v]));
  const matches = text.match(/\{[\s\S]*?\}/g) || [];
  for (const raw of matches) {
    let obj;
    try { obj = JSON.parse(raw); } catch { continue; }
    const id = String(obj.voice_id || obj.voiceId || '').trim();
    if (byId.has(id)) {
      return {
        voiceId: id,
        name: byId.get(id).name,
        reason: String(obj.reason || '').slice(0, 200) || '模型选择（未给理由）',
        method: 'model',
      };
    }
  }
  return null;
}

/** 只在 useModel=true 且能读到内部令牌和用户 id 时才会真的发请求；任何失败返回 null。 */
async function decideWithModel(block, voices, opts = {}) {
  const ioUrl = String(opts.ioUrl || '').replace(/\/+$/, '');
  const userId = Number(opts.userId || 0);
  if (!ioUrl || !Number.isInteger(userId) || userId <= 0) return null;

  let token = String(process.env.DSH_INTERNAL_TOKEN || '');
  if (!token && opts.internalTokenPath) {
    try { token = fs.readFileSync(opts.internalTokenPath, 'utf8').trim(); } catch { token = ''; }
  }
  if (!token) return null;

  const post = async (text) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Number(opts.timeoutMs) || 90000);
    try {
      const res = await fetch(`${ioUrl}/v1/input`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dsh-internal': token,
          'x-dsh-user': String(userId),
        },
        body: JSON.stringify({ text, sessionId: 'speak-voice', persona: false }),
        signal: ac.signal,
      });
      const raw = await res.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = null; }
      return { status: res.status, data };
    } catch {
      return { status: 0, data: null };
    } finally {
      clearTimeout(timer);
    }
  };

  const prompt = buildModelPrompt(block, voices, opts);
  let r = await post(prompt);
  let picked = r.data && r.data.ok ? parseModelChoice(r.data.answer, voices) : null;
  if (!picked) {
    // 和 studio 同一套策略：只输出 JSON + 失败再催一次
    r = await post(`${prompt}\n\n上次的输出无法解析。这次只输出那行 JSON，不要别的内容。`);
    picked = r.data && r.data.ok ? parseModelChoice(r.data.answer, voices) : null;
  }
  if (picked) picked.cached = false;
  return picked;
}

// ---------------------------------------------------------------- 人设与缓存 IO

async function fetchPersona(memoryUrl, timeoutMs) {
  const base = String(memoryUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'MEMORY_URL_MISSING' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(timeoutMs) || 15000);
  try {
    const res = await fetch(`${base}/v1/persona`, { signal: ac.signal });
    const data = await res.json();
    if (!data || !data.ok || !data.block) return { ok: false, error: 'PERSONA_EMPTY', status: res.status };
    return {
      ok: true,
      block: String(data.block),
      version: Number.isFinite(Number(data.version)) ? Number(data.version) : 0,
      traits: data.traits && typeof data.traits === 'object' ? data.traits : null,
    };
  } catch (err) {
    return { ok: false, error: `PERSONA_FETCH: ${err && err.name === 'AbortError' ? 'timeout' : (err && err.message || err)}` };
  } finally {
    clearTimeout(timer);
  }
}

function readCache(cacheFile) {
  try {
    const obj = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch { return null; }
}

function writeCache(cacheFile, obj) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------- 对外主入口

/**
 * 解析"这个人设现在该用什么声音"。
 *
 * @param {object} opts
 * @param {string} opts.memoryUrl   记忆模块地址，如 http://127.0.0.1:8767
 * @param {Array}  opts.voices      BreezeBlue 音色清单（原样或归一化都行）
 * @param {string} opts.cacheFile   缓存文件，如 ...\data\speak\persona-voice.json
 * @param {boolean} opts.force      忽略缓存强制重算
 * @param {string} [opts.language]  语言池，默认 zh
 * @param {string} [opts.defaultVoiceId] 人设不可用时的兜底音色
 * @param {boolean} [opts.useModel] 是否允许走模型决策（默认 false）
 * @returns {Promise<{voiceId,name,reason,cached,version,at,method,ms}>}
 */
async function resolveVoiceForPersona(opts = {}) {
  const started = Date.now();
  const cacheFile = String(opts.cacheFile || '');
  const language = String(opts.language || 'zh').toLowerCase();
  const list = normalizeVoices(opts.voices || []);

  const persona = await fetchPersona(opts.memoryUrl, opts.memoryTimeoutMs);
  const cache = cacheFile ? readCache(cacheFile) : null;
  const version = persona.ok ? persona.version : (cache ? Number(cache.version) || 0 : 0);

  // 1) 缓存命中：版本没变就不重算；人工指定（source=manual）一直有效，直到被 force 或下一次人工指定覆盖
  const manualPin = Boolean(cache && cache.voiceId && cache.source === 'manual');
  if (!opts.force && cache && cache.voiceId && (manualPin || String(cache.version) === String(version))) {
    const v = list.find((x) => x.voiceId === cache.voiceId);
    return {
      voiceId: cache.voiceId,
      name: cache.name || (v && v.name) || '',
      reason: cache.reason || '缓存命中',
      cached: true,
      version,
      at: cache.at || '',
      method: cache.method || 'cache',
      source: cache.source || 'persona',
      score: cache.score,
      ms: Date.now() - started,
    };
  }

  // 2) 版本变了（或强制/首次）：重新决策
  let decision = null;
  if (persona.ok && opts.useModel) {
    decision = await decideWithModel(persona.block, list, {
      language,
      ioUrl: opts.ioUrl,
      userId: opts.modelUserId,
      internalTokenPath: opts.internalTokenPath,
      timeoutMs: opts.modelTimeoutMs,
    });
  }
  if (!decision && persona.ok) {
    decision = decideByKeywords(persona.block, list, { language, traits: persona.traits });
  }
  if (!decision) {
    // 3) 记忆模块不可用：用配置里的默认音色，但不假装这是人设决定
    const fallbackVoice = list.find((v) => v.voiceId === opts.defaultVoiceId) || null;
    decision = {
      voiceId: String(opts.defaultVoiceId || (fallbackVoice && fallbackVoice.voiceId) || ''),
      name: (fallbackVoice && fallbackVoice.name) || '',
      reason: `人设不可用（${persona.error || 'UNKNOWN'}），使用配置默认音色`,
      method: 'default',
      candidates: [],
    };
  }

  const at = new Date().toISOString();
  const record = {
    version,
    voiceId: decision.voiceId,
    name: decision.name,
    reason: decision.reason,
    at,
    method: decision.method || 'keyword',
    source: 'persona',
    score: decision.score,
  };
  if (cacheFile) writeCache(cacheFile, record);

  return Object.assign({}, decision, {
    cached: false,
    version,
    at,
    method: record.method,
    source: 'persona',
    ms: Date.now() - started,
  });
}

/** 人工指定：直接覆盖缓存。version 跟着当前人设版本走，人设变了才会被重新计算。 */
function pinVoice(cacheFile, { voiceId, name, reason, version, source }) {
  const at = new Date().toISOString();
  const record = {
    version: Number(version) || 0,
    voiceId: String(voiceId || ''),
    name: String(name || ''),
    reason: String(reason || '人工指定'),
    at,
    method: 'manual',
    source: source || 'manual',
  };
  const ok = writeCache(cacheFile, record);
  return Object.assign({ ok, at, cached: false }, record);
}

module.exports = {
  // 纯函数（验收可直接调）
  personaProfile,
  decideByKeywords,
  buildModelPrompt,
  parseModelChoice,
  normalizeVoices,
  // IO 相关
  fetchPersona,
  readCache,
  writeCache,
  resolveVoiceForPersona,
  pinVoice,
  // 调试用
  scoreVoice,
};
