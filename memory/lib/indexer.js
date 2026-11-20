'use strict';

/**
 * In-memory inverted index built from the append-only event log.
 * The snapshot on disk is a cache: it can always be rebuilt from the log,
 * so a corrupt index is never data loss.
 */

const store = require('./store.js');
const { extractTerms } = require('./tokens.js');

const state = {
  events: [],
  byId: new Map(),
  terms: new Map(), // term -> Set(eventId)
  builtAt: null,
};

function indexEvent(event) {
  state.events.push(event);
  state.byId.set(event.id, event);
  const terms = new Set([
    ...extractTerms(event.text),
    ...(event.entities || []).flatMap((e) => extractTerms(e)),
    ...(event.tags || []).flatMap((t) => extractTerms(t)),
  ]);
  for (const term of terms) {
    if (!state.terms.has(term)) state.terms.set(term, new Set());
    state.terms.get(term).add(event.id);
  }
}

function rebuild() {
  state.events = [];
  state.byId.clear();
  state.terms.clear();
  for (const event of store.readAllEvents()) indexEvent(event);
  state.builtAt = new Date().toISOString();
  return state;
}

function add(event) {
  indexEvent(event);
  return event;
}

function candidates(queryTerms) {
  const hits = new Map(); // id -> matched term count
  for (const term of queryTerms) {
    const postings = state.terms.get(term);
    if (!postings) continue;
    for (const id of postings) hits.set(id, (hits.get(id) || 0) + 1);
  }
  return hits;
}

function recent(limit) {
  return state.events.slice(-limit);
}

function snapshot() {
  return {
    builtAt: state.builtAt,
    events: state.events.length,
    terms: state.terms.size,
  };
}

module.exports = { rebuild, add, candidates, recent, snapshot, state };
