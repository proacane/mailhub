const api = window.mailhub;

const state = {
  accounts: [],
  caches: {},
  settings: {},
  presets: [],
  encryptionAvailable: true,
  version: '',
  dataDir: '',
  view: { type: 'all', accountId: null, folder: 'INBOX' },
  selectedKey: null,
  search: '',
  filter: 'all',
  bodies: new Map(),
  loadingBody: null,
  syncing: false,
  compose: { mode: 'new', accountId: null, attachments: [], replyMessage: null },
  editingAccountId: null,
  notificationsSupported: false,
  packaged: false,
  theme: 'light'
};

const $ = (id) => document.getElementById(id);

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);

const DOMAIN_PRESETS = [
  [/@(qq|foxmail)\.com$/i, 'qq'],
  [/@163\.com$/i, '163'],
  [/@126\.com$/i, '126'],
  [/@(gmail|googlemail)\.com$/i, 'gmail'],
  [/@(outlook|hotmail|live|msn)\.(com|cn)$/i, 'outlook']
];

/* ---------------- 基础工具 ---------------- */

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatListTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';

  const diffDays = Math.floor((now - date) / 86400000);
  if (diffDays >= 0 && diffDays < 7) {
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
  }
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

function formatFullDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${weekday} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (!value) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function initialOf(name, address) {
  const text = String(name || address || '?').trim();
  if (!text) return '?';
  const chars = [...text];
  return (chars[0] || '?').toUpperCase();
}

// 发件人头像：按地址散列到一组低饱和的墨色，深浅主题下都能压住白字
const AVATAR_COLORS = [
  '#0f6b5b',
  '#265f8c',
  '#6a4a8f',
  '#9a5230',
  '#6f651f',
  '#276c66',
  '#8b3a58',
  '#3f6a33',
  '#5a5f9c',
  '#8a4b1f'
];

function avatarColor(seed) {
  const text = String(seed || '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 100000;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function avatarMarkup(name, address, className = 'avatar') {
  const seed = address || name || '';
  return `<span class="${className}" style="--avatar:${avatarColor(seed)}" aria-hidden="true">${esc(initialOf(name, address))}</span>`;
}

/** 应用内确认弹窗，替代原生 window.confirm */
function confirmDialog({ title = '确认操作', message = '', confirmText = '确定', cancelText = '取消', danger = false } = {}) {
  const backdrop = $('confirm-modal');
  const okButton = $('confirm-ok');
  const cancelButton = $('confirm-cancel');
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  okButton.textContent = confirmText;
  cancelButton.textContent = cancelText;
  okButton.classList.toggle('danger-btn', Boolean(danger));
  backdrop.hidden = false;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      backdrop.hidden = true;
      okButton.removeEventListener('click', onOk);
      cancelButton.removeEventListener('click', onCancel);
      $('confirm-x').removeEventListener('click', onCancel);
      backdrop.removeEventListener('mousedown', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (event) => {
      if (event.target === backdrop) finish(false);
    };
    const onKey = (event) => {
      if (event.key !== 'Escape' && event.key !== 'Enter') return;
      // 捕获阶段截住，避免同时触发全局 Esc 关弹窗的逻辑
      event.preventDefault();
      event.stopPropagation();
      finish(event.key === 'Enter');
    };
    okButton.addEventListener('click', onOk);
    cancelButton.addEventListener('click', onCancel);
    $('confirm-x').addEventListener('click', onCancel);
    backdrop.addEventListener('mousedown', onBackdrop);
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => (danger ? cancelButton : okButton).focus(), 30);
  });
}

function toast(message, kind = 'info') {
  const host = $('toast-host');
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s ease, transform .25s ease';
    node.style.opacity = '0';
    node.style.transform = 'translateY(4px)';
    setTimeout(() => node.remove(), 260);
  }, kind === 'error' ? 6200 : 3600);
}

function accountById(id) {
  return state.accounts.find((account) => account.id === id) || null;
}

function foldersOf(accountId) {
  return state.caches[accountId]?.folders || [];
}

function inboxFolder(accountId) {
  const folders = foldersOf(accountId);
  return folders.find((folder) => folder.specialUse === '\\Inbox') || folders.find((folder) => /inbox|收件箱/i.test(folder.label)) || folders[0] || null;
}

function unreadOf(accountId) {
  const folder = inboxFolder(accountId);
  if (folder) return folder.unseen || 0;
  return foldersOf(accountId).reduce((sum, item) => sum + (item.unseen || 0), 0);
}

function totalUnread() {
  return state.accounts.reduce((sum, account) => sum + unreadOf(account.id), 0);
}

function currentAccount() {
  return state.view.type === 'account' ? accountById(state.view.accountId) : null;
}

function currentFolder() {
  const account = currentAccount();
  if (!account) return null;
  return foldersOf(account.id).find((folder) => folder.path === state.view.folder) || null;
}

/* ---------------- 回信对象 ---------------- */

function isSentFolder(folder) {
  if (!folder) return false;
  return folder.specialUse === '\\Sent' || /已发送|(^|[^a-z])sent([^a-z]|$)/i.test(`${folder.label || ''} ${folder.path || ''}`);
}

