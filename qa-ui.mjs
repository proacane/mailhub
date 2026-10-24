import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const PORT = 9333;
const DATA_DIR = path.resolve('.qa-data');
const SHOT_DIR = path.resolve('.qa-shots');
// Electron 可执行文件：优先 ELECTRON_BIN，其次全局 npm 安装（通常是最新版），最后项目本地依赖
const ELECTRON = process.env.ELECTRON_BIN
  || [path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'electron', 'dist', 'electron.exe'),
      path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')]
    .find((p) => fs.existsSync(p))
  || 'electron';

fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.rmSync(SHOT_DIR, { recursive: true, force: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.MAILHUB_DEMO = '1';
env.MAILHUB_DATA_DIR = DATA_DIR;

const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => process.stdout.write(`[app] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[app:err] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

async function findTarget() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('调试端口没有就绪');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, awaitPromise = true) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result.value;
  }

  async shot(name) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(res.data, 'base64'));
  }
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');

  await sleep(1200);

  // 系统当前可能是深色，先把主题固定为浅色，保证浅色断言可复现
  await cdp.evaluate(`(async () => {
    document.getElementById('btn-settings').click();
    await new Promise((r) => setTimeout(r, 250));
    document.getElementById('settings-theme').value = 'light';
    document.getElementById('btn-save-settings').click();
    await new Promise((r) => setTimeout(r, 600));
    return document.documentElement.dataset.theme;
  })()`);

  const waitFrame = async (expectDark, timeout = 5000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const state = await cdp.evaluate(`(() => {
        const frame = document.getElementById('mail-frame');
        const doc = frame && frame.contentDocument;
        if (!doc || !doc.body) return null;
        return {
          bg: getComputedStyle(doc.body).backgroundColor,
          color: getComputedStyle(doc.body).color,
          dark: doc.documentElement.dataset.dark
        };
      })()`);
      if (state && state.dark === (expectDark ? '1' : '0')) return state;
      await sleep(150);
    }
    return null;
  };

  const boot = await cdp.evaluate(`(() => ({
    accounts: document.querySelectorAll('.account-item').length,
    rows: document.querySelectorAll('.msg-item').length,
    version: document.getElementById('settings-meta')?.textContent || '',
    theme: document.documentElement.dataset.theme,
    innerHeight: innerHeight
  }))()`);
  check('启动后有 3 个演示账号', boot.accounts === 3, JSON.stringify(boot));
  check('列表渲染出邮件', boot.rows > 0, `${boot.rows} 行`);
  const pkgVersion = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version;
  check(`版本号显示 ${pkgVersion}`, boot.version.includes(pkgVersion), boot.version.replace(/\s+/g, ' ').slice(0, 60));
  check('可以切到浅色主题', boot.theme === 'light', boot.theme);

  const avatars = await cdp.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('.msg-item .msg-avatar')];
    const colors = new Set(nodes.map((n) => getComputedStyle(n).backgroundColor));
    const first = nodes[0];
    return {
      count: nodes.length,
      colors: colors.size,
      text: nodes.slice(0, 5).map((n) => n.textContent.trim()),
      radius: first ? getComputedStyle(first).borderRadius : '',
      hasVar: first ? first.style.getPropertyValue('--avatar') : ''
    };
  })()`);
  check('每行都有发件人头像', avatars.count === boot.rows, `${avatars.count} 个头像`);
  check('头像颜色按发件人散列（多种颜色）', avatars.colors >= 3, `${avatars.colors} 种颜色，例：${avatars.text.join('/')}`);
  check('头像是圆形且带色值变量', avatars.radius === '50%' && Boolean(avatars.hasVar), `${avatars.radius} ${avatars.hasVar}`);

  const layout = await cdp.evaluate(`(() => {
    const main = document.querySelector('.main').getBoundingClientRect();
    const list = document.querySelector('.list-pane');
    return { mainH: Math.round(main.height), innerH: innerHeight, listScrollable: list.scrollHeight >= list.clientHeight, overflow: getComputedStyle(document.querySelector('.app')).overflow };
  })()`);
  check('主区域高度不超出窗口', layout.mainH <= layout.innerH + 1, `main=${layout.mainH}px inner=${layout.innerH}px`);

  await cdp.shot('01-light-list');

  // 打开最长的邮件，验证滚动
  const longMail = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.msg-item')];
    const target = rows.find((r) => r.querySelector('.msg-subject')?.textContent.includes('长邮件测试'));
    if (!target) return null;
    target.click();
    return target.dataset.uid;
  })()`);
  await sleep(900);
  await waitFrame(false);

  const scroll = await cdp.evaluate(`(() => {
    const pane = document.getElementById('reading-pane');
    const frame = document.getElementById('mail-frame');
    const before = pane.scrollTop;
    pane.scrollTop = 400;
    const mid = pane.scrollTop;
    pane.scrollTop = 0;
    let iframeH = 0;
    let docDark = null;
    let docBg = null;
    let forwarded = null;
    if (frame && frame.contentDocument) {
      iframeH = frame.getBoundingClientRect().height;
      docDark = frame.contentDocument.documentElement.dataset.dark;
      docBg = getComputedStyle(frame.contentDocument.body).backgroundColor;
      const doc = frame.contentDocument;
      const startTop = pane.scrollTop;
      doc.dispatchEvent(new WheelEvent('wheel', { deltaY: 220, bubbles: true, cancelable: true }));
      forwarded = pane.scrollTop > startTop;
      pane.scrollTop = 0;
    }
    return {
      found: Boolean(frame),
      scrollHeight: pane.scrollHeight,
      clientHeight: pane.clientHeight,
      maxScroll: pane.scrollHeight - pane.clientHeight,
      scrolled: mid,
      iframeH: Math.round(iframeH),
      docDark,
      docBg,
      forwarded,
      before
    };
  })()`);
  check('找到并打开了长邮件', Boolean(longMail), `uid=${longMail}`);
  check('阅读区可以滚动到底', scroll.maxScroll > 100 && scroll.scrolled === 400, JSON.stringify({ maxScroll: scroll.maxScroll, scrolled: scroll.scrolled }));
  check('iframe 高度自适应内容', scroll.iframeH > 800, `iframe=${scroll.iframeH}px`);
  check('浅色下正文 iframe 为白色纸张', scroll.docDark === '0' && scroll.docBg === 'rgb(255, 255, 255)', `${scroll.docDark} ${scroll.docBg}`);
  check('滚轮事件从正文转发到阅读区', scroll.forwarded === true, String(scroll.forwarded));

  // 点发件人写信
  const compose = await cdp.evaluate(`(async () => {
    document.querySelector('.reader-sender')?.click();
    await new Promise((r) => setTimeout(r, 250));
    const to = document.getElementById('compose-to');
    const modal = document.getElementById('compose-modal');
    const subject = document.getElementById('compose-subject');
    return { hidden: modal.hidden, to: to?.value || '', subject: subject?.value || '', title: document.querySelector('#compose-modal .modal-head h3')?.textContent };
  })()`);
  check('点发件人打开写信并自动填收件人', compose.hidden === false && /.+@.+/.test(compose.to), JSON.stringify(compose));
  await cdp.shot('02-compose-direct');
  await cdp.evaluate(`document.querySelector('#compose-modal [data-close="compose-modal"]').click(); true`);
  await sleep(200);

  // 深色模式：设置里切主题并保存
  await cdp.evaluate(`document.getElementById('btn-settings').click(); true`);
  await sleep(300);
  const pushState = await cdp.evaluate(`(() => {
    const node = document.getElementById('settings-push-state');
    return { text: node?.textContent?.trim() || '', led: node?.querySelector('.push-led')?.className || '' };
  })()`);
  check('设置里能看到即时推送状态', pushState.text.includes('推送') && pushState.led.includes('push-led'), JSON.stringify(pushState));

  await cdp.shot('03-settings-light');
  await cdp.evaluate(`(() => {
    const select = document.getElementById('settings-theme');
    select.value = 'dark';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('btn-save-settings').click();
    return true;
  })()`);
  await sleep(600);
  await waitFrame(true);

  const dark = await cdp.evaluate(`(() => {
    const frame = document.getElementById('mail-frame');
    const doc = frame?.contentDocument;
    const body = doc?.body;
    const texts = body ? [...body.querySelectorAll('*')].slice(0, 400) : [];
    const lightBg = texts.filter((n) => {
      const c = getComputedStyle(n).backgroundColor;
      const m = c.match(/rgb\\((\\d+), (\\d+), (\\d+)\\)/);
      return m && (Number(m[1]) > 200 && Number(m[2]) > 200 && Number(m[3]) > 200);
    }).length;
    const imgFilters = [...(doc?.querySelectorAll('img') || [])].map((i) => getComputedStyle(i).filter).filter((f) => f !== 'none');
    return {
      theme: document.documentElement.dataset.theme,
      appBg: getComputedStyle(document.body).backgroundColor,
      docBg: doc ? getComputedStyle(body).backgroundColor : null,
      docColor: doc ? getComputedStyle(body).color : null,
      darkFlag: doc?.documentElement.dataset.dark,
      whiteBlocks: lightBg,
      invertedImages: imgFilters.length,
      toolbarBg: (() => { const t = document.querySelector('.reader-toolbar'); return t ? getComputedStyle(t).backgroundColor : null; })(),
      listRowUnreadBar: (() => { const r = document.querySelector('.msg-item.unread'); return r ? getComputedStyle(r, '::before').backgroundColor : null; })()
    };
  })()`);
  check('主题切到深色', dark.theme === 'dark', dark.theme);
  check('正文纸张跟随深色', dark.docBg === 'rgb(20, 26, 23)' || /rgb\(20, 26, 23\)/.test(dark.docBg || ''), `${dark.docBg} / ${dark.docColor}`);
  check('正文没有残留大块白底', dark.whiteBlocks === 0, `白底元素 ${dark.whiteBlocks} 个`);
  check('图片没有被反色', dark.invertedImages === 0, `filter 非 none 的图片 ${dark.invertedImages} 个`);
  check('阅读工具条深色', /rgb\(20, 26, 23\)|rgba\(20, 26, 23/.test(dark.toolbarBg || ''), dark.toolbarBg);

  await cdp.shot('04-dark-reader');
  await cdp.evaluate(`window.scrollTo(0,0); document.querySelector('.message-list').scrollTop = 0; true`);
  await cdp.shot('05-dark-list');

  // 一键标为已读：切到账号视图，点按钮，验证应用内弹窗
  await cdp.evaluate(`(() => {
    const item = document.querySelector('.account-item');
    item.click();
    return true;
  })()`);
  await sleep(600);
  await cdp.evaluate(`document.getElementById('btn-mark-all-read').click(); true`);
  await sleep(350);
  const confirm = await cdp.evaluate(`(() => {
    const modal = document.getElementById('confirm-modal');
    const box = modal.querySelector('.modal');
    const ok = document.getElementById('confirm-ok');
    return {
      hidden: modal.hidden,
      title: document.getElementById('confirm-title').textContent,
      message: document.getElementById('confirm-message').textContent,
      okText: ok.textContent,
      okBg: getComputedStyle(ok).backgroundColor,
      modalBg: box ? getComputedStyle(box).backgroundColor : null,
      width: box ? Math.round(box.getBoundingClientRect().width) : 0,
      dark: document.documentElement.dataset.theme
    };
  })()`);
  check('标为已读弹出应用内弹窗（不是原生）', confirm.hidden === false && confirm.title.includes('全部标为已读'), JSON.stringify(confirm));
  check('弹窗跟随深色主题', confirm.dark === 'dark' && confirm.modalBg === 'rgb(20, 26, 23)', `${confirm.modalBg} / 按钮 ${confirm.okBg}`);
  await cdp.shot('06-confirm-dark');

  // Esc 关闭，设置弹窗不应被连带关闭（此时设置已关，改为验证不会误关）
  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(200);
  const afterEsc = await cdp.evaluate(`document.getElementById('confirm-modal').hidden`);
  check('Esc 关闭确认弹窗', afterEsc === true, String(afterEsc));

  // 真正确认，验证演示数据被标记
  await cdp.evaluate(`document.getElementById('btn-mark-all-read').click(); true`);
  await sleep(300);
  await cdp.evaluate(`document.getElementById('confirm-ok').click(); true`);
  await sleep(700);
  const marked = await cdp.evaluate(`(() => ({
    unread: document.querySelectorAll('.msg-item.unread').length,
    toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).pop() || '',
    confirmHidden: document.getElementById('confirm-modal').hidden
  }))()`);
  check('确认后全部标为已读生效', marked.unread === 0 && marked.confirmHidden === true, JSON.stringify(marked));
  check('有结果提示', /标为已读|没有未读/.test(marked.toast), marked.toast);

  // 切到账号视图后阅读区被清空，重新选中长邮件再验证主题切换
  const reselected = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('.msg-item')].find((r) => r.querySelector('.msg-subject')?.textContent.includes('长邮件测试'));
    row?.click();
    return Boolean(row);
  })()`);
  check('可以重新打开长邮件', reselected === true, String(reselected));
  await waitFrame(true);

  // 切回浅色，验证正文恢复白纸
  await cdp.evaluate(`document.getElementById('btn-settings').click(); true`);
  await sleep(300);
  await cdp.evaluate(`(() => {
    document.getElementById('settings-theme').value = 'light';
    document.getElementById('btn-save-settings').click();
    return true;
  })()`);
  const lightFrame = await waitFrame(false);
  const backLight = {
    theme: await cdp.evaluate(`document.documentElement.dataset.theme`),
    docBg: lightFrame ? lightFrame.bg : null
  };
  check('切回浅色后正文恢复白纸', backLight.theme === 'light' && backLight.docBg === 'rgb(255, 255, 255)', JSON.stringify(backLight));

  // 关掉「正文跟随深色」再切深色，确认正文保持白纸
  await cdp.evaluate(`document.getElementById('btn-settings').click(); true`);
  await sleep(300);
  await cdp.evaluate(`(() => {
    document.getElementById('settings-dark-mail').checked = false;
    document.getElementById('settings-theme').value = 'dark';
    document.getElementById('btn-save-settings').click();
    return true;
  })()`);
  const optFrame = await waitFrame(false);
  const optOut = {
    theme: await cdp.evaluate(`document.documentElement.dataset.theme`),
    docBg: optFrame ? optFrame.bg : null
  };
  check('关掉开关后正文不跟随深色', optOut.theme === 'dark' && optOut.docBg === 'rgb(255, 255, 255)', JSON.stringify(optOut));
  await cdp.shot('07-dark-mail-optout');

  // 控制台错误
  await cdp.evaluate(`(() => { document.getElementById('btn-settings').click(); return true; })()`);
  await sleep(200);
  const errors = cdp.events
    .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.entry?.text)
    .filter((text) => text && !/favicon/.test(text));
  check('无渲染进程报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  fs.writeFileSync(path.join('.qa-shots', 'results.json'), JSON.stringify({ results, boot, avatars, scroll, dark, confirm, marked }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  ws.close();
  child.kill();
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('测试脚本失败:', err);
  child.kill();
  process.exit(2);
});