'use strict';

const fs = require('fs');

/**
 * 演示数据：仅在 MAILHUB_DEMO=1 且当前没有任何账号时写入，
 * 用于在没有真实邮箱凭据的情况下预览界面与交互。
 */

const ACCOUNTS = [
  { label: '工作邮箱', email: 'work.demo@qq.com', provider: 'demo', color: '#0f6b5b' },
  { label: '订阅与账单', email: 'billing.demo@163.com', provider: 'demo', color: '#265f8c' },
  { label: '个人 Gmail', email: 'personal.demo@gmail.com', provider: 'demo', color: '#8b3a58' }
];

const MESSAGES = [
  {
    account: 0,
    from: { name: '陈明', address: 'chenming@teamflow.cn' },
    subject: '产品评审会改到周四下午 3 点',
    hoursAgo: 2,
    seen: false,
    flagged: false,
    body:
      '各位好，\n\n原定周三上午的产品评审会改到周四下午 3 点，会议室还是 12 楼 A 座。\n\n本次重点评审三件事：\n1. 多账号统一收件箱的交互稿\n2. 邮件列表的搜索与筛选方案\n3. 下个版本的排期\n\n麻烦提前把材料发到群里，谢谢。\n\n陈明'
  },
  {
    account: 2,
    from: { name: 'GitHub', address: 'noreply@github.com' },
    subject: '[mailhub] 你的 Pull Request #42 已被合并',
    hoursAgo: 5,
    seen: false,
    flagged: false,
    body:
      'Hi there,\n\nYour pull request #42 "feat: 支持多账号未读数聚合" was merged into main.\n\nThanks for your contribution!\n\n— GitHub'
  },
  {
    account: 1,
    from: { name: '阿里云', address: 'billing@aliyun.com' },
    subject: '2026 年 10 月账单已生成（¥ 128.40）',
    hoursAgo: 8,
    seen: false,
    flagged: false,
    hasAttachment: true,
    attachmentName: '阿里云-2026-10-账单.pdf',
    body:
      '尊敬的用户：\n\n您 2026 年 10 月的云服务账单已生成，本期应付金额 ¥ 128.40，请于 11 月 5 日前完成支付。\n\n账单明细见附件。\n\n阿里云'
  },
  {
    account: 0,
    from: { name: '李静', address: 'lijing@teamflow.cn' },
    subject: '回复：关于邮件客户端 IMAP 同步性能',
    hoursAgo: 26,
    seen: true,
    flagged: true,
    body:
      '我这边测了一下，收件箱 500 封邮件首次同步大约 3 秒，之后增量同步基本在 1 秒内。\n\n建议默认只拉最近 150 封，其余按需加载，避免首次同步太慢。\n\n李静'
  },
  {
    account: 2,
    from: { name: 'Notion', address: 'team@makenotion.com' },
    subject: '你本周的工作区摘要',
    hoursAgo: 30,
    seen: true,
    body:
      'Here is your weekly workspace digest.\n\n5 pages updated, 12 comments resolved, 2 new databases created.\n\nOpen Notion to see more.'
  },
  {
    account: 0,
    from: { name: '王涛', address: 'wangtao@vendor-supply.com' },
    subject: '合同盖章版已寄出（顺丰 SF7234****）',
    hoursAgo: 32,
    seen: false,
    flagged: false,
    body:
      '张工你好，\n\n合同盖章版今天上午已经寄出，运单号 SF7234****，预计明后天到达，请注意查收。\n\n另外发票下周一开出，到时候邮件发你。\n\n王涛'
  },
  {
    account: 1,
    from: { name: '腾讯云', address: 'notice@tencentcloud.com' },
    subject: '域名即将到期提醒：mailhub.cn',
    hoursAgo: 49,
    seen: true,
    body:
      '您的域名 mailhub.cn 将于 30 天后到期，为避免解析中断，请及时续费。\n\n腾讯云'
  },
  {
    account: 0,
    from: { name: 'HR 赵蕾', address: 'zhaolei@teamflow.cn' },
    subject: '10 月社保公积金变动确认',
    hoursAgo: 54,
    seen: true,
    body:
      '各位同事：\n\n10 月社保公积金基数有变动，请在本周五前登录人事系统确认个人缴纳信息，逾期视为无异议。\n\n赵蕾'
  },
  {
    account: 2,
    from: { name: 'Stripe', address: 'receipts@stripe.com' },
    subject: 'Your receipt from Stripe, Inc. #2451-8890',
    hoursAgo: 58,
    seen: true,
    body: 'Thanks for your payment of $12.00. Your receipt is available in the dashboard.\n\n— Stripe'
  },
  {
    account: 1,
    from: { name: '中国移动', address: 'service@10086.cn' },
    subject: '本月流量使用已达 80%',
    hoursAgo: 72,
    seen: false,
    body:
      '尊敬的用户，截至今日您的套餐流量已使用 80%，剩余 3.2GB。\n\n如需加购流量包请回复短信或前往掌上营业厅。'
  },
  {
    account: 0,
    from: { name: '周航', address: 'zhouhang@teamflow.cn' },
    subject: '设计稿 v3 已上传到 Figma',
    hoursAgo: 80,
    seen: true,
    body:
      '最新一版设计稿已经上传，主要调整了左侧账号栏的信息层级，把未读数做成了小圆点加数字的形式。\n\n链接在群公告里，麻烦看下有没有问题。'
  },
  {
    account: 2,
    from: { name: 'Medium Daily Digest', address: 'noreply@medium.com' },
    subject: 'Building a Multi-Account Email Client with Electron',
    hoursAgo: 96,
    seen: true,
    body:
      'Today\'s highlights for you:\n\n1. Building a Multi-Account Email Client with Electron\n2. IMAP IDLE: push instead of polling\n3. A pragmatic guide to SQLite in desktop apps'
  },
  {
    account: 1,
    from: { name: '招商银行', address: 'ccsvc@message.cmbchina.com' },
    subject: '您尾号 8823 的账户发生一笔支出',
    hoursAgo: 120,
    seen: true,
    body: '您尾号 8823 的账户 10 月 15 日支出人民币 268.00 元，交易类型：线上消费。'
  },
  {
    account: 0,
    from: { name: '徐倩', address: 'xuqian@teamflow.cn' },
    subject: '周五团建报名统计',
    hoursAgo: 128,
    seen: true,
    body: '周五下午团建去爬山，晚上聚餐，想参加的接龙报名，截止周三下班前。'
  },
  {
    account: 2,
    from: { name: 'Apple', address: 'no_reply@apple.com' },
    subject: '您的 Apple ID 已在新设备上登录',
    hoursAgo: 150,
    seen: true,
    body: '您的 Apple ID 刚刚在一台新设备上登录。如果这不是您本人操作，请立即修改密码。'
  },
  {
    account: 0,
    from: { name: '周子豪', address: 'zhouzihao@teamflow.cn' },
    subject: '长邮件测试：IMAP 同步与本地缓存的完整踩坑记录（很长，可以往下滚）',
    hoursAgo: 6,
    seen: false,
    body: [
      '各位好，',
      '',
      '这封邮件比较长，主要是把这两个月做同步模块踩过的坑整理一下，方便后面接手的人少走弯路。如果你只想看结论，直接跳到最后一节。',
      '',
      '一、连接层',
      '1. 国内邮箱基本都要求 SSL 993 端口，明文 143 大多被关掉了；QQ 邮箱、163 邮箱需要在网页端先开启 IMAP 服务并生成授权码，直接填登录密码会报 AUTHENTICATIONFAILED。',
      '2. 连接数不是越多越好。Gmail 对单账号并发连接有限制，超过会直接返回 "[ALERT] Too many simultaneous connections"，现象是同步一半突然断开，而且不报错，只是没数据。我们最后把单账号并发压在 3 条以内。',
      '3. 一定要设 socketTimeout。不做超时的话，网络抖动时 Promise 会一直挂着，界面显示"正在同步"，实际上已经死了。',
      '',
      '二、文件夹与 UID',
      '1. UID 只在同一个文件夹内唯一，跨文件夹会重复。缓存 key 必须用 "账号|文件夹|uid" 三段拼，早期我只用了 uid，结果收件箱和已发送互相覆盖，删一封另一封没了。',
      '2. UIDVALIDITY 变化意味着旧 UID 全部作废。要监听这个值，变了就整个文件夹的缓存重新拉，不然会出现"点开是空的"。',
      '3. 中文文件夹名是 modified UTF-7 编码的，比如 "已发送" 是 "&XfJT0ZAB-"。node-imap 的 getBoxes 会返回解码后的名字，但有些服务端返回的 children 结构不一样，要兜底遍历。',
      '',
      '三、正文解析',
      '1. HTML 邮件一定要放进 iframe 或者做严格清洗。直接 innerHTML 会让邮件里的 <style> 污染整个应用，我就被一封营销邮件把全局字号改成了 28px。',
      '2. 外部图片默认屏蔽，加一个"显示图片"的开关。不然打开一封带追踪像素的邮件，发件人立刻知道你在什么时间看了它。',
      '3. 附件不要一次性全部解码到内存。一封 30MB 的邮件会把渲染进程卡住三秒，改成按需加载之后流畅很多。',
      '',
      '四、本地缓存',
      '1. 列表和正文分开存。列表只需要 headers，存成一个 JSON 就够；正文单独按 uid 存文件，清理缓存时可以只删正文不删列表。',
      '2. 写入要原子化：先写 .tmp，再 rename 覆盖。直接覆盖写如果中途断电，文件会变成半截 JSON，下次启动直接解析失败，账号全丢。',
      '3. 缓存目录要做体积统计，界面上给用户一个"清理缓存"的按钮，否则用一年之后能占几个 G。',
      '',
      '五、结论',
      '同步这件事，80% 的 bug 都来自"想当然"：想当然地以为 UID 全局唯一、想当然地以为连接不会断、想当然地以为服务端返回的顺序是稳定的。把这三个假设推翻之后，剩下的就是体力活。',
      '',
      '有补充的欢迎直接回复这封邮件，我整理成文档放到内网。',
      '',
      '周子豪',
      '平台组 / TeamFlow'
    ].join('\n')
  }
];