function addressList(items) {
  return (items || [])
    .map((item) => (typeof item === 'string' ? item : item?.address))
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

/**
 * 算出这封邮件该回给谁：
 * - 收件箱：回给发件人；回复全部再加上原收件人和抄送
 * - 已发送：发件人是自己，所以回给原收件人（含抄送），否则会变成写给自己
 */
function replyRecipients(message, folder, account, mode = 'reply') {
  const sent = isSentFolder(folder);
  const own = new Set(
    [account?.email, account?.username]
      .filter(Boolean)
      .map((item) => String(item).toLowerCase())
  );
  const clean = (list) =>
    list.filter((address, index) => {
      const lower = address.toLowerCase();
      return list.indexOf(address) === index && !own.has(lower);
    });

  if (sent) {
    return { to: clean(addressList(message.to)), cc: clean(addressList(message.cc)), sent: true };
  }

  const to = [message.fromAddress].filter(Boolean);
  if (mode !== 'reply-all') return { to: clean(to), cc: [], sent: false };

  const cc = [...addressList(message.to), ...addressList(message.cc)];
  return { to: clean(to), cc: clean(cc), sent: false };
}

/* ---------------- 数据选择 ---------------- */

function collectMessages() {
  const items = [];
  if (state.view.type === 'all') {
    for (const account of state.accounts) {
      const folder = inboxFolder(account.id);
      for (const message of folder?.messages || []) {
        items.push({ ...message, accountId: account.id, account, folderPath: folder.path });
      }
    }
  } else {
    const account = currentAccount();
    const folder = currentFolder();
    if (account && folder) {
      for (const message of folder.messages || []) {
        items.push({ ...message, accountId: account.id, account, folderPath: folder.path });
      }
    }
  }

  const keyword = state.search.trim().toLowerCase();
  return items
    .filter((message) => {
      if (state.filter === 'unread' && message.seen) return false;
      if (state.filter === 'flagged' && !message.flagged) return false;
      if (state.filter === 'attachment' && !message.hasAttachments) return false;
      if (!keyword) return true;
      const haystack = [
        message.subject,
        message.fromName,
        message.fromAddress,
        message.snippet,
        ...(message.to || []).map((item) => `${item.name} ${item.address}`)
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(keyword);
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

/* ---------------- 侧栏 ---------------- */

function renderSidebar() {
  const unread = totalUnread();
  const badgeAll = $('badge-all');
  badgeAll.textContent = unread > 99 ? '99+' : String(unread);
  badgeAll.hidden = unread === 0;

  $('nav-all').classList.toggle('active', state.view.type === 'all');

  const list = $('account-list');
  if (!state.accounts.length) {
    list.innerHTML = '<div class="rail-empty" title="还没有邮箱">·</div>';
    return;
  }

  list.innerHTML = state.accounts
    .map((account) => {
      const unreadCount = unreadOf(account.id);
      const active = state.view.type === 'account' && state.view.accountId === account.id;
      const statusClass = account.syncError ? 'error' : account.provider === 'demo' ? 'idle' : '';
      return `
        <button class="account-item ${active ? 'active' : ''}" data-account="${esc(account.id)}" title="${esc(account.label)} · ${esc(account.email)}">
          <span class="account-avatar" style="background:${esc(account.color || avatarColor(account.email))}">
            ${esc(initialOf(account.label, account.email))}
            <span class="status-dot ${statusClass}" title="${account.syncError ? esc(account.syncError) : '已连接'}"></span>
          </span>
          ${unreadCount ? `<span class="badge">${unreadCount > 99 ? '99+' : unreadCount}</span>` : ''}
        </button>`;
    })
    .join('');
}

/* ---------------- 台账面板 ---------------- */

const FOLDER_ORDER = ['\\Inbox', '\\Sent', '\\Drafts', '\\Junk', '\\Trash', '\\Archive'];

function sortedFolders(accountId) {
  return foldersOf(accountId)
    .filter((folder) => folder.path && !/^\[?Gmail\]?$/i.test(folder.path))
    .slice()
    .sort((a, b) => {
      const rank = (folder) => {
        const index = FOLDER_ORDER.indexOf(folder.specialUse || '');
        return index === -1 ? FOLDER_ORDER.length : index;
      };
      return rank(a) - rank(b) || String(a.label).localeCompare(String(b.label), 'zh-CN');
    });
}

function renderPanel() {
  const title = $('panel-title');
  const sub = $('panel-sub');
  const body = $('panel-body');
  if (!title || !body) return;

  if (state.view.type === 'all') {
    const total = collectMessages().length;
    title.textContent = '统一收件箱';
    sub.textContent = `${state.accounts.length} 个邮箱 · ${totalUnread()} 封未读`;
    body.innerHTML = state.accounts.length
      ? state.accounts
          .map((account) => {
            const count = unreadOf(account.id);
            return `
        <button class="panel-row" data-account-jump="${esc(account.id)}">
          <span class="panel-dot" style="background:${esc(account.color || avatarColor(account.email))}"></span>
          <span class="panel-label">${esc(account.label)}</span>
          <span class="panel-count">${count || ''}</span>
        </button>`;
          })
          .join('')
      : '<p class="panel-empty">还没有邮箱。点左下角的「＋」开始添加。</p>';
    return;
  }

  const account = currentAccount();
  if (!account) return;
  title.textContent = account.label;
  sub.textContent = account.email;
  const folders = sortedFolders(account.id);
  body.innerHTML = folders.length
    ? folders
        .map(
          (folder) => `
        <button class="panel-row ${folder.path === state.view.folder ? 'active' : ''}" data-folder="${esc(folder.path)}" title="${esc(folder.path)}">
          <span class="panel-label">${esc(folder.label || folder.path)}</span>
          ${folder.unseen ? `<span class="panel-count">${folder.unseen > 99 ? '99+' : folder.unseen}</span>` : ''}
        </button>`
        )
        .join('')
    : '<p class="panel-empty">这个邮箱还没有同步到文件夹。</p>';
}

/* ---------------- 列表头部 ---------------- */

function renderHeader() {
  const account = currentAccount();
  const folder = currentFolder();
  const markAllButton = $('btn-mark-all-read');
  if (markAllButton) markAllButton.hidden = state.view.type !== 'account' || !folder;

  const editButton = $('btn-edit-account');
  if (editButton) {
    editButton.hidden = !account;
    if (account) editButton.dataset.edit = account.id;
  }

  const scope = $('list-scope');
  if (scope) scope.textContent = state.view.type === 'all' ? '统一收件箱' : folder?.label || '收件箱';

  $('list-progress').textContent = state.syncing ? '同步中…' : '';
  renderTitlebar();
  renderPanel();
}

/* ---------------- 标题栏 ---------------- */

function renderTitlebar() {
  const view = $('titlebar-view');
  if (!view) return;
  if (state.view.type === 'all') {
    view.textContent = '统一收件箱';
    return;
  }
  const account = currentAccount();
  const folder = currentFolder();
  view.textContent = [account?.label, folder?.label].filter(Boolean).join(' · ') || '邮箱';
}

// 原生窗口按钮浮在网页右上角，用它的实际宽度给标题栏留位，避免按钮挡住内容
function syncTitlebarControlsWidth() {
  const overlay = navigator.windowControlsOverlay;
  if (!overlay) return;
  const apply = () => {
    try {
      const rect = overlay.getTitlebarAreaRect();
      const controls = Math.max(0, window.innerWidth - rect.width - rect.x);
      document.documentElement.style.setProperty('--titlebar-controls', `${Math.round(controls) + 8}px`);
    } catch {
      /* 拿不到就保持 CSS 默认值 */
    }
  };
  apply();
  overlay.addEventListener?.('geometrychange', apply);
  window.addEventListener('resize', apply);
}

/* ---------------- 列表 ---------------- */

function renderList() {
  const messages = collectMessages();
  const container = $('message-list');
  const empty = $('list-empty');

  $('list-count').textContent = `${messages.length} 封邮件`;

  if (!messages.length) {
    container.innerHTML = '';
    empty.hidden = false;
    let title = '这里还没有邮件';
    let text = '点击左上角「写邮件」开始，或者点「立即同步」拉取最新邮件。';
    if (!state.accounts.length) {
      title = '先添加一个邮箱';
      text = '支持 QQ、163、126、Gmail 等，添加后所有邮箱会聚合到统一收件箱。';
    } else if (state.search) {
      title = '没有匹配的邮件';
      text = `没有找到包含「${state.search}」的邮件，试试换个关键词。`;
    } else if (state.filter !== 'all') {
      title = '没有符合条件的邮件';
      text = '切换上方的筛选条件看看。';
    }
    empty.innerHTML = `
      <div class="glyph">✉</div>
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
      ${!state.accounts.length ? '<button class="primary-btn" id="empty-add">添加邮箱</button>' : ''}`;
    $('empty-add')?.addEventListener('click', () => openAccountModal());
    return;
  }

  empty.hidden = true;

  container.innerHTML = messages
    .map((message) => {
      const key = `${message.accountId}|${message.folderPath}|${message.uid}`;
      const selected = state.selectedKey === key;
      const showAccount = state.view.type === 'all';
      const sender = message.fromName || message.fromAddress || '未知发件人';
      return `
        <div class="msg-item ${message.seen ? '' : 'unread'} ${selected ? 'selected' : ''}"
             data-key="${esc(key)}" data-account="${esc(message.accountId)}"
             data-folder="${esc(message.folderPath)}" data-uid="${esc(message.uid)}" role="button" tabindex="0"
             title="${esc(sender)}${message.subject ? ` · ${esc(message.subject)}` : ''}">
          ${avatarMarkup(message.fromName, message.fromAddress, 'msg-avatar')}
          <div class="msg-main">
            <div class="msg-top">
              <span class="msg-from">${esc(sender)}</span>
              <span class="msg-time">${esc(formatListTime(message.date))}</span>
            </div>
            <div class="msg-subject">${esc(message.subject || '（无主题）')}</div>
            <div class="msg-snippet">${esc(message.snippet || '')}</div>
            <div class="msg-flags">
              ${showAccount ? `<span class="msg-tag"><span class="dot" style="background:${esc(message.account?.color || '#0f6b5b')}"></span>${esc(message.account?.label || '')}</span>` : ''}
              ${message.hasAttachments ? '<span class="clip-mark" title="含附件">📎</span>' : ''}
              ${message.flagged ? '<span class="star-mark" title="已加星标">★</span>' : ''}
            </div>
          </div>
          ${message.seen ? '' : '<span class="msg-unread-dot" aria-label="未读"></span>'}
        </div>`;
    })
    .join('');
}

/* ---------------- 阅读区 ---------------- */

function readingEmpty() {
  if (!state.accounts.length) {
    return `
      <div class="reader-empty">
        <div class="glyph">✉</div>
        <h3>把多个邮箱装进一个窗口</h3>
        <p>添加 QQ、163、126、Gmail 等邮箱后，所有未读邮件会集中显示在左侧统一收件箱里，点开即可阅读和回复。</p>
        <button class="primary-btn" id="reader-add">添加第一个邮箱</button>
      </div>`;
  }
  return `
    <div class="reader-empty">
      <div class="glyph">◫</div>
      <h3>选择一封邮件开始阅读</h3>
      <p>左侧列表点击任意邮件，这里会显示正文、附件和快捷操作。</p>
    </div>`;
}

function attachReaderEmptyHandlers() {
  $('reader-add')?.addEventListener('click', () => openAccountModal());
}

function renderReading() {
  const pane = $('reading-pane');
  if (!state.selectedKey) {
    pane.innerHTML = readingEmpty();
    attachReaderEmptyHandlers();
    return;
  }

  const [accountId, folderPath, uidText] = state.selectedKey.split('|');
  const uid = Number(uidText);
  const account = accountById(accountId);
  const folder = foldersOf(accountId).find((item) => item.path === folderPath);
  const message = (folder?.messages || []).find((item) => item.uid === uid);

  if (!message || !account) {
    state.selectedKey = null;
    renderReading();
    return;
  }

  const key = state.selectedKey;
  const body = state.bodies.get(key);
  const loading = state.loadingBody === key;
  const color = avatarColor(message.fromAddress || message.fromName || account.email);
  const remoteBlocked = body && body.hasRemoteImages && !body.remoteImagesAllowed && !state.settings.showRemoteImages;
  // 已发送里「回复」要发给原收件人；收件箱里还能再加一个「回复全部」
  const sentFolder = isSentFolder(folder);
  const replyTargets = replyRecipients(message, folder, account, 'reply');
  const replyAllTargets = replyRecipients(message, folder, account, 'reply-all');
  const canReplyAll = (replyAllTargets.to.length + replyAllTargets.cc.length) > (replyTargets.to.length + replyTargets.cc.length)
    || replyTargets.to.length > 1
    || replyTargets.cc.length > 0;

  pane.innerHTML = `
    <div class="reader-toolbar">
      <button class="tool-btn" data-action="reply">↩ ${sentFolder ? '回复收件人' : '回复'}</button>
      ${canReplyAll ? `<button class="tool-btn" data-action="reply-all">↩↩ 回复全部</button>` : ''}
      <button class="tool-btn" data-action="forward">↪ 转发</button>
      <button class="tool-btn" data-action="flag">${message.flagged ? '★ 取消星标' : '☆ 加星标'}</button>
      <button class="tool-btn" data-action="unread">${message.seen ? '● 标为未读' : '✓ 标为已读'}</button>
      <span class="toolbar-spacer"></span>
      ${account.provider === 'demo' ? '<span class="sync-hint">演示邮件</span>' : ''}
      <button class="tool-btn danger" data-action="delete">🗑 删除</button>
    </div>
    <div class="reader-head">
      <h1 class="reader-subject">${esc(message.subject || '（无主题）')}</h1>
      <button type="button" class="reader-sender" data-action="compose-sender" title="给 ${esc(message.fromName || message.fromAddress || '发件人')} 写邮件">
        <div class="reader-avatar" style="background:${esc(color)}">${esc(initialOf(message.fromName, message.fromAddress))}</div>
        <div class="reader-sender-meta">
          <div class="reader-sender-line">
            <span class="reader-sender-name">${esc(message.fromName || message.fromAddress || '未知发件人')}</span>
            <span class="reader-sender-address">${esc(message.fromAddress || '')}</span>
            <span class="reader-sender-hint">✉ 写信</span>
          </div>
        </div>
        <span class="reader-date">${esc(formatFullDate(message.date))}</span>
      </button>
      <div class="reader-recipients">
        <span class="reader-account">收件于 ${esc(account.label)} · ${esc(account.email)}</span>
        ${message.to?.length ? `<span><b>收件人：</b>${esc(message.to.map((item) => item.name || item.address).join('，'))}</span>` : ''}
        ${message.cc?.length ? `<span><b>抄送：</b>${esc(message.cc.map((item) => item.name || item.address).join('，'))}</span>` : ''}
      </div>
    </div>
    ${
      body && body.attachments?.length
        ? `<div class="reader-attachments">
             <div class="attachment-title">附件（${body.attachments.length}）</div>
             ${body.attachments
               .map(
                 (attachment) => `
               <div class="attachment-item">
                 <div class="attachment-icon">📎</div>
                 <div class="attachment-name" title="${esc(attachment.filename)}">${esc(attachment.filename)}</div>
                 <div class="attachment-size">${esc(formatSize(attachment.size))}</div>
                 <div class="attachment-actions">
                   <button class="ghost-btn small" data-attachment-open="${attachment.index}">打开</button>
                   <button class="ghost-btn small" data-attachment-save="${attachment.index}">保存</button>
                 </div>
               </div>`
               )
               .join('')}
           </div>`
        : ''
    }
    <div class="reader-body" id="reader-body">
      ${
        loading
          ? '<div class="sync-hint" style="padding:20px 0">正在加载正文…</div>'
          : body
            ? `${remoteBlocked ? '<div class="remote-image-bar"><span>为防止追踪，邮件中的外部图片已被屏蔽。</span><button data-action="allow-images">显示图片</button></div>' : ''}
               ${body.html ? `<iframe id="mail-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcdoc="${esc(buildEmailDocument(body))}"></iframe>` : `<pre>${esc(body.text || '（这封邮件没有可显示的正文）')}</pre>`}`
            : '<div class="sync-hint" style="padding:20px 0">点击「回复」或重新打开邮件以加载正文。</div>'
      }
    </div>`;

  // 正文 iframe 自适应高度：图片加载完 / 内容变化后重新测量，并把滚轮、翻页键交给外层阅读区
  const frame = $('mail-frame');
  if (frame) {
    const fit = () => {
      try {
        const doc = frame.contentDocument;
        if (!doc || !doc.body) return;
        const height = Math.max(doc.body.scrollHeight || 0, doc.documentElement?.scrollHeight || 0, 240);
        frame.style.height = `${height + 16}px`;
      } catch {
        frame.style.height = '520px';
      }
    };

    const bindFrame = () => {
      let doc = null;
      try {
        doc = frame.contentDocument;
      } catch {
        doc = null;
      }
      if (doc && doc.documentElement?.dataset.dark === '1') {
        try {
          applyDarkEmail(doc);
        } catch {
          /* 个别邮件结构异常时保持原样 */
        }
      }
      fit();
      if (!doc || !doc.body) {
        setTimeout(fit, 200);
        return;
      }

      const refit = () => requestAnimationFrame(fit);

      // 邮件里的图片通常没写死尺寸，加载完高度会变，需要再量一次
      doc.querySelectorAll('img').forEach((img) => {
        if (!img.complete) img.addEventListener('load', refit, { once: true });
      });
      try {
        const observer = new ResizeObserver(refit);
        observer.observe(doc.body);
        if (doc.documentElement) observer.observe(doc.documentElement);
      } catch {
        /* 老内核没有 ResizeObserver，靠 load/setTimeout 兜底 */
      }

      // 关键：鼠标停在正文上滚动时，事件会被 iframe 吃掉，外层阅读区不动
      doc.addEventListener(
        'wheel',
        (event) => {
          if (event.ctrlKey) return;
          const atTop = pane.scrollTop <= 0 && event.deltaY < 0;
          const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2 && event.deltaY > 0;
          if (atTop || atBottom) return;
          pane.scrollTop += event.deltaY;
          event.preventDefault();
        },
        { passive: false }
      );

      // 键盘翻页同理（正文 iframe 获得焦点时）
      const scrollKeys = new Set([' ', 'PageDown', 'PageUp', 'Home', 'End', 'ArrowDown', 'ArrowUp']);
      doc.addEventListener('keydown', (event) => {
        if (!scrollKeys.has(event.key) || event.ctrlKey || event.altKey || event.metaKey) return;
        const tag = (event.target?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        const page = pane.clientHeight * 0.9;
        if (event.key === ' ' || event.key === 'PageDown') pane.scrollTop += page;
        else if (event.key === 'PageUp') pane.scrollTop -= page;
        else if (event.key === 'Home') pane.scrollTop = 0;
        else if (event.key === 'End') pane.scrollTop = pane.scrollHeight;
        else if (event.key === 'ArrowDown') pane.scrollTop += 60;
        else if (event.key === 'ArrowUp') pane.scrollTop -= 60;
        else return;
        event.preventDefault();
      });

      setTimeout(fit, 60);
      setTimeout(fit, 400);
    };

    frame.addEventListener('load', bindFrame);
    setTimeout(bindFrame, 120);
  }

  pane.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => handleReaderAction(button.dataset.action, message, account));
  });
  pane.querySelectorAll('[data-attachment-open]').forEach((button) => {
    button.addEventListener('click', () => saveOrOpenAttachment('open', accountId, folderPath, uid, Number(button.dataset.attachmentOpen)));
  });
  pane.querySelectorAll('[data-attachment-save]').forEach((button) => {
    button.addEventListener('click', () => saveOrOpenAttachment('save', accountId, folderPath, uid, Number(button.dataset.attachmentSave)));
  });
}

const themeQuery = window.matchMedia('(prefers-color-scheme: dark)');

function themePreference() {
  const value = state.settings.theme;
  return value === 'light' || value === 'dark' ? value : 'system';
}

function resolvedTheme() {
  const preference = themePreference();
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return 'light';
  return themeQuery.matches ? 'dark' : 'light';
}

function applyTheme({ rerender = false } = {}) {
  const theme = resolvedTheme();
  const changed = state.theme !== theme;
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  if (rerender && changed) renderReading();
}

function buildEmailDocument(body) {
  const allowRemote = body.remoteImagesAllowed || state.settings.showRemoteImages;
  const imgSources = allowRemote ? "'self' data: http: https: cid:" : "'self' data: cid:";
  const csp = `default-src 'none'; img-src ${imgSources}; style-src 'unsafe-inline'; font-src data:;`;
  // 深色模式下正文也切到深色纸张，具体元素的配色再由 applyDarkEmail 智能映射
  const dark = state.theme === 'dark' && state.settings.darkMailBody !== false;
  const paper = dark ? '#141a17' : '#ffffff';
  const ink = dark ? '#dfe6e1' : '#17201c';
  const link = dark ? '#6cc9b9' : '#0e6b5b';
  const quoteBorder = dark ? '#2b3531' : '#dcded7';
  const quoteText = dark ? '#9aa6a0' : '#5b6272';
  const style = `
    html,body{margin:0;padding:0;background:${paper};color:${ink};
      font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.75;
      word-break:break-word;overflow-x:hidden;color-scheme:${dark ? 'dark' : 'light'}}
    img{max-width:100%;height:auto}
    table{max-width:100%;border-collapse:collapse}
    a{color:${link}}
    blockquote{margin:0 0 0 6px;padding-left:12px;border-left:3px solid ${quoteBorder};color:${quoteText}}
    pre{white-space:pre-wrap}
  `;
  return `<!doctype html><html data-dark="${dark ? '1' : '0'}"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <base target="_blank">
    <style>${style}</style></head><body>${body.html || `<pre>${esc(body.text || '')}</pre>`}</body></html>`;
}

/* 深浅色映射：把邮件自带的浅色底压暗、深色字提亮，尽量保留原本的色相和层级关系 */

function parseColor(value) {
  const match = String(value || '').match(/^rgba?\(([^)]+)\)$/i);
  if (!match) return null;
  const parts = match[1].split(',').map((part) => Number.parseFloat(part));
  if (parts.length < 3 || parts.slice(0, 3).some((item) => Number.isNaN(item))) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

function relativeLuminance({ r, g, b }) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function rgbToHsl({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (delta) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, s, l];
}

function darkSurface(color) {
  const [h, s] = rgbToHsl(color);
  return `hsl(${Math.round(h * 360)} ${Math.round(Math.min(s, 0.4) * 100)}% 13%)`;
}

function applyDarkEmail(doc) {
  if (!doc || !doc.body) return;
  const root = doc.documentElement;
  if (!root || root.dataset.mailhubDark === 'done') return;
  root.dataset.mailhubDark = 'done';
  const view = doc.defaultView;
  if (!view) return;

  const nodes = [root, doc.body, ...doc.body.querySelectorAll('*')];
  for (const node of nodes) {
    const tag = node.tagName;
    if (tag === 'IMG' || tag === 'VIDEO' || tag === 'IFRAME' || tag === 'SVG' || tag === 'CANVAS') continue;
    if (typeof node.closest === 'function' && node.closest('svg')) continue;

    let computed;
    try {
      computed = view.getComputedStyle(node);
    } catch {
      continue;
    }

    const background = parseColor(computed.backgroundColor);
    if (background && background.a > 0.4 && relativeLuminance(background) > 0.55) {
      node.style.setProperty('background-color', darkSurface(background), 'important');
    }

    const foreground = parseColor(computed.color);
    if (foreground && foreground.a > 0.35) {
      const luminance = relativeLuminance(foreground);
      if (luminance < 0.18) node.style.setProperty('color', '#e2e9e4', 'important');
      else if (luminance < 0.45) node.style.setProperty('color', '#bcc7c1', 'important');
    }

    const border = parseColor(computed.borderTopColor);
    if (
      border &&
      computed.borderTopStyle !== 'none' &&
      Number.parseFloat(computed.borderTopWidth) > 0 &&
      relativeLuminance(border) > 0.6
    ) {
      node.style.setProperty('border-color', '#2a3430', 'important');
    }
  }

  doc.querySelectorAll('a').forEach((link) => {
    const color = parseColor(view.getComputedStyle(link).color);
    if (color && relativeLuminance(color) < 0.35) link.style.setProperty('color', '#6cc9b9', 'important');
  });
  doc.querySelectorAll('hr').forEach((hr) => hr.style.setProperty('border-color', '#2a3430', 'important'));
}

/* ---------------- 邮件操作 ---------------- */

async function selectMessage(accountId, folderPath, uid) {
  const key = `${accountId}|${folderPath}|${uid}`;
  state.selectedKey = key;
  state.loadingBody = state.bodies.has(key) ? null : key;
  renderList();
  renderReading();

  if (state.bodies.has(key)) {
    state.loadingBody = null;
    return;
  }

  const result = await api.openMessage(accountId, folderPath, uid);
  state.loadingBody = null;
  if (state.selectedKey !== key) return;

  if (!result.ok) {
    renderReading();
    toast(`加载邮件失败：${result.error}`, 'error');
    return;
  }

  state.bodies.set(key, result.data);
  const message = findMessage(accountId, folderPath, uid);
  if (message && !message.seen) {
    message.seen = true;
    const folder = foldersOf(accountId).find((item) => item.path === folderPath);
    if (folder) folder.unseen = Math.max(0, (folder.unseen || 0) - 1);
    if (accountById(accountId)?.provider !== 'demo') {
      api.setFlags(accountId, folderPath, uid, { seen: true }).catch(() => {});
    }
    renderSidebar();
    renderHeader();
    renderList();
  }
  renderReading();
}

function findMessage(accountId, folderPath, uid) {
  const folder = foldersOf(accountId).find((item) => item.path === folderPath);
  return (folder?.messages || []).find((item) => item.uid === Number(uid)) || null;
}

async function handleReaderAction(action, message, account) {
  const [accountId, folderPath] = state.selectedKey.split('|');
  const uid = Number(message.uid);
  const key = state.selectedKey;

  if (action === 'reply' || action === 'reply-all') {
    const body = state.bodies.get(key);
    const folder = foldersOf(accountId).find((item) => item.path === folderPath);
    const recipients = replyRecipients(message, folder, account, action);
    openCompose({ mode: 'reply', message, account, body, recipients });
    return;
  }
  if (action === 'compose-sender') {
    if (!message.fromAddress) {
      toast('这封邮件没有发件人地址，无法直接写信', 'error');
      return;
    }
    openCompose({ mode: 'direct', account, to: message.fromAddress, toName: message.fromName });
    return;
  }
  if (action === 'forward') {
    const body = state.bodies.get(key);
    openCompose({ mode: 'forward', message, account, body });
    return;
  }
  if (action === 'allow-images') {
    const body = state.bodies.get(key);
    if (body) body.remoteImagesAllowed = true;
    renderReading();
    return;
  }
  if (action === 'flag') {
    const next = !message.flagged;
    if (account.provider === 'demo') {
      message.flagged = next;
      renderList();
      renderReading();
      return;
    }
    const result = await api.setFlags(accountId, folderPath, uid, { flagged: next });
    if (!result.ok) {
      toast(`操作失败：${result.error}`, 'error');
      return;
    }
    message.flagged = next;
    renderList();
    renderReading();
    return;
  }
  if (action === 'unread') {
    const nextSeen = !message.seen;
    if (account.provider !== 'demo') {
      const result = await api.setFlags(accountId, folderPath, uid, { seen: nextSeen });
      if (!result.ok) {
        toast(`操作失败：${result.error}`, 'error');
        return;
      }
    }
    message.seen = nextSeen;
    const folder = foldersOf(accountId).find((item) => item.path === folderPath);
    if (folder) folder.unseen = Math.max(0, (folder.unseen || 0) + (nextSeen ? -1 : 1));
    renderSidebar();
    renderHeader();
    renderList();
    renderReading();
    return;
  }
  if (action === 'delete') {
    const okToDelete = await confirmDialog({
      title: '删除邮件',
      message: '这封邮件会被移动到「已删除」。如果服务器没有回收站，将直接彻底删除。',
      confirmText: '移到已删除',
      danger: true
    });
    if (!okToDelete) return;
    if (account.provider === 'demo') {
      const folder = foldersOf(accountId).find((item) => item.path === folderPath);
      if (folder) {
        folder.messages = (folder.messages || []).filter((item) => item.uid !== uid);
        folder.total = Math.max(0, (folder.total || 1) - 1);
        if (!message.seen) folder.unseen = Math.max(0, (folder.unseen || 0) - 1);
      }
      state.selectedKey = null;
      state.bodies.delete(key);
      renderAll();
      toast('演示邮件已移除', 'success');
      return;
    }
    const result = await api.deleteMessage(accountId, folderPath, uid);
    if (!result.ok) {
      toast(`删除失败：${result.error}`, 'error');
      return;
    }
    state.selectedKey = null;
    state.bodies.delete(key);
    await refreshCache(accountId);
    renderAll();
    toast('已移到「已删除」文件夹', 'success');
  }
}

async function saveOrOpenAttachment(mode, accountId, folderPath, uid, index) {
  const result = mode === 'save'
    ? await api.saveAttachment(accountId, folderPath, uid, index)
    : await api.openAttachment(accountId, folderPath, uid, index);
  if (!result.ok) {
    toast(`附件操作失败：${result.error}`, 'error');
    return;
  }
  if (mode === 'save' && result.data?.path) toast(`已保存到 ${result.data.path}`, 'success');
}

/* ---------------- 同步 ---------------- */

async function refreshCache(accountId) {
  const boot = await api.boot();
  if (!boot.ok) return;
  state.accounts = boot.data.accounts;
  state.caches[accountId] = boot.data.caches[accountId];
  if (state.view.type === 'account' && state.view.accountId === accountId) {
    const folders = foldersOf(accountId);
    if (!folders.some((item) => item.path === state.view.folder)) {
      state.view.folder = inboxFolder(accountId)?.path || 'INBOX';
    }
  }
}

async function syncAccount(accountId, options = {}) {
  const account = accountById(accountId);
  if (!account) return;
  if (account.provider === 'demo') {
    toast('演示账号无法同步，请添加真实邮箱后使用。', 'info');
    return;
  }
  if (account.hasPassword === false) {
    toast('该账号还没有保存密码，请先编辑账号填写授权码。', 'error');
    return;
  }

  if (!options.silent) toast(`正在同步 ${account.label}…`, 'info');
  const result = await api.syncAccount(accountId);
  if (!result.ok) {
    toast(`${account.label} 同步失败：${result.error}`, 'error');
    await refreshCache(accountId);
    renderAll();
    return;
  }

  state.caches[accountId] = result.data.cache;
  if (result.data.account) {
    const index = state.accounts.findIndex((item) => item.id === accountId);
    if (index >= 0) state.accounts[index] = result.data.account;
    else state.accounts.push(result.data.account);
  }
  if (state.view.type === 'account' && state.view.accountId === accountId) {
    const folders = foldersOf(accountId);
    if (!folders.some((item) => item.path === state.view.folder)) {
      state.view.folder = inboxFolder(accountId)?.path || 'INBOX';
    }
  }
  renderAll();
  if (!options.silent) toast(`${account.label} 同步完成`, 'success');
}

async function syncAll() {
  if (state.syncing) return;
  const realAccounts = state.accounts.filter((account) => account.provider !== 'demo');
  if (!realAccounts.length) {
    toast(state.accounts.length ? '演示账号无法同步，请添加真实邮箱。' : '请先添加一个邮箱账号。', 'info');
    return;
  }

  state.syncing = true;
  setSyncBusy(true);
  renderHeader();

  const result = await api.syncAll();
  state.syncing = false;
  setSyncBusy(false);

  if (!result.ok) {
    renderHeader();
    toast(`同步失败：${result.error}`, 'error');
    return;
  }

  const failures = [];
  for (const item of result.data.results) {
    if (!item.ok && !item.skipped) failures.push(item.error);
  }
  applySyncPayload(result.data);
  if (failures.length) toast(failures[0], 'error');
}

function setSyncBusy(busy) {
  const button = $('btn-sync-all');
  button.classList.toggle('busy', busy);
  $('list-progress').textContent = busy ? '同步中…' : '';
}

/* ---------------- 账号弹窗 ---------------- */

function presetById(id) {
  return state.presets.find((item) => item.id === id) || state.presets[state.presets.length - 1];
}

function detectPresetId(email) {
  const value = String(email || '').trim();
  for (const [pattern, id] of DOMAIN_PRESETS) {
    if (pattern.test(value)) return id;
  }
  return 'custom';
}

function fillPresetFields(presetId) {
  const preset = presetById(presetId);
  if (!preset) return;
  $('acct-imap-host').value = preset.imap.host || '';
  $('acct-imap-port').value = preset.imap.port || 993;
  $('acct-smtp-host').value = preset.smtp.host || '';
  $('acct-smtp-port').value = preset.smtp.port || 465;
  $('acct-imap-secure').checked = preset.imap.secure !== false;
  $('acct-smtp-secure').checked = preset.smtp.secure !== false;
  $('acct-password-label').textContent = preset.passwordLabel || '密码';
  const hint = $('acct-hint');
  hint.textContent = preset.hint || '';
  hint.classList.toggle('warn', Boolean(preset.requiresOAuth));
}

function openAccountModal(accountId = null) {
  state.editingAccountId = accountId;
  const account = accountId ? accountById(accountId) : null;
  const select = $('acct-provider');
  select.innerHTML = state.presets
    .map((preset) => `<option value="${esc(preset.id)}">${esc(preset.label)}</option>`)
    .join('');

  $('account-modal-title').textContent = account ? '编辑邮箱账号' : '添加邮箱账号';
  $('acct-email').value = account ? account.email : '';
  $('acct-label').value = account ? account.label : '';
  $('acct-password').value = '';
  $('acct-password').placeholder = account ? '留空表示不修改已保存的密码' : 'QQ/163 填授权码，Gmail 填应用专用密码';
  $('acct-test-result').innerHTML = '';
  $('acct-advanced').open = false;

  const presetId = account ? account.provider : 'custom';
  select.value = state.presets.some((item) => item.id === presetId) ? presetId : 'custom';

  if (account) {
    $('acct-imap-host').value = account.imap?.host || '';
    $('acct-imap-port').value = account.imap?.port || 993;
    $('acct-imap-secure').checked = account.imap?.secure !== false;
    $('acct-smtp-host').value = account.smtp?.host || '';
    $('acct-smtp-port').value = account.smtp?.port || 465;
    $('acct-smtp-secure').checked = account.smtp?.secure !== false;
    const preset = presetById(presetId);
    $('acct-password-label').textContent = preset?.passwordLabel || '密码';
    $('acct-hint').textContent = preset?.hint || '';
    $('acct-hint').classList.toggle('warn', Boolean(preset?.requiresOAuth));
  } else {
    fillPresetFields(select.value);
  }

  // 编辑模式下添加删除按钮
  const footer = $('account-modal').querySelector('.modal-foot');
  footer.querySelector('#btn-delete-account')?.remove();
  if (account) {
    const deleteBtn = document.createElement('button');
    deleteBtn.id = 'btn-delete-account';
    deleteBtn.className = 'ghost-btn';
    deleteBtn.textContent = '删除账号';
    deleteBtn.style.color = 'var(--danger)';
    deleteBtn.addEventListener('click', () => removeAccount(account));
    footer.insertBefore(deleteBtn, footer.firstChild);
  }

  showModal('account-modal');
  setTimeout(() => $('acct-email').focus(), 60);
}

function collectAccountForm() {
  const email = $('acct-email').value.trim();
  const label = $('acct-label').value.trim();
  const provider = $('acct-provider').value;
  const password = $('acct-password').value;
  return {
    email,
    label: label || email,
    provider,
    username: email,
    password,
    imap: {
      host: $('acct-imap-host').value.trim(),
      port: Number($('acct-imap-port').value) || 993,
      secure: $('acct-imap-secure').checked
    },
    smtp: {
      host: $('acct-smtp-host').value.trim(),
      port: Number($('acct-smtp-port').value) || 465,
      secure: $('acct-smtp-secure').checked
    }
  };
}

async function saveAccount() {
  const payload = collectAccountForm();
  if (!payload.email || !/^[^@\s]+@[^@\s]+$/.test(payload.email)) {
    toast('请填写正确的邮箱地址', 'error');
    return;
  }
  if (!payload.imap.host || !payload.smtp.host) {
    toast('请填写 IMAP 和 SMTP 服务器地址', 'error');
    return;
  }
  if (!state.editingAccountId && !payload.password) {
    toast('请填写授权码 / 密码', 'error');
    return;
  }

  const button = $('btn-save-account');
  button.disabled = true;
  const result = state.editingAccountId
    ? await api.updateAccount(state.editingAccountId, payload)
    : await api.addAccount(payload);
  button.disabled = false;

  if (!result.ok) {
    toast(`保存失败：${result.error}`, 'error');
    return;
  }

  const account = result.data;
  const boot = await api.boot();
  if (boot.ok) {
    state.accounts = boot.data.accounts;
    state.caches = boot.data.caches;
  }
  closeModal('account-modal');
  toast(state.editingAccountId ? '账号已更新' : '账号已添加，正在同步…', 'success');
  state.editingAccountId = null;

  if (state.view.type === 'all') renderAll();
  else renderAll();

  if (account.provider !== 'demo') {
    void syncAccount(account.id, { silent: false });
  }
}

async function removeAccount(account) {
  const okToRemove = await confirmDialog({
    title: '删除邮箱账号',
    message: `「${account.label}」会从 MailHub 中移除，本地缓存的邮件一并清除；服务器上的邮件不受影响。`,
    confirmText: '删除账号',
    danger: true
  });
  if (!okToRemove) return;
  const result = await api.removeAccount(account.id);
  if (!result.ok) {
    toast(`删除失败：${result.error}`, 'error');
    return;
  }
  state.accounts = state.accounts.filter((item) => item.id !== account.id);
  delete state.caches[account.id];
  if (state.view.type === 'account' && state.view.accountId === account.id) {
    state.view = { type: 'all', accountId: null, folder: 'INBOX' };
    state.selectedKey = null;
  }
  closeModal('account-modal');
  renderAll();
  toast('账号已删除', 'success');
}

async function testAccount() {
  const payload = collectAccountForm();
  if (!payload.imap.host || !payload.smtp.host) {
    toast('请先填写 IMAP 和 SMTP 服务器地址', 'error');
    return;
  }
  if (!payload.password && !state.editingAccountId) {
    toast('请填写授权码 / 密码后再测试', 'error');
    return;
  }

  const box = $('acct-test-result');
  box.innerHTML = '<span style="color:var(--text-3)">正在连接服务器…</span>';
  const button = $('btn-test-account');
  button.disabled = true;

  const config = {
    imap: payload.imap,
    smtp: payload.smtp,
    user: payload.email,
    password: payload.password,
    provider: payload.provider
  };

  let result;
  if (!payload.password && state.editingAccountId) {
    result = await api.testAccount({ ...config, password: '__stored__', accountId: state.editingAccountId });
  } else {
    result = await api.testAccount(config);
  }
  button.disabled = false;

  if (!result.ok) {
    box.innerHTML = `<span class="fail">测试失败：${esc(result.error)}</span>`;
    return;
  }

  const data = result.data;
  const lines = [];
  lines.push(data.imap.ok ? '<span class="ok">✓ IMAP 收信正常</span>' : `<span class="fail">✕ IMAP 失败：${esc(data.imap.error || '未知错误')}</span>`);
  lines.push(data.smtp.ok ? '<span class="ok">✓ SMTP 发信正常</span>' : `<span class="fail">✕ SMTP 失败：${esc(data.smtp.error || '未知错误')}</span>`);
  box.innerHTML = lines.join('<br>');
}

/* ---------------- 写信 ---------------- */

const DRAFT_KEY = 'mailhub.composeDraft.v1';

function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeDraft(payload) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
  } catch {
    /* 存储满了就放弃自动保存 */
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* 忽略 */
  }
}

let draftTimer = null;

function draftPayload() {
  return {
    accountId: $('compose-from').value,
    to: $('compose-to').value,
    cc: $('compose-cc').value,
    bcc: $('compose-bcc').value,
    subject: $('compose-subject').value,
    body: $('compose-body').value,
    attachments: state.compose.attachments,
    updatedAt: Date.now()
  };
}

// 立刻把当前内容写进草稿（附件也算内容，只有附件时同样要存）
function flushDraft() {
  if (state.compose.mode !== 'new') return;
  if ($('compose-modal').hidden) return;
  const payload = draftPayload();
  const hasContent = Boolean(
    payload.to || payload.cc || payload.bcc || payload.subject || payload.body.trim() || payload.attachments.length
  );
  if (!hasContent) {
    clearDraft();
    return;
  }
  writeDraft(payload);
  const hint = $('compose-draft-hint');
  if (hint) {
    hint.hidden = false;
    hint.textContent = '草稿已自动保存在本地';
  }
}

function scheduleDraftSave() {
  if (state.compose.mode !== 'new') return;
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    draftTimer = null;
    flushDraft();
  }, 600);
}

