# DeepSeek Harness Desktop

English | [中文](README.md)

A desktop client for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (Electron + TypeScript).

## License & Terms of Use

This project is licensed under a **custom license** (see [LICENSE](LICENSE)). Core terms:

- **No commercial use**: No derivative project may be used for commercial purposes (except DeepSeek AI, the author, project contributors, and individuals/organizations with the author's explicit written authorization).
- **Must stay open source**: Any derivative project must publish its source code and comply with this license.
- **Broader grants**: The author reserves the right to grant broader terms (including commercial use) to specific individuals/organizations with explicit written authorization; without it, the default terms apply.
- Third-party dependencies (DeepSeek Harness, `@tencent-connect/qqbot-nodejs`, Electron, etc.) follow their own licenses; see "Credits" below.

## Privacy

- Release packages (installer exe / zip) contain only application code and runtimes — **no** local configuration, wallpapers, access tokens, API keys, session data, or logs.
- User wallpapers, tokens, and configuration live under the system user directory (`%APPDATA%/DeepSeek Harness Desktop`) and never enter the packages or the repository.
- The installer **never deletes user data**: uninstallation keeps `%APPDATA%` config and wallpapers (`deleteAppDataOnUninstall = false`).
- Building from source produces the same privacy guarantees.

## Download & Install

Download from [GitHub Releases](https://github.com/xiaowei2025cqu23phy/dsh-desktop/releases). Three forms:

| Form | File | Notes |
|---|---|---|
| **Installer (recommended)** | `DeepSeek-Harness-Desktop-Setup-*.exe` | NSIS installer; double-click to install; creates Start Menu and desktop shortcuts; optional install directory |
| Portable | `DeepSeek.Harness.Desktop-*.win.zip` | Extract and run; no installation; great for USB drives |
| From source | Clone repo, `npm install && npm start` | Build it yourself |

Uninstalling keeps user config and wallpapers (does not delete `%APPDATA%`); for a full cleanup remove `%APPDATA%/DeepSeek Harness Desktop` manually.

> Requirements: Windows x64, Node.js 18+ (only needed when the desktop app manages/hosts the harness).
> Tip: Run `npx @deepseek-ai/dsh web` and configure a model API key first for the best experience.

> 📖 Step-by-step installation, configuration, phone and QQ-bot usage: [Hands-on Guide (bilingual)](docs/USAGE.md). Hook up DingTalk / Feishu / Home Assistant / iOS Shortcuts and more: [Integration Guide](docs/INTEGRATIONS.md).

## Features

- **Embedded Web UI**: native control bar + the full harness Web UI (sessions, tools, plugins).
- **AI Screensaver (system screensaver replacement)**: after N idle minutes, a fullscreen view shows the agent working live (reasoning, text stream, tool calls); click, key, wheel, or touch exits instantly. Can be registered as the Windows system screensaver.
- **Model selection**: quick default-model switching (DeepSeek official, OpenAI, Anthropic, 37+ catalog providers), plus custom OpenAI-compatible gateways (corporate gateways, Ollama local, etc.); API keys are written securely via `credentials.set`.
- **Harness hosting**: auto-detects a running `dsh web`, spawns one if missing (default `npx @deepseek-ai/dsh web`), restarts on crash, and takes over automatically when an external instance disappears.
- **Wallpapers**: separately customizable for the main window / phone PWA / screensaver, with a crop editor, position offset, and mask control.
- **Phone remote control (PWA)**: scan the QR code to connect over LAN — session messaging, workspace selection, task execution, live streaming; add to home screen as an app.
- **QQ bot channel (optional)**: control the computer from anywhere via QQ — run tasks, check progress, and even enter a continuous chat mode inside a workspace.
- **System tray**: auto-start on boot, one-click screensaver, quick Web UI access.

## Demos

**Main window with wallpaper pass-through** (the main-window wallpaper shows through the embedded chat pages):

![Main window demo](assets/demo-main.gif)

**Phone PWA remote control** (scan to connect → pick workspace & model → run a task → watch it live):

![Phone remote control demo](assets/demo-remote.gif)

**AI screensaver** (fullscreen live agent view when idle; wallpaper fully customizable):

![AI screensaver demo](assets/demo-screensaver.gif)

> Recorded with the built-in "whale ocean" sample wallpaper — no personal wallpapers or session content involved.

## Quick Start

```sh
npm install
npm start        # build and launch the desktop app
```

On first launch it probes `http://127.0.0.1:3080`: an existing harness is adopted; otherwise it runs `npx --yes @deepseek-ai/dsh web --port 3080` automatically (requires Node.js 18+).

## Phone Remote Control (PWA)

Enable it in **Settings → Remote Access**. The desktop app starts a LAN gateway (default port 3082, Bearer token auth):

1. Connect the phone to the same Wi-Fi and scan the **QR code** in the settings panel (or open `http://<PC-IP>:3082` in a browser).
2. The PWA fills in the address and token automatically; add it to the home screen to use it like an app.

Phone features: session list / history / real-time streaming chat / stop tasks; one-click task runner (description + workspace + model); workspace list & creation; security: Bearer token + RPC allowlist (the phone cannot change settings, read secrets, or touch the filesystem), LAN only.

## QQ Bot Remote Control (optional)

In **Settings → QQ Bot**, fill in the AppID/AppSecret from the [QQ Open Platform](https://q.qq.com) (empty = disabled). You can also set a **default workspace/directory** (used when a task command does not specify one). Private-chat the bot; sending anything unrecognized replies with the full command set and examples:

| Command | Description | Example |
|---|---|---|
| `状态` / `会话` / `工作区` / `模型` | Status / sessions / workspaces / models | `状态` |
| `任务 <description>` | Run a task in the default workspace | `任务 分析这个仓库的架构` |
| `任务 @<workspace> <description>` | Run in a specific workspace | `任务 @qqbot 修复登录 bug` |
| `任务 目录:<path> <description>` | Run in a specific directory | `任务 目录:D:/work 写一个脚本` |
| `进入 <workspace/dir>` | **Enter chat mode** (no argument = pure chat, no workspace bound) | `进入 qqbot`、`进入` |
| *(chat mode)* | Send messages directly to chat continuously in that workspace; `退出` ends it | `帮我看看项目里的 TODO` → … → `退出` |
| `进展 <sessionId>` | Live task progress (status / tool stats / latest output) | `进展 session-xxxxxxxx` |
| `停止 <sessionId>` / `打开 <sessionId>` | Stop a task / view session content | `停止 session-xxxxxxxx` |
| `允许` / `拒绝` | **Approval replies**: allow/reject a pending permission request (add a session id when several are pending) | `允许`、`拒绝 session-xxxxxxxx` |
| `选 <number>` | **Question replies**: answer an agent question (multi-select `选 1 3`, custom `选 自定义:…`, batch `#2 选 1`) | `选 2` |

Typical flow: `工作区` to list → `进入 qqbot` → chat freely → `退出`.

Built on [@tencent-connect/qqbot-nodejs](https://github.com/tencent-connect/qqbot-nodejs) (WebSocket gateway); protocol references: [QQ Open Platform API v2](https://bot.q.qq.com/wiki/develop/api-v2/) and the [Agent QQBot guide](https://bot.q.qq.com/wiki/agent-qqbot/). QQ official bots are mainly **passive-reply**, but within 48h of a user interaction they support **proactive push**; long replies are split automatically. When the agent needs **approval or an answer, a notification is pushed immediately** (QQ within the interaction window, and Telegram), and if the push fails, pending items are still appended to the next reply as a reminder. The phone PWA shows approval/question cards inline so you can allow/deny or answer in one tap.

## Development

```sh
npm run build    # tsc compiles main/preload/renderer into dist/
npm start        # build + electron .
npm run smoke    # smoke test: RPC client + model catalog (needs a running harness)
npm run pack     # package Windows installer + zip (electron-builder)
npm run pack:portable   # single-file portable exe
```

Debug switches:

- `--remote-debugging-port=9222` enables CDP; inspect pages with `node scripts/cdp-eval.mjs '<expr>'`.
- `--ss-debug` keeps the screensaver window open (disables idle-exit) for debugging.
- `node scripts/mux-test.mjs <baseUrl>` end-to-end pipeline test (consumes a few model calls).

### Structure

```
src/main/          main process
  index.ts         entry (single-instance lock, /s screensaver arg, event hub wiring)
  harness.ts       harness process hosting (probe/spawn/health/restart/takeover)
  client.ts        HTTP RPC client (POST /api/<method> + mux event stream)
  gateway.ts       LAN remote gateway (token auth, PWA hosting, RPC allowlist, SSE)
  models.ts        model catalog, default-model switching, custom provider wizard
  screensaver.ts   AI screensaver (idle detection, fullscreen window, task orchestration, system registration)
  qq-bot.ts        QQ bot adapter (commands, chat mode, progress summaries)
  qq-commands.ts   pure command parser (unit-testable)
  tray.ts          system tray
src/renderer/      renderer (classic scripts, no bundler)
  index.html       main window (control bar + webview)
  screensaver.html fullscreen screensaver (live agent view)
src/remote/        phone PWA (served by the gateway)
scripts/           smoke / e2e / unit-test scripts
```

### Harness wire protocol

The desktop app implements deepseek-harness's HTTP RPC protocol (`dsh-host-apiproxy`) directly:

- Unary calls: `POST /api/<method>` with `{type:'client-request', rpcId, method, payload}`; responses are `{type:'server-response', rpcId, result}`; loopback needs no token.
- Event stream: `GET /api/events.mux` (SSE on newer versions, WebSocket fallback on older ones); `session/event` frames drive the screensaver and remote clients.
- Key methods: `session.list/create/prompt/cancel/selectModel`, `host.describe`, `llm.providers/models/discoverModels`, `settings.update/mutate`, `credentials.set`.

Protocol details may evolve with the harness; the methods used come from the current `0.1.0-rc.x` `packages/host/apiproxy`.

## Credits

| Project | Contribution | License |
|---|---|---|
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | Core agent runtime and Web UI; this desktop app implements its HTTP RPC protocol directly | MIT |
| [tencent-connect/qqbot-nodejs](https://github.com/tencent-connect/qqbot-nodejs) | QQ Open Platform bot SDK (WebSocket gateway, messages) for the QQ channel | MIT |
| [tencent-connect](https://github.com/tencent-connect) org repos (bot-docs, botpy, …) | QQ Open Platform API and interaction docs | Their own licenses |
| [node-qrcode](https://github.com/soldair/node-qrcode) | QR code generation for phone pairing | MIT |
| [Electron](https://github.com/electron/electron) | Desktop application framework | MIT |
| [electron-builder](https://github.com/electron-userland/electron-builder) | Application packaging | MIT |

Thanks to the DeepSeek Harness community and everyone who provided feedback during testing.

## Known Limitations

- The screensaver is a **viewing mode**: interactions (input, approvals) happen back in the main Web UI; a session that needs confirmation waits and stays visible in the Web UI.
- System screensaver registration is Windows-only (registry-based; original settings are backed up before registering and restored on unregister); macOS/Linux use the built-in idle-detection mode instead.
- The event stream negotiates automatically: older harness versions only accept WebSocket (HTTP 426), newer ones also support SSE; both are compatible.
- The screensaver window follows system screensaver behavior (no auto-wake from sleep).
