# MailHub 交接文档

> 面向接手这个项目的工程师，以及要在这个仓库里干活的 AI agent。
> 读完应该能做到三件事：**跑起来**、**知道改某个功能该动哪个文件**、**知道哪些线不能碰**。
>
> 对应版本：0.2.2 ｜ 仓库：<https://github.com/proacane/mailhub>

---

## 0. 一分钟速览

MailHub 是一个 Windows 桌面邮件客户端：把多个邮箱账号聚合成一个收件箱，直接走 IMAP/SMTP，不经过任何服务器。

| 项目 | 说明 |
| --- | --- |
| 运行时 | Electron 43（Chromium + Node 22） |
| 主进程 | 纯 CommonJS，无 TypeScript、无打包器 |
| 渲染进程 | 单页 HTML + 原生 DOM 操作，无框架、无构建步骤 |
| 邮件协议 | `imapflow`（收信/IDLE）、`mailparser`（解析）、`nodemailer`（发信） |
| 存储 | 本地 JSON 文件（账号、设置、邮件列表缓存、正文与附件） |
| 打包 | electron-builder 26 → NSIS 安装包（per-user） |
| 代码规模 | 主进程约 3.0k 行，渲染层约 4.8k 行，测试脚本约 2.0k 行 |

三条命令：

```powershell
npm start            # 开发运行（读取 %APPDATA%\MailHub\data 或 MAILHUB_DATA_DIR）
npm run dist         # 打 NSIS 安装包 → dist\MailHub-Setup-<version>.exe
node qa-titlebar.mjs # 真实 Electron 回归（任选一个 qa-*.mjs）
```

关键路径：

| 想找什么 | 去哪里 |
| --- | --- |
| 应用启动、窗口、托盘、主题 | `main/main.js` |
| 所有 IPC 处理器 | `main/ipc.js` |
| IMAP 连接、同步、正文抓取 | `main/mail.js` |
| 定时同步与"有新邮件"判定 | `main/sync-manager.js` |
| IMAP IDLE 长连接 | `main/idle-manager.js` |
| 发信与"已发送"副本 | `main/sender.js` |
| 本地数据读写 | `main/store.js` |
| 服务商预设 | `main/providers.js` |
| 渲染层全部逻辑 | `renderer/app.js` |
| 设计系统与样式 | `renderer/styles.css` |
| DOM 骨架 | `renderer/index.html` |
| 渲染进程可用 API | `preload/preload.js` |

---

## 1. 功能清单与边界

### 已实现

- 多账号聚合：统一收件箱、单账号视图、按账号着色的标签
- 账号管理：服务商预设（QQ / 163 / 126 / Gmail / Outlook / 自定义）、连接测试、改色、删除
- 收信：定时轮询 + IMAP IDLE 常驻连接（新邮件到达秒级同步）
- 读信：HTML 正文沙箱渲染、纯文本兜底、内嵌图片（cid）转 data URI、远程图片默认拦截
- 深色正文：可选的"正文跟随深色"，对浅色系 HTML 邮件做亮度反转（见 §5.5）
- 写信：收件人/抄送/密送、附件（按钮选择 + 拖拽）、草稿自动保存与恢复、回复/回复全部/转发
- 邮件操作：已读/未读、标星、删除（移动到垃圾箱）、整文件夹标记已读
- 通知：新邮件系统通知（点击直达）、托盘未读角标、任务栏角标
- 体验：自绘标题栏（跟随主题）、关闭到托盘、开机自启、单实例、四档窗口自适应

### 明确不做（当前版本）

| 未实现 | 原因 |
| --- | --- |
| Outlook / Hotmail 登录 | 微软已关闭基础密码认证，需要 OAuth2，未接入 |
| 全文搜索 | 只搜已缓存邮件的发件人/主题/摘要（`renderer/app.js` 的 `collectMessages`） |
| 推送（Exchange/Graph） | 只支持 IMAP IDLE |
| 多用户/账号同步 | 纯本地应用，无云端 |
| 邮件规则/过滤/自动分类 | 未实现 |
| 附件内联预览（PDF/图片查看器） | 只支持"打开"和"另存为" |
| 签名富文本 | 纯文本签名 + 纯文本正文 |

---

## 2. 架构总览

### 2.1 进程模型

