# AGENTS.md

给在这个仓库里工作的 AI agent 的规则。人类读者请先看 [`docs/HANDOFF.md`](docs/HANDOFF.md)（完整交接文档：架构、数据流、IPC、坑）。

## 这是什么

MailHub：Windows 桌面多邮箱客户端，Electron 43 + 原生 JS（无框架、无构建步骤），真实 IMAP/SMTP。
版本号在 `package.json`；发布走 GitHub Releases。

## 命令

```powershell
npm start                              # 开发运行
npm run dist                           # 打 NSIS 安装包 → dist\MailHub-Setup-<version>.exe
node qa-titlebar.mjs                   # 真实 Electron 回归（任选一个 qa-*.mjs）
node qa-idle.cjs                       # IDLE 状态机单元测试
node qa-send.cjs                       # 发信单元测试
node qa-payload.cjs "dist\MailHub-Setup-<version>.exe"   # 校验打包产物
```

`node_modules` 不在仓库里，先 `npm install`。若本机 Electron 二进制缺失，用全局安装的
`electron.exe`（`package.json` 的 `build.electronDist` 支持指定目录）。

## 红线

1. **真实数据不可碰**：`%APPDATA%\MailHub\data`、已安装版本的 `<install>\data` 存着用户真实账号与邮件。
   一切调试用演示模式：

   ```powershell
   $env:MAILHUB_DEMO = "1"
   $env:MAILHUB_DATA_DIR = "$env:TEMP\mailhub-demo"
   ```

2. **不擅自安装/卸载**用户机器上的 MailHub；**不打包发版**，除非用户明确要求。
3. **不提交** `dist/`、`node_modules/`、`data/`、`.qa-shots/`、`.qa-data*/`（`.gitignore` 已覆盖）。
4. **不伪造测试结果**：跑不了就说明原因（缺授权码、端口占用、无显示器），不要编造通过数。

## 改动后必须自证

| 改动范围 | 至少跑 |
| --- | --- |
| 渲染层 / 布局 / 样式 | `node qa-titlebar.mjs` + `node qa-layout.mjs`（+ `qa-visual.mjs` 若动颜色） |
| 同步 / IDLE | `node qa-idle.cjs` |
| 发信 / 已发送 | `node qa-send.cjs` |
| 打包配置 | `node qa-payload.cjs` + `node qa-packaged.mjs`（需 `QA_EXE`） |

报告时给出"通过 X/X"，并说明修了什么、验证了什么。

## 约定

- CommonJS、无 TypeScript、不引入框架/打包器/CSS 预处理器（保持 clone 即跑）
- UI 文案、注释、提交信息一律中文；提交格式 `类型: 简述`（`feat/fix/style/docs/refactor/build/test`）
- 颜色只走 `renderer/styles.css` 的 `:root` 变量，深色主题只覆盖变量
- 渲染用户数据必须经过 `esc()`
- 新增 IPC 要同时改三处：`main/ipc.js` → `preload/preload.js` → `renderer/app.js`

## 最容易踩的坑

- 163 发信：`envelope.from` 必须等于登录账号，否则被判失败
- 已发送副本：先等 1.2s 再按 `Message-ID` 查重，不要无脑 APPEND
- 标题栏高度 44px 在三处必须一致（`main.js`、`--titlebar-h`、`.titlebar`）
- 升级安装必须保留 `<install>\data`（`build/installer.nsh`），否则用户数据全丢
- 打包版装在非 ASCII（中文）路径可能崩溃

其余细节见 [`docs/HANDOFF.md`](docs/HANDOFF.md) 的 §3（数据流）、§6（IPC）、§7（坑）。