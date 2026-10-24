'use strict';

/**
 * 安装包内容核对：从 exe 里拆出 resources/app.asar，
 * 确认新功能真的进了包，而不是只改到了源码。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const asar = require('@electron/asar');

const installer = process.argv[2] || path.resolve('dist', `MailHub-Setup-${require('./package.json').version}.exe`);
if (!fs.existsSync(installer)) {
  console.error(`找不到安装包: ${installer}`);
  process.exit(2);
}

const sevenZip = (() => {
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  const stack = [cache];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.toLowerCase() === '7za.exe') return full;
    }
  }
  return null;
})();
if (!sevenZip) {
  console.error('找不到 electron-builder 缓存里的 7za.exe');
  process.exit(2);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailhub-payload-'));
console.log(`拆包目录: ${workDir}`);
execFileSync(sevenZip, ['x', installer, '-o' + workDir, 'resources\\app.asar', '-y'], { stdio: 'ignore' });

const asarPath = path.join(workDir, 'resources', 'app.asar');
const read = (file) => asar.extractFile(asarPath, file).toString();
const files = asar.listPackage(asarPath);

const pkg = JSON.parse(read('package.json'));
const app = read('renderer\\app.js');
const css = read('renderer\\styles.css');
const html = read('renderer\\index.html');
const main = read('main\\main.js');
const preload = read('preload\\preload.js');
const sender = read('main\\sender.js');
const ipc = read('main\\ipc.js');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

check(`包内版本 ${pkg.version}`, pkg.version === require('./package.json').version, pkg.version);
check('自绘标题栏结构在 HTML 里', html.includes('class="titlebar"') && html.includes('id="btn-titlebar-compose"'));
check('主进程隐藏原生标题栏', main.includes("titleBarStyle: 'hidden'") && main.includes('setTitleBarOverlay'));
check('标题栏主题与拖动 CSS', css.includes('--titlebar-h') && css.includes('-webkit-app-region: drag'));
check('拖拽附件：webUtils + 投放蒙层', preload.includes('webUtils.getPathForFile') && html.includes('compose-dropzone') && app.includes('attachDroppedFiles'));
check('分拣台四栏布局', html.includes('class="rail"') && html.includes('id="panel-body"') && css.includes('.rail-tab') && app.includes('renderPanel'));
check('信纸与衬线标题', css.includes('--serif') && css.includes('.reader-subject') && css.includes('border-radius: 16px'));
check('草稿附件落盘与恢复', app.includes('flushDraft') && app.includes('markMissingAttachments') && ipc.includes("handle('files:check'"));
check('回复全部 / 已发送回信', app.includes("reply-all") && app.includes('isSentFolder') && app.includes('replyRecipients'));
check('发信去重与 envelope', sender.includes('sentCopyExists') && sender.includes('envelope:') && sender.includes('mailboxOpen'));
check('文件数量正常', files.length > 900, `${files.length} 个文件`);

const bad = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - bad.length}/${results.length}`);
console.log(`临时目录（可删）: ${workDir}`);
process.exit(bad.length ? 1 : 0);