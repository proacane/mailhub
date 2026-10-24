'use strict';

const fs = require('fs');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { presetById } = require('./providers');
const { safeName } = require('./store');

const FOLDER_LABELS = {
  '\\Inbox': '收件箱',
  '\\Sent': '已发送',
  '\\Drafts': '草稿箱',
  '\\Trash': '已删除',
  '\\Junk': '垃圾邮件',
  '\\Archive': '归档',
  '\\All': '所有邮件',
  '\\Flagged': '星标邮件'
};

const FOLDER_ORDER = ['\\Inbox', '\\Sent', '\\Drafts', '\\Archive', '\\Junk', '\\Trash', '\\All', '\\Flagged'];

const MAX_SOURCE_BYTES = 35 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024;
// 内嵌图片（cid:）转成 data URI 的内联总预算
const MAX_INLINE_IMAGE_BYTES = 3 * 1024 * 1024;

function folderLabel(folder) {
  if (folder.specialUse && FOLDER_LABELS[folder.specialUse]) return FOLDER_LABELS[folder.specialUse];
  const name = String(folder.name || folder.path || '');
  const lower = name.toLowerCase();
  if (lower === 'inbox') return '收件箱';
  if (/^sent|已发送/.test(lower)) return '已发送';
  if (/draft|草稿/.test(lower)) return '草稿箱';
  if (/trash|deleted|已删除/.test(lower)) return '已删除';
  if (/junk|spam|垃圾/.test(lower)) return '垃圾邮件';
  if (/archive|归档/.test(lower)) return '归档';
  return name;
}

function friendlyError(err, account) {
  const raw = String((err && (err.responseText || err.message)) || err || '');
  const code = String((err && err.code) || '');
  const preset = presetById(account?.provider);
  const authLike = /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|Invalid login|authentication failed|535|550|User has no permission|Application-specific password|AUTHENTICATE|EAUTH/i.test(raw);

  if (authLike || (err && err.authenticationFailed)) {
    if (account?.provider === 'gmail') {
      return new Error('认证失败：Gmail 需要 16 位「应用专用密码」（需先开启两步验证），不能用 Google 账号密码。');
    }
    if (account?.provider === 'outlook') {
      return new Error('认证失败：微软已关闭 Outlook 的基础密码登录，必须使用 OAuth2（当前版本未支持），可改用其他邮箱。');
    }
    if (preset?.passwordLabel && preset.passwordLabel !== '密码') {
      return new Error(`认证失败：请确认 IMAP 服务已开启，并且填写的是「${preset.passwordLabel}」而不是登录密码。`);
    }
    return new Error('认证失败：账号或密码不正确，请检查后重试。');
  }
  if (code === 'ENOTFOUND' || /getaddrinfo|ENOTFOUND/i.test(raw)) {
    return new Error(`无法解析邮件服务器地址（${account?.imap?.host || '未知'}），请检查服务器地址是否正确。`);
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(raw)) {
    return new Error(`服务器拒绝连接（${account?.imap?.host}:${account?.imap?.port}），请检查端口或代理设置。`);
  }
  if (code === 'ETIMEDOUT' || /timeout|timed out|ETIMEDOUT/i.test(raw)) {
    return new Error('连接邮件服务器超时，请检查网络（如需代理请先在系统代理中配置）。');
  }
  if (/certificate|CERT_|self signed/i.test(raw)) {
    return new Error('服务器证书校验失败，可能是企业邮箱自签名证书或网络被劫持。');
  }
  return new Error(raw || '连接邮件服务器失败');
}

function hasAttachment(structure) {
  if (!structure) return false;
  const stack = [structure];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    const disposition = String(node.disposition || '').toLowerCase();
    const fileName = node.dispositionParameters?.filename || node.parameters?.name;
    if (disposition === 'attachment' && node.part !== '1') return true;
    if (fileName && disposition !== 'inline') return true;
    if (Array.isArray(node.childNodes)) stack.push(...node.childNodes);
  }
  return false;
}

function toAddress(list) {
  return (list || [])
    .map((item) => {
      const address = String(item.address || '').trim();
      const name = String(item.name || '').trim();
      return address ? { name, address } : null;
    })
    .filter(Boolean);
}

function toIsoDate(value) {
  if (!value) return new Date(0).toISOString();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date(0).toISOString();
  return date.toISOString();
}

