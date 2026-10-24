'use strict';

const fs = require('fs');
const { ipcMain, dialog, shell, app, BrowserWindow } = require('electron');
const { sendMail } = require('./sender');
const { allPresets } = require('./providers');

function registerIpc(deps) {
  const { store, mailService, syncManager, notifier, refreshShell, applySettings, showWindow } = deps;

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        const data = await fn(event, ...args);
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) };
      }
    });
  };

  handle('state:boot', () => {
    const accounts = store.listAccounts();
    const caches = {};
    for (const account of accounts) caches[account.id] = store.loadCache(account.id);
    return {
      accounts,
      caches,
      settings: store.getSettings(),
      presets: allPresets(),
      encryptionAvailable: store.encryptionAvailable,
      version: app.getVersion(),
      dataDir: store.dataDir,
      platform: process.platform,
      notificationsSupported: notifier ? notifier.supported() : false,
      packaged: app.isPackaged
    };
  });

  handle('accounts:add', (_event, payload) => {
    if (!payload || !payload.email) throw new Error('请填写邮箱地址');
    if (!payload.imap || !payload.imap.host) throw new Error('请填写 IMAP 服务器地址');
    if (!payload.smtp || !payload.smtp.host) throw new Error('请填写 SMTP 服务器地址');
    if (!payload.password) throw new Error('请填写授权码 / 密码');
    const account = store.addAccount(payload);
    refreshShell();
    deps.onAccountsChanged?.(account.id);
    return account;
  });

  handle('accounts:update', (_event, id, patch) => {
    const updated = store.updateAccount(id, patch || {});
    refreshShell();
    deps.onAccountsChanged?.(id);
    return updated;
  });

  handle('accounts:remove', async (_event, id) => {
    await mailService.disconnect(id);
    const removed = store.removeAccount(id);
    refreshShell();
    deps.onAccountsChanged?.(null);
    return removed;
  });

  handle('accounts:test', (_event, config) => {
    const password = config?.password === '__stored__' ? store.getPassword(config.accountId) : config?.password;
    if (!password) throw new Error('没有可用的密码，请重新填写授权码');
    return mailService.testConnection({ ...config, password });
  });

  handle('sync:account', async (event, id) => {
    const sender = event.sender;
    const cache = await mailService.syncAccount(id, {
      onProgress: (payload) => {
        if (!sender.isDestroyed()) sender.send('sync:progress', payload);
      }
    });
    refreshShell();
    const account = store.listAccounts().find((item) => item.id === id) || null;
    return { cache, account };
  });

  handle('sync:all', async () => {
    // 统一走后台调度器：同一时间只会有一个同步任务
    const payload = await syncManager.runAll('manual');
    refreshShell();
    return payload;
  });

  handle('sync:folder', async (_event, id, folderPath) => {
    const cache = await mailService.syncFolderOnly(id, folderPath, 120);
    return { cache };
  });

  handle('message:open', async (_event, id, folderPath, uid) => {
    const account = store.getAccount(id);
    if (account && account.provider === 'demo') {
      const cached = store.readBody(id, folderPath, uid);
      if (!cached) throw new Error('演示邮件没有正文');
      return cached;
    }
    const body = await mailService.fetchBody(id, folderPath, uid);
    return body;
  });

  handle('message:flags', async (_event, id, folderPath, uid, flags) => {
    const result = await mailService.setFlags(id, folderPath, uid, flags || {});
    refreshShell();
    return result;
  });

  handle('message:delete', async (_event, id, folderPath, uid) => {
    const result = await mailService.deleteMessage(id, folderPath, uid);
    refreshShell();
    return result;
  });

  handle('mail:markAllRead', async (_event, id, folderPath) => {
    const count = await mailService.markAllRead(id, folderPath);
    refreshShell();
    return { count };
  });

  handle('mail:send', async (_event, accountId, payload) => {
    const result = await sendMail({ store, mailService, accountId, payload });
    refreshShell();
    return { ...result, cache: store.loadCache(accountId) };
  });

  handle('dialog:pickFiles', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: '选择附件',
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled) return [];
    return result.filePaths;
  });

  // 草稿里恢复的附件可能已经被删除，发送前逐个确认
  handle('files:check', async (_event, paths) => {
    const list = Array.isArray(paths) ? paths.filter((item) => typeof item === 'string') : [];
    return list.map((filePath) => {
      let exists = false;
      try {
        exists = fs.statSync(filePath).isFile();
      } catch {
        exists = false;
      }
      return { path: filePath, exists };
    });
  });

  handle('attachment:save', async (event, id, folderPath, uid, index) => {
    const body = store.readBody(id, folderPath, uid);
    if (!body) throw new Error('请先打开这封邮件');
    const attachment = (body.attachments || []).find((item) => Number(item.index) === Number(index));
    if (!attachment) throw new Error('附件不存在');

    const win = BrowserWindow.fromWebContents(event.sender);
    const source = store.attachmentPath(id, folderPath, uid, attachment.index, attachment.filename);
    if (!fs.existsSync(source)) throw new Error('附件文件已被清理，请重新打开邮件');

    const result = await dialog.showSaveDialog(win, {
      title: '保存附件',
      defaultPath: attachment.filename
    });
    if (result.canceled || !result.filePath) return { saved: false };
    fs.copyFileSync(source, result.filePath);
    return { saved: true, path: result.filePath };
  });

  handle('attachment:open', async (_event, id, folderPath, uid, index) => {
    const body = store.readBody(id, folderPath, uid);
    const attachment = (body?.attachments || []).find((item) => Number(item.index) === Number(index));
    if (!attachment) throw new Error('附件不存在');
    const target = store.attachmentPath(id, folderPath, uid, attachment.index, attachment.filename);
    if (!fs.existsSync(target)) throw new Error('附件文件已被清理，请重新打开邮件');
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return true;
  });

  handle('settings:set', (_event, patch) => {
    const settings = store.setSettings(patch || {});
    applySettings();
    refreshShell();
    if (deps.onSettingsChanged) deps.onSettingsChanged(settings);
    return settings;
  });

  handle('app:status', () => {
    const tray = deps.getTrayInfo ? deps.getTrayInfo() : null;
    return {
      unread: store.totalUnread(),
      cacheBytes: store.cacheSizeBytes(),
      intervalMs: syncManager ? syncManager.intervalMs : 0,
      lastSyncAt: syncManager ? syncManager.lastRunAt : 0,
      notificationsSupported: notifier ? notifier.supported() : false,
      packaged: app.isPackaged,
      dataDir: store.dataDir,
      platform: process.platform,
      theme: store.getSettings().theme,
      autostart: deps.getAutostart ? deps.getAutostart() : null,
      push: deps.getPushStatus ? deps.getPushStatus() : null,
      tray
    };
  });

  handle('app:testNotification', () => {
    if (!notifier) throw new Error('通知模块未初始化');
    return notifier.test();
  });

  handle('cache:clear', () => {
    const freed = store.clearMessageCache();
    refreshShell();
    return { freed };
  });

  handle('shell:openExternal', async (_event, url) => {
    const value = String(url || '');
    if (!/^(https?:\/\/|mailto:)/i.test(value)) throw new Error('不支持的链接类型');
    await shell.openExternal(value);
    return true;
  });

  handle('app:openDataDir', async () => {
    const error = await shell.openPath(store.dataDir);
    if (error) throw new Error(error);
    return true;
  });

  handle('app:stats', () => store.stats());

  handle('app:showWindow', () => {
    showWindow();
    return true;
  });
}

module.exports = { registerIpc };