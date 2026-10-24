'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { app, BrowserWindow, Menu, shell, dialog, nativeImage, powerMonitor, nativeTheme } = require('electron');
const { createStore } = require('./store');
const { MailService } = require('./mail');
const { registerIpc } = require('./ipc');
const { seedDemoData } = require('./demo');
const { TrayController } = require('./tray');
const { SyncManager } = require('./sync-manager');
const { IdleManager } = require('./idle-manager');
const { createNotifier } = require('./notifier');

const APP_NAME = 'MailHub';
app.setName(APP_NAME);

// 数据目录：
//   1. 环境变量 MAILHUB_DATA_DIR 最优先（测试/便携）
//   2. 打包版放在安装目录下的 data\，跟着安装位置走（装到 D 盘数据就在 D 盘）
//   3. 开发时放在系统用户数据目录
// Electron 自己的 profile（缓存、GPU、localStorage）始终留在系统用户数据目录，那部分只能在 C 盘
const legacyDataDir = path.join(app.getPath('userData'), 'data');
let dataDir = process.env.MAILHUB_DATA_DIR
  ? path.resolve(process.env.MAILHUB_DATA_DIR)
  : app.isPackaged
    ? path.join(path.dirname(process.execPath), 'data')
    : legacyDataDir;

function canWriteDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

// 从旧位置（%APPDATA%\MailHub\data）迁移一次，避免升级后账号和邮件“消失”
function migrateLegacyData() {
  if (process.env.MAILHUB_DATA_DIR) return;
  if (path.resolve(dataDir) === path.resolve(legacyDataDir)) return;
  const alreadyMigrated = fs.existsSync(path.join(dataDir, 'accounts.json'));
  const legacyExists = fs.existsSync(path.join(legacyDataDir, 'accounts.json'));
  if (alreadyMigrated || !legacyExists) return;
  try {
    fs.cpSync(legacyDataDir, dataDir, { recursive: true, force: false, errorOnExist: false });
    console.log('[mailhub] 已把旧数据从', legacyDataDir, '迁移到', dataDir);
  } catch (error) {
    console.error('[mailhub] 旧数据迁移失败，继续使用旧目录：', error);
    dataDir = legacyDataDir;
  }
}

if (process.env.MAILHUB_DATA_DIR) {
  const profile = path.join(dataDir, 'electron-profile');
  app.setPath('userData', profile);
  app.setPath('sessionData', path.join(profile, 'session'));
  app.setPath('crashDumps', path.join(profile, 'crashes'));
}

const ASSETS = path.join(__dirname, '..', 'assets');

let mainWindow = null;
let store = null;
let mailService = null;
let syncManager = null;
let idleManager = null;
let pushStatus = { enabled: false, idleCount: 0, accounts: [] };
let trayController = null;
let notifier = null;
let isQuitting = false;
let trayHintShown = false;

/* ---------------- 窗口 ---------------- */

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openMail(item) {
  showWindow();
  const send = () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mail:open', item);
  };
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', send);
  else send();
}

function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? '#0d1210' : '#ecefea';
}

// 标题栏高度与配色要和渲染层的 .titlebar 完全一致，否则接缝处会露一条白边
const TITLEBAR_HEIGHT = 44;

function titlebarTheme() {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    color: dark ? '#111714' : '#f6f7f3',
    symbolColor: dark ? '#e5ebe7' : '#16201c',
    height: TITLEBAR_HEIGHT
  };
}

function applyTitlebarTheme() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setTitleBarOverlay(titlebarTheme());
  } catch {
    /* 非 Windows 平台没有 overlay，保持系统标题栏 */
  }
}

