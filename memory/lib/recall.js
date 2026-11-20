'use strict';

/**
 * Recall: filter -> score -> pack under a dual budget (items AND tokens).
 *
 * Defaults come from the design: at most 8 items and 1200 tokens. Callers may
 * ask for less, never more than the hard ceiling (32 items / 4000 tokens).
 */

const fs = require('node:fs');
const path = require('node:path');
const indexer = require('./indexer.js');
const store = require('./store.js');
const { estimateTokens, extractTerms } = require('./tokens.js');

const DEFAULTS = { maxItems: 8, maxTokens: 1200 };
const CEILING = { maxItems: 32, maxTokens: 4000 };
const IDENTITY_BUDGET = 200;
const RECENCY_HALF_LIFE_DAYS = 14;

function clampBudget(raw) {
  const maxItems = Math.min(CEILING.maxItems, Math.max(1, Number(raw && raw.maxItems) || DEFAULTS.maxItems));
  const maxTokens = Math.min(CEILING.maxTokens, Math.max(50, Number(raw && raw.maxTokens) || DEFAULTS.maxTokens));
  return { maxItems, maxTokens };
}

function readIdentity() {
  const dir = path.join(store.DATA_DIR, 'identity');
  try {
    if (!fs.existsSync(dir)) return null;
    const files = fs
      .readdirSync(dir)
      .filter((name) => /^identity\.v\d+\.(yaml|yml|txt)$/.test(name))
      .sort((a, b) => Number(a.match(/v(\d+)/)[1]) - Number(b.match(/v(\d+)/)[1]));
    if (!files.length) return null;
    const raw = fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8').trim();
    if (!raw) return null;
    let text = raw;
    if (estimateTokens(text) > IDENTITY_BUDGET) {
      // Hard cap: identity is a budget, not a dumping ground.
      let clipped = '';
      for (const ch of text) {
        if (estimateTokens(clipped + ch) > IDENTITY_BUDGET) break;
        clipped += ch;
      }
      text = `${clipped}…`;
    }
    return { file: files[files.length - 1], text, tokens: estimateTokens(text) };
  } catch {
    return null;
  }
}

function ageInDays(iso, now) {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 365;
  return Math.max(0, (now - ts) / 86400000);
}

function scoreOf(event, queryTerms, matched, now) {
  const matchRatio = queryTerms.length ? matched / queryTerms.length : 0;
  const recency = Math.exp(-ageInDays(event.ts, now) / RECENCY_HALF_LIFE_DAYS);
  const salience = typeof event.salience === 'number' ? event.salience : 0.5;
  // layer weight: only events exist in P0 (facts arrive with consolidation)
  const layerWeight = 0.5;
  return {
    score: Number((0.5 * matchRatio + 0.3 * recency + 0.2 * salience).toFixed(4)),
    parts: { matchRatio: Number(matchRatio.toFixed(3)), recency: Number(recency.toFixed(3)), salience, layerWeight },
  };
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * @param {string} query
 * @param {{maxItems?:number, maxTokens?:number}} rawBudget
 * @returns {object} { identity, items, used, truncated, candidates }
 */
function recall(query, rawBudget) {
  const budget = clampBudget(rawBudget);
  const now = Date.now();
  const queryTerms = extractTerms(query || '');
  const hits = indexer.candidates(queryTerms);

  // Candidates: index hits first, then recent events as fallback so an empty or
  // unusual query still has something to work with.
  const pool = [];
  for (const [id, matched] of hits) {
    const event = indexer.state.byId.get(id);
    if (event) pool.push({ event, matched });
  }
  if (pool.length < budget.maxItems) {
    const seen = new Set(pool.map((entry) => entry.event.id));
    for (const event of indexer.recent(budget.maxItems * 2)) {
      if (seen.has(event.id)) continue;
      pool.push({ event, matched: 0 });
    }
  }

  const ranked = pool
    .map((entry) => ({ ...entry, ...scoreOf(entry.event, queryTerms, entry.matched, now) }))
    .sort((a, b) => b.score - a.score || String(b.event.ts).localeCompare(String(a.event.ts)));

  const items = [];
  let usedTokens = 0;
  let truncated = false;

  for (const entry of ranked) {
    if (items.length >= budget.maxItems) {
      truncated = true;
      break;
    }
    const full = truncate(entry.event.text, 300);
    const short = truncate(entry.event.text, 80);
    let chosen = null;
    for (const candidate of [full, short]) {
      const tokens = estimateTokens(candidate);
      if (usedTokens + tokens <= budget.maxTokens) {
        chosen = { text: candidate, tokens };
        break;
      }
    }
    if (!chosen) {
      truncated = true;
      continue;
    }
    usedTokens += chosen.tokens;
    items.push({
      id: entry.event.id,
      layer: 'event',
      ts: entry.event.ts,
      actor: entry.event.actor,
      text: chosen.text,
      tokens: chosen.tokens,
      score: entry.score,
      parts: entry.parts,
      evidence: entry.event.evidence,
    });
  }

  return {
    identity: readIdentity(),
    items,
    used: { count: items.length, tokens: usedTokens },
    budget,
    truncated,
    candidates: ranked.length,
  };
}

/** Renders the block that goes into a prompt. */
function renderBlock(result) {
  const lines = [];
  if (result.identity) {
    lines.push('[identity]');
    lines.push(result.identity.text);
    lines.push('');
  }
  if (result.items.length) {
    lines.push('[memory]');
    for (const [i, item] of result.items.entries()) {
      const ev = item.evidence ? `${item.evidence.source}:${item.evidence.locator}` : 'no-evidence';
      lines.push(`${i + 1}. [${item.id}] ${item.text}  ⟵ ${ev}`);
    }
  }
  return lines.join('\n');
}

module.exports = { recall, renderBlock, clampBudget, DEFAULTS, CEILING, IDENTITY_BUDGET };
