'use strict';

/**
 * 发信逻辑单测：不联网，替换 nodemailer，验证
 * 1) 信封发件人 = 账号地址（163 要求）
 * 2) 服务商已自存副本时不再重复 APPEND
 * 3) 服务商没存时才补一份
 * 4) 查重失败时退回「照常追加」
 */

const path = require('path');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---- 替换 nodemailer ----
let lastOptions = null;
const transport = {
  sendMail: async (options) => {
    lastOptions = options;
    return { messageId: options.messageId, accepted: options.to, rejected: [] };
  },
  close: () => {}
};
const nodemailerPath = require.resolve('nodemailer');
require.cache[nodemailerPath] = {
  id: nodemailerPath,
  filename: nodemailerPath,
  loaded: true,
  exports: { createTransport: () => transport }
};
const composerPath = require.resolve('nodemailer/lib/mail-composer');
require.cache[composerPath] = {
  id: composerPath,
  filename: composerPath,
  loaded: true,
  exports: class MailComposer {
    constructor(options) {
      this.options = options;
    }
    compile() {
      return { build: async () => Buffer.from('raw-message') };
    }
  }
};

const { sendMail } = require(path.resolve(__dirname, 'main/sender.js'));

function makeStore() {
  const cache = {
    accountId: 'acc',
    folders: [{ path: 'Sent', label: '已发送', specialUse: '\\Sent', messages: [], total: 0 }]
  };
  return {
    getAccount: () => ({
      id: 'acc',
      label: '163 邮箱',
      email: 'someone@163.com',
      username: 'someone@163.com',
      smtp: { host: 'smtp.163.com', port: 465, secure: true }
    }),
    getPassword: () => 'auth-code',
    loadCache: () => JSON.parse(JSON.stringify(cache)),
    saveCache: () => {}
  };
}

function makeMailService(behavior) {
  const calls = { append: 0, search: 0, mailboxOpen: 0 };
  return {
    calls,
    async connect() {
      return {
        async mailboxOpen() {
          calls.mailboxOpen += 1;
        },
        async search() {
          calls.search += 1;
          if (behavior === 'error') throw new Error('SEARCH unsupported');
          return behavior === 'exists' ? [42] : [];
        },
        async append() {
          calls.append += 1;
        }
      };
    }
  };
}

const payload = {
  to: 'a@example.com, b@example.com',
  cc: 'c@example.com',
  bcc: 'd@example.com',
  subject: '测试主题',
  text: '正文内容'
};

(async () => {
  // 1) 163 已经自己存了一份
  {
    const mailService = makeMailService('exists');
    const result = await sendMail({ store: makeStore(), mailService, accountId: 'acc', payload });
    check('信封发件人是登录账号', lastOptions.envelope.from === 'someone@163.com', lastOptions.envelope.from);
    check('信封收件人包含 to/cc/bcc', lastOptions.envelope.to.length === 4, lastOptions.envelope.to.join(','));
    check('带上了 Message-ID 与 Date', Boolean(lastOptions.messageId) && lastOptions.date instanceof Date, lastOptions.messageId);
    check('服务商已存副本时不再追加', mailService.calls.append === 0 && mailService.calls.search === 1, JSON.stringify(mailService.calls));
    check('仍然标记为已保存到已发送', result.savedToSent === true, JSON.stringify(result));
  }

  // 2) 服务商没存（QQ 这类），要补一份
  {
    const mailService = makeMailService('missing');
    const result = await sendMail({ store: makeStore(), mailService, accountId: 'acc', payload });
    check('服务商没存时补一次 APPEND', mailService.calls.append === 1, JSON.stringify(mailService.calls));
    check('补存也算成功', result.savedToSent === true, JSON.stringify(result));
  }

  // 3) 查重不支持（服务器报错）时退回追加
  {
    const mailService = makeMailService('error');
    const result = await sendMail({ store: makeStore(), mailService, accountId: 'acc', payload });
    check('查重失败时退回追加，不让发信结果变差', mailService.calls.append === 1 && result.savedToSent === true, JSON.stringify(mailService.calls));
  }

  // 4) 没有收件人时直接拒绝
  {
    let failed = false;
    try {
      await sendMail({ store: makeStore(), mailService: makeMailService('missing'), accountId: 'acc', payload: { subject: 'x' } });
    } catch (err) {
      failed = /收件人/.test(err.message);
    }
    check('没有收件人时报错', failed, '');
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n通过 ${results.length - bad.length}/${results.length}`);
  process.exit(bad.length ? 1 : 0);
})().catch((err) => {
  console.error('失败:', err);
  process.exit(2);
});