function createWindow() {
  // Windows 上隐藏系统标题栏，换成跟随主题的自绘标题栏 + 原生窗口按钮
  const useOverlay = process.platform === 'win32';
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    backgroundColor: windowBackground(),
    title: 'MailHub 邮箱管家',
    icon: path.join(ASSETS, 'icon.png'),
    autoHideMenuBar: true,
    ...(useOverlay ? { titleBarStyle: 'hidden', titleBarOverlay: titlebarTheme() } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 关闭窗口时最小化到托盘，继续后台收信
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    let keepInTray = false;
    try {
      keepInTray = Boolean(store && store.getSettings().minimizeToTray);
    } catch {
      keepInTray = false;
    }
    console.log('[window] close 事件，minimizeToTray =', keepInTray);
    if (!keepInTray) return;

    event.preventDefault();
    mainWindow.hide();
    console.log('[window] 已拦截关闭并隐藏到托盘');
    if (!trayHintShown && notifier) {
      trayHintShown = true;
      notifier.notifyTrayHint();
    }
  });

  mainWindow.on('closed', () => {
    console.log('[window] 窗口已销毁');
  });

  // 外部链接交给系统浏览器，禁止应用内跳转
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  // F12 / Ctrl+Shift+I 打开开发者工具
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isDevTools = input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i');
    if (isDevTools && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
}

/* ---------------- 托盘 / 任务栏角标 ---------------- */

function updateTaskbarBadge(unread) {
  if (!mainWindow || mainWindow.isDestroyed() || process.platform !== 'win32') return;
  try {
    if (unread > 0) {
      const image = nativeImage.createFromPath(path.join(ASSETS, 'overlay-unread.png'));
      mainWindow.setOverlayIcon(image.isEmpty() ? null : image, `${unread} 封未读`);
    } else {
      mainWindow.setOverlayIcon(null, '');
    }
  } catch {
    /* 忽略角标失败 */
  }
}

/** 未读数变化后刷新托盘图标、提示文字与任务栏角标 */
function refreshShell() {
  const unread = store ? store.totalUnread() : 0;
  if (trayController) trayController.refresh();
  updateTaskbarBadge(unread);
  return unread;
}

function applyThemeSource() {
  const theme = store ? store.getSettings().theme : 'system';
  nativeTheme.themeSource = theme === 'dark' || theme === 'light' ? theme : 'system';
}

/* ---------------- 开机自启 ---------------- */

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_NAME = 'MailHub';
let autostartEnabled = false;

function autostartCommand() {
  const exe = process.execPath;
  const extra = app.isPackaged ? [] : [app.getAppPath()];
  return [`"${exe}"`, ...extra.map((item) => `"${item}"`)].join(' ');
}

function refreshAutostartState() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      try {
        autostartEnabled = Boolean(app.getLoginItemSettings().openAtLogin);
      } catch {
        autostartEnabled = false;
      }
      resolve(autostartEnabled);
      return;
    }
    execFile('reg', ['query', RUN_KEY, '/v', AUTOSTART_NAME], (err, stdout) => {
      autostartEnabled = !err && /MailHub/.test(String(stdout || ''));
      resolve(autostartEnabled);
    });
  });
}

/** 用独立键名写 HKCU\...\Run，避免和别的 Electron 应用共用 electron.app.* 互相覆盖 */
function applyAutostart(enabled) {
  if (process.platform !== 'win32') {
    autostartEnabled = Boolean(enabled);
    return;
  }

  const command = autostartCommand();
  const args = enabled
    ? ['add', RUN_KEY, '/v', AUTOSTART_NAME, '/t', 'REG_SZ', '/d', command, '/f']
    : ['delete', RUN_KEY, '/v', AUTOSTART_NAME, '/f'];

  execFile('reg', args, (err) => {
    if (err) {
      console.error('[login] 修改开机自启失败', err.message);
      return;
    }
    autostartEnabled = Boolean(enabled);
    console.log(`[login] 开机自启已${enabled ? '开启' : '关闭'}${enabled ? `：${command}` : ''}`);
  });
}

function applyLoginItem(enabled) {
  const wanted = Boolean(enabled);
  if (wanted === autostartEnabled) return;
  applyAutostart(wanted);
}

function applySettings() {
  if (!store) return;
  const settings = store.getSettings();

  // 主题：交给 Chromium，窗口底色和渲染进程的 prefers-color-scheme 会一起跟随
  applyThemeSource();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(windowBackground());
  applyTitlebarTheme();

  applyLoginItem(settings.launchAtLogin);

  if (syncManager) syncManager.applySettings();
  refreshShell();
}

async function toggleSetting(key) {
  const settings = store.getSettings();
  const next = !settings[key];
  store.setSettings({ [key]: next });
  applySettings();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings:changed', store.getSettings());
  }
  return next;
}

