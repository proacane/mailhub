'use strict';

const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { friendlyError } = require('./mail');

function splitAddresses(input) {
  return String(input || '')
    .split(/[,;，；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function textToHtml(text) {
  const escaped = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\r?\n/g, '<br>');
}

function findSentFolder(store, accountId) {
  const cache = store.loadCache(accountId);
  const bySpecial = cache.folders.find((folder) => folder.specialUse === '\\Sent');
  if (bySpecial) return bySpecial.path;
  const byName = cache.folders.find((folder) => /sent|已发送/i.test(`${folder.label} ${folder.path}`));
  return byName ? byName.path : 'Sent';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 有些服务商（163 / QQ / Gmail）发完信会自己在「已发送」里存一份。
 * 我们再 APPEND 一次就变成两封，且第二封没有服务商标记的「发送成功」状态。
 * 所以先按 Message-ID 查一下，已经有了就不再追加。
 */
async function sentCopyExists(client, sentPath, messageId) {
  try {
    await client.mailboxOpen(sentPath);
    const found = await client.search({ header: { 'Message-ID': messageId } }, { uid: true });
    return Array.isArray(found) && found.length > 0;
  } catch {
    return false;
  }
}

/**
 * 发送邮件，并把副本追加到「已发送」文件夹。
 */
async function sendMail({ store, mailService, accountId, payload }) {
  const account = store.getAccount(accountId);
  if (!account) throw new Error('账号不存在');
  if (!account.smtp || !account.smtp.host) throw new Error('该账号未配置 SMTP 服务器');

  const password = store.getPassword(accountId);
  if (!password) throw new Error('没有保存该账号的密码，请编辑账号重新填写授权码');

  const to = splitAddresses(payload.to);
  const cc = splitAddresses(payload.cc);
  const bcc = splitAddresses(payload.bcc);
  if (!to.length && !cc.length && !bcc.length) throw new Error('请至少填写一个收件人');

  const subject = String(payload.subject || '').trim();
  const text = String(payload.text || '');
  const attachments = (payload.attachments || [])
    .filter((file) => file && typeof file === 'string')
    .map((file) => ({ filename: path.basename(file), path: file }));

  const domain = (account.email.split('@')[1] || 'mailhub.local').replace(/[^a-z0-9.-]/gi, '') || 'mailhub.local';
  const messageId = `<${crypto.randomUUID()}@${domain}>`;

  const mailOptions = {
    from: { name: account.label || account.email, address: account.email },
    to,
    cc,
    bcc,
    subject,
    text,
    html: payload.html || textToHtml(text),
    attachments,
    messageId,
    date: new Date(),
    // 信封发件人必须和登录账号一致，163 会因为两者不一致把信标记成失败
    envelope: { from: account.email, to: [...to, ...cc, ...bcc] }
  };
  if (payload.inReplyTo) {
    mailOptions.inReplyTo = payload.inReplyTo;
    mailOptions.references = [payload.inReplyTo];
  }

  const transporter = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure !== false,
    auth: { user: account.username || account.email, pass: password },
    connectionTimeout: 25000,
    greetingTimeout: 20000,
    socketTimeout: 60000
  });

  let info;
  try {
    info = await transporter.sendMail(mailOptions);
  } catch (err) {
    throw friendlyError(err, account);
  } finally {
    try {
      transporter.close();
    } catch {
      /* 忽略 */
    }
  }

  const rejected = [...(info.rejected || [])];
  const accepted = [...(info.accepted || [])];

  // 追加副本到「已发送」，失败不影响发信结果
  let savedToSent = false;
  let warning = null;
  try {
    const raw = await new MailComposer(mailOptions).compile().build();
    const client = await mailService.connect(accountId);
    const sentPath = findSentFolder(store, accountId);

    // 给服务商一点时间把它自己的副本写进「已发送」，再决定要不要补一份
    await sleep(1200);
    const alreadySaved = await sentCopyExists(client, sentPath, messageId);
    if (!alreadySaved) {
      await client.append(sentPath, raw, ['\\Seen'], new Date());
    }

    const cache = store.loadCache(accountId);
    const sentFolder = cache.folders.find((folder) => folder.path === sentPath);
    if (sentFolder) {
      const optimistic = {
        uid: -Date.now(),
        folder: sentPath,
        messageId: messageId.replace(/^<|>$/g, ''),
        subject: subject || '（无主题）',
        fromName: account.label || '',
        fromAddress: account.email,
        to: to.map((address) => ({ name: '', address })),
        cc: cc.map((address) => ({ name: '', address })),
        date: new Date().toISOString(),
        seen: true,
        flagged: false,
        hasAttachments: attachments.length > 0,
        size: raw.length,
        snippet: text.replace(/\s+/g, ' ').slice(0, 160),
        pendingSync: true
      };
      sentFolder.messages = [optimistic, ...(sentFolder.messages || [])].slice(0, 200);
      sentFolder.total = (sentFolder.total || 0) + 1;
      store.saveCache(accountId, cache);
    }
    savedToSent = true;
  } catch (err) {
    warning = `邮件已发送，但保存副本到「已发送」失败：${err.message}`;
  }

  return {
    messageId: info.messageId || messageId,
    accepted,
    rejected,
    savedToSent,
    warning
  };
}

module.exports = { sendMail, textToHtml, splitAddresses };