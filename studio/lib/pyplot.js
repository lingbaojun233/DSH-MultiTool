'use strict';
/**
 * pyplot.js -- 让模型"写 Python 画图"。
 *
 * 为什么值得多一层：数学教学里"画个函数曲线/曲面/向量场"，用 matplotlib 比
 * 任何手绘图元都准，而且是**真算出来的**（求导、积分、坐标变换都对）。
 * 代价是每题一次 Python 进程（约 1~3 秒），比 GDI 慢但换来的正确性值。
 *
 * 安全边界：只在本机跑、只给一个输出路径、超时即杀、不传网络与文件系统能力
 * （代码由我们自己写的模板包裹，模型只能填画图部分）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e && e.message || e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** 把模型给的画图代码裹进固定模板：字体、后端、保存路径都由我们决定。 */
function wrapScript(code, outFile, w, h) {
  return [
    'import matplotlib',
    "matplotlib.use('Agg')",
    'import matplotlib.pyplot as plt',
    'import numpy as np',
    "plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'SimHei', 'DejaVu Sans']",
    "plt.rcParams['axes.unicode_minus'] = False",
    "plt.rcParams['figure.facecolor'] = '#0d1220'",
    "plt.rcParams['axes.facecolor'] = '#0d1220'",
    "plt.rcParams['savefig.facecolor'] = '#0d1220'",
    "plt.rcParams['text.color'] = '#e8eefc'",
    "plt.rcParams['axes.labelcolor'] = '#e8eefc'",
    "plt.rcParams['xtick.color'] = '#8fa3c8'",
    "plt.rcParams['ytick.color'] = '#8fa3c8'",
    "plt.rcParams['axes.edgecolor'] = '#3a4a70'",
    `_OUT = ${JSON.stringify(outFile)}`,
    `_W, _H = ${w}, ${h}`,
    'try:',
    '    fig = plt.gcf()',
    '    fig.set_size_inches(_W / 120.0, _H / 120.0)',
    'except Exception:',
    '    pass',
    '',
    '# ---- model code ----',
    code,
    '# ---- end ----',
    '',
    'plt.tight_layout()',
    'plt.savefig(_OUT, dpi=120, facecolor=plt.rcParams["savefig.facecolor"])',
    'print("SAVED", _OUT)',
  ].join('\n');
}

async function renderPyplot({ python, work, index, code, w = 1920, h = 1080, timeoutMs = 90000 }) {
  if (!code || typeof code !== 'string') return { ok: false, error: 'NO_CODE' };
  const outFile = path.join(work, `plot-${index}.png`);
  const script = path.join(work, `plot-${index}.py`);
  fs.writeFileSync(script, wrapScript(code, outFile.replace(/\\/g, '/'), w, h), 'utf8');

  const r = await run(python, ['-X', 'utf8', script], timeoutMs);
  const exists = fs.existsSync(outFile) && fs.statSync(outFile).size > 5000;
  if (r.code !== 0 || !exists) {
    return { ok: false, error: `PYPLOT_FAILED(code=${r.code}) ${(r.err || r.out || '').slice(-400)}` };
  }
  return { ok: true, png: outFile, error: null };
}

module.exports = { renderPyplot };