```
┌──────────────────────────── 主进程 (Node) ────────────────────────────┐
│ main.js ── 生命周期、窗口、托盘、主题、自启、单实例                      │
│   ├─ store.js        accounts.json / settings.json / cache/ / bodies/  │
│   ├─ mail.js         ImapFlow 连接池、同步、正文抓取、标记、删除         │
│   ├─ sync-manager.js 定时轮询、runAll / runAccount、diffNew              │
│   ├─ idle-manager.js 每账号一条 IDLE 长连接、断线重连、状态上报          │
│   ├─ sender.js       nodemailer 发信 + 已发送副本去重                    │
│   ├─ ipc.js          全部 ipcMain.handle                                 │
│   ├─ tray.js / notifier.js / providers.js / demo.js                     │
│   └─ build/installer.nsh ── 升级保留 data\，卸载删除                     │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ contextBridge 白名单（preload.js）
┌───────────────────────────────▼────────────────────────────────────────┐
│ 渲染进程 (Chromium, sandbox: true)                                       │
│ index.html（四栏骨架 + 三个弹窗） → app.js（全部交互与渲染）             │
│ styles.css（设计系统变量 + 组件）                                        │
│ 阅读区使用 <iframe sandbox> 渲染邮件正文，与主界面隔离                   │
└─────────────────────────────────────────────────────────────────────────┘
```

安全边界：渲染进程 `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`；
所有文件系统、网络、剪贴板能力都必须经过 `preload/preload.js` 暴露的方法。
邮件正文跑在独立 iframe 里，通过 `postMessage` 上报高度。

### 2.2 主进程模块

| 文件 | 行数 | 职责 | 什么时候动它 |
| --- | --- | --- | --- |
| `main/main.js` | 484 | 数据目录决策、窗口、托盘、任务栏角标、主题、开机自启、电源事件、单实例 | 改窗口行为、托盘菜单、启动流程 |
| `main/ipc.js` | 243 | 所有 `ipcMain.handle`，统一 `{ok, data\|error}` 包装 | 加/改 IPC 接口 |
| `main/mail.js` | 629 | `MailService`：连接池、列文件夹、同步、抓正文、标记、删除、连通性测试 | 改 IMAP 行为 |
| `main/sync-manager.js` | 157 | 定时器、`runAll`、`runAccount`、`diffNew`（新邮件判定） | 改同步节奏、通知触发条件 |
| `main/idle-manager.js` | 257 | 每账号一条 IDLE 连接、`exists` 触发同步、指数退避重连、状态机 | 改推送行为 |
| `main/sender.js` | 172 | 组装邮件、SMTP 发送、追加"已发送"副本 | 改发信逻辑 |
| `main/store.js` | 382 | 账号/设置/缓存的原子读写、密码加密、正文与附件落盘 | 改数据结构 |
| `main/demo.js` | 394 | 演示模式种子数据（3 个账号、16 封邮件、正文） | 改演示内容 |
| `main/tray.js` | 87 | 托盘图标、菜单、未读数字 | 改托盘 |
| `main/notifier.js` | 77 | 系统通知（新邮件、托盘提示、测试通知） | 改通知 |
| `main/providers.js` | 92 | 服务商 IMAP/SMTP 预设与域名识别 | 加服务商 |

### 2.3 为什么不用前端框架

- 无构建步骤：改完 `renderer/` 直接刷新/重启即可，没有 bundler 缓存和 sourcemap 问题
- 包体积：`node_modules` 只装 3 个运行时依赖
- 状态简单：单窗口、单用户，`state` 一个对象 + `renderAll()` 全量重绘足够
- 代价：`app.js` 已经 2140 行、`styles.css` 2393 行，属于可接受的技术债（见 §10）

---

## 3. 运行时数据流

### 3.1 收信：两条路

**定时轮询**（兜底，默认 10 分钟）
`sync-manager.js: applySettings()` 按 `settings.syncIntervalMinutes` 建 `setInterval` → `runAll('timer')`。

**IMAP IDLE**（主路径）
`idle-manager.js` 为每个可推送账号建一条连接，`client.mailboxOpen('INBOX')` 后进入空闲；
服务器有新邮件时触发 `exists` 事件 → 去抖 1.2s → 调 `syncManager.runAccount(accountId, 'idle')`。

两条路最终都收敛到 `MailService.syncAccount()`：

```
syncAccount(accountId)
  ├─ connect(accountId)               复用连接池，没有则新建 ImapFlow
  ├─ listFolders()                    写入 cache.folders（含 specialUse）
  ├─ syncFolder(INBOX, 150)           拉最近 150 封的 envelope/flags（已发送只拉 60 封）
  ├─ syncFolder(其他有 specialUse 的文件夹, 150)
  └─ store.saveCache()                每个文件夹最多保留 800 封
```

