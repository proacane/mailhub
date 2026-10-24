'use strict';

/**
 * IMAP IDLE 推送：每个真实账号保持一条常驻连接，服务器有新邮件时立刻触发增量同步。
 *
 * - 只在账号有密码、非演示账号时建立连接
 * - imapflow 默认会在连接空闲时自动进入 IDLE，并在 maxIdleTime 到期后自动续期
 * - 断线按 5s → 10s → 20s … 最多 5 分钟退避重连
 * - 服务器不支持 IDLE 时标记 unsupported，交给设置里的定时轮询兜底
 */

const { ImapFlow } = require('imapflow');

const RECONNECT_START = 5000;
const RECONNECT_MAX = 5 * 60 * 1000;
const IDLE_RENEW_MS = 25 * 60 * 1000;
const DEBOUNCE_MS = 1200;
const MIN_SYNC_GAP = 8000;

class IdleManager {
  constructor({ store, syncManager, onStatus }) {
    this.store = store;
    this.syncManager = syncManager;
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.connections = new Map();
    this.started = false;
  }

  start() {
    this.started = true;
    this.refreshAll();
  }

  stop() {
    this.started = false;
    for (const accountId of [...this.connections.keys()]) this.teardown(accountId);
  }

  /** 账号增删改后重建连接 */
  refreshAll() {
    if (!this.started) return;
    const accounts = this.store.listAccounts().filter((account) => account.provider !== 'demo');
    const alive = new Set(accounts.map((account) => account.id));
    for (const accountId of [...this.connections.keys()]) {
      if (!alive.has(accountId)) this.teardown(accountId);
    }
    for (const account of accounts) this.ensure(account);
    this.report();
  }

  refresh(accountId) {
    if (!this.started) return;
    this.teardown(accountId);
    const account = this.store.getAccount(accountId);
    if (account && account.provider !== 'demo') this.ensure(account);
    this.report();
  }

  /** 系统休眠唤醒 / 网络恢复后重新建立连接 */
  restartAll() {
    if (!this.started) return;
    for (const accountId of [...this.connections.keys()]) this.teardown(accountId);
    this.refreshAll();
  }

  ensure(account) {
    if (!this.started) return;
    if (this.connections.has(account.id)) return;
    const state = {
      accountId: account.id,
      label: account.label,
      state: 'connecting',
      detail: '',
      client: null,
      attempts: 0,
      reconnectTimer: null,
      debounceTimer: null,
      lastSyncAt: 0,
      closed: false
    };
    this.connections.set(account.id, state);
    void this.connect(state, account);
  }

  async connect(state, account) {
    if (!this.started || state.closed) return;

    const password = this.store.getPassword(account.id);
    if (!password) {
      this.setState(state, 'no-password', '没有保存授权码');
      return;
    }
    if (!account.imap || !account.imap.host) {
      this.setState(state, 'no-config', '未配置 IMAP 服务器');
      return;
    }

    const client = new ImapFlow({
      host: account.imap.host,
      port: account.imap.port || 993,
      secure: account.imap.secure !== false,
      auth: { user: account.username || account.email, pass: password },
      logger: false,
      socketTimeout: 5 * 60 * 1000,
      greetingTimeout: 20000,
      connectionTimeout: 25000,
      maxIdleTime: IDLE_RENEW_MS,
      // imapflow 默认空闲 15 秒才自动 IDLE，新账号连上后要干等；这里压到 1.5 秒
      autoIdleDelay: 1500,
      tls: { servername: account.imap.host }
    });
    state.client = client;

    let lost = false;
    const onLost = (error) => {
      if (lost || state.closed) return;
      lost = true;
      this.handleLost(state, error);
    };

    client.on('error', (error) => onLost(error));
    client.on('close', () => onLost(new Error('连接已断开')));
    client.on('exists', (data) => this.handleExists(state, data));

    try {
      await client.connect();
      if (state.closed) {
        client.close();
        return;
      }
      const capabilities = client.capabilities;
      if (capabilities && typeof capabilities.has === 'function' && !capabilities.has('IDLE')) {
        this.closeClient(state);
        this.setState(state, 'unsupported', '服务器不支持 IDLE，已交给定时同步');
        state.attempts = 0;
        return;
      }
      await client.mailboxOpen('INBOX');
      state.attempts = 0;
      this.setState(state, 'idle', '已连接，等待新邮件');
    } catch (error) {
      onLost(error);
    }
  }

  handleExists(state, data) {
    if (state.closed) return;
    const prev = Number(data && data.prevCount);
    const count = Number(data && data.count);
    if (Number.isFinite(prev) && Number.isFinite(count) && count <= prev) return;

    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      void this.triggerSync(state);
    }, DEBOUNCE_MS);
  }

  async triggerSync(state) {
    if (!this.started || state.closed) return;
    const wait = state.lastSyncAt + MIN_SYNC_GAP - Date.now();
    if (wait > 0) {
      setTimeout(() => void this.triggerSync(state), wait);
      return;
    }
    state.lastSyncAt = Date.now();
    try {
      await this.syncManager.runAccount(state.accountId, 'idle');
      this.setState(state, 'idle', '已同步新邮件');
    } catch (error) {
      // 正在同步时 mailService 会拒绝并发，属于正常情况
      const message = (error && error.message) || String(error);
      this.setState(state, 'idle', /正在同步/.test(message) ? '正在同步中' : `同步失败：${message}`);
    }
  }

  handleLost(state, error) {
    if (state.closed) return;
    const message = (error && (error.responseText || error.message)) || String(error);
    this.closeClient(state);
    state.attempts += 1;

    // 授权码错误重试没有意义，停下来等用户去改账号配置
    if (state.attempts >= 3 && /auth|login|password|credential|认证|授权/i.test(message)) {
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
      this.setState(state, 'auth-error', '登录失败，请检查授权码');
      return;
    }

    const delay = Math.min(RECONNECT_START * 2 ** (state.attempts - 1), RECONNECT_MAX);
    this.setState(state, 'retry', `${message}，${Math.round(delay / 1000)} 秒后重连`);
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      const account = this.store.getAccount(state.accountId);
      if (!account || account.provider === 'demo' || !this.started) return;
      state.closed = false;
      void this.connect(state, account);
    }, delay);
    if (typeof state.reconnectTimer.unref === 'function') state.reconnectTimer.unref();
  }

  closeClient(state) {
    const client = state.client;
    state.client = null;
    if (!client) return;
    try {
      client.removeAllListeners();
      client.close();
    } catch {
      /* 已经断开 */
    }
  }

  teardown(accountId) {
    const state = this.connections.get(accountId);
    if (!state) return;
    state.closed = true;
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    this.closeClient(state);
    this.connections.delete(accountId);
  }

  setState(state, next, detail) {
    state.state = next;
    state.detail = detail || '';
    this.report();
  }

  report() {
    try {
      this.onStatus(this.status());
    } catch {
      /* 状态回调失败不影响连接 */
    }
  }

  status() {
    const accounts = [...this.connections.values()].map((state) => ({
      accountId: state.accountId,
      label: state.label,
      state: state.state,
      detail: state.detail
    }));
    return {
      enabled: this.started,
      idleCount: accounts.filter((item) => item.state === 'idle').length,
      accounts
    };
  }
}

module.exports = { IdleManager };