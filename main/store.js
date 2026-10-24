'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeStorage } = require('electron');

const MAX_MESSAGES_PER_FOLDER = 800;

const ACCOUNT_COLORS = [
  '#0f6b5b', '#265f8c', '#6a4a8f', '#9a5230',
  '#6f651f', '#276c66', '#8b3a58', '#3f6a33'
];

const DEFAULT_SETTINGS = {
  signature: '',
  syncIntervalMinutes: 10,
  pageSize: 150,
  showRemoteImages: false,
  minimizeToTray: true,
  notificationsEnabled: true,
  launchAtLogin: false,
  theme: 'system',
  darkMailBody: true
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function safeName(name) {
  const cleaned = String(name || 'attachment')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .slice(0, 120)
    .trim();
  return cleaned || 'attachment';
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.accountsFile = path.join(dataDir, 'accounts.json');
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.cacheDir = path.join(dataDir, 'cache');
    this.bodiesDir = path.join(dataDir, 'bodies');

    this.accounts = [];
    this.settings = { ...DEFAULT_SETTINGS };
    this.cacheMemory = new Map();
    this.encryptionAvailable = false;

    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.mkdirSync(this.bodiesDir, { recursive: true });

    const storedAccounts = readJson(this.accountsFile, { accounts: [] });
    this.accounts = Array.isArray(storedAccounts.accounts) ? storedAccounts.accounts : [];

    this.settings = { ...DEFAULT_SETTINGS, ...readJson(this.settingsFile, {}) };

    try {
      this.encryptionAvailable = safeStorage.isEncryptionAvailable();
    } catch {
      this.encryptionAvailable = false;
    }
  }

  /* ---------------- 密码加密 ---------------- */

  encryptSecret(plain) {
    const value = String(plain || '');
    if (!value) return null;
    if (this.encryptionAvailable) {
      return { enc: 'os', value: safeStorage.encryptString(value).toString('base64') };
    }
    // 系统安全存储不可用时退化为本地混淆，并在 UI 提示风险
    return { enc: 'plain', value: Buffer.from(value, 'utf8').toString('base64') };
  }

  decryptSecret(record) {
    if (!record || !record.value) return '';
    try {
      if (record.enc === 'os') {
        return safeStorage.decryptString(Buffer.from(record.value, 'base64'));
      }
      return Buffer.from(record.value, 'base64').toString('utf8');
    } catch {
      return '';
    }
  }

  /* ---------------- 账号 ---------------- */

  listAccounts() {
    return this.accounts.map((account) => this.toPublic(account));
  }

  getAccount(id) {
    return this.accounts.find((account) => account.id === id) || null;
  }

  getPassword(id) {
    const account = this.getAccount(id);
    return account ? this.decryptSecret(account.secret) : '';
  }

  toPublic(account) {
    const { secret, ...rest } = account;
    return {
      ...rest,
      hasPassword: Boolean(secret),
      passwordMode: secret ? secret.enc : null
    };
  }

  persistAccounts() {
    writeJsonAtomic(this.accountsFile, { accounts: this.accounts });
  }

  nextColor() {
    const used = new Set(this.accounts.map((account) => account.color));
    return ACCOUNT_COLORS.find((color) => !used.has(color)) || ACCOUNT_COLORS[this.accounts.length % ACCOUNT_COLORS.length];
  }

  addAccount(input) {
    const id = crypto.randomUUID();
    const account = {
      id,
      label: String(input.label || input.email || '未命名邮箱').trim(),
      email: String(input.email || '').trim(),
      provider: input.provider || 'custom',
      color: input.color || this.nextColor(),
      username: String(input.username || input.email || '').trim(),
      imap: {
        host: String(input.imap?.host || '').trim(),
        port: Number(input.imap?.port) || 993,
        secure: input.imap?.secure !== false
      },
      smtp: {
        host: String(input.smtp?.host || '').trim(),
        port: Number(input.smtp?.port) || 465,
        secure: input.smtp?.secure !== false
      },
      secret: this.encryptSecret(input.password),
      createdAt: new Date().toISOString(),
      lastSyncAt: null,
      syncError: null
    };
    this.accounts.push(account);
    this.persistAccounts();
    return this.toPublic(account);
  }

  updateAccount(id, patch) {
    const account = this.getAccount(id);
    if (!account) throw new Error('账号不存在');

    if (patch.label !== undefined) account.label = String(patch.label).trim() || account.label;
    if (patch.email !== undefined) account.email = String(patch.email).trim();
    if (patch.provider !== undefined) account.provider = patch.provider;
    if (patch.color !== undefined) account.color = patch.color;
    if (patch.username !== undefined) account.username = String(patch.username).trim();
    if (patch.imap) {
      account.imap = {
        host: String(patch.imap.host || '').trim(),
        port: Number(patch.imap.port) || 993,
        secure: patch.imap.secure !== false
      };
    }
    if (patch.smtp) {
      account.smtp = {
        host: String(patch.smtp.host || '').trim(),
        port: Number(patch.smtp.port) || 465,
        secure: patch.smtp.secure !== false
      };
    }
    if (patch.password) account.secret = this.encryptSecret(patch.password);

    this.persistAccounts();
    return this.toPublic(account);
  }

  removeAccount(id) {
    this.accounts = this.accounts.filter((account) => account.id !== id);
    this.persistAccounts();
    this.cacheMemory.delete(id);
    for (const target of [this.cacheFile(id), path.join(this.bodiesDir, id)]) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {
        /* 忽略清理失败 */
      }
    }
    return true;
  }

  markSynced(id, error) {
    const account = this.getAccount(id);
    if (!account) return;
    account.lastSyncAt = new Date().toISOString();
    account.syncError = error ? String(error) : null;
    this.persistAccounts();
  }

  /* ---------------- 邮件缓存 ---------------- */

  cacheFile(accountId) {
    return path.join(this.cacheDir, `${accountId}.json`);
  }

  loadCache(accountId) {
    if (this.cacheMemory.has(accountId)) return this.cacheMemory.get(accountId);
    const cache = readJson(this.cacheFile(accountId), {
      accountId,
      updatedAt: 0,
      folders: []
    });
    if (!Array.isArray(cache.folders)) cache.folders = [];
    this.cacheMemory.set(accountId, cache);
    return cache;
  }

  saveCache(accountId, cache) {
    const trimmed = {
      accountId,
      updatedAt: Date.now(),
      folders: (cache.folders || []).map((folder) => ({
        ...folder,
        messages: (folder.messages || []).slice(0, MAX_MESSAGES_PER_FOLDER)
      }))
    };
    this.cacheMemory.set(accountId, trimmed);
    writeJsonAtomic(this.cacheFile(accountId), trimmed);
    return trimmed;
  }

  /* ---------------- 正文与附件 ---------------- */

  bodyDir(accountId, folder) {
    const key = crypto.createHash('sha1').update(String(folder)).digest('hex').slice(0, 12);
    return path.join(this.bodiesDir, accountId, key);
  }

  bodyFile(accountId, folder, uid) {
    return path.join(this.bodyDir(accountId, folder), `${uid}.json`);
  }

  readBody(accountId, folder, uid) {
    return readJson(this.bodyFile(accountId, folder, uid), null);
  }

  writeBody(accountId, folder, uid, payload) {
    const file = this.bodyFile(accountId, folder, uid);
    writeJsonAtomic(file, payload);
    return file;
  }

  attachmentPath(accountId, folder, uid, index, fileName) {
    return path.join(this.bodyDir(accountId, folder), `${uid}-att-${index}-${safeName(fileName)}`);
  }

  removeBody(accountId, folder, uid) {
    const file = this.bodyFile(accountId, folder, uid);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 忽略 */
    }
    try {
      const dir = this.bodyDir(accountId, folder);
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(`${uid}-att-`)) fs.rmSync(path.join(dir, name), { force: true });
      }
    } catch {
      /* 忽略 */
    }
  }

  clearBodyCache(accountId) {
    try {
      fs.rmSync(path.join(this.bodiesDir, accountId), { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }

  /* ---------------- 设置 ---------------- */

  getSettings() {
    return { ...this.settings };
  }

  setSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    writeJsonAtomic(this.settingsFile, this.settings);
    return this.getSettings();
  }

  /* ---------------- 备份统计 ---------------- */

  /** 所有账号收件箱的未读数合计（托盘角标用） */
  totalUnread() {
    let total = 0;
    for (const account of this.accounts) {
      const cache = this.loadCache(account.id);
      const inbox =
        cache.folders.find((folder) => folder.specialUse === '\\Inbox') ||
        cache.folders.find((folder) => /inbox|收件箱/i.test(folder.label));
      if (inbox) total += inbox.unseen || 0;
    }
    return total;
  }

  dirSizeBytes(dir) {
    let total = 0;
    const walk = (target) => {
      let entries;
      try {
        entries = fs.readdirSync(target, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(target, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          try {
            total += fs.statSync(full).size;
          } catch {
            /* 忽略 */
          }
        }
      }
    };
    walk(dir);
    return total;
  }

  cacheSizeBytes() {
    return this.dirSizeBytes(this.cacheDir) + this.dirSizeBytes(this.bodiesDir);
  }

  /** 清空所有本地邮件缓存（账号配置保留），返回释放的字节数 */
  clearMessageCache() {
    const before = this.cacheSizeBytes();
    this.cacheMemory.clear();
    for (const dir of [this.cacheDir, this.bodiesDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
      fs.mkdirSync(dir, { recursive: true });
    }
    return before;
  }

  stats() {
    let messageCount = 0;
    for (const account of this.accounts) {
      const cache = this.loadCache(account.id);
      for (const folder of cache.folders) messageCount += folder.messages?.length || 0;
    }
    return { accounts: this.accounts.length, messageCount };
  }
}

function createStore(dataDir) {
  return new Store(dataDir);
}

module.exports = { createStore, Store, safeName, MAX_MESSAGES_PER_FOLDER, ACCOUNT_COLORS };