function quitApp() {
  isQuitting = true;
  try {
    if (syncManager) syncManager.stop();
    if (idleManager) idleManager.stop();
    if (trayController) trayController.destroy();
  } catch {
    /* 忽略清理错误 */
  }
  app.quit();
}

/* ---------------- 应用生命周期 ---------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  app.whenReady()
    .then(async () => {
      Menu.setApplicationMenu(null);

      // 安装目录不可写（例如装进了 Program Files）就退回用户数据目录，避免启动即崩
      if (!canWriteDir(dataDir)) {
        console.warn('[mailhub] 数据目录不可写，退回', legacyDataDir);
        dataDir = legacyDataDir;
        canWriteDir(dataDir);
      } else {
        migrateLegacyData();
      }

      store = createStore(dataDir);
      // 先定主题再建窗口，避免深色模式下启动闪一下白屏
      applyThemeSource();
      await refreshAutostartState();
      if (process.env.MAILHUB_DEMO === '1') {
        try {
          seedDemoData(store);
        } catch (err) {
          console.error('演示数据初始化失败', err);
        }
      }

      mailService = new MailService(store);
      syncManager = new SyncManager({
        store,
        mailService,
        getWindow: () => mainWindow,
        onNewMail: (items) => {
          if (notifier) notifier.notifyNewMail(items);
          // 新邮件到达后立即刷新托盘未读数与任务栏角标
          try {
            refreshShell();
          } catch {
            /* 窗口还没创建好 */
          }
        }
      });
      idleManager = new IdleManager({
        store,
        syncManager,
        onStatus: (status) => {
          pushStatus = status;
          if (mainWindow && !mainWindow.isDestroyed()) {
            try {
              mainWindow.webContents.send('push:status', status);
            } catch {
              /* 窗口可能正在关闭 */
            }
          }
        }
      });
      notifier = createNotifier({
        store,
        getWindow: () => mainWindow,
        showWindow,
        openMail
      });

      registerIpc({
        store,
        mailService,
        syncManager,
        notifier,
        refreshShell,
        applySettings,
        showWindow,
        quitApp,
        onAccountsChanged: (accountId) => {
          if (!idleManager) return;
          if (accountId) idleManager.refresh(accountId);
          else idleManager.refreshAll();
        },
        getPushStatus: () => pushStatus,
        getAutostart: () => autostartEnabled,
        getTrayInfo: () => {
          if (!trayController || !trayController.tray) return null;
          try {
            const bounds = trayController.tray.getBounds();
            return { bounds, visible: Boolean(bounds && bounds.width) };
          } catch {
            return { bounds: null, visible: false };
          }
        }
      });

      createWindow();

      trayController = new TrayController({
        store,
        onShow: showWindow,
        onSyncNow: () => {
          syncManager.runAll('tray').catch(() => {});
        },
        onQuit: quitApp,
        onToggleSetting: (key) => toggleSetting(key)
      });
      trayController.init();

      applySettings();

      // IMAP IDLE：常驻连接收到新邮件立刻同步，定时轮询继续作为兜底
      idleManager.start();

      // 休眠唤醒 / 解锁后补一次同步，避免长时间在托盘里错过新邮件
      const syncOnWake = () => {
        if (syncManager) syncManager.runAll('wake').catch(() => {});
        if (idleManager) idleManager.restartAll();
      };
      powerMonitor.on('resume', syncOnWake);
      powerMonitor.on('unlock-screen', syncOnWake);

      // 跟随系统主题时，系统切换深浅色要同步窗口底色
      nativeTheme.on('updated', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.setBackgroundColor(windowBackground());
        applyTitlebarTheme();
      });

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
        else showWindow();
      });
    })
    .catch((err) => {
      dialog.showErrorBox('MailHub 启动失败', String((err && err.message) || err));
      app.quit();
    });

  app.on('window-all-closed', () => {
    // 最小化到托盘时窗口只是隐藏，这里不会触发；真的关闭则退出
    if (process.platform !== 'darwin' && !(store && store.getSettings().minimizeToTray)) {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (syncManager) syncManager.stop();
    if (idleManager) idleManager.stop();
    if (trayController) trayController.destroy();
  });
}

process.on('uncaughtException', (err) => {
  console.error('未捕获异常:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('未处理的 Promise 拒绝:', err);
});