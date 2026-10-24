import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const PORT = 9340;
const DATA_DIR = path.resolve('.qa-data-layout');
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
  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const LAYOUT = `(() => {
  const w = (sel) => { const n = document.querySelector(sel); return n ? Math.round(n.getBoundingClientRect().width) : null; };
  const railTabs = [...document.querySelectorAll('.account-item')];
  return {
    rail: w('.rail'),
    panel: w('.sidebar'),
    list: w('.list-pane'),
    reader: w('.reading-pane'),
    tabs: railTabs.length,
    allActive: document.getElementById('nav-all').classList.contains('active'),
    panelTitle: document.getElementById('panel-title')?.textContent,
    panelRows: document.querySelectorAll('#panel-body .panel-row').length,
    readerMargin: getComputedStyle(document.querySelector('.reading-pane')).margin,
    readerRadius: getComputedStyle(document.querySelector('.reading-pane')).borderRadius,
    innerWidth: window.innerWidth,
    docWidth: document.documentElement.scrollWidth
  };
})()`;

(async () => {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await sleep(1500);

  // 固定浅色，避免上一次测试留下的深色
  await cdp.evaluate(`(async () => {
    document.getElementById('btn-settings').click();
    await new Promise((r) => setTimeout(r, 250));
    document.getElementById('settings-theme').value = 'light';
    document.getElementById('btn-save-settings').click();
    await new Promise((r) => setTimeout(r, 600));
    return true;
  })()`);
  await sleep(400);

  const base = await cdp.evaluate(LAYOUT);
  check('四栏结构：分拣格 68 / 台账 212 / 清单 368', base.rail === 68 && base.panel === 212 && base.list === 368, `${base.rail}/${base.panel}/${base.list}`);
  check('账户变成竖排分拣格', base.tabs === 3, `${base.tabs} 个`);
  check('默认停在统一收件箱', base.allActive === true && base.panelTitle === '统一收件箱', base.panelTitle);
  check('统一收件箱的台账列出所有邮箱', base.panelRows === 3, `${base.panelRows} 行`);
  check('信纸是浮起的卡片', /14px/.test(base.readerMargin) && parseFloat(base.readerRadius) >= 12, `${base.readerMargin} / ${base.readerRadius}`);
  check('无横向溢出', base.docWidth === base.innerWidth, `${base.docWidth}/${base.innerWidth}`);

  await cdp.shot('.qa-shots/v2-01-unified-list.png');

  // 切到某个账号 → 台账变成文件夹
  const accountView = await cdp.evaluate(`(async () => {
    document.querySelector('.account-item').click();
    await new Promise((r) => setTimeout(r, 700));
    const rows = [...document.querySelectorAll('#panel-body .panel-row')];
    return {
      title: document.getElementById('panel-title').textContent,
      sub: document.getElementById('panel-sub').textContent,
      folders: rows.map((r) => r.textContent.trim()),
      active: rows.filter((r) => r.classList.contains('active')).map((r) => r.textContent.trim()),
      editVisible: !document.getElementById('btn-edit-account').hidden
    };
  })()`);
  check('选中账号后台账显示该账号的文件夹', accountView.folders.length >= 4, accountView.folders.join(' / '));
  check('当前文件夹高亮', accountView.active.length === 1 && accountView.active[0].includes('收件箱'), JSON.stringify(accountView.active));
  check('账号栏提供编辑入口', accountView.editVisible === true, `${accountView.title} · ${accountView.sub}`);

  // 点文件夹（已发送）切换
  const folderSwitch = await cdp.evaluate(`(async () => {
    const sent = [...document.querySelectorAll('#panel-body .panel-row')].find((b) => /已发送|Sent/i.test(b.textContent));
    if (!sent) return { skipped: true };
    sent.click();
    await new Promise((r) => setTimeout(r, 700));
    return {
      scope: document.getElementById('list-scope').textContent,
      active: [...document.querySelectorAll('#panel-body .panel-row.active')].map((b) => b.textContent.trim())
    };
  })()`);
  check('台账里点文件夹能切换清单范围', folderSwitch.skipped ? true : folderSwitch.scope === '已发送' && folderSwitch.active.length === 1, JSON.stringify(folderSwitch));

  // 打开一封邮件看信纸排版
  const reader = await cdp.evaluate(`(async () => {
    const inbox = [...document.querySelectorAll('#panel-body .panel-row')].find((b) => b.textContent.includes('收件箱'));
    inbox?.click();
    await new Promise((r) => setTimeout(r, 600));
    document.querySelector('.msg-item')?.click();
    await new Promise((r) => setTimeout(r, 1100));
    const subject = document.querySelector('.reader-subject');
    const sheet = document.querySelector('.reading-pane');
    return {
      subjectFont: subject ? getComputedStyle(subject).fontFamily : null,
      subjectSize: subject ? getComputedStyle(subject).fontSize : null,
      sheetBg: getComputedStyle(sheet).backgroundColor,
      radius: getComputedStyle(sheet).borderRadius
    };
  })()`);
  check('正文标题用衬线字（信纸感）', /serif/i.test(reader.subjectFont || '') && parseFloat(reader.subjectSize) >= 20, `${reader.subjectSize} ${reader.subjectFont?.slice(0, 40)}`);
  check('信纸有独立底色与圆角', reader.radius === '16px', `${reader.sheetBg} / ${reader.radius}`);

  await cdp.shot('.qa-shots/v2-02-reader-light.png');

  // 未读条改成邮戳红
  const unread = await cdp.evaluate(`(() => {
    const row = document.querySelector('.msg-item.unread');
    if (!row) return { skipped: true };
    return { bar: getComputedStyle(row, '::before').backgroundColor, dot: getComputedStyle(row.querySelector('.msg-unread-dot')).backgroundColor };
  })()`);
  check('未读标记是邮戳红', unread.skipped ? true : unread.bar === 'rgb(166, 58, 47)' && unread.dot === 'rgb(166, 58, 47)', JSON.stringify(unread));

  // 深色
  await cdp.evaluate(`(async () => {
    document.getElementById('btn-settings').click();
    await new Promise((r) => setTimeout(r, 250));
    document.getElementById('settings-theme').value = 'dark';
    document.getElementById('btn-save-settings').click();
    await new Promise((r) => setTimeout(r, 800));
    return true;
  })()`);
  await sleep(500);
  const dark = await cdp.evaluate(`(() => {
    const bg = (sel) => getComputedStyle(document.querySelector(sel)).backgroundColor;
    return { rail: bg('.rail'), panel: bg('.sidebar'), list: bg('.list-pane'), sheet: bg('.reading-pane'), theme: document.documentElement.dataset.theme };
  })()`);
  check('深色下四层纸面各自成立', dark.theme === 'dark' && dark.panel === 'rgb(17, 23, 20)' && dark.list === 'rgb(20, 26, 23)' && dark.sheet === 'rgb(20, 26, 23)', JSON.stringify(dark));
  await cdp.shot('.qa-shots/v2-03-reader-dark.png');

  // 窄窗口
  for (const [width, height, label] of [[1024, 720, '1024'], [800, 600, '800']]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const narrow = await cdp.evaluate(`(() => ({
      rail: Math.round(document.querySelector('.rail').getBoundingClientRect().width),
      panel: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
      list: Math.round(document.querySelector('.list-pane').getBoundingClientRect().width),
      docW: document.documentElement.scrollWidth,
      innerW: window.innerWidth
    }))()`);
    check(`${label} 宽下不溢出`, narrow.docW === narrow.innerW, JSON.stringify(narrow));
    if (label === '800') await cdp.shot('.qa-shots/v2-04-narrow.png');
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');

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