// 关闭写信窗口时不能只靠 600ms 防抖，否则刚拖进来的附件会丢
function saveDraftBeforeClose() {
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
  }
  flushDraft();
}

function openCompose({ mode = 'new', message = null, account = null, body = null, to = '', toName = '', recipients = null } = {}) {
  state.compose = { mode, accountId: account?.id || null, attachments: [], missing: new Set(), replyMessage: message };

  const select = $('compose-from');
  select.innerHTML = state.accounts
    .map((item) => `<option value="${esc(item.id)}">${esc(item.label)} &lt;${esc(item.email)}&gt;</option>`)
    .join('');

  const preferred =
    account?.id ||
    (state.view.type === 'account' ? state.view.accountId : null) ||
    state.accounts[0]?.id;
  if (preferred) select.value = preferred;
  state.compose.accountId = select.value;

  $('compose-title').textContent = mode === 'reply' ? '回复邮件' : mode === 'forward' ? '转发邮件' : '写邮件';
  $('compose-error').textContent = '';
  const noticeBox = $('compose-notice');
  if (noticeBox) {
    noticeBox.hidden = true;
    noticeBox.textContent = '';
  }
  $('compose-cc-fields').hidden = true;
  $('compose-cc').value = '';
  $('compose-bcc').value = '';
  $('compose-attachments').innerHTML = '';

  const signature = state.settings.signature ? `\n\n${state.settings.signature}` : '';

  if (mode === 'reply' && message) {
    const replyTo = recipients?.to?.length ? recipients.to.join(', ') : message.fromAddress || '';
    const replyCc = recipients?.cc || [];
    $('compose-to').value = replyTo;
    $('compose-cc').value = replyCc.join(', ');
    if (replyCc.length) $('compose-cc-fields').hidden = false;
    const notice = $('compose-notice');
    if (recipients?.sent) {
      notice.hidden = false;
      notice.textContent = replyCc.length
        ? '这是你发出的邮件，回复会发给原收件人和抄送人。'
        : '这是你发出的邮件，回复会发给原收件人。';
    } else if (replyCc.length) {
      notice.hidden = false;
      notice.textContent = `回复全部：除了发件人，还会抄送给原收件人${replyCc.length > 1 ? '们' : ''}。`;
    }
    $('compose-subject').value = /^re:/i.test(message.subject || '') ? message.subject : `Re: ${message.subject || ''}`;
    const quoted = body?.text ? `\n\n------ 原始邮件 ------\n发件人：${message.fromName || ''} <${message.fromAddress || ''}>\n时间：${formatFullDate(message.date)}\n主题：${message.subject || ''}\n\n${body.text}` : '';
    $('compose-body').value = `${quoted}${signature}`;
  } else if (mode === 'forward' && message) {
    $('compose-to').value = '';
    $('compose-subject').value = /^fwd?:/i.test(message.subject || '') ? message.subject : `Fwd: ${message.subject || ''}`;
    const quoted = body?.text ? `\n\n------ 转发的邮件 ------\n发件人：${message.fromName || ''} <${message.fromAddress || ''}>\n时间：${formatFullDate(message.date)}\n主题：${message.subject || ''}\n\n${body.text}` : '';
    $('compose-body').value = `${quoted}${signature}`;
  } else if (mode === 'direct') {
    // 从阅读区点发件人进入：直接写给这个人，不套用草稿
    $('compose-to').value = to || '';
    $('compose-subject').value = '';
    $('compose-body').value = signature.replace(/^\n+/, '');
    if (toName) $('compose-to').title = toName;
  } else {
    $('compose-to').value = '';
    $('compose-subject').value = '';
    $('compose-body').value = signature.replace(/^\n+/, '');
  }

  // 新建邮件时恢复上次没发出去的草稿
  const draftHint = $('compose-draft-hint');
  draftHint.hidden = true;
  draftHint.textContent = '';
  if (mode === 'new') {
    const draft = readDraft();
    const draftAttachments = Array.isArray(draft?.attachments) ? draft.attachments.filter((item) => typeof item === 'string') : [];
    if (draft && (draft.to || draft.cc || draft.bcc || draft.subject || (draft.body && draft.body.trim()) || draftAttachments.length)) {
      if (draft.accountId && state.accounts.some((item) => item.id === draft.accountId)) {
        select.value = draft.accountId;
        state.compose.accountId = draft.accountId;
      }
      $('compose-to').value = draft.to || '';
      $('compose-cc').value = draft.cc || '';
      $('compose-bcc').value = draft.bcc || '';
      $('compose-subject').value = draft.subject || '';
      $('compose-body').value = draft.body || '';
      if (draft.cc || draft.bcc) $('compose-cc-fields').hidden = false;
      state.compose.attachments = Array.isArray(draft.attachments)
        ? draft.attachments.filter((item) => typeof item === 'string')
        : [];
      renderAttachmentChips();
      void markMissingAttachments();
      const when = draft.updatedAt ? new Date(draft.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      draftHint.hidden = false;
      draftHint.textContent = when ? `已恢复 ${when} 未发送的草稿` : '已恢复上次未发送的草稿';
    }
  }

  showModal('compose-modal');
  setTimeout(() => {
    if (mode === 'new') $('compose-to').focus();
    else $('compose-body').focus();
  }, 60);
}

function renderAttachmentChips() {
  const host = $('compose-attachments');
  const missing = state.compose.missing || new Set();
  host.innerHTML = state.compose.attachments
    .map((file, index) => {
      const gone = missing.has(file);
      return `
      <span class="attachment-chip ${gone ? 'missing' : ''}" title="${esc(gone ? `文件已不存在：${file}` : file)}">
        <span>${gone ? '⚠' : '📎'} ${esc(file.split(/[\\/]/).pop())}${gone ? '（找不到）' : ''}</span>
        <button data-remove-attachment="${index}" title="移除">✕</button>
      </span>`;
    })
    .join('');
  host.querySelectorAll('[data-remove-attachment]').forEach((button) => {
    button.addEventListener('click', () => {
      const [removed] = state.compose.attachments.splice(Number(button.dataset.removeAttachment), 1);
      state.compose.missing?.delete(removed);
      renderAttachmentChips();
      scheduleDraftSave();
    });
  });
}

// 加附件：去重、清掉旧的“缺失”标记，并立刻进入草稿
function addAttachments(paths) {
  const added = [];
  for (const file of paths || []) {
    if (typeof file !== 'string' || !file) continue;
    if (state.compose.attachments.includes(file)) continue;
    state.compose.attachments.push(file);
    state.compose.missing?.delete(file);
    added.push(file);
  }
  if (!added.length) {
    if (paths?.length) toast('这些文件已经在附件列表里了', 'info');
    return;
  }
  renderAttachmentChips();
  scheduleDraftSave();
  void markMissingAttachments();
}

async function markMissingAttachments() {
  if (!state.compose.attachments.length || typeof api.checkFiles !== 'function') return;
  const result = await api.checkFiles(state.compose.attachments);
  if (!result.ok) return;
  const missing = new Set(result.data.filter((item) => !item.exists).map((item) => item.path));
  state.compose.missing = missing;
  renderAttachmentChips();
}

// 拖进来的文件走 webUtils 拿真实路径；拿不到就明确告诉用户，而不是假装加上了
function attachDroppedFiles(fileList) {
  const paths = [];
  for (const file of fileList || []) {
    let filePath = '';
    try {
      filePath = api.getPathForFile?.(file) || '';
    } catch {
      filePath = '';
    }
    if (!filePath) {
      toast(`无法读取「${file.name || '这个文件'}」的路径，请改用「＋ 添加附件」`, 'error');
      continue;
    }
    paths.push(filePath);
  }
  addAttachments(paths);
}

async function sendCompose() {
  const accountId = $('compose-from').value;
  const to = $('compose-to').value.trim();
  const cc = $('compose-cc').value.trim();
  const bcc = $('compose-bcc').value.trim();
  const subject = $('compose-subject').value.trim();
  const text = $('compose-body').value;
  const errorBox = $('compose-error');

  if (!to && !cc && !bcc) {
    errorBox.textContent = '请填写至少一个收件人';
    $('compose-to').focus();
    return;
  }
  if (!accountId) {
    errorBox.textContent = '请先添加邮箱账号';
    return;
  }
  if (!subject) {
    errorBox.textContent = '主题不能为空';
    $('compose-subject').focus();
    return;
  }

  // 草稿里恢复出来的附件可能已经被移动或删除，发之前先确认文件还在
  if (state.compose.attachments.length && typeof api.checkFiles === 'function') {
    const check = await api.checkFiles(state.compose.attachments);
    if (check.ok) {
      const gone = check.data.filter((item) => !item.exists);
      if (gone.length) {
        state.compose.missing = new Set(gone.map((item) => item.path));
        renderAttachmentChips();
        errorBox.textContent = `有 ${gone.length} 个附件已经找不到了，请先移除或重新添加：${gone.map((item) => item.path.split(/[\\/]/).pop()).join('、')}`;
        return;
      }
    }
  }

  const button = $('btn-send');
  button.disabled = true;
  button.textContent = '发送中…';
  errorBox.textContent = '';

  const result = await api.sendMail(accountId, {
    to,
    cc,
    bcc,
    subject,
    text,
    attachments: state.compose.attachments,
    inReplyTo: state.compose.replyMessage?.messageId || null
  });

  button.disabled = false;
  button.textContent = '发送';

  if (!result.ok) {
    errorBox.textContent = result.error;
    return;
  }

  if (result.data.cache) state.caches[accountId] = result.data.cache;
  clearDraft();
  if (draftTimer) clearTimeout(draftTimer);
  $('compose-draft-hint').hidden = true;
  closeModal('compose-modal');
  renderAll();
  if (result.data.warning) toast(result.data.warning, 'info');
  toast('邮件已发送', 'success');
}

/* ---------------- 设置 ---------------- */

function openSettings() {
  const settings = state.settings;
  $('settings-theme').value = themePreference();
  $('settings-signature').value = settings.signature || '';
  $('settings-remote-images').checked = Boolean(settings.showRemoteImages);
  $('settings-dark-mail').checked = settings.darkMailBody !== false;
  $('settings-minimize-tray').checked = settings.minimizeToTray !== false;
  $('settings-notifications').checked = settings.notificationsEnabled !== false;
  $('settings-login').checked = Boolean(settings.launchAtLogin);
  $('settings-login-note').textContent = state.packaged
    ? ''
    : '（开发模式下登记的是 electron.exe，打包后自动指向程序本体）';
  $('settings-interval').value = String(settings.syncIntervalMinutes ?? 10);
  $('settings-notify-state').textContent = state.notificationsSupported ? '' : '当前系统不支持桌面通知';
  $('settings-storage').textContent = '正在统计…';
  $('settings-meta').innerHTML = `
    版本 ${esc(state.version)}<br>
    数据目录 ${esc(state.dataDir)}<br>
    密码存储 ${state.encryptionAvailable ? '系统加密（Electron safeStorage）' : '本地编码存储（当前系统不支持安全存储，请注意风险）'}`;
  showModal('settings-modal');

  api.getStatus().then((result) => {
    if (!result.ok) {
      $('settings-storage').textContent = '缓存统计失败';
      return;
    }
    $('settings-storage').textContent = `邮件缓存 ${formatSize(result.data.cacheBytes)}`;
    if (result.data.intervalMs > 0) {
      $('settings-notify-state').textContent = `每 ${Math.round(result.data.intervalMs / 60000)} 分钟后台同步`;
    }
    if (result.data.autostart != null) $('settings-login').checked = Boolean(result.data.autostart);
    renderPushState(result.data.push);
  });
}

/** 设置里的即时推送状态：IMAP IDLE 连接了几个账号 */
function renderPushState(push) {
  const node = $('settings-push-state');
  if (!node) return;
  if (!push || !push.enabled) {
    node.innerHTML = '<span class="push-led off"></span>即时收信未运行';
    return;
  }
  const accounts = push.accounts || [];
  if (!accounts.length) {
    const demoOnly = state.accounts.length > 0 && state.accounts.every((account) => account.provider === 'demo');
    node.innerHTML = `<span class="push-led off"></span>${demoOnly ? '演示模式不建立即时推送连接' : '还没有可用的邮箱账号'}`;
    return;
  }
  const idle = accounts.filter((item) => item.state === 'idle').length;
  const problem = accounts.find((item) => item.state !== 'idle' && item.state !== 'connecting');
  const label = idle === accounts.length ? '全部账号已连接' : `${idle}/${accounts.length} 个账号已连接`;
  node.innerHTML = `<span class="push-led ${idle ? 'on' : 'warn'}"></span>IMAP IDLE 即时收信 · ${esc(label)}${
    problem ? `<span class="push-detail" title="${esc(problem.detail)}">${esc(problem.label)}：${esc(problem.detail)}</span>` : ''
  }`;
}

async function saveSettings() {
  const patch = {
    theme: $('settings-theme').value,
    signature: $('settings-signature').value,
    showRemoteImages: $('settings-remote-images').checked,
    darkMailBody: $('settings-dark-mail').checked,
    minimizeToTray: $('settings-minimize-tray').checked,
    notificationsEnabled: $('settings-notifications').checked,
    launchAtLogin: $('settings-login').checked,
    syncIntervalMinutes: Number($('settings-interval').value)
  };
  const result = await api.setSettings(patch);
  if (!result.ok) {
    toast(`保存失败：${result.error}`, 'error');
    return;
  }
  state.settings = result.data;
  applyTheme({ rerender: true });
  closeModal('settings-modal');
  toast('设置已保存', 'success');
  renderAll();
}

/* ---------------- 后台同步 / 桌面提醒 ---------------- */

/** 把主进程（后台定时同步 / 托盘手动同步）的结果合并进界面状态 */
function applySyncPayload(payload) {
  if (!payload) return;
  for (const item of payload.results || []) {
    if (item.cache) state.caches[item.id] = item.cache;
  }
  if (Array.isArray(payload.accounts)) state.accounts = payload.accounts;

  const failures = (payload.results || []).filter((item) => !item.ok && !item.skipped);
  if (failures.length) {
    $('sync-hint').textContent = `${failures.length} 个账号同步失败`;
  } else if (payload.at) {
    $('sync-hint').textContent = `上次同步 ${new Date(payload.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  }

  const account = state.view.type === 'account' ? accountById(state.view.accountId) : null;
  if (account) {
    const folders = foldersOf(account.id);
    if (!folders.some((item) => item.path === state.view.folder)) {
      state.view.folder = inboxFolder(account.id)?.path || 'INBOX';
    }
  }
  renderAll();
}

/** 点击桌面通知后跳到对应邮件 */
async function jumpToMail(item) {
  if (!item) return;
  const account = accountById(item.accountId);
  if (!account) return;
  state.view = { type: 'account', accountId: item.accountId, folder: item.folder || 'INBOX' };
  state.selectedKey = null;
  state.search = '';
  state.filter = 'all';
  $('search-input').value = '';
  $('filter-chips').querySelectorAll('.chip').forEach((node) => node.classList.toggle('active', node.dataset.filter === 'all'));
  renderAll();
  await selectMessage(item.accountId, item.folder || 'INBOX', Number(item.uid));
  const row = document.querySelector('.msg-item.selected');
  if (row) row.scrollIntoView({ block: 'center' });
}

async function markAllRead() {
  const account = currentAccount();
  const folder = currentFolder();
  if (!account || !folder) {
    toast('请先选择一个邮箱账号', 'info');
    return;
  }
  const okToMark = await confirmDialog({
    title: '全部标为已读',
    message: `「${folder.label || folder.path}」里所有未读邮件都会被标记为已读，这个操作会同步到服务器。`,
    confirmText: '全部标为已读'
  });
  if (!okToMark) return;

  if (account.provider === 'demo') {
    for (const message of folder.messages || []) message.seen = true;
    folder.unseen = 0;
    renderAll();
    toast('演示邮件已全部标为已读', 'success');
    return;
  }

  const result = await api.markAllRead(account.id, folder.path);
  if (!result.ok) {
    toast(`操作失败：${result.error}`, 'error');
    return;
  }
  await refreshCache(account.id);
  renderAll();
  toast(result.data.count ? `已把 ${result.data.count} 封邮件标为已读` : '这个文件夹没有未读邮件', 'success');
}

/* ---------------- 弹窗控制 ---------------- */

function showModal(id) {
  $(id).hidden = false;
}

function closeModal(id) {
  // 关掉写信窗口前先把草稿落盘，避免刚添加的附件随防抖丢失
  if (id === 'compose-modal' && !$(id).hidden) saveDraftBeforeClose();
  $(id).hidden = true;
}

function closeAllModals() {
  if (!$('compose-modal').hidden) saveDraftBeforeClose();
  ['account-modal', 'compose-modal', 'settings-modal'].forEach((id) => {
    const node = $(id);
    if (node && !node.hidden) node.hidden = true;
  });
  state.editingAccountId = null;
}

/* ---------------- 渲染总入口 ---------------- */

function renderAll() {
  renderSidebar();
  renderHeader();
  renderList();
  renderReading();
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('btn-compose').addEventListener('click', () => openCompose({ mode: 'new' }));
  $('btn-titlebar-compose')?.addEventListener('click', () => openCompose({ mode: 'new' }));
  $('btn-add-account').addEventListener('click', () => openAccountModal());
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-sync-all').addEventListener('click', syncAll);
  $('btn-mark-all-read').addEventListener('click', markAllRead);
  $('btn-refresh').addEventListener('click', () => {
    if (state.view.type === 'account') void syncAccount(state.view.accountId);
    else void syncAll();
  });

  $('nav-all').addEventListener('click', () => {
    state.view = { type: 'all', accountId: null, folder: 'INBOX' };
    state.selectedKey = null;
    renderAll();
  });

  $('account-list').addEventListener('click', (event) => {
    const editButton = event.target.closest('[data-edit]');
    if (editButton) {
      event.stopPropagation();
      openAccountModal(editButton.dataset.edit);
      return;
    }
    const row = event.target.closest('[data-account]');
    if (!row) return;
    const accountId = row.dataset.account;
    const inbox = inboxFolder(accountId);
    state.view = { type: 'account', accountId, folder: inbox?.path || 'INBOX' };
    state.selectedKey = null;
    renderAll();
    const account = accountById(accountId);
    if (account && account.provider !== 'demo' && !inbox?.messages?.length) {
      void syncAccount(accountId, { silent: true });
    }
  });

  $('btn-edit-account').addEventListener('click', (event) => {
    const id = event.currentTarget.dataset.edit;
    if (id) openAccountModal(id);
  });

  $('panel-body').addEventListener('click', async (event) => {
    const accountRow = event.target.closest('[data-account-jump]');
    if (accountRow) {
      const accountId = accountRow.dataset.accountJump;
      const inbox = inboxFolder(accountId);
      state.view = { type: 'account', accountId, folder: inbox?.path || 'INBOX' };
      state.selectedKey = null;
      renderAll();
      return;
    }

    const folderRow = event.target.closest('[data-folder]');
    if (!folderRow) return;
    state.view.folder = folderRow.dataset.folder;
    state.selectedKey = null;
    renderAll();
    const folder = currentFolder();
    if (folder && !folder.messages?.length) {
      const account = currentAccount();
      if (account?.provider === 'demo') return;
      const result = await api.syncFolder(account.id, folder.path);
      if (result.ok) {
        state.caches[account.id] = result.data.cache;
        renderAll();
      } else {
        toast(`加载文件夹失败：${result.error}`, 'error');
      }
    }
  });

  $('search-input').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderList();
  });

  $('filter-chips').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-filter]');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    $('filter-chips').querySelectorAll('.chip').forEach((node) => node.classList.toggle('active', node === chip));
    renderList();
  });

  $('message-list').addEventListener('click', (event) => {
    const item = event.target.closest('.msg-item');
    if (!item) return;
    selectMessage(item.dataset.account, item.dataset.folder, Number(item.dataset.uid));
  });

  // 账号弹窗
  $('acct-provider').addEventListener('change', (event) => fillPresetFields(event.target.value));
  $('acct-email').addEventListener('change', (event) => {
    const email = event.target.value.trim();
    if (!email) return;
    const presetId = state.editingAccountId ? null : detectPresetId(email);
    if (presetId && presetId !== $('acct-provider').value) {
      $('acct-provider').value = presetId;
      fillPresetFields(presetId);
    }
    if (!$('acct-label').value.trim() && !state.editingAccountId) {
      $('acct-label').value = email.split('@')[0];
    }
  });
  $('btn-test-account').addEventListener('click', testAccount);
  $('btn-save-account').addEventListener('click', saveAccount);

  // 写信弹窗
  $('btn-send').addEventListener('click', sendCompose);
  $('btn-toggle-cc').addEventListener('click', () => {
    const fields = $('compose-cc-fields');
    fields.hidden = !fields.hidden;
  });
  $('btn-add-attachment').addEventListener('click', async () => {
    const result = await api.pickFiles();
    if (result.ok && result.data?.length) addAttachments(result.data);
  });

  // 拖拽添加附件：整个写信窗口都是放置区，拖入时压一层提示
  const composeModal = $('compose-modal');
  const dropOverlay = $('compose-dropzone');
  const composeCard = composeModal.querySelector('.modal-compose');
  let dragDepth = 0;
  const setDragging = (dragging) => {
    if (dropOverlay) dropOverlay.hidden = !dragging;
    composeCard.classList.toggle('drop-active', dragging);
  };
  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');

  composeModal.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    setDragging(true);
  });
  composeModal.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  composeModal.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragging(false);
  });
  composeModal.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    setDragging(false);
    attachDroppedFiles(event.dataTransfer?.files);
  });
  // 拖到窗口其它地方时不要让 Electron 直接打开文件
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
  $('compose-from').addEventListener('change', (event) => {
    state.compose.accountId = event.target.value;
    scheduleDraftSave();
  });

  // 草稿自动保存
  ['compose-to', 'compose-cc', 'compose-bcc', 'compose-subject', 'compose-body'].forEach((id) => {
    $(id).addEventListener('input', scheduleDraftSave);
  });

  // 设置
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('btn-test-notify').addEventListener('click', async () => {
    const result = await api.testNotification();
    if (!result.ok) toast(`提醒发送失败：${result.error}`, 'error');
    else toast('已发送一条测试提醒', 'success');
  });
  $('btn-clear-cache').addEventListener('click', async () => {
    const okToClear = await confirmDialog({
      title: '清理邮件缓存',
      message: '已下载的正文和附件会被删除，下次打开需要重新从服务器拉取。账号配置和密码不受影响。',
      confirmText: '清理缓存',
      danger: true
    });
    if (!okToClear) return;
    const result = await api.clearCache();
    if (!result.ok) {
      toast(`清理失败：${result.error}`, 'error');
      return;
    }
    for (const account of state.accounts) {
      state.caches[account.id] = { accountId: account.id, folders: [] };
    }
    state.bodies.clear();
    state.selectedKey = null;
    $('settings-storage').textContent = '邮件缓存 0 B';
    renderAll();
    toast(`已清理 ${formatSize(result.data.freed)} 本地缓存`, 'success');
  });
  $('btn-open-data').addEventListener('click', async () => {
    const result = await api.openDataDir();
    if (!result.ok) toast(result.error, 'error');
  });

  // 主进程事件：后台同步完成 / 点击通知 / 托盘里改了设置
  api.onSyncFinished((payload) => {
    applySyncPayload(payload);
  });
  api.onOpenMail((item) => {
    void jumpToMail(item);
  });
  api.onSettingsChanged((settings) => {
    state.settings = settings;
    applyTheme({ rerender: true });
    if (!$('settings-modal').hidden) openSettings();
  });

  // 跟随系统主题：系统切换深浅色时即时更新
  themeQuery.addEventListener('change', () => applyTheme({ rerender: true }));

  // 通用关闭
  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => closeModal(button.dataset.close));
  });
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) closeAllModals();
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAllModals();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      openCompose({ mode: 'new' });
    }
  });

  api.onSyncProgress((payload) => {
    if (payload.phase === 'folders') {
      const account = accountById(payload.accountId);
      $('sync-hint').textContent = `${account?.label || '邮箱'}：读取文件夹…`;
    } else if (payload.phase === 'messages') {
      $('sync-hint').textContent = `${payload.label || payload.folder} 同步中…`;
    }
  });

  api.onPushStatus?.((status) => {
    renderPushState(status);
  });
}

/* ---------------- 启动 ---------------- */

async function boot() {
  document.documentElement.dataset.platform = api.platform || 'win32';
  bindEvents();
  syncTitlebarControlsWidth();
  const result = await api.boot();
  if (!result.ok) {
    toast(`启动失败：${result.error}`, 'error');
    return;
  }

  state.accounts = result.data.accounts;
  state.caches = result.data.caches;
  state.settings = result.data.settings;
  state.presets = result.data.presets;
  state.encryptionAvailable = result.data.encryptionAvailable;
  state.version = result.data.version;
  state.dataDir = result.data.dataDir;
  state.notificationsSupported = Boolean(result.data.notificationsSupported);
  state.packaged = Boolean(result.data.packaged);
  applyTheme();

  // 启动落在统一收件箱：多邮箱聚合才是这个软件的主界面
  state.view = { type: 'all', accountId: null, folder: 'INBOX' };

  renderAll();

  if (!state.accounts.length) return;
  if (state.accounts.some((account) => account.provider === 'demo')) {
    $('sync-hint').textContent = '演示数据模式';
    return;
  }

  const lastSync = state.accounts
    .map((account) => account.lastSyncAt)
    .filter(Boolean)
    .sort()
    .pop();
  if (lastSync) {
    $('sync-hint').textContent = `上次同步 ${new Date(lastSync).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  }

  // 启动后自动同步一次（不阻塞界面）
  setTimeout(() => {
    void syncAll();
  }, 400);
}

boot();