const SENT = [
  {
    account: 0,
    to: [{ name: '陈明', address: 'chenming@teamflow.cn' }],
    subject: '回复：产品评审会改到周四下午 3 点',
    hoursAgo: 1,
    body: '收到，材料我今晚整理好发群里。'
  },
  {
    account: 0,
    to: [{ name: '王涛', address: 'wangtao@vendor-supply.com' }],
    subject: '回复：合同盖章版已寄出',
    hoursAgo: 31,
    body: '好的，收到后我这边走内部用印流程，有进展同步你。'
  },
  {
    account: 2,
    to: [{ name: 'Stripe Support', address: 'support@stripe.com' }],
    subject: 'Question about invoice #2451-8890',
    hoursAgo: 57,
    body: 'Hi, could you resend the invoice to my billing address? Thanks.'
  }
];

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function textToHtml(text) {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

function seedDemoData(store) {
  const existing = store.listAccounts();
  let accounts;

  if (existing.length > 0) {
    // 已经有账号：只有在「演示账号的缓存被清空」时才补回演示邮件，
    // 这样设置里点过「清理邮件缓存」之后演示模式不会变成空白。
    const demoAccounts = existing.filter((account) => account.provider === 'demo');
    const allEmpty = demoAccounts.length > 0 && demoAccounts.every((account) => !(store.loadCache(account.id).folders || []).length);
    if (!allEmpty) return;
    accounts = demoAccounts;
  } else {
    accounts = ACCOUNTS.map((item) =>
      store.addAccount({
        label: item.label,
        email: item.email,
        provider: item.provider,
        color: item.color,
        username: item.email,
        password: 'demo-password-not-real',
        imap: { host: 'demo.local', port: 993, secure: true },
        smtp: { host: 'demo.local', port: 465, secure: true }
      })
    );
  }

  const byAccount = new Map(accounts.map((account, index) => [index, { account, messages: [], unseen: 0 }]));

  for (const item of MESSAGES) {
    const bucket = byAccount.get(item.account);
    if (!bucket) continue;
    const date = new Date(Date.now() - item.hoursAgo * 3600 * 1000);
    const uid = 1000 + MESSAGES.indexOf(item);
    const attachmentIndex = item.hasAttachment ? 0 : -1;

    bucket.messages.push({
      uid,
      folder: 'INBOX',
      messageId: `demo-${uid}@mailhub.local`,
      subject: item.subject,
      fromName: item.from.name,
      fromAddress: item.from.address,
      to: [{ name: bucket.account.label, address: bucket.account.email }],
      cc: [],
      date: date.toISOString(),
      seen: !!item.seen,
      flagged: !!item.flagged,
      hasAttachments: !!item.hasAttachment,
      size: 4096,
      snippet: item.body.replace(/\s+/g, ' ').slice(0, 120)
    });
    if (!item.seen) bucket.unseen += 1;

    let attachments = [];
    if (item.hasAttachment) {
      const filePath = store.attachmentPath(bucket.account.id, 'INBOX', uid, 0, item.attachmentName);
      try {
        fs.mkdirSync(require('path').dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, '演示附件：本文件由 MailHub 演示数据生成。\n', 'utf8');
        attachments = [
          {
            index: 0,
            filename: item.attachmentName,
            contentType: 'application/pdf',
            size: 62,
            cid: ''
          }
        ];
      } catch {
        attachments = [];
      }
    }

    store.writeBody(bucket.account.id, 'INBOX', uid, {
      uid,
      folder: 'INBOX',
      subject: item.subject,
      fromName: item.from.name,
      fromAddress: item.from.address,
      to: [{ name: bucket.account.label, address: bucket.account.email }],
      cc: [],
      date: date.toISOString(),
      replyTo: item.from.address,
      text: item.body,
      html: `<div style="font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.7;color:#1f2937">${textToHtml(item.body)}</div>`,
      attachments,
      hasRemoteImages: false,
      remoteImagesAllowed: false,
      fetchedAt: Date.now(),
      accountEmail: bucket.account.email
    });
  }

  for (const [index, bucket] of byAccount) {
    const sent = SENT.filter((item) => item.account === index).map((item, pos) => {
      const date = new Date(Date.now() - item.hoursAgo * 3600 * 1000);
      return {
        uid: 5000 + pos,
        folder: 'Sent',
        messageId: `demo-sent-${pos}@mailhub.local`,
        subject: item.subject,
        fromName: bucket.account.label,
        fromAddress: bucket.account.email,
        to: item.to,
        cc: [],
        date: date.toISOString(),
        seen: true,
        flagged: false,
        hasAttachments: false,
        size: 2048,
        snippet: item.body.slice(0, 120)
      };
    });

    store.saveCache(bucket.account.id, {
      folders: [
        {
          path: 'INBOX',
          name: 'INBOX',
          label: '收件箱',
          specialUse: '\\Inbox',
          delimiter: '/',
          total: bucket.messages.length,
          unseen: bucket.unseen,
          messages: bucket.messages.sort((a, b) => new Date(b.date) - new Date(a.date))
        },
        {
          path: 'Sent',
          name: 'Sent',
          label: '已发送',
          specialUse: '\\Sent',
          delimiter: '/',
          total: sent.length,
          unseen: 0,
          messages: sent
        },
        {
          path: 'Drafts',
          name: 'Drafts',
          label: '草稿箱',
          specialUse: '\\Drafts',
          delimiter: '/',
          total: 0,
          unseen: 0,
          messages: []
        },
        {
          path: 'Trash',
          name: 'Trash',
          label: '已删除',
          specialUse: '\\Trash',
          delimiter: '/',
          total: 0,
          unseen: 0,
          messages: []
        }
      ]
    });
    store.markSynced(bucket.account.id, null);
  }
}

module.exports = { seedDemoData };