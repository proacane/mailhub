'use strict';

/**
 * 常见邮箱服务商的 IMAP / SMTP 预设。
 * 国内邮箱（QQ/163/126）用「授权码」当密码；Gmail 用「应用专用密码」；
 * Outlook 已关闭基础密码认证，需要 OAuth2，这里只给出明确提示。
 */
const PRESETS = {
  qq: {
    id: 'qq',
    label: 'QQ 邮箱',
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true },
    hint: '先在 QQ 邮箱「设置 → 账号 → POP3/IMAP/SMTP 服务」开启 IMAP，再用页面生成的「授权码」作为密码（不是 QQ 密码）。',
    passwordLabel: '授权码'
  },
  '163': {
    id: '163',
    label: '网易 163 邮箱',
    imap: { host: 'imap.163.com', port: 993, secure: true },
    smtp: { host: 'smtp.163.com', port: 465, secure: true },
    hint: '在网易邮箱「设置 → POP3/SMTP/IMAP」开启 IMAP 服务，并使用「客户端授权密码」。',
    passwordLabel: '授权码'
  },
  '126': {
    id: '126',
    label: '网易 126 邮箱',
    imap: { host: 'imap.126.com', port: 993, secure: true },
    smtp: { host: 'smtp.126.com', port: 465, secure: true },
    hint: '在网易邮箱「设置 → POP3/SMTP/IMAP」开启 IMAP 服务，并使用「客户端授权密码」。',
    passwordLabel: '授权码'
  },
  gmail: {
    id: 'gmail',
    label: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    hint: '需要先开启两步验证，然后在 Google 账号「安全性 → 应用专用密码」生成 16 位密码，填在这里。',
    passwordLabel: '应用专用密码'
  },
  outlook: {
    id: 'outlook',
    label: 'Outlook / Hotmail',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    hint: '微软已全面关闭 Outlook 的 IMAP/SMTP 基础密码登录，必须使用 OAuth2 授权。当前版本暂未接入 OAuth2，建议改用 Gmail 或国内邮箱。',
    passwordLabel: '密码',
    requiresOAuth: true
  },
  custom: {
    id: 'custom',
    label: '其他 / 企业邮箱',
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
    hint: '请自行填写邮件服务商提供的 IMAP / SMTP 服务器地址与端口。',
    passwordLabel: '密码 / 授权码'
  }
};

const DOMAIN_RULES = [
  { test: /@(qq|foxmail)\.com$/i, preset: 'qq' },
  { test: /@163\.com$/i, preset: '163' },
  { test: /@126\.com$/i, preset: '126' },
  { test: /@(gmail|googlemail)\.com$/i, preset: 'gmail' },
  { test: /@(outlook|hotmail|live|msn)\.(com|cn)$/i, preset: 'outlook' }
];

function presetById(id) {
  return PRESETS[id] || PRESETS.custom;
}

function detectPreset(email) {
  const value = String(email || '').trim().toLowerCase();
  for (const rule of DOMAIN_RULES) {
    if (rule.test.test(value)) return PRESETS[rule.preset];
  }
  return PRESETS.custom;
}

function allPresets() {
  return Object.values(PRESETS).map((p) => ({
    id: p.id,
    label: p.label,
    hint: p.hint,
    passwordLabel: p.passwordLabel,
    requiresOAuth: !!p.requiresOAuth,
    imap: p.imap,
    smtp: p.smtp
  }));
}

module.exports = { PRESETS, presetById, detectPreset, allPresets };