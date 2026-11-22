'use strict';
/**
 * manim.js -- 调 Manim 渲染一段真动画。
 *
 * 只做三件事：
 *   1) 安全闸门：模型写的代码要在服务器上跑，文件/网络/进程/动态执行一律拒收；
 *   2) 字体增强：中文 Text 强制 Microsoft YaHei；标题 font_size>=44 且 weight=BOLD；
 *   3) 渲染：python -m manim render -qm --disable_caching，超时 20s + 3×时长。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCENE_NAME_RE = /^[\p{L}_][\p{L}\p{N}_]{0,63}$/u;
const CJK_RE = /[\u3400-\u9fff]/;

/**
 * 布局助手：不交给模型写，由渲染器固定拼进每段代码的 import 之后。
 * 模型只要用 near()/label_at()/label_on_line() 摆放标注，就不会再出现
 * "Δy 压在竖线上"这种像素级事故（buff 是硬下限）。
 *
 * 顶部是 dsh_manim_kit 的软接入：装了就把安全布局组件导进来（模型的代码里
 * 可以直接 `class Xxx(SafeScene)`），没装就 HAS_KIT=False 退回裸助手，
 * 旧代码/旧场次一行都不用改。
 */
const LAYOUT_HELPERS = `# --- layout helpers (auto-injected) ---
# 安全布局组件包（软依赖）：装了就优先用，没装就走下面的裸助手。
try:
    import dsh_manim_kit as kit
    from dsh_manim_kit import SafeScene, Title, PanelGrid, Label, Annotate, PlotFrame
    HAS_KIT = True
except ImportError:
    HAS_KIT = False


def near(mob, target, direction=UP, buff=0.28):
    """把 mob 摆到 target 的指定方向外侧，buff 保证不压线。"""
    mob.next_to(target, direction, buff=buff)
    return mob


def label_at(mob, point, direction=UP, buff=0.28):
    """同 near，但 target 可以是一个坐标点（numpy 数组）。"""
    mob.next_to(point, direction, buff=buff)
    return mob


def label_on_line(mob, line, direction=UP, buff=0.28, t=0.5):
    """先取线段 t 处的点，再往外侧推 buff：竖线标注、Δy/Δx 最稳的摆法。"""
    try:
        point = line.point_from_proportion(t)
    except Exception:
        point = line.get_center()
    mob.next_to(point, direction, buff=buff)
    return mob


def place_label(mob, anchor, direction=UP, buff=0.28):
    """兼容写法：place_label(标注, 锚点, 方向)。"""
    return label_at(mob, anchor, direction, buff)
# --- end layout helpers ---`;

/**
 * 提示词里插的组件清单（plan.js 的 visualPrompt 直接引这段）。
 * 只讲"用哪个组件、怎么用"，不复述排版铁律；总行数控制在 40 行内。
 */
const KIT_PROMPT = [
  '## 优先用 dsh_manim_kit 组件（已装；比手写 manim 更安全，优先选它）',
  '- SafeScene：继承它代替 Scene；画面每次定稿前自动做 bbox 压线检测并微调',
  '- Title(text, level=1)：顶部标题，自动占位、字号下限 44，内容区自动让开它',
  "- Label(text, size='md' / 'sm' / 'lg')：统一字号/颜色（投影后仍可读，正文下限 26）",
  '- PanelGrid(n_rows, n_cols)：分栏/四宫格；grid.place(mob, row, col) 放进格子（左上角是 0,0），装不下会自动等比缩小',
  '- Annotate(target, text)：把标注放到 target 外侧"不撞别的东西"的方向（上/右/下/左逐个试）；公式加 math=True',
  '- Callout(target, text)：气泡框 + 引线指向 target，方向同样自动选',
  '- Legend([(颜色, "说明"), ...])：并排图例',
  '- PlotFrame(x_range, y_range, x_label=, y_label=)：坐标轴套件；.curve(fn) / .area(fn,a,b) / .tangent(fn,x0) / .secant(fn,x0,x1) / .point(x, y, "名字")',
  '- PlotFrame.delta(x0, x1, axis=\'x\')：Δx 专用，括号画在轴外侧、Δx 再放括号外侧；axis=\'y\' 画纵向 Δy',
  '- 颜色常量：INK（墨色）、KLEIN_BLUE（克莱因蓝）、MUTED（弱化）、GRID（分栏线）',
  '骨架：',
  'from manim import *',
  'from dsh_manim_kit import SafeScene, Title, PanelGrid, Label, Annotate, PlotFrame, KLEIN_BLUE, INK',
  'class Xxx(SafeScene):',
  '    def construct(self):',
  '        self.play(Write(Title("标题")))',
  '        pf = PlotFrame((0, 4), (0, 8), x_label="t", y_label="s")',
  '        self.add(pf.axes, pf.axes_labels, pf.curve(lambda t: t * t / 2))',
  '        self.play(GrowFromCenter(pf.delta(1, 3)))   # Δx 自动放到轴外侧',
  '        self.add(pf.point(2, 2, "P"))               # 名字自动选不撞的方向',
  '',
  '- 用了 kit 的组件就不要再自己 move_to/next_to 摆标注（组件已经摆好了）；',
  '- 旧的 near / label_at / label_on_line 仍然可用，旧写法不会被拒收。',
].join('\n');


