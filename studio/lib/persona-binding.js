'use strict';
/**
 * persona-binding.js -- 把"人设"翻译成三件能执行的事：音色 / 风格 / 语气。
 *
 * 为什么单独一层：
 *   - 音色由 speak 按人设挑（GET /v1/voice），风格由 studio 按人设关键词映射
 *     （lib/styles.js 的 resolvePersonaStyle），这两条各自有实现，但都**说不出
 *     人话**：面板要给用户看"为什么是这个人、这个风格"。
 *   - 语气没人管：旁白以前是播音腔，因为提示词里只有"口语、一句一个意思"，
 *     不知道她自称什么、爱用什么语气词、情绪偏硬还是偏软。
 *
 * 这里的做法：从人设正文里抽出**可以照着写**的几条（自称、称呼、语气词、
 * 情绪倾向），拼成一段提示词块；同时给人一句短标签（如"温柔口语"）给面板展示。
 * 全部是确定性文本分析，不额外调模型 —— 每次生成旁白都多一次模型调用不值得。
 */

// 情绪/说话方式线索。命中数越多，越能代表这个人的默认口气。
// 顺序就是平票时的优先级：温柔 > 顽皮 > 傲娇 > 可爱 > 直率 > 冷静。
const TONE_RULES = [
  { id: 'gentle', label: '温柔', words: ['温柔', '心软', '体贴', '安慰', '哄', '暖', '撒娇', '软'] },
  { id: 'playful', label: '顽皮', words: ['顽皮', '俏皮', '调皮', '抬杠', '吐槽', '嬉', '得意', '爱玩'] },
  { id: 'shy', label: '傲娇', words: ['傲娇', '嘴硬', '害羞', '别扭', '嘟囔', '不好意思', '炸毛'] },
  { id: 'cute', label: '可爱', words: ['可爱', '天然呆', '迷糊', '贪吃', '摸鱼', '好哄', '呆'] },
  { id: 'sharp', label: '直率', words: ['直率', '直接', '犀利', '毒舌', '怼', '损'] },
  { id: 'calm', label: '冷静', words: ['冷静', '平静', '克制', '安静', '稳', '慢'] },
];

// 语气词：人设正文里出现过的才写进提示词。写一堆它不用的语气词，旁白立刻变味。
const PARTICLES = ['呀', '啦', '嘛', '诶', '嘿嘿', '嘻嘻', '呜', '哦', '嗯', '哈', '唉', '欸'];

// 数值人格（traits）到语气标签的补充：正文没关键词时，靠数值兜底。
const TRAIT_TONE = [
  { key: 'warmth', min: 75, id: 'gentle' },
  { key: 'playfulness', min: 70, id: 'playful' },
  { key: 'directness', min: 75, id: 'sharp' },
  { key: 'caution', min: 70, id: 'calm' },
];

const LABEL_BY_ID = {};
for (const r of TONE_RULES) LABEL_BY_ID[r.id] = r.label;

function countOccurrences(text, word) {
  if (!word) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(word, from);
    if (at < 0) break;
    n += 1;
    from = at + word.length;
  }
  return n;
}

