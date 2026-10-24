'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const subscribe = (channel, callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('mailhub', {
  platform: process.platform,
  boot: () => invoke('state:boot'),

  addAccount: (payload) => invoke('accounts:add', payload),
  updateAccount: (id, patch) => invoke('accounts:update', id, patch),
  removeAccount: (id) => invoke('accounts:remove', id),
  testAccount: (config) => invoke('accounts:test', config),

  syncAccount: (id) => invoke('sync:account', id),
  syncAll: () => invoke('sync:all'),
  syncFolder: (id, folderPath) => invoke('sync:folder', id, folderPath),

  openMessage: (id, folderPath, uid) => invoke('message:open', id, folderPath, uid),
  setFlags: (id, folderPath, uid, flags) => invoke('message:flags', id, folderPath, uid, flags),
  deleteMessage: (id, folderPath, uid) => invoke('message:delete', id, folderPath, uid),
  markAllRead: (id, folderPath) => invoke('mail:markAllRead', id, folderPath),

  sendMail: (accountId, payload) => invoke('mail:send', accountId, payload),
  pickFiles: () => invoke('dialog:pickFiles'),
  checkFiles: (paths) => invoke('files:check', paths),
  // 拖拽进来的 File 对象只有通过 webUtils 才能拿到真实磁盘路径
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  saveAttachment: (id, folderPath, uid, index) => invoke('attachment:save', id, folderPath, uid, index),
  openAttachment: (id, folderPath, uid, index) => invoke('attachment:open', id, folderPath, uid, index),

  setSettings: (patch) => invoke('settings:set', patch),
  openDataDir: () => invoke('app:openDataDir'),
  openExternal: (url) => invoke('shell:openExternal', url),
  stats: () => invoke('app:stats'),
  getStatus: () => invoke('app:status'),
  testNotification: () => invoke('app:testNotification'),
  clearCache: () => invoke('cache:clear'),
  showWindow: () => invoke('app:showWindow'),

  onSyncProgress: (callback) => subscribe('sync:progress', callback),
  onSyncFinished: (callback) => subscribe('sync:finished', callback),
  onOpenMail: (callback) => subscribe('mail:open', callback),
  onPushStatus: (callback) => subscribe('push:status', callback),
  onSettingsChanged: (callback) => subscribe('settings:changed', callback)
});