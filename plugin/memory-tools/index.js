/**
 * @dsh-multitool/memory-tools
 *
 * 把 DSH-MultiTool 的能力注册成 DSH 原生工具，让模型像使用 bash/fs 一样直接调用，
 * 而不是只看到一段目录散文、然后自己 ls/find 翻文件。
 *
 * 不 import @deepseek-ai/dsh-tools：profile 里解析不到该包；ctx.tools.register
 * 接受的就是 defineTool 编译后的普通对象（name/description/parameters/output/execute）。
 */

import { execFile } from 'node:child_process';
import path from 'node:path';

export const name = 'memory-tools';
export const inject = ['tools'];

const DEFAULT_MEMORY_URL = process.env.DSH_MEMORY_URL || 'http://127.0.0.1:8767';
const DEFAULT_REGISTRY_DIR = process.env.DSH_REGISTRY_DIR || 'C:\\Apps\\DSH-MultiTool\\registry';
const DEFAULT_NODE = process.env.DSH_NODE || 'C:\\Apps\\DSH-MultiTool\\core\\runtime\\node\\node.exe';

async function postJson(url, body, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    try {
      return { status: res.status, data: JSON.parse(text) };
    } catch {
      return { status: res.status, data: { ok: false, error: text } };
    }
  } finally {
    clearTimeout(timer);
  }
}

function textBlock(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
}

export function apply(ctx, config) {
  const memoryUrl = (config && config.memoryUrl) || DEFAULT_MEMORY_URL;
  const registryDir = (config && config.registryDir) || DEFAULT_REGISTRY_DIR;
  const nodeBin = (config && config.nodeBin) || DEFAULT_NODE;

  // 1) 检索
  ctx.tools.register({
    name: 'memory_search',
    description:
      'Recall memories from past sessions under a strict count+token budget. Every item carries an evidence locator. Returns empty when nothing matches — never invent.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Natural language or keywords' },
        max_items: { type: 'integer', minimum: 1, maximum: 32, description: 'Default 8' },
        max_tokens: { type: 'integer', minimum: 50, maximum: 4000, description: 'Default 1200' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textBlock(value),
    },
    async execute(args) {
      const { data } = await postJson(`${memoryUrl}/v1/tools/memory_search`, {
        query: String(args.query || ''),
        budget: {
          max_items: args.max_items || 8,
          max_tokens: args.max_tokens || 1200,
        },
      });
      return data;
    },
  });

  // 2) 写入
  ctx.tools.register({
    name: 'memory_remember',
    description:
      'Persist one event. Evidence is mandatory: "source:locator" such as chat:g123#m456. Chat-chatter and duplicates are rejected with a reason.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['content', 'evidence'],
      properties: {
        content: { type: 'string', description: 'What was said or done' },
        evidence: { type: 'string', description: 'source:locator' },
        kind: { type: 'string', enum: ['msg', 'video', 'action', 'commitment'] },
        speaker: { type: 'string' },
        salience: { type: 'integer', minimum: 0, maximum: 100 },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textBlock(value),
    },
    async execute(args) {
      const { data } = await postJson(`${memoryUrl}/v1/tools/memory_remember`, {
        content: String(args.content || ''),
        evidence: String(args.evidence || ''),
        kind: args.kind || 'msg',
        speaker_name: args.speaker,
        salience: args.salience,
        channel: 'chat',
      });
      return data;
    },
  });

  // 3) 遗忘
  ctx.tools.register({
    name: 'memory_forget',
    description:
      'Soft-delete one memory (event:<id>). It becomes unsearchable immediately, is audited, and can be undone with {undo:true, tombstoneId}.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'event:123 or 123' },
        reason: { type: 'string' },
        undo: { type: 'boolean' },
        tombstone_id: { type: 'integer' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textBlock(value),
    },
    async execute(args) {
      const { data } = await postJson(`${memoryUrl}/v1/tools/memory_forget`, {
        id: args.id,
        reason: args.reason,
        undo: Boolean(args.undo),
        tombstoneId: args.tombstone_id,
      });
      return data;
    },
  });

  // 4) 模块用法
  ctx.tools.register({
    name: 'read_module',
    description:
      'Load one module\'s usage card (when to use, when not, inputs/outputs, one example). Use it before acting on a module instead of grepping its files.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Module name from the catalog, e.g. memory' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textBlock(value && value.content ? value.content : value),
    },
    execute(args) {
      const cli = path.join(registryDir, 'cli.js');
      const moduleName = String(args.name || '');
      return new Promise((resolve) => {
        execFile(
          nodeBin,
          [cli, 'read', moduleName, '--json'],
          { cwd: registryDir, timeout: 10000, windowsHide: true },
          (err, stdout, stderr) => {
            if (err) {
              resolve({ ok: false, code: 'READ_FAILED', message: String(stderr || err.message) });
              return;
            }
            try {
              resolve(JSON.parse(stdout));
            } catch {
              resolve({ ok: true, content: String(stdout) });
            }
          },
        );
      });
    },
  });
}
