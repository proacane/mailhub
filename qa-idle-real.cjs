'use strict';

/**
 * IMAP IDLE 端到端测试：本地起一个最小 IMAP 服务器，
 * 让 imapflow 真实连接、真实 IDLE，验证 EXISTS 推送能触发同步。
 */

const net = require('net');
const path = require('path');

const PORT = 1143;
const log = [];
const waitUntil = async (fn, timeout = 8000, step = 100) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
};

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  socket.write('* OK [CAPABILITY IMAP4rev1 IDLE AUTH=PLAIN] fake imap ready\r\n');
  let buffer = '';
  let idling = false;
  let idleTag = null;
  let pingTimer = null;

  const reply = (line) => socket.write(`${line}\r\n`);

  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      log.push(line);
      if (!line) continue;

      if (line === 'DONE' && idling) {
        idling = false;
        if (pingTimer) clearTimeout(pingTimer);
        reply(`${idleTag} OK IDLE terminated`);
        continue;
      }

      const match = line.match(/^(\S+) (\S+)(?: (.*))?$/);
      if (!match) continue;
      const [, tag, command] = match;
      const cmd = command.toUpperCase();

      if (cmd === 'CAPABILITY') {
        reply('* CAPABILITY IMAP4rev1 IDLE AUTH=PLAIN');
        reply(`${tag} OK CAPABILITY completed`);
      } else if (cmd === 'AUTHENTICATE' || cmd === 'LOGIN') {
        reply(`${tag} OK authentication completed`);
      } else if (cmd === 'SELECT' || cmd === 'EXAMINE') {
        reply('* FLAGS (\\Seen \\Flagged)');
        reply('* 3 EXISTS');
        reply('* 0 RECENT');
        reply('* OK [UIDVALIDITY 1] UIDs valid');
        reply('* OK [UIDNEXT 100] Predicted next UID');
        reply(`${tag} OK [READ-WRITE] SELECT completed`);
      } else if (cmd === 'IDLE') {
        idling = true;
        idleTag = tag;
        reply('+ idling');
        // 进入 IDLE 后 400ms 推一封“新邮件”
        pingTimer = setTimeout(() => {
          if (!idling) return;
          log.push('<< server push: * 4 EXISTS >>');
          reply('* 4 EXISTS');
        }, 400);
      } else if (cmd === 'NOOP') {
        reply(`${tag} OK NOOP completed`);
      } else if (cmd === 'LOGOUT') {
        reply('* BYE logging out');
        reply(`${tag} OK LOGOUT completed`);
        socket.end();
      } else if (cmd === 'CLOSE') {
        reply(`${tag} OK CLOSE completed`);
      } else {
        reply(`${tag} OK ${cmd} completed`);
      }
    }
  });

  socket.on('error', () => {});
});

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

(async () => {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const account = {
    id: 'acc-e2e',
    label: '本地测试邮箱',
    email: 'tester@localhost',
    username: 'tester@localhost',
    provider: 'custom',
    password: 'pw',
    imap: { host: '127.0.0.1', port: PORT, secure: false }
  };
  const store = {
    listAccounts: () => [account],
    getAccount: (id) => (id === account.id ? account : null),
    getPassword: () => 'pw'
  };
  const syncs = [];
  const { IdleManager } = require(path.resolve(__dirname, 'main/idle-manager.js'));
  const manager = new IdleManager({
    store,
    syncManager: { runAccount: async (id, reason) => syncs.push({ id, reason }) },
    onStatus: () => {}
  });

  manager.start();
  const state = () => manager.connections.get('acc-e2e');

  await waitUntil(() => state()?.state === 'idle', 8000);
  check('真实 imapflow 连上并进入 IDLE', state()?.state === 'idle', `${state()?.state} / ${state()?.detail}`);
  check(
    '走完了认证与 SELECT INBOX',
    log.some((l) => / (AUTHENTICATE|LOGIN) /.test(l)) && log.some((l) => /SELECT INBOX/.test(l)),
    `${log.length} 行协议交互`
  );

  const idled = await waitUntil(() => log.some((l) => / IDLE$/.test(l)), 8000);
  check('客户端在连接后进入 IDLE（不等 15 秒默认延迟）', idled, log.filter((l) => /IDLE/.test(l)).join(' | '));

  const pushed = await waitUntil(() => log.some((l) => l.includes('server push')), 5000);
  check('服务器在 IDLE 期间推送了 EXISTS', pushed, String(pushed));

  const synced = await waitUntil(() => syncs.length > 0, 6000);
  check('IDLE 中的 EXISTS 触发了一次增量同步', synced && syncs[0]?.reason === 'idle', JSON.stringify(syncs));
  check('同步后状态回到 idle', state()?.state === 'idle', state()?.detail);

  manager.stop();
  await new Promise((r) => setTimeout(r, 300));
  check('stop 后连接关闭且不再持有账号', manager.connections.size === 0, JSON.stringify(manager.status()));

  server.close();
  console.log('协议日志:', JSON.stringify(log));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('失败:', err);
  server.close();
  process.exit(2);
});