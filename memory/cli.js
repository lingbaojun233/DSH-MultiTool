#!/usr/bin/env node
'use strict';

/**
 * memory CLI —— 供 DSH 以 bash/终端方式调用，与 HTTP 接口同源。
 *
 *   node cli.js remember --data '{"content":"...","evidence":"chat:g1#m1"}'
 *   node cli.js remember "文本内容" --evidence chat:g1#m1 --channel chat
 *   node cli.js search "上次说过的部署路径" --max-items 5 --max-tokens 600
 *   node cli.js forget event:12 --reason "用户要求"
 *   node cli.js undo 3
 *   node cli.js nightly --dry-run
 *   node cli.js persona
 *   node cli.js proactive --turn 42 --session s1
 *   node cli.js stats
 *
 * 默认输出人类可读文本，--json 输出结构化结果（机器调用用）。
 */

const fs = require('node:fs');
const path = require('node:path');

const { open } = require('./db/open.js');
const { remember } = require('./lib/remember.js');
const { search } = require('./lib/search.js');
const { nightly, forget, undoForget } = require('./lib/maintenance.js');
const { proactiveRecall } = require('./lib/proactive.js');
const persona = require('./lib/persona.js');
const { toResponse } = require('./lib/errors.js');

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

function print(value, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

const [command, ...rest] = process.argv.slice(2);
const { flags, positional } = parseArgs(rest);
const asJson = Boolean(flags.json);
const db = open();
persona.initPersona(db);

try {
  switch (command) {
    case 'remember': {
      let input;
      // Windows 记事本/PowerShell 5.1 写 UTF-8 会带 BOM，JSON.parse 会直接炸
      if (flags.file) input = JSON.parse(fs.readFileSync(path.resolve(flags.file), 'utf8').replace(/^\uFEFF/, ''));
      else if (flags.data) input = JSON.parse(flags.data);
      else input = { content: positional.join(' '), evidence: flags.evidence, channel: flags.channel || 'chat' };

      const result = remember(db, input);
      if (asJson) print({ ok: true, ...result }, true);
      else {
        print(result.stored ? `已记住 ${result.eventId}（显著度 ${result.salience}）` : `未入库：${result.reason}`);
        if (result.facts && result.facts.length) print(`事实：${result.facts.map((f) => `${f.subject} ${f.predicate} ${f.object}`).join('；')}`);
      }
      break;
    }

    case 'search': {
      const query = positional.join(' ');
      const result = search(db, {
        query,
        context: flags.session ? { sessionId: flags.session } : {},
        budget: { maxItems: Number(flags['max-items'] || 8), maxTokens: Number(flags['max-tokens'] || 1200) },
      });
      if (asJson) {
        print({ ok: true, ...result }, true);
      } else if (!result.items.length) {
        print('（没有相关记忆）');
      } else {
        result.items.forEach((item, index) => {
          print(`${index + 1}. ${item.content || item.text}  ⟵ ${item.evidence || ''}  [${item.score != null ? item.score.toFixed(3) : ''}]`);
        });
        print(`— ${result.used.count} 条 / ${result.used.tokens} token（预算 ${result.budget.maxItems} 条 / ${result.budget.maxTokens} token）`);
      }
      break;
    }

    case 'forget': {
      const target = positional[0] || flags.id;
      const result = forget(db, target, flags.reason || 'user_request');
      print(result, asJson);
      break;
    }

    case 'undo': {
      const result = undoForget(db, Number(positional[0] || flags.tombstone));
      print(result, asJson);
      break;
    }

    case 'nightly': {
      const dryRun = Boolean(flags['dry-run']);
      const result = { maintenance: nightly(db, { dryRun }), persona: persona.consolidate(db, { dryRun }) };
      print(result, asJson);
      break;
    }

    case 'persona': {
      print(asJson ? persona.getPersona(db) : persona.render(db), asJson);
      break;
    }

    case 'proactive': {
      const result = proactiveRecall(db, {
        turn: Number(flags.turn || 0),
        sessionId: flags.session || 'default',
        cues: flags.cues ? JSON.parse(flags.cues) : {},
      });
      print(result, asJson);
      break;
    }

    case 'stats': {
      const counts = {
        events: db.prepare('SELECT COUNT(*) c FROM events WHERE deleted = 0').get().c,
        facts: db.prepare('SELECT COUNT(*) c FROM facts WHERE deleted = 0').get().c,
        conflicts: db.prepare("SELECT COUNT(*) c FROM facts WHERE status = 'conflict'").get().c,
        entities: db.prepare('SELECT COUNT(*) c FROM entities').get().c,
        tombstones: db.prepare('SELECT COUNT(*) c FROM tombstones').get().c,
      };
      print(counts, asJson);
      break;
    }

    default:
      process.stderr.write(
        '用法: node cli.js <remember|search|forget|undo|nightly|persona|proactive|stats> [参数] [--json]\n',
      );
      process.exitCode = 2;
  }
} catch (err) {
  print(toResponse(err), true);
  process.exitCode = 1;
} finally {
  db.close();
}
