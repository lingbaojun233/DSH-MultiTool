'use strict';

/**
 * Evidence gate. A memory without a locator is not a memory, it is a rumour:
 * anything missing evidence.source / evidence.locator is rejected here and
 * logged, never silently dropped.
 */

const crypto = require('node:crypto');

const ACTORS = new Set(['user', 'dsh', 'system']);
const KINDS = new Set(['message', 'action', 'observation']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function makeId(prefix) {
  // 时间有序 + 随机，避免依赖外部库
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(5).toString('hex');
  return `${prefix}_${ts}${rand}`;
}

function normaliseEvidence(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = text(raw.source);
  const locator = text(raw.locator);
  if (!source || !locator) return null;
  const evidence = { source, locator };
  const excerpt = text(raw.excerpt);
  if (excerpt) evidence.excerpt = excerpt.slice(0, 200);
  return evidence;
}

/**
 * @returns {{ok:true, event:object} | {ok:false, errors:string[]}}
 */
function validateEvent(input) {
  const errors = [];
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['body must be an object'] };
  }

  const body = text(input.text);
  if (!body) errors.push('text is required');
  if (body.length > 4000) errors.push('text exceeds 4000 characters');

  const actor = text(input.actor) || 'user';
  if (!ACTORS.has(actor)) errors.push(`actor must be one of ${[...ACTORS].join(', ')}`);

  const kind = text(input.kind) || 'message';
  if (!KINDS.has(kind)) errors.push(`kind must be one of ${[...KINDS].join(', ')}`);

  const evidence = normaliseEvidence(input.evidence);
  if (!evidence) errors.push('evidence.source and evidence.locator are required');

  if (errors.length) return { ok: false, errors };

  const salienceRaw = Number(input.salience);
  const salience = Number.isFinite(salienceRaw) ? Math.min(1, Math.max(0, salienceRaw)) : 0.5;

  const ts = text(input.ts) || new Date().toISOString();
  if (Number.isNaN(Date.parse(ts))) return { ok: false, errors: ['ts is not a valid ISO8601 timestamp'] };

  const event = {
    id: makeId('evt'),
    ts,
    actor,
    kind,
    text: body,
    evidence,
    entities: Array.isArray(input.entities) ? input.entities.map(text).filter(Boolean).slice(0, 20) : [],
    tags: Array.isArray(input.tags) ? input.tags.map(text).filter(Boolean).slice(0, 20) : [],
    salience,
    sessionId: text(input.sessionId) || 'unknown',
  };
  event.hash = crypto.createHash('sha256').update(`${event.ts}|${event.actor}|${event.text}|${event.evidence.locator}`).digest('hex').slice(0, 16);

  return { ok: true, event };
}

module.exports = { validateEvent, makeId };
