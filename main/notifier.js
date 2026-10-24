'use strict';

const { Notification } = require('electron');

/**
 * 桌面通知：新邮件到达、托盘提示、设置里的测试按钮。
 */
function createNotifier({ store, getWindow, showWindow, openMail }) {
  const supported = () => {
    try {
      return Notification.isSupported();
    } catch {
      return false;
    }
  };

  function shouldNotify() {
    if (!store.getSettings().notificationsEnabled) return false;
    if (!supported()) return false;
    const win = getWindow();
    // 用户正盯着窗口看的时候不打扰
    if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) return false;
    return true;
  }

  function show({ title, body, onClick }) {
    const notification = new Notification({ title, body, silent: false });
    if (typeof onClick === 'function') notification.on('click', onClick);
    notification.show();
    return notification;
  }

  return {
    supported,

    notifyNewMail(items) {
      if (!items || !items.length || !shouldNotify()) return false;

      if (items.length === 1) {
        const item = items[0];
        show({
          title: `${item.accountLabel}：新邮件`,
          body: `${item.fromName}\n${item.subject}`,
          onClick: () => openMail(item)
        });
        return true;
      }

      const preview = items
        .slice(0, 3)
        .map((item) => `${item.fromName}：${item.subject}`)
        .join('\n');
      show({
        title: `${items.length} 封新邮件`,
        body: `${preview}${items.length > 3 ? `\n…还有 ${items.length - 3} 封` : ''}`,
        onClick: () => openMail(items[0])
      });
      return true;
    },

    notifyTrayHint() {
      if (!supported()) return;
      show({
        title: 'MailHub 仍在后台运行',
        body: '窗口已隐藏到托盘，会继续定时收取新邮件。点击托盘图标可以重新打开。'
      });
    },

    test() {
      if (!supported()) throw new Error('当前系统不支持桌面通知');
      show({ title: 'MailHub 测试提醒', body: '通知功能正常，新邮件到达时会这样提醒你。' });
      return true;
    }
  };
}

module.exports = { createNotifier };