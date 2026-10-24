import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const PORT = 9339;
const DATA_DIR = path.resolve('.qa-data-compose');
// Electron 可执行文件：优先 ELECTRON_BIN，其次全局 npm 安装（通常是最新版），最后项目本地依赖
const ELECTRON = process.env.ELECTRON_BIN
  || [path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'electron', 'dist', 'electron.exe'),
      path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')]
    .find((p) => fs.existsSync(p))
  || 'electron';
const TEMP_DIR = path.join(os.tmpdir(), 'mailhub-qa-attach');
const DROP_FILE = path.join(TEMP_DIR, '季度报告.txt');

fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.writeFileSync(DROP_FILE, '这是一个用于测试拖拽上传的附件。', 'utf8');

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
  await sleep(1500);

  // 打开写信
  const rect = await cdp.evaluate(`(async () => {
    document.getElementById('btn-titlebar-compose').click();
    await new Promise((r) => setTimeout(r, 600));
    const card = document.querySelector('.modal-compose');
    const r = card.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), hidden: document.getElementById('compose-modal').hidden };
  })()`);
  check('标题栏的写邮件按钮能打开写信窗口', rect.hidden === false, JSON.stringify({ x: rect.x, y: rect.y }));

  // 用 CDP 派发真实文件拖拽（不是伪造 File 对象）
  const dragData = { items: [], files: [DROP_FILE], dragOperationsMask: 1 };
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: rect.x, y: rect.y, data: dragData });
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: rect.x, y: rect.y, data: dragData });
  const overlay = await cdp.evaluate(`(() => {
    const node = document.getElementById('compose-dropzone');
    return { visible: node && !node.hidden, text: node?.textContent?.replace(/\\s+/g, ' ').trim() };
  })()`);
  check('拖入文件时显示投放蒙层', overlay.visible === true, overlay.text);
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: rect.x, y: rect.y, data: dragData });
  await sleep(900);

  const attached = await cdp.evaluate(`(() => {
    const chips = [...document.querySelectorAll('#compose-attachments .attachment-chip')];
    return {
      count: chips.length,
      names: chips.map((c) => c.querySelector('span')?.textContent?.trim()),
      missing: chips.filter((c) => c.classList.contains('missing')).length,
      overlayHidden: document.getElementById('compose-dropzone').hidden
    };
  })()`);
  check('拖拽后附件进入列表', attached.count === 1 && attached.names[0]?.includes('季度报告.txt'), JSON.stringify(attached.names));
  check('刚拖入的附件不标记缺失', attached.missing === 0, `missing=${attached.missing}`);
  check('投放后蒙层收起', attached.overlayHidden === true, String(attached.overlayHidden));

  // 关闭写信（Esc），附件应写进草稿
  await cdp.evaluate(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    return true;
  })()`);
  const draft = await cdp.evaluate(`(() => {
    const raw = localStorage.getItem('mailhub.composeDraft.v1');
    const parsed = raw ? JSON.parse(raw) : null;
    return { saved: Boolean(parsed), attachments: parsed?.attachments || [] };
  })()`);
  check('只带附件也能存进草稿', draft.saved && draft.attachments.length === 1, JSON.stringify(draft.attachments));

  // 重新打开写信，附件应恢复
  const restored = await cdp.evaluate(`(async () => {
    document.getElementById('btn-titlebar-compose').click();
    await new Promise((r) => setTimeout(r, 900));
    const chips = [...document.querySelectorAll('#compose-attachments .attachment-chip')];
    return {
      count: chips.length,
      text: chips[0]?.textContent?.replace(/\\s+/g, ' ').trim(),
      hint: document.getElementById('compose-draft-hint').textContent
    };
  })()`);
  check('重新打开能恢复草稿附件', restored.count === 1 && restored.text?.includes('季度报告.txt'), `${restored.text} / ${restored.hint}`);

  // 把文件删掉，再重开，应提示找不到
  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  fs.rmSync(DROP_FILE, { force: true });
  const missing = await cdp.evaluate(`(async () => {
    document.getElementById('btn-titlebar-compose').click();
    await new Promise((r) => setTimeout(r, 1000));
    const chip = document.querySelector('#compose-attachments .attachment-chip');
    return {
      missing: chip?.classList.contains('missing') || false,
      text: chip?.textContent?.replace(/\\s+/g, ' ').trim(),
      title: chip?.getAttribute('title')
    };
  })()`);
  check('附件被删除后草稿里标记「找不到」', missing.missing === true, `${missing.text} / ${missing.title}`);

  // 发送前拦截：有缺失附件时不发信，明确报错
  const guarded = await cdp.evaluate(`(async () => {
    document.getElementById('compose-to').value = 'someone@example.com';
    document.getElementById('compose-subject').value = '测试附件缺失';
    document.getElementById('btn-send').click();
    await new Promise((r) => setTimeout(r, 600));
    return { error: document.getElementById('compose-error').textContent };
  })()`);
  check('缺附件时发送被拦下并提示', /找不到/.test(guarded.error || ''), guarded.error);

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