function buildMessage(imapMessage, folder) {
  const envelope = imapMessage.envelope || {};
  const fromList = toAddress(envelope.from);
  const from = fromList[0] || { name: '', address: '' };
  return {
    uid: imapMessage.uid,
    folder: folder.path,
    messageId: String(envelope.messageId || '').replace(/^<|>$/g, ''),
    subject: String(envelope.subject || '').trim() || '（无主题）',
    fromName: from.name,
    fromAddress: from.address,
    to: toAddress(envelope.to),
    cc: toAddress(envelope.cc),
    date: toIsoDate(envelope.date || imapMessage.internalDate),
    seen: imapMessage.flags ? imapMessage.flags.has('\\Seen') : false,
    flagged: imapMessage.flags ? imapMessage.flags.has('\\Flagged') : false,
    hasAttachments: hasAttachment(imapMessage.bodyStructure),
    size: Number(imapMessage.size) || 0,
    snippet: ''
  };
}

function sortFolders(folders) {
  return folders.sort((a, b) => {
    const ai = FOLDER_ORDER.indexOf(a.specialUse);
    const bi = FOLDER_ORDER.indexOf(b.specialUse);
    const aRank = ai === -1 ? 99 : ai;
    const bRank = bi === -1 ? 99 : bi;
    if (aRank !== bRank) return aRank - bRank;
    return String(a.label).localeCompare(String(b.label), 'zh-Hans-CN');
  });
}

class MailService {
  constructor(store) {
    this.store = store;
    this.clients = new Map();
    this.syncing = new Set();
  }

  getClient(accountId) {
    const existing = this.clients.get(accountId);
    if (existing) {
      if (existing.usable) return existing;
      this.clients.delete(accountId);
    }
    return null;
  }

  async connect(accountId) {
    const cached = this.getClient(accountId);
    if (cached) return cached;

    const account = this.store.getAccount(accountId);
    if (!account) throw new Error('账号不存在或已被删除');
    if (!account.imap || !account.imap.host) throw new Error('该账号未配置 IMAP 服务器');

    const password = this.store.getPassword(accountId);
    if (!password) throw new Error('没有保存该账号的密码，请编辑账号重新填写授权码');

    const client = new ImapFlow({
      host: account.imap.host,
      port: account.imap.port,
      secure: account.imap.secure !== false,
      auth: { user: account.username || account.email, pass: password },
      logger: false,
      socketTimeout: 120000,
      greetingTimeout: 20000,
      connectionTimeout: 25000,
      disableAutoIdle: true,
      tls: { servername: account.imap.host }
    });

    const forget = () => this.clients.delete(accountId);
    client.on('error', forget);
    client.on('close', forget);

    try {
      await client.connect();
    } catch (err) {
      forget();
      throw friendlyError(err, account);
    }
    this.clients.set(accountId, client);
    return client;
  }

