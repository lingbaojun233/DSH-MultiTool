'use strict';
/**
 * gdi-scene.js -- 用 GDI+（draw.ps1）把"绘图指令 JSON"渲染成讲解画面。
 *
 * 为什么不用无头浏览器：Edge/Chromium 在计划任务的服务账户下根本起不来
 * （SYSTEM 40ms 退出，新建本地用户会挂死）。GDI+ 没有这个限制，80ms 就能出图。
 *
 * 代价：模型不能随便写 HTML/SVG 了，要写一份受限的绘图 DSL。
 * 好处：确定性强、快、任何账户都能跑。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

function runPowerShell(script, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e && e.message || e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** PNG 是否像一张有内容的图（纯色图字节数会很小）。 */
function pngUsable(file) {
  try {
    const st = fs.statSync(file);
    return st.size > 8000;
  } catch { return false; }
}

/**
 * 渲染一场景的静帧（按 step 出多张）。
 * spec 形如 {title, bg1, bg2, shapes:[{step,type,...}], steps:[...]}
 */
async function renderGdiStills({ psScript, work, index, spec, w = 1920, h = 1080, timeoutMs = 60000 }) {
  const outDir = path.join(work, `gdi-${index}`);
  fs.mkdirSync(outDir, { recursive: true });
  const specFile = path.join(work, `spec-${index}.json`);
  const payload = Object.assign({ index, bg1: '#101a33', bg2: '#0b1220' }, spec || {});
  fs.writeFileSync(specFile, JSON.stringify(payload), 'utf8');

  const r = await runPowerShell(psScript, ['-SpecFile', specFile, '-OutDir', outDir, '-Width', String(w), '-Height', String(h)], timeoutMs);
  const pngs = fs.existsSync(outDir)
    ? fs.readdirSync(outDir).filter((f) => /^gdi-.*\.png$/i.test(f)).sort().map((f) => path.join(outDir, f))
    : [];
  const usable = pngs.filter(pngUsable);
  if (r.code !== 0 || !usable.length) {
    return { ok: false, error: `GDI_FAILED(code=${r.code}) ${(r.err || '').slice(0, 300)}`, pngs: usable };
  }
  return { ok: true, pngs: usable, error: null };
}

module.exports = { renderGdiStills, runPowerShell };