/**
 * 渲染前几何自检：同名子类包一层，先跑模型自己的 construct，再扫一遍
 * 文字包围盒与线/坐标轴包围盒是否相交，命中就打 LAYOUT_OVERLAP。
 * 只报告、不抛错 —— 真正的拦截交给 lint + 提示词，这里负责"渲染时兜底"。
 */
const LAYOUT_PROBE = `# --- layout probe (auto-injected) ---
def _layout_probe(scene, _limit=12):
    _text_names = ("Text", "MarkupText", "MathTex", "Tex", "Paragraph", "Code")
    _line_names = ("Line", "Arrow", "DashedLine", "NumberLine", "Vector", "DoubleArrow", "Elbow")
    def _walk(mob, depth=0):
        yield mob
        if depth >= 4:
            return
        for child in (getattr(mob, "submobjects", None) or []):
            for item in _walk(child, depth + 1):
                yield item
    texts = []
    lines = []
    seen = set()
    for top in (getattr(scene, "mobjects", None) or []):
        for mob in _walk(top):
            if id(mob) in seen:
                continue
            seen.add(id(mob))
            name = type(mob).__name__
            if name in _text_names:
                texts.append(mob)
            elif name in _line_names:
                lines.append(mob)
    def _box(mob):
        return (mob.get_left()[0], mob.get_right()[0], mob.get_bottom()[1], mob.get_top()[1])
    found = 0
    for text in texts:
        try:
            tl, tr, tb, tt = _box(text)
        except Exception:
            continue
        if tr - tl < 1e-3 or tt - tb < 1e-3:
            continue
        for line in lines:
            try:
                ll, lr, lb, lt = _box(line)
            except Exception:
                continue
            if tl < lr - 0.02 and tr > ll + 0.02 and tb < lt - 0.02 and tt > lb + 0.02:
                print("LAYOUT_OVERLAP: %s x %s @ (%.2f, %.2f)" % (
                    type(text).__name__, type(line).__name__, (tl + tr) / 2.0, (tb + tt) / 2.0))
                found += 1
                break
        if found >= _limit:
            break
# --- end layout probe ---`;

const FORBIDDEN = [
  { re: /(^|[^\w.])open\s*\(/m, name: 'open(' },
  { re: /\bimport\s+os\b|\bfrom\s+os\b|\bos\.[a-zA-Z_]/m, name: 'import os' },
  { re: /\bsubprocess\b/m, name: 'subprocess' },
  { re: /\brequests\b/m, name: 'requests' },
  { re: /\burllib\b|\bhttpx?\b/m, name: 'http' },
  { re: /\bsocket\b/m, name: 'socket' },
  { re: /\bpathlib\b|\bshutil\b|\bglob\b/m, name: 'filesystem module' },
  { re: /\bctypes\b|\bpickle\b|\bmarshal\b/m, name: 'native/serialization' },
  { re: /__import__/m, name: '__import__' },
  { re: /(^|[^\w.])eval\s*\(/m, name: 'eval(' },
  { re: /(^|[^\w.])exec\s*\(/m, name: 'exec(' },
  { re: /\bScene\.embed\b/m, name: 'Scene.embed' },
];

/** 允许 import 的顶层模块：manim / numpy，以及安全布局组件包 dsh_manim_kit。 */
const ALLOWED_IMPORT_ROOTS = new Set(['manim', 'numpy', 'dsh_manim_kit']);

/** 返回命中的规则名；null 表示通过。 */
function checkCode(code) {
  const src = String(code == null ? '' : code);
  for (const f of FORBIDDEN) if (f.re.test(src)) return f.name;
  // import 只允许 manim / numpy / dsh_manim_kit
  const importRe = /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*))/gm;
  let m;
  while ((m = importRe.exec(src))) {
    const part = String(m[1] || m[2] || '');
    for (const mod of part.split(',')) {
      const root = mod.trim().split('.')[0];
      if (!root) continue;
      if (!ALLOWED_IMPORT_ROOTS.has(root)) return `import ${root}`;
    }
  }
  return null;
}

function tail(s, n = 800) {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? t.slice(-n) : t;
}

function run(cmd, args, timeoutMs, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        windowsHide: true,
        cwd: opts.cwd,
        env: Object.assign({}, process.env, opts.env || {}),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: -1, out: '', err: String((err && err.message) || err), timedOut: false });
      return;
    }
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch {
        try { child.kill(); } catch { /* 已退出 */ }
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String((e && e.message) || e), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    });
  });
}

