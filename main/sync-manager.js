'use strict';

/**
 * 后台同步调度：定时轮询所有账号，找出新到的未读邮件并触发提醒。
 * 托盘常驻时窗口隐藏也会继续工作。
 */
class SyncManager {
  constructor({ store, mailService, getWindow, onNewMail }) {
    this.store = store;
    this.mailService = mailService;
    this.getWindow = getWindow;
    this.onNewMail = onNewMail;
    this.timer = null;
    this.intervalMs = 0;
    this.pending = null;
    this.lastRunAt = 0;
  }

  applySettings() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    const minutes = Number(this.store.getSettings().syncIntervalMinutes) || 0;
    this.intervalMs = minutes > 0 ? minutes * 60 * 1000 : 0;
    if (!this.intervalMs) return;

    this.timer = setInterval(() => {
      this.runAll('timer').catch(() => {});
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  runAll(reason = 'manual') {
    if (this.pending) return this.pending;
    this.pending = this.run(reason).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async run(reason) {
    const accounts = this.store.listAccounts();
    const results = [];
    const newMails = [];

    for (const account of accounts) {
      if (account.provider === 'demo') {
        results.push({ id: account.id, ok: true, skipped: true });
        continue;
      }
      const before = this.snapshotInbox(account.id);
      try {
        const cache = await this.mailService.syncAccount(account.id, {
          onProgress: (payload) => this.emit('sync:progress', payload)
        });
        results.push({ id: account.id, ok: true, cache });
        newMails.push(...this.diffNew(account, cache, before));
      } catch (err) {
        results.push({ id: account.id, ok: false, error: (err && err.message) || String(err) });
      }
    }

    this.lastRunAt = Date.now();
    const payload = {
      results,
      accounts: this.store.listAccounts(),
      reason,
      at: this.lastRunAt
    };
    this.emit('sync:finished', payload);

    if (newMails.length) {
      try {
        this.onNewMail(newMails);
      } catch {
        /* 提醒失败不影响同步 */
      }
    }
    return payload;
  }

  /** 单个账号的增量同步：IMAP IDLE 收到新邮件通知后调用 */
  async runAccount(accountId, reason = 'idle') {
    const account = this.store.getAccount(accountId);
    if (!account || account.provider === 'demo') return { skipped: true };

    const before = this.snapshotInbox(accountId);
    const cache = await this.mailService.syncAccount(accountId, {
      onProgress: (payload) => this.emit('sync:progress', payload)
    });
    const newMails = this.diffNew(account, cache, before);

    this.lastRunAt = Date.now();
    this.emit('sync:finished', {
      results: [{ id: accountId, ok: true, cache }],
      accounts: this.store.listAccounts(),
      reason,
      at: this.lastRunAt
    });

    if (newMails.length) {
      try {
        this.onNewMail(newMails);
      } catch {
        /* 提醒失败不影响同步 */
      }
    }
    return { cache, newMails };
  }

  snapshotInbox(accountId) {
    const cache = this.store.loadCache(accountId);
    const folder = cache.folders.find((item) => item.specialUse === '\\Inbox') || cache.folders[0];
    return {
      path: folder ? folder.path : 'INBOX',
      count: (folder && folder.messages ? folder.messages.length : 0),
      uids: new Set(((folder && folder.messages) || []).map((message) => message.uid))
    };
  }

  diffNew(account, cache, before) {
    // 首次同步（本地没有任何缓存）不提醒，避免一次弹出上百封
    if (!before.count) return [];
    const folder =
      cache.folders.find((item) => item.path === before.path) ||
      cache.folders.find((item) => item.specialUse === '\\Inbox');
    if (!folder) return [];

    return (folder.messages || [])
      .filter((message) => !before.uids.has(message.uid) && !message.seen)
      .slice(0, 5)
      .map((message) => ({
        accountId: account.id,
        accountLabel: account.label,
        folder: folder.path,
        uid: message.uid,
        subject: message.subject,
        fromName: message.fromName || message.fromAddress || '未知发件人',
        date: message.date
      }));
  }

  emit(channel, payload) {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    const contents = win.webContents;
    if (!contents || contents.isDestroyed()) return;
    contents.send(channel, payload);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { SyncManager };