function dedupe(list) {
  const out = [];
  for (const v of list) {
    const s = String(v || '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * 抽"自称"。人设正文里一般写成：
 *   自称三选一：我（默认）/ 人家（撒娇害羞）/ 本鲸鱼（得意自嘲），一条消息只用一次。
 * 括号里是解释，不能当成自称，所以先剥掉括号再切分。
 */
function extractSelfRefs(block) {
  const src = String(block || '');
  const m = src.match(/自称[^\n]{0,10}[：:]\s*([^\n]{0,90})/);
  const region = m ? m[1] : '';
  const found = [];
  if (region) {
    const cleaned = region.replace(/[（(][^）)]*[）)]/g, ' ').replace(/[，,。；;].*$/, '');
    for (const part of cleaned.split(/[\/、|，,]+/)) {
      const w = part.replace(/[“”"'‘’\s]/g, '').trim();
      if (w && w.length <= 6 && !/^[a-z0-9]+$/i.test(w)) found.push(w);
      if (found.length >= 3) break;
    }
  }
  // 正文里直接出现的自称也算（有的版本没写"自称"那一行）
  for (const w of ['人家', '本鲸鱼', '咱', '我']) {
    if (countOccurrences(src, w) > 0 && found.length < 3) found.push(w);
  }
  return dedupe(found).slice(0, 3);
}

/** 抽"怎么称呼对方"。人设里通常写：默认称呼“主人” */
function extractAddress(block) {
  const src = String(block || '');
  const m = src.match(/称呼[^\n]{0,6}[“"「『]([^”"」』]{1,8})[”"」』]/)
    || src.match(/喊他[^\n]{0,4}[“"「『]([^”"」』]{1,8})[”"」』]/);
  return m ? m[1].trim() : '';
}

/** 语气词：只保留正文里出现过的，按出现次数排序。 */
function extractParticles(block) {
  const src = String(block || '');
  const hits = PARTICLES
    .map((w) => ({ w, n: countOccurrences(src, w) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((x) => x.w);
  return hits.slice(0, 5);
}

/**
 * 打分挑主口气。traits 只在正文关键词缺失时补分，避免"60 分的中庸值"抢戏。
 * 返回 { id, label, scores, runnerUp }。
 */
function pickTone(block, traits) {
  const src = String(block || '');
  const scores = {};
  for (const rule of TONE_RULES) {
    let n = 0;
    for (const w of rule.words) n += countOccurrences(src, w);
    scores[rule.id] = n;
  }
  const tr = traits && typeof traits === 'object' ? traits : {};
  for (const rule of TRAIT_TONE) {
    const v = Number(tr[rule.key]);
    if (Number.isFinite(v) && v >= rule.min) scores[rule.id] = (scores[rule.id] || 0) + 2;
  }
  let best = TONE_RULES[0];
  for (const rule of TONE_RULES) {
    if ((scores[rule.id] || 0) > (scores[best.id] || 0)) best = rule;
  }
  const sorted = TONE_RULES
    .map((r) => ({ id: r.id, label: r.label, score: scores[r.id] || 0 }))
    .sort((a, b) => b.score - a.score);
  const runnerUp = sorted[1] && sorted[1].score > 0 && sorted[1].score * 3 >= Math.max(1, sorted[0].score) * 2
    ? sorted[1].label
    : '';
  return { id: best.id, label: best.label, scores, runnerUp };
}

/**
 * 人设 → 语气描述。block 为空时返回一个中性的兜底（宁可没个性，也不要瞎编）。
 * 返回 { label, tags, selfRefs, particles, address, runnerUp, scores }。
 */
function describeTone(block, traits) {
  const src = String(block || '');
  if (!src.trim()) {
    return {
      label: '平静口语',
      tags: ['中性'],
      selfRefs: [],
      particles: [],
      address: '',
      runnerUp: '',
      scores: {},
      empty: true,
    };
  }
  const picked = pickTone(src, traits);
  const selfRefs = extractSelfRefs(src);
  const particles = extractParticles(src);
  const address = extractAddress(src);
  const tags = dedupe([picked.label, picked.runnerUp].filter(Boolean));
  return {
    label: `${picked.label}口语`,
    tags,
    selfRefs,
    particles,
    address,
    runnerUp: picked.runnerUp,
    scores: picked.scores,
    empty: false,
  };
}

/**
 * 旁白语气提示词块。
 * 写给人听的那几句必须是"可执行约束"，不能是形容词堆砌 ——
 * 模型对"温柔一点"的理解和我们对"不要播音腔"的理解完全不是一回事。
 *
 * opts.spoken=false 时用于"写稿拆场"：旁白要尽量用用户原话，语气只影响
 * 补的过渡词，不能为了口语化改写原稿。
 */
function narrationTonePrompt(tone, opts = {}) {
  const t = tone || describeTone('', null);
  const spoken = opts.spoken !== false;
  const lines = ['## 旁白口气（照这个人设说，不要播音腔）'];
  const bits = [];
  if (t.label) bits.push(`整体：${t.label}`);
  if (t.tags && t.tags.length > 1) bits.push(`底色：${t.tags.join('+')}`);
  if (bits.length) lines.push(`- ${bits.join('；')}`);
  if (t.selfRefs && t.selfRefs.length) {
    lines.push(`- 自称只用：${t.selfRefs.join(' / ')}（一句话里最多出现一次）`);
  }
  if (t.address) lines.push(`- 称呼对方「${t.address}」，一句一次就够，别句句都喊`);
  if (t.particles && t.particles.length) {
    lines.push(`- 语气词可以用：${t.particles.join(' ')}，一句最多一个，不要叠`);
  }
  if (spoken) {
    lines.push('- 像平时说话：短句、口语、可以有不完整句；一句一个意思，别一口气讲三层');
    lines.push('- 不要书面语，不要"首先/其次/最后/综上所述"，不要总结升华，不要每句都下结论');
    lines.push('- 不要电视解说腔：不要"让我们一起……""接下来我们来看……""你学会了吗"');
    lines.push('- 讲知识也要像在跟人聊天：可以"你看啊""这个有意思""别急"这种起头');
  } else {
    lines.push('- 这一轮的旁白要尽量保留稿子原话，不要为了口语化改写；语气只影响你补的过渡词');
    lines.push('- 不要把原话改成"首先/其次/综上所述"这类书面结构，也不要加总结句');
  }
  return lines;
}

module.exports = {
  TONE_RULES,
  PARTICLES,
  describeTone,
  narrationTonePrompt,
  extractSelfRefs,
  extractAddress,
  extractParticles,
  pickTone,
};
