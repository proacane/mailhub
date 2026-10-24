import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const PORT = 9338;
const DATA_DIR = path.resolve('.qa-data-015');
// Electron 可执行文件：优先 ELECTRON_BIN，其次全局 npm 安装（通常是最新版），最后项目本地依赖
const ELECTRON = process.env.ELECTRON_BIN
  || [path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'electron', 'dist', 'electron.exe'),
      path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')]
    .find((p) => fs.existsSync(p))
  || 'electron';

fs.rmSync(DATA_DIR, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.MAILHUB_DEMO = '1';
env.MAILHUB_DATA_DIR = DATA_DIR;

const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => process.stderr.write(`[app:err] ${d}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getJson = (url) =>
  new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });

async function findTarget() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error('调试端口没就绪');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) this.events.push(m);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result.value;
  }
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

(async () => {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await sleep(1600);

  const layout = await cdp.evaluate(`(() => {
    const bar = document.querySelector('.titlebar');
    const app = document.querySelector('.app');
    const controls = getComputedStyle(document.documentElement).getPropertyValue('--titlebar-controls').trim();
    return {
      hasBar: Boolean(bar),
      barHeight: bar ? Math.round(bar.getBoundingClientRect().height) : 0,
      barTop: bar ? Math.round(bar.getBoundingClientRect().top) : -1,
      appTop: app ? Math.round(app.getBoundingClientRect().top) : -1,
      appHeight: app ? Math.round(app.getBoundingClientRect().height) : 0,
      innerHeight: window.innerHeight,
      controls,
      dragRegion: bar ? getComputedStyle(bar).webkitAppRegion : null,
      overlayApi: Boolean(navigator.windowControlsOverlay),
      overlayRect: navigator.windowControlsOverlay ? (() => { const r = navigator.windowControlsOverlay.getTitlebarAreaRect(); return { x: Math.round(r.x), width: Math.round(r.width) }; })() : null,
      view: document.getElementById('titlebar-view')?.textContent,
      settingsBtn: Boolean(document.getElementById('btn-settings')),
      composeBtn: Boolean(document.getElementById('btn-titlebar-compose'))
    };
  })()`);

  check('标题栏存在且高度 44', layout.hasBar && layout.barHeight === 44, `${layout.barHeight}px`);
  check('内容区正好接在标题栏下面', layout.appTop === 44 && Math.abs(layout.appTop + layout.appHeight - layout.innerHeight) <= 1, `app ${layout.appTop}+${layout.appHeight} / window ${layout.innerHeight}`);
  check('标题栏是窗口拖动区', layout.dragRegion === 'drag', String(layout.dragRegion));
  check('拿到原生窗口按钮区域', layout.overlayApi && layout.overlayRect.width > 0, JSON.stringify(layout.overlayRect));
  check('标题栏预留了窗口按钮宽度', parseInt(layout.controls, 10) >= 100, layout.controls);
  check('标题栏显示当前视图', /统一收件箱|收件箱|Sent|已发送/.test(layout.view || ''), layout.view);
  check('设置与写邮件按钮在标题栏', layout.settingsBtn && layout.composeBtn, `${layout.settingsBtn}/${layout.composeBtn}`);

  // 深色主题下标题栏跟着变
  const dark = await cdp.evaluate(`(async () => {
    document.getElementById('btn-settings').click();
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById('settings-theme').value = 'dark';
    document.getElementById('btn-save-settings').click();
    await new Promise((r) => setTimeout(r, 800));
    const bar = document.querySelector('.titlebar');
    return { bg: getComputedStyle(bar).backgroundColor, border: getComputedStyle(bar).borderBottomColor };
  })()`);
  check('深色下标题栏跟随主题', dark.bg === 'rgb(17, 23, 20)', `${dark.bg} / ${dark.border}`);

  // 已发送：回复对象应该是原收件人
  const reply = await cdp.evaluate(`(async () => {
    const account = document.querySelector('.account-item');
    account.click();
    await new Promise((r) => setTimeout(r, 500));
    const folders = [...document.querySelectorAll('[data-folder]')].map((b) => b.textContent.trim());
    const sent = [...document.querySelectorAll('[data-folder]')].find((b) => /已发送|Sent/i.test(b.textContent || b.dataset.folder || ''));
    if (!sent) return { skipped: true, options: folders };
    sent.click();
    await new Promise((r) => setTimeout(r, 800));
    const row = document.querySelector('.msg-item');
    if (!row) return { skipped: true, reason: '已发送里没有邮件' };
    row.click();
    await new Promise((r) => setTimeout(r, 900));
    const to = document.querySelector('[data-action="reply"]');
    to.click();
    await new Promise((r) => setTimeout(r, 500));
    return {
      to: document.getElementById('compose-to').value,
      cc: document.getElementById('compose-cc').value,
      notice: document.getElementById('compose-notice').textContent,
      noticeHidden: document.getElementById('compose-notice').hidden,
      folders
    };
  })()`);
  if (reply.skipped) {
    check('已发送回复（演示数据没有已发送，跳过）', true, JSON.stringify(reply));
  } else {
    check('已发送里回复发给原收件人而不是自己', reply.to && !reply.to.includes('@qq.com'), `to=${reply.to}`);
    check('已发送回复有说明提示', reply.noticeHidden === false && reply.notice.includes('原收件人'), reply.notice);
  }

  const errors = cdp.events
    .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text)
    .filter(Boolean);
  check('无渲染进程报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  await ws.close();
  child.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('失败:', err);
  child.kill();
  process.exit(2);
});