然后 `SyncManager.diffNew()` 对比同步前后的 UID 集合，取前 5 封未读新邮件 → `onNewMail()` → 系统通知 + 托盘刷新。
注意：**首次同步（本地缓存为空）不提醒**，避免一次弹几百条。

### 3.2 打开邮件

```
renderer: selectMessage() → api.openMessage(accountId, folder, uid)
main/ipc.js: message:open
  ├─ demo 账号 → store.readBody() 直接读种子数据
  └─ 真实账号 → mail.js: fetchBody()
        ├─ 命中 store.readBody() 直接返回（正文永久缓存，除非清缓存）
        ├─ getMailboxLock(folder) 独占拉取 source
        ├─ simpleParser() 解析
        ├─ 内嵌图片 cid → data URI（单封内嵌图合计 ≤ 3MB）
        ├─ 附件写盘 bodies/<account>/<sha1(folder)>/<uid>-att-<i>-<name>
        └─ store.writeBody() + patchSnippet()（回填列表摘要）
```

渲染端把 `buildEmailDocument(body)` 产出的完整 HTML 通过 `srcdoc` 塞进
`<iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox">`，
文档里带 `<base target="_blank">`，外链点击由 `shell.openExternal` 交给系统浏览器；
iframe 通过 `postMessage` 上报内容高度，外层再设置 `height`（`renderer/app.js: renderReading`）。

### 3.3 发信

`main/sender.js: sendMail()`：

1. 校验账号、SMTP 配置、密码、收件人
2. 生成 `Message-ID: <uuid@domain>`
3. `nodemailer.sendMail()`，**`envelope.from` 强制等于登录账号**（163 会校验，不一致直接判失败）
4. 成功后再追加"已发送"副本，这一步失败不影响发信结果（只返回 `warning`）：
   - 先 `sleep(1200)` 等服务商自己写入
   - 用 `Message-ID` 在已发送文件夹 `search` 一次
   - 已存在 → 跳过 APPEND（避免 163/QQ/Gmail 出现两封重复、且第二封没有"发送成功"标记）
5. 在本地缓存里插入一条 `pendingSync: true` 的乐观记录，列表立刻可见

### 3.4 标记 / 删除

- `message:flags` → `MailService.setFlags()`：IMAP `messageFlagsAdd/Remove`，同步改缓存
- `message:delete` → 移动到垃圾箱（`\Trash`），没有垃圾箱才真删
- `mail:markAllRead` → `MailService.markAllRead()`：批量 `\Seen`，前端弹自绘确认框

### 3.5 草稿

纯前端：`localStorage` 键 `mailhub.composeDraft.v1`（`renderer/app.js: DRAFT_KEY`）。
输入停止 600ms 后写入，关闭弹窗前强制 `flushDraft()`；重新打开写信时提示"恢复草稿"。
附件只存路径字符串，**恢复时用 `api.checkFiles()` 逐个确认文件是否还在**，缺失的标红。

### 3.6 通知与托盘

`notifier.js` 用 Electron `Notification`，仅在 `settings.notificationsEnabled` 且窗口不可见时弹；
点击通知 → `openMail()` → 显示窗口 + `webContents.send('mail:open', item)` → 渲染层跳转并打开。

托盘菜单：显示主窗口 / 立即同步 / 通知开关 / 开机自启开关 / 退出。
关闭窗口默认隐藏到托盘（`settings.minimizeToTray`），真正退出走托盘"退出"或 `isQuitting`。

---

## 4. 数据存储

### 4.1 数据目录解析顺序（`main/main.js: 24-29`）

1. `MAILHUB_DATA_DIR` 环境变量（测试、便携、演示）
2. 打包版：`<安装目录>\data`（装在 D 盘数据就在 D 盘）
3. 开发版：`%APPDATA%\MailHub\data`

Electron 自己的 profile（localStorage、GPU 缓存）始终在用户数据目录；用 `MAILHUB_DATA_DIR` 时会整体重定向到 `<dataDir>\electron-profile`。

启动时会做一次性迁移：旧位置 `%APPDATA%\MailHub\data` 有 `accounts.json` 而新位置没有，就 `cpSync` 复制过去（**复制不移动**，旧数据保留）。
目录不可写（例如装进 Program Files）时回退到用户数据目录，避免启动即崩。

### 4.2 文件布局

