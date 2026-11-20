'use strict';

/**
 * 文本工具：归一化、哈希、线索抽取。纯函数，供 remember / search / proactive 共用。
 */

const crypto = require('node:crypto');

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
const SPACE = /[\s\u3000]+/g;

// 时间指代：用于主动回忆的线索抽取
const TIME_CUES = ['今天', '昨天', '前天', '明天', '上周', '下周', '上个月', '去年', '今年', '刚才', '之前', '上次', '以前', '后来', '当时', '那会儿'];
// 情绪线索（粗粒度，够用即可）
const EMOTION_CUES = ['开心', '高兴', '难过', '生气', '烦', '累', '焦虑', '害怕', '期待', '失望', '喜欢', '讨厌', '尴尬', '委屈', '兴奋'];
// 回忆型问句：只有这类才触发二次精排
const RECALL_PATTERN = /(之前|上次|以前|记得|还记得|我们说过|你说过|那个事|那件事|后来呢|说好|答应过)/;

/**
 * 归一化：去表情、压空白、统一引号与省略号、去掉句尾多余符号。
 * @returns {{text:string, removedEmoji:number, changed:boolean}}
 */
function normalize(input) {
  const raw = String(input == null ? '' : input);
  let removedEmoji = 0;
  const noEmoji = raw.replace(EMOJI, () => {
    removedEmoji += 1;
    return '';
  });
  const text = noEmoji
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…+/g, '…')
    .replace(/[ \t]+/g, ' ')
    .replace(SPACE, ' ')
    .trim();
  return { text, removedEmoji, changed: text !== raw.trim() };
}

/** 归一化内容的稳定哈希（精确去重用）。 */
function contentHash(normalized, extra = '') {
  return crypto.createHash('sha256').update(`${normalized}${extra}`).digest('hex').slice(0, 32);
}

/** 是否值得入库的粗筛：闲聊（太短、纯语气词）直接跳过。 */
function isChitchat(normalized) {
  const text = String(normalized || '').trim();
  if (text.length < 4) return true;
  // 纯标点/表情
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  const fillers = /^(嗯|哦|啊|哈|呵|好|好的|行|可以|收到|了解|ok|okay|谢谢|拜拜|晚安|早安)+[。！？.!?~]*$/iu;
  return fillers.test(text);
}

/**
 * 线索抽取：实体、时间指代、情绪、话题词。
 * 这里故意用规则而不是模型——线索必须可复现、零成本。
 */
function extractCues(text) {
  const value = String(text || '');
  const times = TIME_CUES.filter((cue) => value.includes(cue));
  const emotions = EMOTION_CUES.filter((cue) => value.includes(cue));

  const mentions = [...value.matchAll(/@([^\s@,，。！？]{1,20})/g)].map((m) => m[1]);
  const ids = [...value.matchAll(/\b(\d{5,12})\b/g)].map((m) => m[1]);
  const latins = [...value.matchAll(/\b[A-Za-z][A-Za-z0-9_-]{2,30}\b/g)].map((m) => m[0]);
  const cjkRuns = value.match(/[\u4e00-\u9fff]{2,8}/g) || [];

  return {
    mentions,
    ids,
    latins: [...new Set(latins)].slice(0, 10),
    topics: [...new Set(cjkRuns)].slice(0, 10),
    times,
    emotions,
  };
}

/** 只有回忆型问句才触发二次精排。 */
function isRecallQuestion(query) {
  return RECALL_PATTERN.test(String(query || ''));
}

/** 是否改变了未来行为：承诺、关系、事实、高情绪。用于入库门槛。 */
function isWorthRemembering(normalized, cues) {
  const text = String(normalized || '');
  if (isChitchat(text)) return false;

  const commitment = /(答应|说好|约定|保证|承诺|下次|以后都|记得要|别忘了|务必)/.test(text);
  const relation = /(是(我|你)的|叫我|称呼|我们是|我(爸|妈|哥|姐|弟|妹|对象|朋友))/.test(text);
  const factLike = /(叫|住在|位于|在[^\s]{1,12}(工作|上班|读书)|生日|电话|微信|qq|QQ|账号|密码|地址|价格|预算|版本|端口|路径)/.test(text);
  const emotional = (cues && cues.emotions && cues.emotions.length > 0) && text.length >= 12;

  return commitment || relation || factLike || emotional;
}

module.exports = {
  normalize,
  contentHash,
  isChitchat,
  isWorthRemembering,
  extractCues,
  isRecallQuestion,
  TIME_CUES,
  EMOTION_CUES,
};