/** 从 ffmpeg -i 的 stderr 里抠时长/尺寸/fps（机器上只有 ffmpeg，没有 ffprobe）。 */
async function probeMedia(ffmpeg, file) {
  if (!ffmpeg || !fs.existsSync(file)) return null;
  const r = await run(ffmpeg, ['-hide_banner', '-i', file], 20000);
  const s = String(r.err || '');
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
  const dim = /Video:.*?,\s*(\d{2,5})x(\d{2,5})/.exec(s);
  const fps = /(\d+(?:\.\d+)?)\s*fps\b/.exec(s);
  return {
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
    width: dim ? Number(dim[1]) : 0,
    height: dim ? Number(dim[2]) : 0,
    fps: fps ? Number(fps[1]) : 0,
  };
}

/**
 * 猜场景类名：基类允许 Scene / SafeScene（含 kit.SafeScene、dsh_manim_kit.SafeScene）。
 * 用 kit 的 SafeScene 时如果这里不认，renderManim 会直接 NO_SCENE_NAME —— 所以必须认。
 */
function guessSceneName(code) {
  const m = String(code || '').match(
    /class\s+([\p{L}_][\p{L}\p{N}_]*)\s*\(\s*(?:[\p{L}_][\p{L}\p{N}_]*\.)?(?:Scene|SafeScene)\s*\)/u,
  );
  return m ? m[1] : null;
}

