'use strict';

const path = require('path');
const { Tray, Menu, nativeImage, app } = require('electron');

const ASSETS = path.join(__dirname, '..', 'assets');

class TrayController {
  constructor({ store, onShow, onSyncNow, onQuit, onToggleSetting }) {
    this.store = store;
    this.onShow = onShow;
    this.onSyncNow = onSyncNow;
    this.onQuit = onQuit;
    this.onToggleSetting = onToggleSetting;
    this.tray = null;
    this.icons = {};
  }

  loadIcons() {
    const load = (name) => {
      const image = nativeImage.createFromPath(path.join(ASSETS, name));
      return image && !image.isEmpty() ? image : null;
    };
    this.icons.normal = load('tray.png');
    this.icons.unread = load('tray-unread.png') || this.icons.normal;
    this.icons.app = load('icon.png');
  }

  init() {
    if (this.tray) return;
    this.loadIcons();
    const image = this.icons.normal || nativeImage.createEmpty();
    this.tray = new Tray(image);
    this.tray.setToolTip('MailHub 邮箱管家');
    this.tray.on('click', () => this.onShow());
    this.tray.on('double-click', () => this.onShow());
    this.refresh();
  }

  refresh() {
    if (!this.tray || this.tray.isDestroyed()) return;
    const unread = this.store.totalUnread();
    this.tray.setImage(unread > 0 ? this.icons.unread : this.icons.normal);
    this.tray.setToolTip(unread > 0 ? `MailHub — ${unread} 封未读` : 'MailHub 邮箱管家');
    this.tray.setContextMenu(this.buildMenu(unread));
  }

  buildMenu(unread) {
    const settings = this.store.getSettings();
    const packaged = app.isPackaged;
    return Menu.buildFromTemplate([
      { label: unread > 0 ? `${unread} 封未读邮件` : '暂无未读邮件', enabled: false },
      { type: 'separator' },
      { label: '打开主窗口', click: () => this.onShow() },
      { label: '立即同步', click: () => this.onSyncNow() },
      { type: 'separator' },
      {
        label: '关闭窗口时最小化到托盘',
        type: 'checkbox',
        checked: Boolean(settings.minimizeToTray),
        click: () => this.onToggleSetting('minimizeToTray')
      },
      {
        label: '新邮件桌面提醒',
        type: 'checkbox',
        checked: Boolean(settings.notificationsEnabled),
        click: () => this.onToggleSetting('notificationsEnabled')
      },
      {
        label: packaged ? '开机自动启动' : '开机自动启动（打包后可用）',
        type: 'checkbox',
        checked: Boolean(settings.launchAtLogin),
        enabled: packaged,
        click: () => this.onToggleSetting('launchAtLogin')
      },
      { type: 'separator' },
      { label: '退出 MailHub', click: () => this.onQuit() }
    ]);
  }

  destroy() {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }
}

module.exports = { TrayController };