  async disconnect(accountId) {
    const client = this.clients.get(accountId);
    this.clients.delete(accountId);
    if (!client) return;
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        /* 忽略 */
      }
    }
  }

  async closeAll() {
    const ids = [...this.clients.keys()];
    await Promise.all(ids.map((id) => this.disconnect(id)));
  }

  /* ---------------- 文件夹 ---------------- */

  async listFolders(accountId) {
    const client = await this.connect(accountId);
    const raw = await client.list({ statusQuery: { messages: true, unseen: true } });
    const folders = raw
      .filter((item) => !item.flags.has('\\Noselect'))
      .map((item) => ({
        path: item.path,
        name: item.name,
        label: folderLabel(item),
        specialUse: item.specialUse || '',
        delimiter: item.delimiter || '/',
        total: item.status?.messages || 0,
        unseen: item.status?.unseen || 0
      }));
    return sortFolders(folders);
  }

  /* ---------------- 同步 ---------------- */

  async syncFolder(client, folder, limit) {
    let lock;
    try {
      lock = await client.getMailboxLock(folder.path);
    } catch (err) {
      throw friendlyError(err, null);
    }
    try {
      const exists = Number(client.mailbox?.exists) || 0;
      if (!exists) return [];
      const start = Math.max(1, exists - limit + 1);
      const collected = [];
      for await (const message of client.fetch(
        `${start}:*`,
        { uid: true, envelope: true, flags: true, size: true, bodyStructure: true },
        { uid: false }
      )) {
        collected.push(buildMessage(message, folder));
      }
      return collected;
    } finally {
      lock.release();
    }
  }

  /**
   * 同步一个账号：文件夹清单 + 收件箱元数据（+ 已发送），返回写入后的缓存。
   */
  async syncAccount(accountId, options = {}) {
    if (this.syncing.has(accountId)) throw new Error('该账号正在同步中');
    this.syncing.add(accountId);
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const account = this.store.getAccount(accountId);
    const limit = Number(options.limit) || 150;

    try {
      onProgress({ accountId, phase: 'folders' });
      const folders = await this.listFolders(accountId);
      const client = this.getClient(accountId);

      const cache = this.store.loadCache(accountId);
      const previous = new Map(cache.folders.map((item) => [item.path, item]));
      const nextFolders = folders.map((folder) => {
        const old = previous.get(folder.path);
        return { ...folder, messages: old?.messages || [] };
      });

      const targets = nextFolders.filter((folder) => {
        const special = folder.specialUse;
        if (special === '\\Inbox') return true;
        if (special === '\\Sent') return true;
        return options.folders ? options.folders.includes(folder.path) : false;
      });

      for (const folder of targets) {
        onProgress({ accountId, phase: 'messages', folder: folder.path, label: folder.label });
        const messages = await this.syncFolder(client, folder, folder.specialUse === '\\Sent' ? 60 : limit);
        const oldByUid = new Map((previous.get(folder.path)?.messages || []).map((m) => [m.uid, m]));
        folder.messages = messages
          .map((message) => {
            const old = oldByUid.get(message.uid);
            return old && old.snippet ? { ...message, snippet: old.snippet } : message;
          })
          .sort((a, b) => new Date(b.date) - new Date(a.date));
      }

      const saved = this.store.saveCache(accountId, { folders: sortFolders(nextFolders) });
      this.store.markSynced(accountId, null);
      onProgress({ accountId, phase: 'done' });
      return saved;
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : String(err);
      this.store.markSynced(accountId, message);
      await this.disconnect(accountId);
      throw err;
    } finally {
      this.syncing.delete(accountId);
    }
  }

  /**
   * 只同步指定文件夹（用于用户点开其他文件夹时按需拉取）。
   */
  async syncFolderOnly(accountId, folderPath, limit = 100) {
    const folders = await this.listFolders(accountId);
    const target = folders.find((folder) => folder.path === folderPath);
    if (!target) throw new Error('文件夹不存在');
    const client = this.getClient(accountId);
    const messages = await this.syncFolder(client, target, limit);

    const cache = this.store.loadCache(accountId);
    const existing = cache.folders.find((folder) => folder.path === folderPath);
    const oldByUid = new Map((existing?.messages || []).map((m) => [m.uid, m]));
    const merged = messages
      .map((message) => {
        const old = oldByUid.get(message.uid);
        return old && old.snippet ? { ...message, snippet: old.snippet } : message;
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    const foldersMerged = cache.folders.map((folder) =>
      folder.path === folderPath ? { ...folder, total: target.total, unseen: target.unseen, messages: merged } : folder
    );
    return this.store.saveCache(accountId, { folders: foldersMerged });
  }

  /* ---------------- 正文 ---------------- */

  async fetchBody(accountId, folderPath, uid) {
    const cached = this.store.readBody(accountId, folderPath, uid);
    if (cached) return cached;

    const client = await this.connect(accountId);
    let lock;
    try {
      lock = await client.getMailboxLock(folderPath);
    } catch (err) {
      throw friendlyError(err, this.store.getAccount(accountId));
    }
    try {
      const message = await client.fetchOne(String(uid), { uid: true, source: true, size: true, envelope: true }, { uid: true });
      if (!message || !message.source) throw new Error('该邮件在服务器上已不存在');

      const size = Number(message.size) || message.source.length;
      if (size > MAX_SOURCE_BYTES) throw new Error('该邮件体积过大，暂不支持在客户端中打开');

      const parsed = await simpleParser(message.source, { skipHtmlToText: false, skipTextToHtml: true });

      const account = this.store.getAccount(accountId);
      const wantRemoteImages = Boolean(this.store.getSettings().showRemoteImages);
      const html = typeof parsed.html === 'string' ? parsed.html : '';
      const inlineImages = new Map();
      let inlineBytes = 0;

      const attachments = [];
      let attachmentBytes = 0;
      (parsed.attachments || []).forEach((attachment, index) => {
        const content = attachment.content;
        if (!content || !content.length) return;

        // 内嵌图片（cid:）转成 data URI，让正文里的 logo / 图标能正常显示
        const cid = String(attachment.cid || '').replace(/^<|>$/g, '').trim();
        const contentType = attachment.contentType || 'application/octet-stream';
        if (cid && /^image\//i.test(contentType) && inlineBytes + content.length <= MAX_INLINE_IMAGE_BYTES) {
          inlineBytes += content.length;
          inlineImages.set(cid.toLowerCase(), `data:${contentType};base64,${content.toString('base64')}`);
        }

        attachmentBytes += content.length;
        if (attachmentBytes > MAX_ATTACHMENT_BYTES) return;

        const fileName = safeName(attachment.filename || `附件-${index + 1}`);
        const filePath = this.store.attachmentPath(accountId, folderPath, uid, index, fileName);
        try {
          fs.writeFileSync(filePath, content);
        } catch {
          return;
        }
        attachments.push({
          index,
          filename: fileName,
          contentType: attachment.contentType || 'application/octet-stream',
          size: content.length,
          cid: String(attachment.cid || '').replace(/^<|>$/g, '')
        });
      });

      const resolvedHtml = inlineImages.size
        ? html.replace(/cid:([^"'\s>)]+)/gi, (match, raw) => {
            let key = String(raw).trim().toLowerCase();
            try {
              key = decodeURIComponent(key);
            } catch {
              /* 保留原始写法 */
            }
            return inlineImages.get(key) || inlineImages.get(key.replace(/^<|>$/g, '')) || match;
          })
        : html;

      const payload = {
        uid: Number(uid),
        folder: folderPath,
        subject: String(parsed.subject || message.envelope?.subject || '').trim() || '（无主题）',
        fromName: parsed.from?.value?.[0]?.name || '',
        fromAddress: parsed.from?.value?.[0]?.address || '',
        to: (parsed.to?.value || []).map((item) => ({ name: item.name || '', address: item.address || '' })),
        cc: (parsed.cc?.value || []).map((item) => ({ name: item.name || '', address: item.address || '' })),
        date: toIsoDate(parsed.date || message.envelope?.date),
        replyTo: parsed.replyTo?.value?.[0]?.address || '',
        text: typeof parsed.text === 'string' ? parsed.text : '',
        html: resolvedHtml,
        attachments,
        hasRemoteImages: /<img[^>]+src\s*=\s*["']?https?:/i.test(resolvedHtml),
        remoteImagesAllowed: wantRemoteImages,
        fetchedAt: Date.now(),
        accountEmail: account?.email || ''
      };

      this.store.writeBody(accountId, folderPath, uid, payload);

      // 顺便把摘要回填到缓存，列表里就能显示正文预览
      this.patchSnippet(accountId, folderPath, uid, payload);
      return payload;
    } finally {
      lock.release();
    }
  }

  patchSnippet(accountId, folderPath, uid, payload) {
    const cache = this.store.loadCache(accountId);
    const folder = cache.folders.find((item) => item.path === folderPath);
    if (!folder) return;
    const message = (folder.messages || []).find((item) => item.uid === Number(uid));
    if (!message) return;
    const snippet = String(payload.text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    if (snippet && snippet !== message.snippet) {
      message.snippet = snippet;
      this.store.saveCache(accountId, cache);
    }
  }

  /* ---------------- 标记 / 删除 ---------------- */

  async setFlags(accountId, folderPath, uid, flags) {
    const client = await this.connect(accountId);
    let lock;
    try {
      lock = await client.getMailboxLock(folderPath);
    } catch (err) {
      throw friendlyError(err, this.store.getAccount(accountId));
    }
    try {
      const add = [];
      const remove = [];
      if (flags.seen === true) add.push('\\Seen');
      if (flags.seen === false) remove.push('\\Seen');
      if (flags.flagged === true) add.push('\\Flagged');
      if (flags.flagged === false) remove.push('\\Flagged');
      if (add.length) await client.messageFlagsAdd(String(uid), add, { uid: true });
      if (remove.length) await client.messageFlagsRemove(String(uid), remove, { uid: true });

      const cache = this.store.loadCache(accountId);
      for (const folder of cache.folders) {
        if (folder.path !== folderPath) continue;
        const message = (folder.messages || []).find((item) => item.uid === Number(uid));
        if (!message) continue;
        if (flags.seen !== undefined) message.seen = flags.seen;
        if (flags.flagged !== undefined) message.flagged = flags.flagged;
        if (flags.seen === true) folder.unseen = Math.max(0, (folder.unseen || 0) - 1);
        if (flags.seen === false) folder.unseen = (folder.unseen || 0) + 1;
      }
      this.store.saveCache(accountId, cache);
      return true;
    } finally {
      lock.release();
    }
  }

  /** 把整个文件夹里的未读邮件一次性标为已读（服务端一条 STORE 命令搞定） */
  async markAllRead(accountId, folderPath) {
    const client = await this.connect(accountId);
    let lock;
    try {
      lock = await client.getMailboxLock(folderPath);
    } catch (err) {
      throw friendlyError(err, this.store.getAccount(accountId));
    }
    try {
      await client.messageFlagsAdd({ seen: false }, ['\\Seen'], { uid: false });

      const cache = this.store.loadCache(accountId);
      let changed = 0;
      for (const folder of cache.folders) {
        if (folder.path !== folderPath) continue;
        for (const message of folder.messages || []) {
          if (!message.seen) {
            message.seen = true;
            changed += 1;
          }
        }
        folder.unseen = 0;
      }
      this.store.saveCache(accountId, cache);
      return changed;
    } finally {
      lock.release();
    }
  }

  async trashFolderPath(accountId) {
    const cache = this.store.loadCache(accountId);
    const bySpecial = cache.folders.find((folder) => folder.specialUse === '\\Trash');
    if (bySpecial) return bySpecial.path;
    const byName = cache.folders.find((folder) => /trash|deleted|已删除/i.test(`${folder.label} ${folder.path}`));
    return byName ? byName.path : null;
  }

  async deleteMessage(accountId, folderPath, uid) {
    const client = await this.connect(accountId);
    const trashPath = await this.trashFolderPath(accountId);
    const permanent = !trashPath || trashPath === folderPath;

    let lock;
    try {
      lock = await client.getMailboxLock(folderPath);
    } catch (err) {
      throw friendlyError(err, this.store.getAccount(accountId));
    }
    try {
      if (permanent) {
        await client.messageDelete(String(uid), { uid: true });
      } else {
        await client.messageMove(String(uid), trashPath, { uid: true });
      }
    } finally {
      lock.release();
    }

    const cache = this.store.loadCache(accountId);
    for (const folder of cache.folders) {
      if (folder.path !== folderPath) continue;
      const before = (folder.messages || []).length;
      folder.messages = (folder.messages || []).filter((item) => item.uid !== Number(uid));
      folder.total = Math.max(0, (folder.total || before) - 1);
    }
    if (!permanent) {
      const trash = cache.folders.find((folder) => folder.path === trashPath);
      if (trash) trash.total = (trash.total || 0) + 1;
    }
    this.store.saveCache(accountId, cache);
    this.store.removeBody(accountId, folderPath, uid);
    return { permanent };
  }

  /* ---------------- 连接测试 ---------------- */

  async testConnection({ imap, smtp, user, password, provider }) {
    const meta = { provider, imap, smtp, email: user };
    const result = { imap: { ok: false, error: null }, smtp: { ok: false, error: null } };
    if (!password) {
      result.imap.error = '请填写授权码 / 密码';
      result.smtp.error = '请填写授权码 / 密码';
      return result;
    }

    let client;
    try {
      client = new ImapFlow({
        host: imap.host,
        port: Number(imap.port) || 993,
        secure: imap.secure !== false,
        auth: { user, pass: password },
        logger: false,
        greetingTimeout: 15000,
        connectionTimeout: 20000,
        tls: { servername: imap.host }
      });
      client.on('error', () => {});
      await client.connect();
      await client.list({ listOnly: true });
      await client.logout();
      result.imap.ok = true;
    } catch (err) {
      try {
        client?.close();
      } catch {
        /* 忽略 */
      }
      result.imap.error = friendlyError(err, meta).message;
    }

    const nodemailer = require('nodemailer');
    try {
      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: Number(smtp.port) || 465,
        secure: smtp.secure !== false,
        auth: { user, pass: password },
        connectionTimeout: 20000,
        greetingTimeout: 15000,
        socketTimeout: 30000
      });
      await transporter.verify();
      transporter.close();
      result.smtp.ok = true;
    } catch (err) {
      result.smtp.error = friendlyError(err, meta).message;
    }

    return result;
  }
}

module.exports = { MailService, folderLabel, FOLDER_LABELS, friendlyError };