```
<dataDir>/
  accounts.json          { accounts: [{ id, label, email, provider, color, username,
                                        imap:{host,port,secure}, smtp:{...},
                                        secret:{enc:'os'|'plain', value}, createdAt,
                                        lastSyncAt, syncError }] }
  settings.json          见 store.js: DEFAULT_SETTINGS
  cache/<accountId>.json { accountId, updatedAt, folders:[{ path, label, specialUse,
                            messages:[{uid,subject,fromName,fromAddress,to,cc,date,
                                       seen,flagged,hasAttachments,size,snippet}],
                            total, unseen }] }
  bodies/<accountId>/<sha1(folder) 前12位>/<uid>.json      解析后的正文
  bodies/<accountId>/<sha1(folder) 前12位>/<uid>-att-<i>-<name>  附件实体
```

### 4.3 密码

`safeStorage.encryptString()` → `{enc:'os'}`；系统密钥不可用时退化为 base64 `{enc:'plain'}`，`state:boot` 会返回 `encryptionAvailable: false`，设置页有风险提示。密码永不出现在 `listAccounts()` 的返回里（只返回 `hasPassword` / `passwordMode`）。

### 4.4 容量上限

| 项 | 上限 | 位置 |
| --- | --- | --- |
| 每文件夹缓存邮件数 | 800 | `store.js: MAX_MESSAGES_PER_FOLDER` |
| 单封原始大小 | 35 MB | `mail.js: MAX_SOURCE_BYTES` |
| 单封附件合计落盘 | 40 MB | `mail.js: MAX_ATTACHMENT_BYTES` |
| 单封内嵌图片合计 | 3 MB | `mail.js: MAX_INLINE_IMAGE_BYTES` |
| 设置页"清空缓存" | 删除 `cache/` + `bodies/`，保留账号 | `ipc.js: cache:clear` |

---

## 5. 前端

### 5.1 DOM 骨架（`renderer/index.html`）

```
.titlebar        44px 自绘标题栏：品牌 + 当前视图 + 写邮件/设置按钮（右侧留出原生窗口按钮）
.app
 ├─ .rail        68px  分拣格：统一收件箱、账号标签、写邮件、同步、添加账号
 ├─ .sidebar    212px  台账：当前视图的文件夹清单 / 统一视图下的账号花名册
 ├─ .main       368px  清单：范围标题、搜索、过滤 chip、邮件列表
 └─ .reading-pane     信纸：阅读区 / 空状态
```

弹窗（都挂 `#app` 下，`.modal-backdrop`）：账号编辑、写信、设置、通用确认框（`#confirm-modal`）。

### 5.2 渲染层状态（`renderer/app.js: state`）

| 字段 | 含义 |
| --- | --- |
| `accounts` / `caches` / `settings` | 启动时一次性拉取，之后由 IPC 返回值本地更新 |
| `view` | `{type:'all'\|'account', accountId, folder}` |
| `selectedKey` | `accountId::folder::uid`，当前打开的邮件 |
| `bodies` | `Map<key, body>`，已打开的正文缓存 |
| `compose` | `{mode, accountId, attachments, replyMessage}` |
| `search` / `filter` | 列表过滤条件（`all` / `unread` / `flagged` / `attachment`） |
| `theme` | `light` / `dark`（解析后的实际主题） |

渲染原则：任何状态变化 → 改 `state` → `renderAll()`（或局部 `renderList` / `renderReading`）全量重绘。
没有虚拟 DOM，列表规模上限 800 封，直接 `innerHTML` 足够快。

### 5.3 CSS 设计系统（`renderer/styles.css: :root`）

所有颜色、阴影、圆角、字体都走变量，深色主题只覆盖 `:root[data-theme='dark']`。

| 变量组 | 浅色 | 深色 |
| --- | --- | --- |
| 背景 | `--bg:#ecefea` `--surface:#fff` `--surface-2:#f6f7f3` | `#0d1210` / `#141a17` / `#111714` |
| 正文 | `--text:#16201c` `--text-2:#4f5b54` `--text-3:#616c65` | `#e5ebe7` / `#a7b3ac` / `#849089` |
| 交互色 | `--accent:#0f6b5b` `--accent-strong:#0a5449` | `#4fb3a2` / `#6cc9b9` |
| 未读 | `--red:#a63a2f`（邮戳红，只表达状态） | `#e0796f` |
| 危险 | `--danger:#a8322a` | `#e0796f` |
| 字体 | `--font` 系统无衬线 / `--serif` 宋体类 / `--mono` 等宽 | 同 |

