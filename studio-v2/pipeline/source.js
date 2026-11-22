'use strict';
/**
 * source.js -- 把一条已完成的任务导出成「可以自己改的 manim 工程」（zip）。
 *
 * 目的：用户在面板里改代码之外，还想要一份离线工程 —— 解压后 manim / VS Code
 * 都能直接开，改完本地就能出片。所以每个 sceneNN.py 必须是能独立渲染的完整文件：
 *   from manim import *  +  from dsh_kit import *  +  一个 Scene 子类
 *
 * 约定：
 *   - sceneNN.py 里的代码是"渲染时真正跑的那份"（去掉自动注入的 helper 块，改由
 *     dsh_kit.py 提供 near()/label_at()/label_on_line()），保证和服务器成片一致；
 *   - 导出不含配音/字幕/边框（那些是服务端后处理），render.ps1 只拼画面；
 *   - 文件名固定、排序固定、sha256 写进 manifest.json，方便校验和复现。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const M = require('./manim');

const ENGINE_ZH = {
  manim: 'manim 动画',
  text: '文字卡（导出为占位场景）',
  sticker: '表情卡（导出为占位场景）',
};

/** 一场的稳定文件名：scene01 / scene02 ... */
function stemOf(index) {
  return `scene${String(index + 1).padStart(2, '0')}`;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 从任务记录里挑风格：request.style 是用户选的 id，空则用默认风格。 */
function pickStyle(job, cfg) {
  const styles = (cfg && cfg.styles) || {};
  const wanted = String((job.request && job.request.style) || '').trim();
  const fallback = String((cfg && cfg.defaultStyle) || 'whiteboard');
  return styles[wanted] || styles[fallback] || {
    id: wanted || fallback,
    name: wanted || fallback,
    bg: '#FFFFFF',
    fg: '#1A1A1A',
    accent: '#002FA7',
    font: (cfg && cfg.fontName) || 'Microsoft YaHei',
  };
}

/** dsh_kit.py：服务器渲染时自动注入的布局助手，导出成单独模块。 */
function kitSource() {
  const body = String(M.LAYOUT_HELPERS || '')
    .split(/\r?\n/)
    .filter((line) => !/^# ---/.test(line))
    .join('\n')
    .trim();
  return [
    '# -*- coding: utf-8 -*-',
    '# dsh_kit.py -- dsh-studio 渲染时自动注入的布局助手。',
    '# 导出工程里这些函数在这个文件里，sceneNN.py 用 from dsh_kit import * 拿到。',
    '# 想改行为直接改这里（改完所有场一起生效）。',
    '',
    // 助手的默认参数用了 UP/DOWN 这些常量：不 import manim 的话模块一加载就 NameError
    'from manim import *',
    '',
    body,
    '',
  ].join('\n');
}

/** 保证文件里有 from dsh_kit import *：插在最后一行 import 之后。 */
function withKitImport(code) {
  const src = String(code || '');
  if (/from\s+dsh_kit\s+import/.test(src)) return src;
  const lines = src.split(/\r?\n/);
  let lastImport = -1;
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    if (/^\s*(from\s+[^\s]+\s+import|import\s+[^\s]+)/.test(lines[i])) {
      lastImport = i;
      continue;
    }
    if (lines[i].trim() && !/^\s*#/.test(lines[i]) && lastImport >= 0) break;
  }
  if (lastImport < 0) return `from manim import *\nfrom dsh_kit import *\n\n${src}`;
  return [...lines.slice(0, lastImport + 1), 'from dsh_kit import *', ...lines.slice(lastImport + 1)].join('\n');
}

/** 单场 manim 代码 → 可独立渲染的文件正文（含文件头注释）。 */
function sceneCode(job, scene, style, cfg, index, total) {
  const enhanced = M.enhanceCode((scene.manim && scene.manim.code) || '', scene, style, cfg, {
    locked: Boolean(scene.manim && scene.manim.locked),
    noProbe: true,
  });
  // stripInjected 只切掉我们自己注入的 helper 段；背景色、风格色、字体增强都留着
  const body = M.stripInjected ? M.stripInjected(enhanced.code) : enhanced.code;
  const stem = stemOf(index);
  const cls = (scene.manim && scene.manim.scene) || M.guessSceneName(body) || '';
  const header = [
    '# -*- coding: utf-8 -*-',
    `# dsh-studio 导出 | 任务 ${job.id} | 第 ${index + 1}/${total} 场`,
    `# 引擎：manim | 计划时长：${Number(scene.seconds) || 0} 秒 | 类名：${cls || '（未解析出来）'}`,
    `# 本地渲染：manim -qm ${stem}.py ${cls || '<ClassName>'}`,
    '# 提示：near() / label_at() / label_on_line() 来自同目录的 dsh_kit.py',
    '',
    '',
  ].join('\n');
  return header + withKitImport(body).trim() + '\n';
}

/** text / sticker 场没有 manim 代码：给一个能跑的占位场景，render.ps1 不会因此中断。 */
function placeholderCode(index, scene, style) {
  const cls = `Scene${String(index + 1).padStart(2, '0')}`;
  const shown = String(scene.text || scene.narration || '').slice(0, 60);
  const font = (style && style.font) || 'Microsoft YaHei';
  const fg = (style && style.fg) || '#1A1A1A';
  const bg = (style && style.bg) || '#FFFFFF';
  return [
    'from manim import *',
    'from dsh_kit import *',
    '',
    '',
    `class ${cls}(Scene):`,
    '    """占位场景：这一场在服务器上是文字卡/表情卡，不是 manim 动画。',
    '    这里只把它的标题摆出来，方便你照着改成本地动画。"""',
    '',
    '    def construct(self):',
    `        self.camera.background_color = ${JSON.stringify(bg)}`,
    `        label = Text(${JSON.stringify(shown)}, font=${JSON.stringify(font)}, font_size=44, color=${JSON.stringify(fg)})`,
    '        label.move_to(ORIGIN)',
    '        self.play(Write(label), run_time=1.0)',
    '        self.wait(1.0)',
    '',
  ].join('\n');
}

function validIdent(name) {
  return /^[\p{L}_][\p{L}\p{N}_]{0,63}$/u.test(String(name || ''));
}

/** 渲染脚本（PowerShell）：纯 ASCII，Windows PowerShell 5.1 才不会被 ANSI 误读。 */
function renderPs1() {
  return `# render.ps1 -- render every scene locally and join them into final.mp4 (video only).
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\\render.ps1
#   powershell -ExecutionPolicy Bypass -File .\\render.ps1 -Manim "C:\\path\\manim.cmd" -Ffmpeg "C:\\path\\ffmpeg.exe"
# Each sceneNN.py is a standalone manim file; its class name and planned seconds
# are in sceneNN.meta.json. We render, pad/trim to those seconds, then concat.
param(
    [string]$Manim = 'manim',
    [string]$Ffmpeg = 'ffmpeg',
    [string]$Quality = '-qm',
    [string]$Width = '1920',
    [string]$Height = '1080',
    [string]$Fps = '30'
)

$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot
try {
    $metas = @(Get-ChildItem -Filter 'scene*.meta.json' | Sort-Object Name)
    if ($metas.Count -eq 0) { throw 'no scene*.meta.json found next to render.ps1' }

    $parts = New-Object System.Collections.ArrayList
    $i = 0
    foreach ($metaFile in $metas) {
        $i++
        $meta = Get-Content -LiteralPath $metaFile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        $stem = [System.IO.Path]::GetFileNameWithoutExtension([System.IO.Path]::GetFileNameWithoutExtension($metaFile.Name))
        $py = Join-Path $PSScriptRoot ($stem + '.py')
        if (-not (Test-Path -LiteralPath $py)) { throw ('missing ' + $py) }
        $cls = [string]$meta.className
        $sec = [double]$meta.seconds
        if ($sec -le 0) { $sec = 4 }

        Write-Host ('[' + $i + '/' + $metas.Count + '] ' + $stem + ' -> ' + $cls + ' (' + $sec + 's)')
        $media = Join-Path $PSScriptRoot ('media\\' + $stem)
        & $Manim $Quality --disable_caching --media_dir $media -r ($Width + ',' + $Height) --fps $Fps -o ($stem + '.mp4') $py $cls
        if ($LASTEXITCODE -ne 0) { throw ('manim failed on ' + $stem) }

        $raw = @(Get-ChildItem -Path $media -Recurse -Filter ($stem + '.mp4') -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending)
        if ($raw.Count -eq 0) { throw ('manim produced no mp4 for ' + $stem) }

        $out = Join-Path $PSScriptRoot ($stem + '.mp4')
        $chain = 'tpad=stop_mode=clone:stop_duration=' + $sec +
            ',scale=' + $Width + ':' + $Height + ':force_original_aspect_ratio=decrease' +
            ',pad=' + $Width + ':' + $Height + ':(ow-iw)/2:(oh-ih)/2:color=black' +
            ',setsar=1,fps=' + $Fps + ',format=yuv420p'
        & $Ffmpeg -hide_banner -loglevel error -y -i $raw[0].FullName -vf $chain -t $sec -an -c:v libx264 -preset veryfast -crf 20 $out
        if ($LASTEXITCODE -ne 0) { throw ('ffmpeg failed on ' + $stem) }
        [void]$parts.Add($out)
    }

    $list = Join-Path $PSScriptRoot 'concat.txt'
    # File names only (no directory): ffmpeg resolves them against the directory of
    # concat.txt, so a project under a CJK / spaced path still works.
    $lines = @()
    foreach ($p in $parts) { $lines += ("file '" + [System.IO.Path]::GetFileName($p) + "'") }
    $nl = [Environment]::NewLine
    $text = ($lines -join $nl) + $nl
    # NOTE: WriteAllLines(path, string, encoding) flattens the array into one line; use WriteAllText.
    [System.IO.File]::WriteAllText($list, $text, (New-Object System.Text.UTF8Encoding($false)))

    $final = Join-Path $PSScriptRoot 'final.mp4'
    & $Ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i $list -c copy $final
    if ($LASTEXITCODE -ne 0) {
        & $Ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i $list -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -an $final
        if ($LASTEXITCODE -ne 0) { throw 'concat failed' }
    }
    Remove-Item -LiteralPath $list -Force -ErrorAction SilentlyContinue
    Write-Host ('done: ' + $final)
}
finally {
    Pop-Location
}
`;
}

/** 渲染脚本（bash）：和 render.ps1 等价，给 macOS / Linux 用。 */
function renderSh() {
  return `#!/usr/bin/env bash
# render.sh -- same as render.ps1, for macOS / Linux.
#   MANIM=manim FFMPEG=ffmpeg ./render.sh
set -euo pipefail
cd "$(dirname "$0")"

MANIM="\${MANIM:-manim}"
FFMPEG="\${FFMPEG:-ffmpeg}"
QUALITY="\${QUALITY:--qm}"
W="\${WIDTH:-1920}"
H="\${HEIGHT:-1080}"
FPS="\${FPS:-30}"

parts=()
for meta in $(ls scene*.meta.json | sort); do
  stem="\${meta%.meta.json}"
  cls=$(python -c "import json,sys;print(json.load(open(sys.argv[1],encoding='utf-8'))['className'])" "$meta")
  sec=$(python -c "import json,sys;print(json.load(open(sys.argv[1],encoding='utf-8'))['seconds'])" "$meta")
  echo "[$stem] $cls (\${sec}s)"
  "$MANIM" "$QUALITY" --disable_caching --media_dir "media/$stem" -r "$W,$H" --fps "$FPS" -o "$stem.mp4" "$stem.py" "$cls"
  raw=$(find "media/$stem" -name "$stem.mp4" -type f | head -n 1)
  if [ -z "$raw" ]; then echo "no mp4 for $stem" >&2; exit 1; fi
  "$FFMPEG" -hide_banner -loglevel error -y -i "$raw" \\
    -vf "tpad=stop_mode=clone:stop_duration=$sec,scale=$W:$H:force_original_aspect_ratio=decrease,pad=$W:$H:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=$FPS,format=yuv420p" \\
    -t "$sec" -an -c:v libx264 -preset veryfast -crf 20 "$stem.mp4"
  parts+=("$stem.mp4")
done

> concat.txt
for p in "\${parts[@]}"; do
  # 只写文件名：ffmpeg 按 concat.txt 所在目录解析，中文/空格路径不会出问题
  echo "file '$p'" >> concat.txt
done
"$FFMPEG" -hide_banner -loglevel error -y -f concat -safe 0 -i concat.txt -c copy final.mp4
rm -f concat.txt
echo "done: $PWD/final.mp4"
`;
}

/** README：怎么本地渲染、每场是什么、占位场次说明。 */
function readme(job, scenes, style) {
  const title = String(job.title || (scenes[0] && scenes[0].text) || '未命名视频');
  const rows = scenes.map((item) => {
    const s = item.scene;
    const engine = s.tool === 'text' ? 'text' : s.tool === 'sticker' ? 'sticker' : 'manim';
    const file = stemOf(item.index);
    return `| ${item.index + 1} | ${file}.py | ${ENGINE_ZH[engine] || engine} | ${Number(s.seconds) || 0} 秒 | ${String(s.text || '').replace(/\|/g, '/')} |`;
  });
  return [
    `# ${title} · manim 工程`,
    '',
    `这是 dsh-studio 导出的 manim 工程（任务 \`${job.id}\`）。`,
    '每一场一个 `.py` 文件，都是能独立渲染的完整 manim 脚本；配音、字幕、外边框是服务端后处理，不在这个工程里。',
    '',
    '## 本地渲染',
    '',
    '需要 Python 3.10+ 和 manim（本机安装：`pip install manim`）。',
    '',
    '单场试渲（最快）：',
    '',
    '```bash',
    'manim -pql scene01.py <ClassName>',
    '```',
    '',
    'Class 名在每个 `sceneNN.meta.json` 的 `className` 里，也用 `sceneNN.py` 里的 `class Xxx(Scene)`。',
    '',
    '一次渲全部（画面拼成 `final.mp4`，无配音）：',
    '',
    '```powershell',
    'powershell -ExecutionPolicy Bypass -File .\\render.ps1',
    '```',
    '',
    '```bash',
    './render.sh',
    '```',
    '',
    '`render.ps1` / `render.sh` 会按每场 `meta.seconds` 把画面裁/补到计划时长（补 = 停末帧），再拼接。',
    '想换 manim / ffmpeg 路径：`-Manim D:\\manim\\manim.cmd -Ffmpeg D:\\ffmpeg\\bin\\ffmpeg.exe`（bash 用 `MANIM=` / `FFMPEG=`）。',
    '',
    '## 场次',
    '',
    '| # | 文件 | 引擎 | 计划时长 | 标题 |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## 说明',
    '',
    `- 风格：${(style && (style.name || style.id)) || '默认'}（bg ${(style && style.bg) || '#FFFFFF'} / fg ${(style && style.fg) || '#1A1A1A'}）。`,
    '- `dsh_kit.py` 是服务端渲染时自动注入的布局助手（`near` / `label_at` / `label_on_line` / `place_label`），导出到这里；`sceneNN.py` 用 `from dsh_kit import *` 拿到它们。',
    '- 标成「文字卡 / 表情卡」的场次在服务器上不是 manim 动画，导出的是占位场景（只把标题摆出来），照着改就能变成真动画。',
    '- 每场计划时长在 `project.json` 和 `sceneNN.meta.json` 里；真的成片时长还会受旁白长度影响（旁白比计划长，服务端会拉长这一场）。',
    '- `manifest.json` 里有每个文件的 sha256，改完文件可以自己核对。',
    '',
  ].join('\n');
}

function projectJson(job, scenes, style, cfg) {
  const req = job.request || {};
  return {
    generator: 'dsh-studio',
    jobId: job.id,
    title: job.title || '',
    projectId: job.projectId || '',
    projectTitle: job.projectTitle || '',
    version: Number(job.version) || 0,
    createdAt: job.createdAt || 0,
    style: {
      id: (style && style.id) || '',
      name: (style && style.name) || '',
      bg: (style && style.bg) || '',
      fg: (style && style.fg) || '',
      accent: (style && style.accent) || '',
      font: (style && style.font) || '',
    },
    // 影响成片节奏的参数快照：本地照着调，画面节奏能对上
    params: {
      seconds: Number(req.seconds) || 0,
      narrationSpeed: req.narrationSpeed,
      scenePadding: req.scenePadding,
      stickerDuration: req.stickerDuration,
      voicePitch: req.voicePitch,
    },
    voice: req.voice || '',
    topic: req.topic || '',
    script: req.script || '',
    canvas: { width: Number(cfg.width) || 1920, height: Number(cfg.height) || 1080, fps: Number(cfg.fps) || 30 },
    scenes: scenes.map((item) => ({
      index: item.index + 1,
      file: `${stemOf(item.index)}.py`,
      meta: `${stemOf(item.index)}.meta.json`,
      className: item.className,
      engine: item.engine,
      seconds: item.seconds,
      text: item.scene.text || '',
      narration: item.scene.narration || '',
      hint: item.scene.hint || '',
      placeholder: Boolean(item.placeholder),
    })),
  };
}

/**
 * 组装整个导出工程。
 * 返回 { files:[{name,data:Buffer}], manifest, zipName }。
 */
function buildSource({ job, cfg }) {
  const style = pickStyle(job, cfg);
  const scenes = (Array.isArray(job.scenes) ? job.scenes : []).map((scene, index) => {
    const isManim = scene.tool === 'manim' && scene.manim && scene.manim.code;
    const stem = stemOf(index);
    let code;
    let className;
    if (isManim) {
      code = sceneCode(job, scene, style, cfg, index, (job.scenes || []).length);
      className = (scene.manim && scene.manim.scene) || M.guessSceneName(code) || null;
      if (!validIdent(className)) className = M.guessSceneName(code) || null;
    } else {
      code = placeholderCode(index, scene, style);
      className = `Scene${String(index + 1).padStart(2, '0')}`;
    }
    const engine = scene.tool === 'text' ? 'text' : scene.tool === 'sticker' ? 'sticker' : 'manim';
    return {
      index,
      scene,
      stem,
      code,
      className: className || '',
      engine,
      seconds: Number(scene.seconds) || 0,
      placeholder: !isManim,
    };
  });

  const files = [];
  const add = (name, text) => files.push({ name, data: Buffer.from(String(text), 'utf8') });

  add('README.md', readme(job, scenes, style));
  add('project.json', JSON.stringify(projectJson(job, scenes, style, cfg), null, 2) + '\n');
  add('dsh_kit.py', kitSource());
  add('render.ps1', renderPs1());
  add('render.sh', renderSh());

  for (const item of scenes) {
    add(`${item.stem}.py`, item.code);
    const meta = {
      index: item.index + 1,
      file: `${item.stem}.py`,
      className: item.className,
      engine: item.engine,
      text: item.scene.text || '',
      narration: item.scene.narration || '',
      seconds: item.seconds,
      duration: item.seconds,
      hint: item.scene.hint || '',
      placeholder: item.placeholder,
      locked: Boolean(item.scene.manim && item.scene.manim.locked),
      note: item.scene.note || '',
    };
    add(`${item.stem}.meta.json`, JSON.stringify(meta, null, 2) + '\n');
  }

  // manifest 只算"内容文件"：它自己不算自己
  const manifest = {
    generator: 'dsh-studio',
    jobId: job.id,
    title: job.title || '',
    // 用任务创建时间而不是导出时间：同一个任务导出两次，字节完全一致（可复现）
    generatedAt: new Date(Number(job.createdAt) || Date.now()).toISOString(),
    fileCount: files.length + 1,
    files: files.map((f) => ({ name: f.name, bytes: f.data.length, sha256: sha256(f.data) })),
  };
  add('manifest.json', JSON.stringify(manifest, null, 2) + '\n');

  return { files, manifest, zipName: `${safeName(job.title || job.id)}-manim-source.zip` };
}

/** 下载文件名：去掉 Windows/浏览器不认的字符，空则用任务 id。 */
function safeName(title) {
  const s = String(title || '').trim()
    .replace(/[\\/:*?"<>|\r\n\t]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return s || 'scene';
}

// ------------------------------------------------------------------ ZIP ----
// 只做 store（不压缩）：工程文件都是文本，几十 KB，省掉一个第三方依赖更划算。

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** zip 里的时间：固定成任务创建时间，同一份任务导出两次字节一致。 */
function dosDateTime(ms) {
  const d = new Date(Number(ms) || Date.now());
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((Math.max(1980, d.getFullYear())) - 1980) << 9) | ((d.getMonth() + 1) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/** files: [{name, data:Buffer}] → zip Buffer（store / UTF-8 文件名）。 */
function zipStore(files, when) {
  const { time, date } = dosDateTime(when);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(String(file.name).replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 文件名
    local.writeUInt16LE(0, 8);           // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk
    central.writeUInt16LE(0, 36);        // internal attrs
    central.writeUInt32LE(0, 38);        // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

module.exports = {
  buildSource,
  zipStore,
  crc32,
  sha256,
  stemOf,
  kitSource,
  withKitImport,
  sceneCode,
  placeholderCode,
  renderPs1,
  renderSh,
  readme,
};
