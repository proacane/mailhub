'use strict';

/**
 * IMAP IDLE 逻辑的单元测试：用假的 ImapFlow 替换真实连接，
 * 验证能力判断、防抖同步、断线退避与授权失败停机。
 */

const path = require('path');

const opened = [];
const instances = [];

class FakeImapFlow {
  constructor(options) {
    this.options = options;
    this.capabilities = FakeImapFlow.capabilitiesOverride || new Map([['IDLE', true], ['IMAP4rev1', true]]);
    this.handlers = new Map();
    this.connected = false;
    this.closed = false;
    opened.push(options);
    instances.push(this);
  }

  on(name, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name).push(fn);
    return this;
  }

  emit(name, payload) {
    for (const fn of this.handlers.get(name) || []) fn(payload);
  }

  removeAllListeners() {
    this.handlers.clear();
  }

  async connect() {
    this.connected = true;
  }

  async mailboxOpen(mailbox) {
    this.opened = mailbox;
  }

  close() {
    this.closed = true;
    this.connected = false;
  }
}

const imapflowPath = require.resolve('imapflow');
require.cache[imapflowPath] = { id: imapflowPath, filename: imapflowPath, loaded: true, exports: { ImapFlow: FakeImapFlow } };

const idlePath = path.resolve(__dirname, 'main/idle-manager.js');
delete require.cache[idlePath];
const { IdleManager } = require(idlePath);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeStore(accounts) {
  return {
    listAccounts: () => accounts,
    getAccount: (id) => accounts.find((a) => a.id === id) || null,
    getPassword: (id) => accounts.find((a) => a.id === id)?.password || null
  };
}

const baseAccount = {
  id: 'acc-1',
  label: '工作邮箱',
  email: 'work@example.com',
  username: 'work@example.com',
  provider: 'qq',
  password: 'secret',
  imap: { host: 'imap.example.com', port: 993, secure: true }
};

async function testGating() {
  const accounts = [
    { ...baseAccount, id: 'demo', provider: 'demo' },
    { ...baseAccount, id: 'nopass', password: '' },
    { ...baseAccount, id: 'noconfig', imap: null }
  ];
  const statuses = [];
  const manager = new IdleManager({ store: makeStore(accounts), syncManager: { runAccount: async () => {} }, onStatus: (s) => statuses.push(s) });
  manager.start();
  await sleep(50);
  const byId = Object.fromEntries(manager.status().accounts.map((a) => [a.accountId, a.state]));
  check('演示账号不建连接', !byId.demo, JSON.stringify(byId));
  check('没密码的账号标记 no-password', byId.nopass === 'no-password', byId.nopass);
  check('没配服务器的账号标记 no-config', byId.noconfig === 'no-config', byId.noconfig);
  check('状态回调有输出', statuses.length > 0 && statuses.at(-1).enabled === true, `${statuses.length} 次`);
  manager.stop();
}

async function testIdleAndExists() {
  instances.length = 0;
  const account = { ...baseAccount, id: 'acc-idle' };
  const calls = [];
  const manager = new IdleManager({
    store: makeStore([account]),
    syncManager: { runAccount: async (id, reason) => calls.push({ id, reason }) },
    onStatus: () => {}
  });
  manager.start();
  await sleep(80);

  const client = instances[0];
  const state = manager.connections.get('acc-idle');
  check('真实账号建立了连接', Boolean(client) && client.connected === true, client ? `host=${client.options.host}` : '无');
  check('连接参数带认证与 IDLE 续期', client.options.auth.user === 'work@example.com' && client.options.maxIdleTime > 0, JSON.stringify({ user: client.options.auth.user, maxIdleTime: client.options.maxIdleTime }));
  check('打开 INBOX 后状态为 idle', client.opened === 'INBOX' && state.state === 'idle', `${client.opened} / ${state.state}`);

  client.emit('exists', { path: 'INBOX', count: 12, prevCount: 11 });
  check('新邮件到达后先防抖，不立即同步', calls.length === 0, `调用 ${calls.length} 次`);
  await sleep(1500);
  check('防抖结束后触发一次增量同步', calls.length === 1 && calls[0].id === 'acc-idle' && calls[0].reason === 'idle', JSON.stringify(calls));
  check('同步后状态写回已同步', state.state === 'idle' && state.detail.includes('已同步'), state.detail);

  client.emit('exists', { path: 'INBOX', count: 12, prevCount: 12 });
  await sleep(1400);
  check('数量没变化时不重复同步', calls.length === 1, `调用 ${calls.length} 次`);

  manager.stop();
  check('stop 后连接被关闭且状态禁用', client.closed === true && manager.status().enabled === false && manager.connections.size === 0, JSON.stringify(manager.status()));
}

async function testUnsupported() {
  instances.length = 0;
  const account = { ...baseAccount, id: 'acc-old' };
  FakeImapFlow.capabilitiesOverride = new Map([['IMAP4rev1', true]]);
  const manager = new IdleManager({ store: makeStore([account]), syncManager: { runAccount: async () => {} }, onStatus: () => {} });
  manager.start();
  await sleep(50);
  const client = instances[0];
  const state = manager.connections.get('acc-old');
  FakeImapFlow.capabilitiesOverride = null;
  check('不支持 IDLE 时标记 unsupported', state.state === 'unsupported', state.state);
  check('不支持时释放连接，不占服务器配额', client.closed === true, String(client.closed));
  manager.stop();
}

async function testRetryAndAuthStop() {
  instances.length = 0;
  const account = { ...baseAccount, id: 'acc-retry' };
  const manager = new IdleManager({ store: makeStore([account]), syncManager: { runAccount: async () => {} }, onStatus: () => {} });
  manager.start();
  await sleep(30);
  const state = manager.connections.get('acc-retry');

  manager.handleLost(state, new Error('socket closed'));
  check('断线后进入 retry 并给出 5 秒退避', state.state === 'retry' && /5 秒后重连/.test(state.detail), state.detail);
  manager.handleLost(state, new Error('socket closed'));
  check('第二次退避翻倍到 10 秒', state.state === 'retry' && /10 秒后重连/.test(state.detail), state.detail);

  manager.handleLost(state, new Error('AUTHENTICATIONFAILED'));
  check('连续认证失败后停止重连', state.state === 'auth-error' && !state.reconnectTimer, `${state.state} / timer=${state.reconnectTimer}`);
  check('认证失败不再消耗服务器连接', manager.status().idleCount === 0, JSON.stringify(manager.status()));
  manager.stop();
}

async function testAccountRefresh() {
  instances.length = 0;
  const account = { ...baseAccount, id: 'acc-refresh' };
  const manager = new IdleManager({ store: makeStore([account]), syncManager: { runAccount: async () => {} }, onStatus: () => {} });
  manager.start();
  await sleep(30);
  const first = instances[0];
  manager.refresh('acc-refresh');
  await sleep(30);
  check('改账号后重建连接（旧连接关闭）', first.closed === true && instances.length === 2, `实例 ${instances.length} 个`);

  manager.refreshAll();
  await sleep(30);
  check('refreshAll 不会给同一账号建重复连接', manager.connections.size === 1, `连接 ${manager.connections.size} 条`);
  manager.stop();
}

(async () => {
  await testGating();
  await testIdleAndExists();
  await testUnsupported();
  await testRetryAndAuthStop();
  await testAccountRefresh();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})();