对比度要求：正文级文本 ≥ 4.5:1（`qa-visual.mjs` 会实测，改动颜色后必须重跑）。

### 5.4 主题

- 设置项 `theme: 'system' | 'light' | 'dark'` → `main.js: applyThemeSource()` 设置 `nativeTheme.themeSource`
- 渲染层 `applyTheme()` 把结果写到 `<html data-theme="...">`，CSS 变量随之切换
- 窗口底色 `windowBackground()` 和标题栏 overlay `titlebarTheme()` 必须与 CSS 的 `--bg` / `--surface-2` **完全一致**，否则标题栏接缝会露出色差（这是之前修过的 bug）
- 标题栏高度三处必须同步：`main.js: TITLEBAR_HEIGHT = 44`、`styles.css: --titlebar-h: 44px`、`.titlebar` 实际高度

### 5.5 深色正文算法（`renderer/app.js: applyDarkEmail`）

邮件正文是第三方 HTML，颜色不可控。做法：

1. 遍历 iframe 内元素，取计算样式的 `color` / `backgroundColor`
2. 只处理**浅底**（`relativeLuminance > 0.55`）的块级容器，按 HSL 亮度映射到深色纸面 `#141a17`，文字映射到 `#dfe6e1`
3. 跳过 `IMG / VIDEO / IFRAME / SVG / CANVAS` 以及 `closest('svg')`，避免把图片反色
4. `settings.darkMailBody = false` 时完全不执行

### 5.6 常见修改入口

| 想改 | 改哪里 |
| --- | --- |
| 配色 / 圆角 / 间距 | `renderer/styles.css` 的 `:root` 变量，不要硬编码颜色 |
| 列表行长什么样 | `renderList()` + `.msg-item` 相关 CSS |
| 阅读区布局 | `renderReading()` + `.reader-*` CSS |
| 加一个设置项 | `store.js: DEFAULT_SETTINGS` → `index.html` 设置弹窗 → `app.js: openSettings/saveSettings` → 需要生效的模块监听 `settings:changed` |
| 加一个 IPC 接口 | `ipc.js` 加 `handle()` → `preload.js` 加方法 → `app.js` 调用 |
| 加服务商 | `providers.js: PRESETS` + `DOMAIN_RULES` |
| 托盘菜单 | `main/tray.js: buildMenu()` |
| 通知文案 | `main/notifier.js` |

---

## 6. IPC 契约

所有 `invoke` 统一返回 `{ ok: true, data }` 或 `{ ok: false, error: '可读中文错误' }`（`ipc.js: handle()` 包装）。
渲染层调用统一 `const result = await api.xxx(); if (!result.ok) ...`。

### 6.1 请求（渲染 → 主）

| 通道 | 参数 | 返回 |
| --- | --- | --- |
| `state:boot` | — | accounts、caches、settings、presets、version、dataDir、platform、packaged… |
| `accounts:add` | `payload` | 新账号（不含密码） |
| `accounts:update` | `id, patch` | 更新后的账号 |
| `accounts:remove` | `id` | true |
| `accounts:test` | `config`（`password:'__stored__'` 表示用已存的） | 连接测试结果 |
| `sync:account` | `id` | `{ cache, account }` |
| `sync:all` | — | `{ results, accounts, reason, at }` |
| `sync:folder` | `id, folderPath` | `{ cache }` |
| `message:open` | `id, folderPath, uid` | 正文对象 |
| `message:flags` | `id, folderPath, uid, flags` | IMAP 结果 |
| `message:delete` | `id, folderPath, uid` | 删除结果 |
| `mail:markAllRead` | `id, folderPath` | `{ count }` |
| `mail:send` | `accountId, payload` | `{ messageId, accepted, rejected, savedToSent, warning, cache }` |
| `dialog:pickFiles` | — | 路径数组 |
| `files:check` | `paths[]` | `[{path, exists}]` |
| `attachment:save` | `id, folderPath, uid, index` | `{ saved, path }` |
| `attachment:open` | `id, folderPath, uid, index` | true |
| `settings:set` | `patch` | 完整设置 |
| `app:status` | — | 未读数、缓存大小、同步间隔、推送状态、托盘信息… |
| `app:testNotification` | — | 通知测试结果 |
| `cache:clear` | — | `{ freed }` |
| `shell:openExternal` | `url` | true（只允许 http/https/mailto） |
| `app:openDataDir` | — | true |
| `app:stats` | — | `{ accounts, messageCount }` |
| `app:showWindow` | — | true |

