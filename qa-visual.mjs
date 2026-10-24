import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const PORT = 9334;
const DATA_DIR = path.resolve('.qa-data');
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
    } catch {}
    await sleep(250);
  }
  throw new Error('调试端口没有就绪');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
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
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result.value;
  }
}

const MEASURE = `(() => {
  const parse = (value) => {
    const m = String(value).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(',').map((v) => parseFloat(v.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const blend = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1
  });
  const effectiveBg = (node) => {
    let current = node;
    let acc = null;
    while (current && current !== document.documentElement) {
      const bg = parse(getComputedStyle(current).backgroundColor);
      if (bg && bg.a > 0) acc = acc ? blend(acc, bg) : bg;
      if (acc && acc.a >= 0.999) return acc;
      current = current.parentElement;
    }
    return acc || { r: 255, g: 255, b: 255, a: 1 };
  };
  const ratio = (fg, bg) => {
    const l1 = lum(fg);
    const l2 = lum(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const targets = [
    '.msg-from', '.msg-subject', '.msg-snippet', '.msg-time', '.msg-flags',
    '.list-bar h3', '.panel-head h2', '.panel-head p', '.panel-row', '.panel-count', '.rail-tab',
    '.sync-hint', '.chip.active', '.search-row input',
    '.reader-subject', '.reader-sender-name', '.reader-sender-address', '.reader-date',
    '.reader-recipients', '.reader-account', '.tool-btn', '.tool-btn.danger',
    '.settings-section h4', '.settings-meta', '.hint-box', '.checkbox', '.push-detail',
    '.confirm-message', '.modal-head h3', '.field > span',
  '.titlebar-view', '.titlebar-brand strong', '.compose-drop-hint'
  ];
  const out = [];
  for (const selector of targets) {
    const node = document.querySelector(selector);
    if (!node) { out.push({ selector, missing: true }); continue; }
    const cs = getComputedStyle(node);
    const fg = parse(cs.color);
    const bg = effectiveBg(node);
    const text = blend(fg, bg);
    out.push({
      selector,
      fontSize: parseFloat(cs.fontSize),
      weight: cs.fontWeight,
      color: cs.color,
      bg: 'rgb(' + Math.round(bg.r) + ', ' + Math.round(bg.g) + ', ' + Math.round(bg.b) + ')',
      ratio: Math.round(ratio(text, bg) * 100) / 100
    });
  }
  return out;
})()`;

const OVERFLOW = `(() => {
  const vw = innerWidth;
  const bad = [];
  for (const node of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(node);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0) continue;
    const intentionalClip = cs.textOverflow === 'ellipsis' || cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.overflowX === 'hidden';
    if (rect.right > vw + 1 && !intentionalClip) {
      bad.push({ cls: node.className, right: Math.round(rect.right), vw });
    }
  }
  return { docScrollWidth: document.documentElement.scrollWidth, innerWidth: vw, nodes: bad.slice(0, 5) };
})()`;

(async () => {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await sleep(1200);

  const setTheme = async (theme) => {
    await cdp.evaluate(`(async () => {
      document.getElementById('btn-settings').click();
      await new Promise((r) => setTimeout(r, 200));
      document.getElementById('settings-theme').value = '${theme}';
      document.getElementById('btn-save-settings').click();
      await new Promise((r) => setTimeout(r, 500));
      return true;
    })()`);
    await sleep(500);
  };

  // 选中第一封邮件，阅读区元素才有得量
  await cdp.evaluate(`document.querySelector('.msg-item').click(); true`);
  await sleep(700);

  await setTheme('light');
  const light = await cdp.evaluate(MEASURE);
  const lightOverflow = await cdp.evaluate(OVERFLOW);

  await setTheme('dark');
  const dark = await cdp.evaluate(MEASURE);
  const darkOverflow = await cdp.evaluate(OVERFLOW);

  const report = (label, rows) => {
    console.log(`\n=== ${label} ===`);
    for (const row of rows) {
      if (row.missing) { console.log(`  (缺元素) ${row.selector}`); continue; }
      const flag = row.ratio < 4.5 ? (row.ratio < 3 ? ' ✗' : ' !') : '';
      console.log(`  ${String(row.ratio).padStart(5)}:1  ${row.fontSize}px${flag}  ${row.selector}  ${row.color} on ${row.bg}`);
    }
  };
  report('浅色对比度', light);
  report('深色对比度', dark);
  console.log('\n浅色溢出:', JSON.stringify(lightOverflow));
  console.log('深色溢出:', JSON.stringify(darkOverflow));

  // 响应式：1024x720 与 800x600
  const sizes = [[1024, 720], [800, 600]];
  for (const [width, height] of sizes) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const m = await cdp.evaluate(`(() => {
      const app = document.querySelector('.app').getBoundingClientRect();
      const panes = document.querySelector('.panes').getBoundingClientRect();
      return {
        appW: Math.round(app.width), appH: Math.round(app.height),
        panesW: Math.round(panes.width),
        docW: document.documentElement.scrollWidth,
        innerW: innerWidth,
        sidebar: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
        list: Math.round(document.querySelector('.list-pane').getBoundingClientRect().width)
      };
    })()`);
    console.log(`窗口 ${width}x${height}:`, JSON.stringify(m));
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  fs.writeFileSync('.qa-shots/contrast.json', JSON.stringify({ light, dark, lightOverflow, darkOverflow }, null, 2));
  ws.close();
  child.kill();
  process.exit(0);
})().catch((err) => {
  console.error('失败:', err);
  child.kill();
  process.exit(2);
});