/** MathTex 参数外再包 $ 会让 LaTeX 直接失败，这里做确定性清洗。 */
function stripMathDelims(code) {
  return String(code == null ? '' : code).replace(
    /\b(MathTex|Tex)\(\s*(r?)(["'])\s*\$+([\s\S]*?)\$+\s*\3\s*\)/g,
    (m, fn, raw, quote, inner) => `${fn}(${raw}${quote}${inner}${quote})`,
  );
}

function normText(s) {
  return String(s || '').replace(/[\s，。！？、；：,.!?;:'"「」『』（）()\-—]/g, '').toLowerCase();
}

/**
 * 找到某个函数调用的参数区间（括号配对，跳过字符串里的括号）。
 * 只用于 Text(...) 这种简单调用；找不到就返回空数组。
 */
function findCalls(src, name) {
  const out = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('(', m.index);
    let depth = 0;
    let quote = '';
    let close = -1;
    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close > open) out.push({ open, close, args: src.slice(open + 1, close), index: m.index });
  }
  return out;
}

function stringLiterals(args) {
  const out = [];
  const re = /(?:r)?(["'])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let m;
  while ((m = re.exec(String(args || '')))) out.push(m[2]);
  return out;
}

/**
 * 标题判定：
 *   - 字符串内容匹配场景标题；
 *   - 变量名是 title/标题；
 *   - 这一行后面跟着 .to_edge(UP...；
 *   - 模型自己写了 font_size >= 40。
 * 匹配用归一化后的包含关系，避免标点/换行差异导致漏掉。
 */
function looksLikeTitle(args, scene, callStart, src) {
  const target = normText(scene && scene.text);
  const lits = stringLiterals(args).map(normText).filter(Boolean);
  if (target && target.length >= 2) {
    for (const lit of lits) {
      if (lit.includes(target) || (lit.length >= 4 && target.includes(lit))) return true;
    }
  }
  const sizeMatch = /\bfont_size\s*=\s*(\d+)/.exec(args);
  if (sizeMatch && Number(sizeMatch[1]) >= 40) return true;
  const lineStart = src.lastIndexOf('\n', callStart) + 1;
  const before = src.slice(lineStart, callStart);
  if (/(?:^|[^\w])(title|标题)\s*=\s*$/i.test(before)) return true;
  // 找这个调用的右括号之后到行尾，看是不是 .to_edge(UP...)
  let depth = 0;
  let quote = '';
  let close = -1;
  for (let i = callStart; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close >= 0) {
    const lineEnd = src.indexOf('\n', close);
    const rest = src.slice(close, lineEnd < 0 ? src.length : lineEnd);
    if (/\.to_edge\(\s*UP\b/.test(rest)) return true;
  }
  return false;
}

/**
 * 给 Text 调用补字体/字号/字重（确定性兜底，不依赖模型自觉）：
 *   - 标题：font_size 缺省补 52，已有但 <44 抬到 44；没有 weight 补 BOLD
 *   - 所有 Text：已有 font_size <28 抬到 28
 *   - 含中文且没有 font 补 Microsoft YaHei
 * 只处理括号配对的 Text(...)；MathTex/Tex 不碰；幂等（重复执行结果不变）。
 */
function enhanceTextCalls(code, scene) {
  let src = String(code || '');
  const calls = findCalls(src, 'Text');
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    let args = c.args;
    const isTitle = looksLikeTitle(args, scene, c.index, src);
    const hasCjk = stringLiterals(args).some((s) => CJK_RE.test(s));
    const add = [];

    if (!/\bfont\s*=/.test(args) && (hasCjk || isTitle)) {
      add.push('font="Microsoft YaHei"');
    }
    const sizeMatch = /\bfont_size\s*=\s*(\d+)/.exec(args);
    const size = sizeMatch ? Number(sizeMatch[1]) : null;
    if (isTitle) {
      if (size == null) add.push('font_size=52');
      else if (size < 44) args = args.replace(/\bfont_size\s*=\s*\d+/, 'font_size=44');
      if (!/\bweight\s*=/.test(args)) add.push('weight=BOLD');
    } else if (size != null && size < 28) {
      args = args.replace(/\bfont_size\s*=\s*\d+/, 'font_size=28');
    }
    if (!add.length && args === c.args) continue;
    let addition = add.map((a) => `, ${a}`).join('');
    if (/,\s*$/.test(args)) addition = addition.replace(/^,\s*/, '');
    if (!args.trim()) addition = addition.replace(/^,\s*/, '');
    src = src.slice(0, c.open + 1) + args + addition + src.slice(c.close);
  }
  return src;
}

/**
 * 标题重复兜底：标题与上一场相同（titleRepeat）时，把标题 Text 的字面量清空。
 * 不删整行，避免模型后面还 Write(title) 造成 NameError；空 Text 不占画面、
 * 动画等于空转，效果就是"这一场不出现标题、也不做标题动画"。
 */
function neutralizeRepeatedTitle(code, scene) {
  const src0 = String(code || '');
  if (!scene || !scene.titleRepeat) return { code: src0, changed: false, cleared: 0 };
  let src = src0;
  let cleared = 0;
  const title = normText(scene.text);
  const prev = normText(scene.titlePrev || scene.text);
  const calls = findCalls(src, 'Text');
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (!looksLikeTitle(c.args, scene, c.index, src)) continue;
    let args = c.args;
    const re = /(?:r)?(["'])((?:\\.|(?!\1)[\s\S])*?)\1/g;
    const edits = [];
    let m;
    while ((m = re.exec(args))) {
      const lit = m[2];
      const norm = normText(lit);
      if (!norm || /\{/.test(lit)) continue;
      // 只清"基本就是标题本身"的字面量：太短的子串（比如标题里的"积分"）不动，
      // 避免把同一场的坐标轴标签一起清掉。
      const nearTitle = norm.length >= Math.max(2, Math.floor(title.length * 0.5));
      const hit = (title && nearTitle && (norm.includes(title) || title.includes(norm)))
        || (prev && nearTitle && norm.includes(prev));
      if (hit) edits.push({ start: m.index, end: m.index + m[0].length });
    }
    if (!edits.length) continue;
    for (const e of edits.sort((a, b) => b.start - a.start)) {
      args = args.slice(0, e.start) + '""' + args.slice(e.end);
    }
    src = src.slice(0, c.open + 1) + args + src.slice(c.close);
    cleared += edits.length;
  }
  return { code: src, changed: src !== src0, cleared };
}

/** 把布局助手插到第一个 class 之前（不插进 construct，模型看不见也不需要写）。 */
function injectLayoutHelpers(code) {
  const src = String(code || '');
  if (src.includes('def near(')) return src;
  const lines = src.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^\s*class\s+[\p{L}_][\p{L}\p{N}_]*\s*[(:]/u.test(l));
  if (idx < 0) return src;
  return [...lines.slice(0, idx), LAYOUT_HELPERS, '', ...lines.slice(idx)].join('\n');
}

/** 包一层同名子类：跑完原 construct 后做几何自检（Layer 3）。 */
function injectLayoutProbe(code) {
  const src = String(code || '');
  if (src.includes('_layout_probe')) return src;
  const name = guessSceneName(src);
  if (!name) return src;
  return `${src}\n\n${LAYOUT_PROBE}\n\n_Base_${name} = ${name}\n\n\n`
    + `class ${name}(_Base_${name}):\n    def construct(self):\n        super().construct()\n        _layout_probe(self)\n`;
}

const HELPERS_BLOCK_RE = /# --- layout helpers \(auto-injected\) ---[\s\S]*?# --- end layout helpers ---/g;
const PROBE_BLOCK_RE = /# --- layout probe \(auto-injected\) ---[\s\S]*?# --- end layout probe ---/g;

/** lint 只看模型写的代码：把自己注入的助手/探针段落切掉，避免自证。 */
function stripInjected(code) {
  return String(code || '').replace(HELPERS_BLOCK_RE, '').replace(PROBE_BLOCK_RE, '');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从某个位置取"到语句结束"的一小段（括号链/同行链都算）。 */
function statementTail(src, from, maxLen = 260) {
  const end = Math.min(src.length, from + maxLen);
  let i = from;
  while (i < end) {
    if (src[i] === '\n') {
      const prev = src.slice(from, i).trimEnd();
      if (!/[.(,+\-*/\\]$/.test(prev)) break;
    }
    i += 1;
  }
  return src.slice(from, i);
}

const LINT_TEXT_CALLS = ['Text', 'MarkupText', 'MathTex', 'Tex'];
const POSITIONED_RE = /\.next_to\s*\(|\.to_edge\s*\(|\.to_corner\s*\(|\.align_to\s*\(|\bnear\s*\(|\blabel_at\s*\(|\blabel_on_line\s*\(|\bplace_label\s*\(/;
const DELTA_RE = /\\Delta\s*[xy]\b|Δ\s*[xy]/i;

/**
 * 静态检查（不调模型）：只产出 warnings，fatal 只在"根本解析不出 Scene"时给。
 * 规则：
 *   1) 标注用 .move_to([x,y,0]) 绝对定位；
 *   2) 标注字号 < 24（糊成一团，压不压线都看不清）；
 *   3) Δx/Δy 标注没有 next_to/near/label_on_line 相对定位；
 *   4) 非标题文字绝对 y > 2.4（几乎一定和顶部标题/坐标轴打架）。
 */
function lintManim(code, scene) {
  const warnings = [];
  const src = stripInjected(code);
  const sceneName = guessSceneName(src);
  if (!sceneName || !/def\s+construct\s*\(\s*self\s*\)\s*:/.test(src)) {
    return { warnings, fatal: 'NO_SCENE_OR_CONSTRUCT' };
  }
  const seen = new Set();
  const calls = [];
  for (const name of LINT_TEXT_CALLS) {
    for (const c of findCalls(src, name)) {
      const id = `${c.open}:${c.close}`;
      if (seen.has(id)) continue;
      seen.add(id);
      calls.push({ name, ...c });
    }
  }
  calls.sort((a, b) => a.index - b.index);
  for (const c of calls) {
    const tail = statementTail(src, c.close);
    const lineStart = src.lastIndexOf('\n', c.index) + 1;
    const head = src.slice(lineStart, c.index);
    const assigned = /([\p{L}_][\p{L}\p{N}_]*)\s*=\s*$/u.exec(head);
    const varName = assigned ? assigned[1] : '';
    const varPositioned = varName
      ? new RegExp(
        `(?:\\b${escapeRe(varName)}\\s*\\.\\s*(?:next_to|to_edge|to_corner|align_to|shift)\\s*\\(`
        + `|(?:near|label_at|label_on_line|place_label)\\s*\\(\\s*${escapeRe(varName)}\\b)`,
      ).test(src)
      : false;
    const positioned = POSITIONED_RE.test(tail) || varPositioned;
    const isTitle = looksLikeTitle(c.args, scene, c.index, src);
    const label = stringLiterals(c.args).filter((s) => !/^#/.test(s) && !/^Microsoft/.test(s))[0] || c.args;
    const shown = String(label).slice(0, 18);
    const varMoveTo = varName
      ? new RegExp(`\\b${escapeRe(varName)}\\s*\\.\\s*move_to\\s*\\(`).test(src)
      : false;

    if (/\.move_to\s*\(/.test(tail) || varMoveTo) {
      warnings.push(`「${shown}」用了 .move_to(绝对坐标)，标注容易压线；改用 next_to/near/label_on_line`);
    }
    const size = /\bfont_size\s*=\s*(\d+)/.exec(c.args);
    if (size && Number(size[1]) < 24) {
      warnings.push(`「${shown}」字号 ${size[1]} < 24，投影后看不清`);
    }
    const lits = stringLiterals(c.args);
    if (lits.some((s) => DELTA_RE.test(s)) && !positioned) {
      warnings.push(`增量标注「${shown}」没有 next_to/near/label_on_line 相对定位`);
    }
    const varAbsY = varName
      ? new RegExp(`\\b${escapeRe(varName)}\\s*\\.\\s*move_to\\s*\\(\\s*\\[\\s*[-\\d.]+\\s*,\\s*([-\\d.]+)`).exec(src)
      : null;
    const absY = /\.move_to\s*\(\s*\[\s*[-\d.]+\s*,\s*([-\d.]+)\s*,\s*[-\d.]+\s*\]/.exec(tail) || varAbsY;
    if (absY && Number(absY[1]) > 2.4 && !isTitle) {
      warnings.push(`「${shown}」绝对 y=${absY[1]} > 2.4，可能与顶部标题重叠`);
    }
  }
  const deduped = [...new Set(warnings)];
  if (deduped.length > 12) return { warnings: deduped.slice(0, 12), fatal: null, more: deduped.length - 12 };
  return { warnings: deduped, fatal: null };
}

/** 从渲染输出里数 LAYOUT_OVERLAP 行（Layer 3 报告）。 */
function parseLayoutOverlaps(stdout) {
  const out = [];
  const re = /^LAYOUT_OVERLAP:\s*(.+)$/gm;
  let m;
  while ((m = re.exec(String(stdout || '')))) out.push(m[1].trim());
  return out;
}

/** 画布底色：统一走 cfg.canvas.bg（纯白），风格只决定墨色/强调色。 */
function canvasBg(style, cfg) {
  const fromCfg = cfg && cfg.canvas && cfg.canvas.bg;
  if (fromCfg) return String(fromCfg);
  return String((style && style.bg) || '#FFFFFF');
}

/** 在 construct 开头注入画布底色（纯白，强制覆盖模型自己写的深色背景）。 */
function injectBackground(code, style, cfg) {
  const bg = canvasBg(style, cfg);
  if (!bg) return code;
  const setRe = /(self\.camera\.background_color|config\.background_color)\s*=\s*["'][^"']*["']/g;
  if (setRe.test(code)) return String(code).replace(setRe, `$1 = "${bg}"`);
  const lines = String(code || '').split(/\r?\n/);
  const idx = lines.findIndex((l) => /^\s*def\s+construct\s*\(\s*self\s*\)\s*:/.test(l));
  if (idx < 0) return code;
  let indent = '';
  for (let i = idx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    indent = (lines[i].match(/^\s*/) || [''])[0];
    break;
  }
  if (!indent) indent = (lines[idx].match(/^\s*/) || [''])[0] + '    ';
  lines.splice(idx + 1, 0, `${indent}self.camera.background_color = "${bg}"`);
  return lines.join('\n');
}

/**
 * 风格色落实：
 *   1) 把模型写死的 WHITE/BLUE/GREEN... 换成风格色（白板上的白字是隐形的）；
 *   2) 在 construct 开头设 Mobject 默认色，模型没写 color 的轴/线也有对比度。
 */
function injectStyleColors(code, style, cfg) {
  if (!style) return code;
  const canvas = (cfg && cfg.canvas) || {};
  const fg = canvas.fg || style.fg || '#1A1A1A';
  const accent = style.accent || fg;
  const accent2 = style.accent2 || accent;
  const muted = canvas.muted || style.muted || fg;
  const map = {
    WHITE: fg, BLUE: accent, GREEN: accent, TEAL: accent, PURPLE: accent,
    YELLOW: accent2, GOLD: accent2, ORANGE: accent2, RED: accent2,
    GREY: muted, GRAY: muted,
  };
  let out = String(code || '');
  // 模型自己定义的 BLUE/WHITE 变量别动：把变量名换成字面量会得到 "#..." = "#..."
  const assigned = new Set();
  const assignRe = /^\s*([A-Z][A-Z0-9_]*)\s*=/gm;
  let am;
  while ((am = assignRe.exec(out))) assigned.add(am[1]);
  for (const [word, hex] of Object.entries(map)) {
    if (assigned.has(word)) continue;
    out = out.replace(new RegExp(`(?<!["'])\\b${word}\\b(?!["'])`, 'g'), `"${hex}"`);
  }
  if (!/Mobject\.set_default\s*\(/.test(out)) {
    const lines = out.split(/\r?\n/);
    const idx = lines.findIndex((l) => /^\s*def\s+construct\s*\(\s*self\s*\)\s*:/.test(l));
    if (idx >= 0) {
      let indent = '';
      for (let i = idx + 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        indent = (lines[i].match(/^\s*/) || [''])[0];
        break;
      }
      if (!indent) indent = (lines[idx].match(/^\s*/) || [''])[0] + '    ';
      lines.splice(idx + 1, 0,
        `${indent}Mobject.set_default(color="${fg}")`,
        `${indent}Text.set_default(color="${fg}", font="${(style.font || 'Microsoft YaHei')}")`,
        `${indent}Axes.set_default(color="${fg}")`,
      );
      out = lines.join('\n');
    }
  }
  return out;
}

/**
 * 渲染前的确定性增强：清 $、标题去重、补字体、注入白底/墨色、注入布局助手与自检。
 * 返回 { code, notes }，notes 会写日志，方便解释"为什么改它"。
 *
 * opts.locked = true（面板里手改并锁定的代码）：跳过"标题去重"这种会删掉用户
 * 字面量的步骤，但字体/白底/风格色/布局助手照旧注入 —— 用户改的是结构，
 * 不该被我们的风格规则改写；同时画面风格仍和自动生成的场次一致。
 */
function enhanceCode(code, scene, style, cfg, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const notes = [];
  let out = stripMathDelims(code);
  if (!/^\s*from\s+manim\s+import/m.test(out)) {
    out = `from manim import *\n${out}`;
    notes.push('补 from manim import *');
  }
  if (options.locked) {
    // 手改代码：不动用户写的标题字面量
    out = String(out);
  } else {
    const cleared = neutralizeRepeatedTitle(out, scene);
    out = cleared.code;
    if (cleared.changed) notes.push(`标题与上一场相同，跳过标题动画（清空 ${cleared.cleared} 处标题字面量）`);
  }
  const beforeText = out;
  out = enhanceTextCalls(out, scene);
  if (out !== beforeText) notes.push('字体/标题增强');
  const beforeBg = out;
  out = injectBackground(out, style, cfg);
  if (out !== beforeBg) notes.push(`注入画布底色 ${canvasBg(style, cfg)}`);
  const beforeColors = out;
  out = injectStyleColors(out, style, cfg);
  if (out !== beforeColors) notes.push('风格色注入');
  const beforeHelpers = out;
  out = injectLayoutHelpers(out);
  if (out !== beforeHelpers) notes.push('注入布局助手 near/label_at/label_on_line');
  // noProbe：导出给用户的工程不要自检探针（它会把类是包一层，本地跑着更容易糊涂）
  if (options.noProbe) return { code: out, notes };
  const beforeProbe = out;
  out = injectLayoutProbe(out);
  if (out !== beforeProbe) notes.push('注入布局自检');
  return { code: out, notes };
}

function findOutput(mediaRoot, stem) {
  const base = path.join(mediaRoot, 'videos', stem);
  try {
    for (const q of fs.readdirSync(base)) {
      const p = path.join(base, q, 'out.mp4');
      if (fs.existsSync(p) && fs.statSync(p).size > 1000) return p;
    }
  } catch { /* 走递归兜底 */ }
  let best = null;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'out.mp4') {
        try {
          const st = fs.statSync(p);
          if (st.size > 1000 && (!best || st.mtimeMs > best.mtimeMs)) best = { file: p, mtimeMs: st.mtimeMs };
        } catch { /* 忽略 */ }
      }
    }
  };
  walk(path.join(mediaRoot, 'videos'), 0);
  return best ? best.file : path.join(base, 'out.mp4');
}

/**
 * 渲染一段 manim。
 * 返回 { ok, file, ms, error, detail, naturalSeconds, rawFile }。
 */
async function renderManim({ cfg, work, index, code, sceneName, seconds, log }) {
  const started = Date.now();
  if (!code || !String(code).trim()) return { ok: false, error: 'NO_CODE', ms: 0 };
  if (!cfg.python || !fs.existsSync(cfg.python)) return { ok: false, error: 'NO_PYTHON', ms: 0 };
  const unsafe = checkCode(code);
  if (unsafe) return { ok: false, error: 'UNSAFE_CODE', detail: unsafe, ms: Date.now() - started };

  const name = SCENE_NAME_RE.test(String(sceneName || '')) ? String(sceneName) : guessSceneName(code);
  if (!name) return { ok: false, error: 'NO_SCENE_NAME', ms: Date.now() - started };

  const stem = `manim-${index}`;
  const script = path.join(work, `${stem}.py`);
  const mediaDir = path.join(work, `media-${index}`);
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(script, String(code), 'utf8');

  const args = [
    '-m', 'manim', 'render', String(cfg.manimQuality || '-qm'), '--disable_caching',
    '--media_dir', mediaDir,
  ];
  const rw = Number(cfg.manimRenderWidth) || Number(cfg.width) || 1920;
  const rh = Number(cfg.manimRenderHeight) || Number(cfg.height) || 1080;
  if (rw > 0 && rh > 0) args.push('-r', `${rw},${rh}`);
  if (Number(cfg.fps) > 0) args.push('--fps', String(Number(cfg.fps)));
  args.push('-o', 'out.mp4', script, name);

  // 任务书要求：超时 20s + 3×时长。
  const budget = (Number(cfg.manimTimeoutBaseMs) || 20000)
    + (Number(cfg.manimTimeoutPerSecondMs) || 3000) * Math.max(0, Number(seconds) || 0);

  const ffmpegDir = cfg.ffmpeg ? path.dirname(cfg.ffmpeg) : '';
  const r = await run(cfg.python, args, budget, {
    cwd: work,
    env: {
      PYTHONPATH: '',
      PYTHONIOENCODING: 'utf-8',
      TMP: work, TEMP: work, TMPDIR: work,
      PATH: ffmpegDir ? `${ffmpegDir};${process.env.PATH || ''}` : (process.env.PATH || ''),
    },
  });
  const ms = Date.now() - started;
  const out = findOutput(mediaDir, stem);
  const exists = fs.existsSync(out) && fs.statSync(out).size > 1000;

  if (r.timedOut) return { ok: false, error: `MANIM_TIMEOUT(${budget}ms)`, ms };
  if (!exists || r.code !== 0) {
    return {
      ok: false,
      error: `MANIM_FAILED(code=${r.code})`,
      detail: tail(r.err || r.out, 900),
      ms,
    };
  }
  const info = await probeMedia(cfg.ffmpeg, out);
  if (log) log(`manim 完成 ${(ms / 1000).toFixed(1)}s（自然时长 ${fix(info && info.duration)}s）`);
  const layout = parseLayoutOverlaps(r.out);
  if (layout.length && log) log(`布局自检：${layout.length} 处文字压线（${layout.slice(0, 4).join('；')}）`);
  return {
    ok: true,
    file: out,
    rawFile: out,
    ms,
    layout,
    naturalSeconds: info && info.duration > 0 ? info.duration : Math.max(1, Number(seconds) || 4),
  };
}

/**
 * 把 py_compile 的 stderr 拆成 [{line, message}]。
 * Python 的格式是：File "xxx.py", line 12 / 源码行 / caret / SyntaxError: 具体原因。
 * 这里在同一段里往后找 "XxxError: ..." 那一行当人话，找不到就退回源码行。
 */
function parsePyErrors(text, file) {
  const lines = String(text || '').split(/\r?\n/);
  const base = path.basename(String(file || ''));
  const errors = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*File "([^"]+)",\s*line\s*(\d+)/.exec(lines[i]);
    if (!m) continue;
    if (base && !String(m[1]).endsWith(base)) continue;
    const lineNo = Number(m[2]);
    let message = '';
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
      const t = lines[j].trim();
      if (!t) continue;
      if (/^[~^ ]+$/.test(t)) continue;
      if (/^[A-Za-z_]*Error:/.test(t)) {
        message = t;
        break;
      }
      if (!message) message = t;
    }
    const key = `${lineNo}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    errors.push({ line: lineNo, message: message || '语法错误' });
  }
  if (!errors.length) {
    const tailText = String(text || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
    errors.push({ line: 0, message: tailText || '语法错误' });
  }
  return errors.slice(0, 8);
}

/**
 * 语法校验：只跑 python -m py_compile（编译，不执行用户代码），返回错误行号。
 * 面板「校验」按钮用；不会碰 manim，也不写进正式渲染目录。
 * 返回 { ok, errors:[{line, message}], raw }。
 */
async function checkSyntax({ cfg, code, timeoutMs }) {
  const src = String(code || '');
  if (!src.trim()) return { ok: false, errors: [{ line: 0, message: '代码是空的' }], raw: '' };
  if (!cfg || !cfg.python || !fs.existsSync(cfg.python)) {
    return { ok: false, errors: [{ line: 0, message: '服务器上没有可用的 python，没法校验语法' }], raw: '' };
  }
  const dir = path.join(os.tmpdir(), 'studio-v2-check');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `check-${process.pid}-${Date.now()}.py`);
  fs.writeFileSync(file, src, 'utf8');
  try {
    const r = await run(cfg.python, ['-X', 'utf8', '-m', 'py_compile', file], Number(timeoutMs) || 45000);
    const raw = String(r.err || r.out || '');
    if (r.code === 0) return { ok: true, errors: [], raw };
    return { ok: false, errors: parsePyErrors(raw, file), raw };
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* 忽略 */ }
    try { fs.rmSync(path.join(dir, '__pycache__'), { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

function fix(v) {
  return Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '?';
}

module.exports = {
  renderManim,
  enhanceCode,
  checkCode,
  checkSyntax,
  parsePyErrors,
  probeMedia,
  guessSceneName,
  stripMathDelims,
  // 三层布局约束：注入的助手、静态 lint、渲染时几何自检
  lintManim,
  neutralizeRepeatedTitle,
  injectLayoutHelpers,
  injectLayoutProbe,
  stripInjected,
  parseLayoutOverlaps,
  canvasBg,
  LAYOUT_HELPERS,
  KIT_PROMPT,
  ALLOWED_IMPORT_ROOTS,
  run,
  findCalls,
};
