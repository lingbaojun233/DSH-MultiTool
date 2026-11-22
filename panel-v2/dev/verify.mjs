/*
 * 真跑验收：桩服务 8774 + 面板 8775 + 无头 Edge（CDP）。
 *   node dev/verify.mjs
 * 产出：dev/shots/*.png，控制台 PASS/FAIL，退出码 0/1。
 * 不依赖任何 npm 包：CDP 用 Node 自带的 WebSocket。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startMock } = require('./mock-studio.js');
const { startSpeak } = require('./mock-speak.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = path.resolve(HERE, '..');
const SHOT_DIR = path.join(HERE, 'shots');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PANEL_PORT = 8775;
const STUDIO_PORT = 8774;
const PANEL_URL = `http://127.0.0.1:${PANEL_PORT}/`;

const results = [];
const pageErrors = [];

function check(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs, intervalMs, label) {
  const started = Date.now();
  let last;
  while (Date.now() - started < (timeoutMs || 10000)) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(intervalMs || 200);
  }
  throw new Error(`timeout: ${label || 'waitFor'}`);
}

function freePort(preferred) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(freePort(preferred + 1)));
    server.listen(preferred, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/* ---------- 极简 CDP 客户端 ---------- */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('cdp websocket error')), { once: true });
    });
    const client = new Cdp(ws);
    ws.addEventListener('message', (event) => client._onMessage(event));
    return client;
  }

  async _onMessage(event) {
    let raw = event.data;
    if (typeof raw !== 'string') {
      raw = typeof raw === 'string' ? raw : await raw.text();
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message || 'cdp error'} (${msg.error.code})`));
      else resolve(msg.result || {});
      return;
    }
    if (msg.method) {
      const list = this.listeners.get(msg.method) || [];
      for (const fn of list) {
        try {
          fn(msg.params || {}, msg.sessionId);
        } catch (err) {
          /* 监听器自己出错不拖垮验收 */
        }
      }
    }
  }

  on(method, fn) {
    const list = this.listeners.get(method) || [];
    list.push(fn);
    this.listeners.set(method, list);
  }

  send(method, params, sessionId) {
    const id = ++this.nextId;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`cdp timeout: ${method}`));
        }
      }, 20000);
    });
  }
}

/* ---------- 页面辅助 ---------- */

function makePage(client, sessionId) {
  const call = (method, params) => client.send(method, params, sessionId);

  async function evaluate(expression) {
    const out = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (out.exceptionDetails) {
      throw new Error(`page exception: ${out.exceptionDetails.text}`);
    }
    return out.result ? out.result.value : undefined;
  }

  async function waitReady() {
    await waitFor(
      async () => (await evaluate('document.readyState')) === 'complete',
      15000,
      150,
      'document.readyState'
    );
  }

  async function goto(url) {
    await call('Page.navigate', { url });
    await waitReady();
    await waitFor(
      async () => (await evaluate('!!document.querySelector(".tab")')),
      10000,
      100,
      'app booted'
    );
    await sleep(300);
  }

  async function screenshot(fileName) {
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(SHOT_DIR, fileName), Buffer.from(shot.data, 'base64'));
  }

  return { call, evaluate, waitReady, goto, screenshot };
}

/* ---------- 主流程 ---------- */

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const logPath = path.join(SHOT_DIR, 'panel.log');
  const logFd = fs.openSync(logPath, 'w');

  const mock = await startMock({ port: STUDIO_PORT });
  check('桩服务 v2-core 起在 8774', true, `http://127.0.0.1:${STUDIO_PORT}`);

  const speakPort = await freePort(8790);
  const speak = await startSpeak({ port: speakPort });
  check('桩 speak 已起（音色清单）', true, `http://127.0.0.1:${speakPort}/v1/voices`);

  const panel = spawn(process.execPath, ['server.js'], {
    cwd: PANEL_DIR,
    env: Object.assign({}, process.env, {
      STUDIO_V2_URL: `http://127.0.0.1:${STUDIO_PORT}`,
      DSH_SPEAK_URL: `http://127.0.0.1:${speakPort}`,
      DSH_PANEL_V2_PORT: String(PANEL_PORT),
    }),
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });

  const panelExit = new Promise((resolve) => panel.once('exit', resolve));
  panelExit.then((code) => {
    if (code !== 0) console.log(`[verify] panel exited early code=${code}`);
  });

  const cleanup = async () => {
    try {
      panel.kill();
    } catch (err) {
      /* 已退出 */
    }
    try {
      await mock.close();
    } catch (err) {
      /* 已关闭 */
    }
    try {
      await speak.close();
    } catch (err) {
      /* 已关闭 */
    }
  };

  let browser = null;
  try {
    const rootRes = await waitFor(
      async () => {
        const res = await fetch(`${PANEL_URL}`, { cache: 'no-store' });
        return res.ok ? res : null;
      },
      15000,
      250,
      'panel GET / 200'
    );
    const html = await rootRes.text();
    check('面板 GET / 200', rootRes.status === 200, `status=${rootRes.status}`);
    check(
      '首屏 HTML 是三视图骨架',
      html.includes('id="view-make"') && html.includes('id="view-jobs"') && html.includes('id="view-settings"'),
      'make/jobs/settings'
    );

    const health = await fetch(`${PANEL_URL}api/health`, { cache: 'no-store' }).then((res) => res.json());
    check(
      '代理健康检查',
      health.ok === true && health.upstreamOk === true && health.upstreamStatus === 200,
      JSON.stringify({ upstream: health.upstream, upstreamStatus: health.upstreamStatus })
    );

    // ---- 启动无头 Edge ----
    const debugPort = await freePort(9333);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-v2-edge-'));
    browser = spawn(
      EDGE,
      [
        '--headless=new',
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-gpu',
        '--disable-background-networking',
        '--window-size=1280,900',
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true }
    );

    const version = await waitFor(
      async () => {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { cache: 'no-store' });
        return res.ok ? res.json() : null;
      },
      20000,
      250,
      'edge devtools'
    );
    check('无头 Edge 已启动', true, version.Browser || 'edge');

    const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = makePage(cdp, sessionId);

    cdp.on('Runtime.exceptionThrown', (params) => {
      const text = params && params.exceptionDetails
        ? params.exceptionDetails.text + ' ' + (params.exceptionDetails.exception && params.exceptionDetails.exception.description || '')
        : 'unknown exception';
      pageErrors.push(text);
    });
    cdp.on('Log.entryAdded', (params) => {
      if (params && params.entry && params.entry.level === 'error') {
        pageErrors.push(`log: ${params.entry.text}`);
      }
    });

    await page.call('Page.enable');
    await page.call('Runtime.enable');
    await page.call('Log.enable');
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.goto(PANEL_URL);
    await waitFor(
      async () => (await page.evaluate(`document.querySelectorAll('#setVoice option').length`)) > 1,
      8000,
      100,
      'voices loaded'
    );

    // ---- 首屏结构 ----
    const firstScreen = await page.evaluate(`(() => {
      const tabs = [...document.querySelectorAll('.tab')].map(t => t.textContent.trim());
      const segs = [...document.querySelectorAll('.seg-btn')].map(b => ({ sec: b.dataset.sec, text: b.textContent.trim() }));
      return {
        tabs,
        placeholder: document.querySelector('#topicInput').placeholder,
        segs,
        start: document.querySelector('#startBtn').textContent.trim(),
        advancedOpen: document.querySelector('#advanced').open,
        currentHidden: document.querySelector('#currentJob').classList.contains('hidden'),
        makeActive: document.querySelector('#view-make').classList.contains('active'),
        jobsActive: document.querySelector('#view-jobs').classList.contains('active'),
        settingsActive: document.querySelector('#view-settings').classList.contains('active'),
        styleOptions: [...document.querySelectorAll('#setStyle option')].map(o => o.textContent.trim()),
        styleValues: [...document.querySelectorAll('#setStyle option')].map(o => o.value),
        voiceOptions: [...document.querySelectorAll('#setVoice option')].map(o => o.textContent.trim()),
        voiceValues: [...document.querySelectorAll('#setVoice option')].map(o => o.value),
        voiceHint: document.querySelector('#voiceHint').textContent.trim(),
        persona: document.querySelector('#personaLine').textContent.trim(),
      };
    })()`);

    check('三个 tab：做视频 / 任务 / 设置', firstScreen.tabs.join('|') === '做视频|任务|设置', firstScreen.tabs.join('|'));
    check('默认视图 = 做视频', firstScreen.makeActive && !firstScreen.jobsActive && !firstScreen.settingsActive);
    check('大 textarea 占位文案正确', firstScreen.placeholder === '你想做什么视频？也可以贴一段稿子', firstScreen.placeholder);
    check('时长四个档位', firstScreen.segs.map((s) => s.sec).join(',') === '30,45,60,90', firstScreen.segs.map((s) => s.text).join(' / '));
    check('主按钮文案「开始做」', firstScreen.start === '开始做', firstScreen.start);
    check('高级区默认收起', firstScreen.advancedOpen === false);
    check('首屏没有任务卡', firstScreen.currentHidden === true);
    check('风格枚举与 v2-core 一致', JSON.stringify(firstScreen.styleValues) === '["","whiteboard","blueprint","oscilloscope-math"]', firstScreen.styleOptions.join(' / '));
    check('音色下拉默认「跟人设（推荐）」', firstScreen.voiceOptions[0] === '跟人设（推荐）', firstScreen.voiceOptions[0]);
    check(
      '音色清单从 speak 动态加载',
      firstScreen.voiceValues.includes('voc_test_a') &&
        firstScreen.voiceValues.includes('voc_test_b') &&
        firstScreen.voiceOptions.some((label) => label.startsWith('小暖')) &&
        firstScreen.voiceOptions.some((label) => label.startsWith('小刚')),
      `${firstScreen.voiceOptions.join(' / ')} | values=${firstScreen.voiceValues.join(',')}`
    );
    check('音色提示说明已加载数量', firstScreen.voiceHint.includes('2 个云端音色'), firstScreen.voiceHint);
    check('设置页人设只读行', firstScreen.persona === '当前人设：大肥鱼（迷糊版） · 白板讲解 · 温柔口语', firstScreen.persona);
    await page.screenshot('01-make-1280.png');

    // ---- 验收 1：topic 提交 ----
    const topic = '三分钟讲清楚猫咪为什么怕黄瓜';
    await page.evaluate(`(() => {
      const input = document.querySelector('#topicInput');
      input.value = ${JSON.stringify(topic)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.seg-btn[data-sec="30"]').click();
    })()`);
    const modeHint = await page.evaluate(`document.querySelector('#submitHint').textContent.trim()`);
    check('短文本判为「主题」', modeHint.includes('按主题处理'), modeHint);

    await page.evaluate(`document.querySelector('#startBtn').click()`);
    const topicReq = await waitFor(
      () => mock.requests.find((r) => r.method === 'POST' && r.path === '/v1/jobs') || null,
      8000,
      100,
      'topic POST /v1/jobs'
    );
    const topicBody = topicReq.body;
    check(
      'topic 提交请求体 = {topic, seconds}',
      JSON.stringify(Object.keys(topicBody).sort()) === '["seconds","topic"]' &&
        topicBody.topic === topic &&
        topicBody.seconds === 30,
      JSON.stringify(topicBody)
    );
    check('请求带 JSON content-type', topicReq.contentType.includes('application/json'), topicReq.contentType);

    const cardVisible = await waitFor(
      async () => page.evaluate(`(() => {
        const card = document.querySelector('#currentJob .card');
        if (!card) return null;
        return { title: card.querySelector('.card-title').textContent.trim(), status: card.querySelector('.card-status').textContent.trim() };
      })()`),
      3000,
      100,
      '任务卡立刻出现'
    );
    check('提交后立刻出现任务卡', Boolean(cardVisible && cardVisible.title.includes(topic)), JSON.stringify(cardVisible));

    // ---- 验收 2：进度 running 3/7 → done ----
    const seen = new Set();
    let progressText = '';
    let elapsedText = '';
    await waitFor(
      async () => {
        const status = await page.evaluate(`document.querySelector('#currentJob .card-status').textContent.trim()`);
        seen.add(status);
        if (/第 3\/7 场 manim 渲染中/.test(status)) {
          progressText = status;
          if (/已用 \d+ 秒/.test(status)) elapsedText = status;
        }
        return /已完成/.test(status);
      },
      16000,
      200,
      'job done'
    );
    check('进度展示「第 3/7 场 manim 渲染中…」', Boolean(progressText), progressText);
    check('进度带已用时间', Boolean(elapsedText), elapsedText);

    const doneCard = await page.evaluate(`(() => {
      const card = document.querySelector('#currentJob .card');
      const visible = (act) => { const btn = card.querySelector('[data-act="' + act + '"]'); return btn ? !btn.classList.contains('hidden') : false; };
      const dl = [...card.querySelectorAll('a.btn')].map(a => ({ text: a.textContent.trim(), href: a.getAttribute('href') }));
      return {
        status: card.querySelector('.card-status').textContent.trim(),
        chip: card.querySelector('.chip').textContent.trim(),
        play: visible('play'),
        redo: visible('redo'),
        dl,
        bar: card.querySelector('.bar > i').style.width,
      };
    })()`);
    check('完成态状态行', doneCard.status.includes('已完成'), doneCard.status);
    check('完成态按钮：播放 / 下载视频 / 下载字幕 / 重做',
      doneCard.play && doneCard.redo && doneCard.dl.length === 2,
      JSON.stringify(doneCard));
    check('下载链接指向代理视频接口',
      doneCard.dl.some((a) => a.href.includes('/api/studio/video/j1')) &&
        doneCard.dl.some((a) => a.text === '下载字幕' && a.href.includes('srt=1')),
      JSON.stringify(doneCard.dl));

    await page.evaluate(`document.querySelector('#currentJob [data-act="play"]').click()`);
    const player = await page.evaluate(`(() => {
      const video = document.querySelector('#currentJob video');
      return video ? { src: video.getAttribute('src'), visible: !video.closest('.card-player').classList.contains('hidden') } : null;
    })()`);
    check('点播放出现内嵌播放器', Boolean(player && player.visible && player.src.includes('/api/studio/video/j1')), JSON.stringify(player));
    await page.screenshot('02-job-done.png');

    // ---- 验收 1b：长稿子判为 script ----
    const script = '大家好，今天想跟你聊聊一个很多人都会遇到的小问题：为什么明明很困，躺到床上却越躺越清醒。'.repeat(3);
    await page.evaluate(`(() => {
      const input = document.querySelector('#topicInput');
      input.value = ${JSON.stringify(script)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.seg-btn[data-sec="45"]').click();
    })()`);
    const scriptHint = await page.evaluate(`document.querySelector('#submitHint').textContent.trim()`);
    check('长文本判为「稿子」', scriptHint.includes('按稿子处理'), scriptHint);
    await page.evaluate(`document.querySelector('#startBtn').click()`);
    const scriptReq = await waitFor(
      () => mock.requests.filter((r) => r.method === 'POST' && r.path === '/v1/jobs')[1] || null,
      8000,
      100,
      'script POST /v1/jobs'
    );
    const scriptBody = scriptReq.body;
    check(
      'script 提交请求体 = {script, seconds}',
      JSON.stringify(Object.keys(scriptBody).sort()) === '["script","seconds"]' &&
        scriptBody.script === script &&
        scriptBody.seconds === 45,
      JSON.stringify({ keys: Object.keys(scriptBody), seconds: scriptBody.seconds, chars: scriptBody.script.length })
    );

    // ---- 验收 3：重做流程 ----
    await page.evaluate(`document.querySelector('.tab[data-view="jobs"]').click()`);
    await waitFor(
      async () => (await page.evaluate(`document.querySelectorAll('#jobsList .card').length`)) >= 2,
      8000,
      200,
      'jobs list'
    );
    await page.screenshot('03-jobs.png');

    const redoClicked = await page.evaluate(`(() => {
      const cards = [...document.querySelectorAll('#jobsList .card')];
      const card = cards.find(c => c.textContent.includes('任务 j1'));
      if (!card) return false;
      const btn = card.querySelector('[data-act="redo"]');
      if (!btn || btn.classList.contains('hidden')) return false;
      btn.click();
      return true;
    })()`);
    check('完成卡上有可点的「重做」', redoClicked === true);

    const loaded = await waitFor(
      async () => page.evaluate(`(() => {
        const adv = document.querySelector('#advanced');
        const rows = [...document.querySelectorAll('#scenesBody .scene-row')];
        return {
          makeActive: document.querySelector('#view-make').classList.contains('active'),
          open: adv.open,
          rows: rows.length,
          texts: rows.map(r => r.querySelector('.scene-text').value),
          banner: document.querySelector('#redoBanner').classList.contains('hidden') ? '' : document.querySelector('#redoText').textContent.trim(),
        };
      })()`),
      8000,
      200,
      'redo scenes loaded'
    );
    check('重做 → 回到做视频页并展开折叠区', loaded.makeActive === true && loaded.open === true, JSON.stringify({ makeActive: loaded.makeActive, open: loaded.open }));
    check('重做 → 分镜载入（7 场）', loaded.rows === 7 && loaded.texts[0].length > 0, `${loaded.rows} 行 / 首场「${loaded.texts[0]}」`);
    check('重做横幅提示', loaded.banner.includes('重做任务 j1'), loaded.banner);
    await page.screenshot('04-redo-scenes.png');

    await page.evaluate(`(() => {
      const input = document.querySelector('#scenesBody .scene-row .scene-text');
      input.value = '改过的第一场标题';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const edited = await page.evaluate(`document.querySelector('#scenesBody .scene-row .scene-text').value`);
    check('分镜第 1 场可编辑', edited === '改过的第一场标题', edited);

    await page.evaluate(`document.querySelector('#startBtn').click()`);
    const redoReq = await waitFor(
      () => mock.requests.find((r) => r.method === 'POST' && /\/v1\/jobs\/[^/]+\/redo$/.test(r.path)) || null,
      8000,
      100,
      'redo POST'
    );
    check(
      '重做请求走 /v1/jobs/:id/redo',
      redoReq.path === '/v1/jobs/j1/redo',
      redoReq.path
    );
    check(
      '重做请求体里 scenes[0].text 是新值',
      Array.isArray(redoReq.body.scenes) &&
        redoReq.body.scenes.length === 7 &&
        redoReq.body.scenes[0].text === '改过的第一场标题',
      JSON.stringify({ count: redoReq.body.scenes && redoReq.body.scenes.length, first: redoReq.body.scenes && redoReq.body.scenes[0] && redoReq.body.scenes[0].text })
    );
    check(
      '重做只提交 scenes（契约干净）',
      JSON.stringify(Object.keys(redoReq.body)) === '["scenes"]',
      JSON.stringify(Object.keys(redoReq.body))
    );

    // ---- 验收 4：失败态可读文案 ----
    // 重做提交成功后旧分镜会被清掉；这里显式点「清空」再按主题提交
    await page.evaluate(`document.querySelector('#clearScenesBtn').click()`);
    const cleared = await page.evaluate(`document.querySelectorAll('#scenesBody .scene-row').length`);
    check('「清空」按钮清掉分镜', cleared === 0, `rows=${cleared}`);
    await page.evaluate(`(() => {
      const input = document.querySelector('#topicInput');
      input.value = '__FAIL_VOICE__';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.seg-btn[data-sec="60"]').click();
      document.querySelector('#startBtn').click();
    })()`);
    const failText = await waitFor(
      async () => {
        const text = await page.evaluate(`document.querySelector('#currentJob .card-status').textContent.trim()`);
        return text.includes('配音服务不可用，已重试') ? text : null;
      },
      10000,
      200,
      'failure copy'
    );
    const failChip = await page.evaluate(`document.querySelector('#currentJob .chip').textContent.trim()`);
    check('失败态显示可读中文', failText.includes('配音服务不可用，已重试') && failChip === '失败', `${failChip} / ${failText}`);
    await page.screenshot('05-failure.png');

    const failedDetail = mock.jobs.find((job) => job.failCode === 'VOICE_UNAVAILABLE');
    check('桩确实返回 VOICE_UNAVAILABLE', Boolean(failedDetail), failedDetail ? failedDetail.id : 'none');

    // ---- 设置页 ----
    await page.evaluate(`document.querySelector('.tab[data-view="settings"]').click()`);
    const settingsView = await page.evaluate(`(() => ({
      active: document.querySelector('#view-settings').classList.contains('active'),
      style: document.querySelector('#setStyle').value,
      voice: document.querySelector('#setVoice').value,
      persona: document.querySelector('#personaLine').textContent.trim(),
    }))()`);
    check('设置页可见且两个下拉', settingsView.active && settingsView.style === '' && settingsView.voice === '', JSON.stringify(settingsView));

    await page.evaluate(`(() => {
      const style = document.querySelector('#setStyle');
      style.value = 'blueprint';
      style.dispatchEvent(new Event('change', { bubbles: true }));
      const voice = document.querySelector('#setVoice');
      voice.value = 'voc_test_b';
      voice.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const saved = await page.evaluate(`window.localStorage.getItem('dsh-panel-v2-prefs')`);
    check('设置写入 localStorage', saved.includes('blueprint') && saved.includes('voc_test_b'), saved);
    await page.screenshot('06-settings.png');

    await page.call('Page.reload', { ignoreCache: true });
    await page.waitReady();
    await waitFor(async () => page.evaluate(`!!document.querySelector('.tab')`), 10000, 100, 'reload boot');
    await waitFor(
      async () => (await page.evaluate(`document.querySelectorAll('#setVoice option').length`)) > 1,
      8000,
      100,
      'voices reloaded'
    );
    const persisted = await page.evaluate(`(() => ({
      setStyle: document.querySelector('#setStyle').value,
      setVoice: document.querySelector('#setVoice').value,
      advStyle: document.querySelector('#styleSel').value,
      advVoice: document.querySelector('#voiceSel').value,
    }))()`);
    check('刷新后设置仍在（两处下拉同步）',
      persisted.setStyle === 'blueprint' && persisted.setVoice === 'voc_test_b' &&
        persisted.advStyle === 'blueprint' && persisted.advVoice === 'voc_test_b',
      JSON.stringify(persisted));

    // 还原成「跟人设」
    await page.evaluate(`(() => {
      const s = document.querySelector('#setStyle'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true }));
      const v = document.querySelector('#setVoice'); v.value = ''; v.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);

    // ---- 验收 5：800px 窄屏 ----
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: 800,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.call('Page.reload', { ignoreCache: true });
    await page.waitReady();
    await waitFor(async () => page.evaluate(`!!document.querySelector('.tab')`), 10000, 100, 'narrow boot');
    await sleep(300);

    const narrow = await page.evaluate(`(() => {
      window.scrollTo(0, 0);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const box = (sel) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
      };
      const items = { input: box('#topicInput'), seg: box('#secondsSeg'), start: box('#startBtn') };
      const all = Object.values(items);
      return {
        vw, vh,
        scrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        items,
        withinWidth: all.every(r => r.left >= 0 && r.right <= vw),
        withinScreen: all.every(r => r.top >= 0 && r.bottom <= vh),
        flexDirection: getComputedStyle(document.querySelector('.make-row')).flexDirection,
      };
    })()`);
    check('800px 无横向滚动', narrow.scrollWidth <= narrow.vw && narrow.bodyScrollWidth <= narrow.vw,
      `scrollWidth=${narrow.scrollWidth} innerWidth=${narrow.vw}`);
    check('800px 三个控件都在视口内', narrow.withinWidth && narrow.withinScreen, JSON.stringify(narrow.items));
    check('800px 单列布局', narrow.flexDirection === 'column', narrow.flexDirection);
    await page.screenshot('07-narrow-800.png');

    // ---- 验收 5b：390px 手机宽度 ----
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await page.call('Page.reload', { ignoreCache: true });
    await page.waitReady();
    await waitFor(async () => page.evaluate(`!!document.querySelector('.tab')`), 10000, 100, 'phone boot');
    await sleep(300);
    const phone = await page.evaluate(`(() => {
      window.scrollTo(0, 0);
      const vw = window.innerWidth;
      const box = (sel) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right) };
      };
      const items = { input: box('#topicInput'), seg: box('#secondsSeg'), start: box('#startBtn') };
      const closedWidth = document.documentElement.scrollWidth;
      document.querySelector('#advanced').open = true;
      const fold = document.querySelector('#advanced').getBoundingClientRect();
      const openWidth = document.documentElement.scrollWidth;
      document.querySelector('#advanced').open = false;
      return {
        vw, closedWidth, openWidth,
        items,
        withinWidth: Object.values(items).every(r => r.left >= 0 && r.right <= vw),
        foldWithin: fold.left >= 0 && fold.right <= vw,
      };
    })()`);
    check('390px 手机宽度无横向滚动', phone.closedWidth <= phone.vw && phone.withinWidth,
      `scrollWidth=${phone.closedWidth} innerWidth=${phone.vw} ${JSON.stringify(phone.items)}`);
    check('390px 展开高级也不撑破页面', phone.openWidth <= phone.vw && phone.foldWithin,
      `openScrollWidth=${phone.openWidth} innerWidth=${phone.vw}`);
    await page.screenshot('08-phone-390.png');

    // ---- 鉴权透传 ----
    await page.evaluate(`window.localStorage.setItem('dsh-panel-token', 'test-token-123')`);
    await page.call('Page.reload', { ignoreCache: true });
    await page.waitReady();
    const authReq = await waitFor(
      () => mock.requests.find((r) => r.authorization === 'Bearer test-token-123') || null,
      8000,
      200,
      'auth passthrough'
    );
    check('登录 token 透传到 v2-core', Boolean(authReq), `${authReq.method} ${authReq.path} ${authReq.authorization}`);

    // ---- 风格 / 音色 id 透传 ----
    await page.evaluate(`(() => {
      const style = document.querySelector('#setStyle');
      style.value = 'blueprint';
      style.dispatchEvent(new Event('change', { bubbles: true }));
      const voice = document.querySelector('#setVoice');
      voice.value = 'voc_test_b';
      voice.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('.tab[data-view="make"]').click();
      const input = document.querySelector('#topicInput');
      input.value = '音色透传测试';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#startBtn').click();
    })()`);
    const styledReq = await waitFor(
      () => mock.requests.slice().reverse().find((r) => r.method === 'POST' && r.path === '/v1/jobs' && r.body.topic === '音色透传测试') || null,
      8000,
      100,
      'style/voice submit'
    );
    check(
      '风格/音色 id 透传到 v2-core',
      styledReq.body.style === 'blueprint' && styledReq.body.voice === 'voc_test_b',
      JSON.stringify(styledReq.body)
    );

    // ---- 页面无未捕获异常 ----
    const realErrors = pageErrors.filter((line) => line && !/favicon/i.test(line));
    check('页面无 JS 未捕获异常', realErrors.length === 0, realErrors.slice(0, 3).join(' | ') || 'clean');

    // 汇总
    const passed = results.filter((r) => r.pass).length;
    const failed = results.length - passed;
    console.log('');
    console.log(`===== 验收汇总：${passed}/${results.length} 通过，${failed} 失败 =====`);
    for (const r of results.filter((item) => !item.pass)) {
      console.log(`  FAIL: ${r.name} ${r.detail}`);
    }
    console.log(`截图目录：${SHOT_DIR}`);
    console.log(`面板日志：${logPath}`);

    await cdp.send('Browser.close').catch(() => {});
    if (browser) {
      try {
        browser.kill();
      } catch (err) {
        /* 已退出 */
      }
    }
    await sleep(300);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch (err) {
      /* Windows 偶发占用，忽略 */
    }

    await cleanup();
    fs.closeSync(logFd);
    process.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error(`[verify] 失败：${err && err.stack ? err.stack : err}`);
    console.log(`面板日志：${logPath}`);
    if (browser) {
      try {
        browser.kill();
      } catch (e) {
        /* ignore */
      }
    }
    await cleanup();
    try {
      fs.closeSync(logFd);
    } catch (e) {
      /* ignore */
    }
    process.exit(1);
  }
}

main();