### 6.2 事件（主 → 渲染）

| 通道 | 负载 | 触发时机 |
| --- | --- | --- |
| `sync:progress` | `{ accountId, folder, done, total }` | 同步过程中 |
| `sync:finished` | `{ results, accounts, reason, at }` | 一次同步结束（手动/定时/唤醒/IDLE） |
| `mail:open` | `{ accountId, folder, uid, … }` | 点击系统通知 |
| `push:status` | `{ enabled, idleCount, accounts:[{id,state,detail}] }` | IDLE 状态变化 |
| `settings:changed` | 完整 settings | 托盘切换开关 |

### 6.3 新增一个 IPC 的三处改动

1. `main/ipc.js`：`handle('your:channel', async (event, ...args) => { ... })`
2. `preload/preload.js`：`yourMethod: (...args) => invoke('your:channel', ...args)`
3. `renderer/app.js`：`const res = await api.yourMethod(...)`

---

## 7. 关键决策与坑（改之前务必看）

| # | 事实 | 为什么 | 位置 |
| --- | --- | --- | --- |
| 1 | `envelope.from` 必须等于登录账号 | 163 校验信封发件人，不一致会把信标记为发送失败 | `sender.js:86` |
| 2 | 发信后先 `sleep(1200)` 再查重 | 服务商异步写"已发送"，立刻查会误判没写而重复追加 | `sender.js:128` |
| 3 | 已发送副本按 `Message-ID` 去重 | 163/QQ/Gmail 自己会存一份，重复 APPEND 会出现两封且第二封无"发送成功"标记 | `sender.js:39-47` |
| 4 | 首次同步不弹通知 | 本地无缓存时 `before.count === 0`，否则一次弹上百条 | `sync-manager.js:123` |
| 5 | IDLE 进入 `auth-error` 前必须 `clearTimeout(reconnectTimer)` | 否则挂起的重连定时器会把连接"复活"，状态自相矛盾（已修复的 bug） | `idle-manager.js:177-205` |
| 6 | `autoIdleDelay: 1500` | imapflow 默认空闲 15s 才进 IDLE，加账号后要干等 | `idle-manager.js:109` |
| 7 | IDLE 断线退避 5s → 5min 封顶 | 避免服务器拒绝时高频重连 | `idle-manager.js:14-15` |
| 8 | 服务器不支持 IDLE → 关闭连接并标记 `unsupported` | 否则会占着一条无用连接 | `idle-manager.js:132-136` |
| 9 | 标题栏 44px 三处一致 | 主进程 overlay 高度、CSS 变量、`.titlebar` 实际高度不一致会露白边 | `main.js` / `styles.css` |
| 10 | 拖拽附件用 `webUtils.getPathForFile()` | 渲染进程拿到的 `File` 没有 `path` 属性 | `preload.js:35` |
| 11 | 升级必须保留 `<install>\data` | electron-builder 默认升级时会递归删 `$INSTDIR`，会丢账号和邮件 | `build/installer.nsh` |
| 12 | 卸载会删除 `data\` | 有意为之，README 已提示备份 | `build/installer.nsh` |
| 13 | 打包版装在**非 ASCII 路径**可能崩（`0x80000003`） | Chromium 对安装路径有编码限制；`dist\` 里打包没事，安装目录别用中文 | 已知限制 |
| 14 | 演示模式不启动 IDLE | `provider: 'demo'` 的账号没有真实服务器，状态显示"演示模式不建立即时推送连接" | `idle-manager.js: ensure()` |
| 15 | 单实例锁 | 第二个实例只 `showWindow()`，避免两个进程同时写 `accounts.json` | `main.js:325` |
| 16 | 关闭窗口 ≠ 退出 | `minimizeToTray` 为真时 `preventDefault()` 后隐藏，后台继续收信 | `main.js:155-173` |
| 17 | 数据目录不可写要回退 | 装进 Program Files 时 `$INSTDIR\data` 不可写，必须退到用户目录 | `main.js:338-343` |

---

## 8. 开发、测试与发布

### 8.1 首次运行

本仓库**不包含** `node_modules`。装依赖：

```powershell
npm install
```

如果本地没有 `electron` 二进制（例如公司镜像拉不到），可以用全局安装的 Electron：

```powershell
$env:ELECTRON_BIN = "C:\Users\<you>\AppData\Roaming\npm\node_modules\electron\dist\electron.exe"
npm start
```

打包同理：`package.json` 的 `build.electronDist` 支持指定现成 Electron 目录（本机历史上用过全局安装的 electron）。

### 8.2 演示模式（不碰真实邮箱）

```powershell
$env:MAILHUB_DEMO = "1"
$env:MAILHUB_DATA_DIR = "$env:TEMP\mailhub-demo"
npm start
```

会注入 3 个演示账号（工作邮箱 / 订阅与账单 / 个人 Gmail）、16 封邮件，`provider: 'demo'` 的账号不发任何网络请求。
测试脚本默认也是这个模式——**任何自动化测试都必须这样跑，绝不能指向 `%APPDATA%\MailHub\data`**。

### 8.3 测试套件

仓库根目录的 `qa-*.mjs` / `qa-*.cjs` 是自建的验收脚本，不是标准测试框架，直接 `node` 运行。
它们会启动真实 Electron（走 CDP 远程调试）或做纯单元测试。

| 脚本 | 类型 | 覆盖 | 条数 |
| --- | --- | --- | --- |
| `qa-ui.mjs` | CDP | 列表、头像、搜索过滤、阅读区、深色正文、确认框、标为已读、无控制台错误 | 29 |
| `qa-layout.mjs` | CDP | 四栏宽度、统一/单账号切换、信纸圆角与衬线标题、邮戳红、窄窗口不溢出 | 17 |
| `qa-titlebar.mjs` | CDP | 标题栏高度/主题/拖动区、原生按钮预留宽度 | 11 |
| `qa-compose.mjs` | CDP | 写信弹窗、附件 chip、拖拽落区、草稿恢复 | 10 |
| `qa-visual.mjs` | CDP | 颜色对比度实测、横向溢出检测（多分辨率） | 动态 |
| `qa-idle.cjs` | 单元 | IDLE 状态机（mock imapflow）：去抖、退避、auth-error、unsupported | 20 |
| `qa-idle-real.cjs` | 网络 | 真实账号的 IDLE 验证（需要授权码，平时跳过） | 7 |
| `qa-send.cjs` | 单元 | 发信：envelope、Message-ID 去重、乐观缓存 | 9 |
| `qa-payload.cjs` | 构建产物 | 解包 `dist\*.exe` 或 asar，检查布局标记、拖拽、发信代码是否真的打进去 | 11 |
| `qa-packaged.mjs` | 构建产物 | 用 `QA_EXE` 指向解包目录，验证打包版能启动、主题、推送区块、无报错 | 9 |

注意事项：

- 同时跑会抢 CDP 端口（9333–9336）和 `MAILHUB_DATA_DIR`，**串行执行**
- `qa-ui.mjs` 启动时会清空 `.qa-shots/`，截图按需重跑对应脚本
- 测试结束务必确认 Electron 进程已退出（脚本内有 `kill`，但异常中断需手动 `Stop-Process`）

手工验收清单（发版前）：

- [ ] 添加一个真实账号 → 收件箱能拉取 → 打开一封 HTML 邮件图片正常
- [ ] 写一封带附件的信 → 收件方收到 → 自己的"已发送"只有一封
- [ ] 托盘右键"立即同步" → 有新邮件时系统通知可点击跳转
- [ ] 关闭窗口 → 托盘可见、后台仍在同步 → 托盘退出后进程消失
- [ ] 浅色/深色切换 → 标题栏、列表、阅读区无白色闪块
- [ ] 升级安装 → 账号与缓存保留

### 8.4 构建

```powershell
npm run dist
```

产物：

```
dist\MailHub-Setup-<version>.exe          安装包（NSIS，per-user）
dist\win-unpacked\                        未打包目录（可用 qa-packaged.mjs 验证）
dist\MailHub-Setup-<version>.exe.blockmap 增量更新用
```

打包后建议验证：

```powershell
node qa-payload.cjs "dist\MailHub-Setup-<version>.exe"   # 检查 asar 里真的有新代码
$env:QA_EXE = "dist\win-unpacked\MailHub.exe"
node qa-packaged.mjs                                     # 检查打包版能启动
```

### 8.5 发布

1. 改 `package.json` 的 `version`
2. 更新 `README.md` 顶部版本说明和 `docs/HANDOFF.md` 的版本号
3. `npm run dist`
4. `git commit` + `git push`
5. `gh release create v<version> dist\MailHub-Setup-<version>.exe --title ... --notes ...`

安装包约 96–100 MB。仓库**不提交** `dist/`（`.gitignore` 已排除），只通过 Releases 分发，避免仓库膨胀。

---

## 9. 代码风格与约定

- **CommonJS**：`require` / `module.exports`，不用 ESM；主进程无 TypeScript
- **中文优先**：所有 UI 文案、代码注释、错误信息都是中文；新增也一样
- **HTML 转义**：渲染用户数据一律走 `esc()`，不要直接拼 `innerHTML`
- **事件**：列表/弹窗用事件委托，`bindEvents()` 里集中绑定一次
- **CSS**：只加变量、不硬编码颜色；深色主题只覆盖变量，不写 `!important`
- **IPC**：错误用 `throw new Error('中文可读原因')`，由 `handle()` 统一包装
- **提交信息**：`类型: 简述`，类型用 `feat / fix / style / docs / refactor / build / test`（例：`feat: 收件箱支持 IMAP IDLE 实时推送`）
- **不要**：引入构建工具、前端框架、CSS 预处理器、新的原生依赖（会破坏"clone 即跑"）

---

## 10. 已知限制与技术债

| 项 | 现状 | 影响 |
| --- | --- | --- |
| `renderer/app.js` 2140 行 | 单文件包含全部渲染逻辑 | 改复杂交互时注意函数边界，别再拆出新的全局变量 |
| `renderer/styles.css` 2393 行 | 单文件，按注释分节 | 新增样式请放到对应分节，不要堆到文件末尾 |
| 无单元测试框架 | 只有 `qa-*.cjs` 自建断言 | 无法 CI；改核心逻辑时优先补 `qa-idle.cjs` / `qa-send.cjs` 这类纯单元脚本 |
| 无 CI | 依赖本机 Electron | 发布前必须手工跑 §8.3 |
| 全文搜索 | 只搜缓存中的主题/发件人/摘要 | 搜不到正文内容 |
| Outlook | 需要 OAuth2，未实现 | README 已注明 |
| 大附件 | > 40 MB 不落盘、> 35 MB 正文不打开 | 明确报错 |
| 非 ASCII 安装路径 | 可能崩溃 | 安装时选英文路径 |

路线图（与 README 保持一致）：全文搜索索引、邮件规则、OAuth2（Outlook/Gmail）、多语言、附件内预览。

---

## 11. 给接手的 AI agent 的工作守则

1. **先读这份文档 + `AGENTS.md`**，再动代码。
2. **绝不触碰真实用户数据**：`%APPDATA%\MailHub\data`、以及已安装版本的 `<install>\data` 里是真实账号和邮件。所有调试用 `MAILHUB_DEMO=1` + 临时 `MAILHUB_DATA_DIR`。
3. **不要擅自安装/卸载**用户机器上的 MailHub；不要打包发版，除非用户明确要求。
4. **改动后自证**：UI 改动至少跑 `qa-titlebar.mjs` + `qa-layout.mjs`；动同步/IDLE 跑 `qa-idle.cjs`；动发信跑 `qa-send.cjs`；颜色改动跑 `qa-visual.mjs`。报告时给出通过数，不要只说"已完成"。
5. **不要伪造测试结果**：跑不了就说明原因（缺授权码、端口占用），不要编造数字。
6. **保持行文语言一致**：代码注释、UI 文案、提交信息都用中文。
7. **改 IPC / 数据结构要兼容旧缓存**：`store.loadCache()` 对缺字段有兜底，但删除字段前先确认 `renderer/app.js` 不再读取。
8. **测试脚本产生的临时目录**（`.qa-data*`、`.qa-shots/`、`.qa-installer/`）都在 `.gitignore` 里，别提交。

---

## 附：一次典型改动的工作流

以"给列表加一个'仅看今天'过滤器"为例：

1. `renderer/app.js: collectMessages()` 加 `filter === 'today'` 分支（比较 `message.date` 是否在当天）
2. `renderer/index.html` 的 `.chip-row` 加一个 chip（`data-filter="today"`）
3. `renderer/app.js: bindEvents()` 里处理 chip 点击 → 改 `state.filter` → `renderList()`
4. `renderer/styles.css` 的 `.chip` 分节确认选中态样式已覆盖新 chip
5. `node qa-ui.mjs` + `node qa-layout.mjs` 确认没回归
6. 提交：`feat: 邮件列表支持仅看今天`

如果是主进程侧的功能（例如"同步间隔支持 30 秒"）：

1. `store.js: DEFAULT_SETTINGS` 与校验
2. `sync-manager.js: applySettings()` 的间隔计算
3. `index.html` + `app.js` 设置项
4. `node qa-idle.cjs`（确认没有影响 IDLE 与轮询的协作）