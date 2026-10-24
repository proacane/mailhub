import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const PORT = 9336;
const EXE = process.env.QA_EXE || path.resolve('dist/win-unpacked/MailHub.exe');
const DATA_DIR = path.resolve('.qa-data-packaged');

fs.rmSync(DATA_DIR, { recursive: true, force: true });
if (!fs.existsSync(EXE)) throw new Error(`没有找到打包产物: ${EXE}`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.MAILHUB_DEMO = '1';
env.MAILHUB_DATA_DIR = DATA_DIR;

const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  throw new Error('打包版调试端口没就绪');
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
  await sleep(1500);

  const boot = await cdp.evaluate(`(async () => {
    const meta = await window.mailhub.boot();
    document.getElementById('btn-settings').click();
    await new Promise((r) => setTimeout(r, 300));
    const push = document.getElementById('settings-push-state')?.textContent?.trim();
    const versionText = document.getElementById('settings-meta')?.textContent || '';
    document.getElementById('settings-modal').hidden = true;
    return {
      ok: meta.ok,
      version: meta.ok ? meta.data.version : null,
      packaged: meta.ok ? meta.data.packaged : null,
      accounts: document.querySelectorAll('.account-item').length,
      rows: document.querySelectorAll('.msg-item').length,
      avatars: document.querySelectorAll('.msg-avatar').length,
      push,
      versionText
    };
  })()`);

  check('打包版能正常启动', boot.ok === true, JSON.stringify({ version: boot.version, packaged: boot.packaged }));
  check('运行的是打包模式', boot.packaged === true, String(boot.packaged));
  const pkgVersion = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version;
  check(`版本号为 ${pkgVersion}`, boot.version === pkgVersion, String(boot.version));
  // 启动落在统一收件箱，列表是三个演示账号的合集
  check('演示账号与统一列表正常', boot.accounts === 3 && boot.rows >= 7, `账号 ${boot.accounts} / 邮件 ${boot.rows}`);
  check('发件人头像在打包版里存在', boot.avatars === boot.rows, `${boot.avatars} 个`);
  check('新加的推送状态区块渲染正常', typeof boot.push === 'string' && boot.push.includes('推送'), boot.push);

  // 深色 + 正文跟随
  await cdp.evaluate(`(async () => {
    document.getElementById('btn-settings').click();
    await new Promise((r) => setTimeout(r, 250));
    document.getElementById('settings-theme').value = 'dark';
    document.getElementById('btn-save-settings').click();
    await new Promise((r) => setTimeout(r, 700));
    document.querySelector('.msg-item')?.click();
    await new Promise((r) => setTimeout(r, 700));
    return true;
  })()`);
  await sleep(600);

  const dark = await cdp.evaluate(`(() => {
    const frame = document.getElementById('mail-frame');
    const doc = frame?.contentDocument;
    return {
      theme: document.documentElement.dataset.theme,
      docBg: doc?.body ? getComputedStyle(doc.body).backgroundColor : null,
      docColor: doc?.body ? getComputedStyle(doc.body).color : null
    };
  })()`);
  check('打包版深色主题生效', dark.theme === 'dark', dark.theme);
  check('打包版正文跟随深色', dark.docBg === 'rgb(20, 26, 23)', `${dark.docBg} / ${dark.docColor}`);

  const errors = cdp.events
    .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text)
    .filter(Boolean);
  check('打包版无渲染报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  ws.close();
  child.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('失败:', err);
  child.kill();
  process.exit(2);
});