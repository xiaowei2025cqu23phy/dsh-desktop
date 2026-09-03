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

> Requirements: Windows x64, Node.js 18+ (22 or 24 LTS recommended; only needed when the desktop hosts/manages the harness).
> Tip: Run `npx @deepseek-ai/dsh web` and configure a model API key first for the best experience.

### 🆕 Fresh-install in 3 steps (for new machines)

The installer ships without the agent runtime and without any config/keys (by design — privacy first). On a new PC:

1. **Install Node.js (LTS)** — download the Windows Installer (.msi, LTS 22/24) from https://nodejs.org/zh-cn/download and click through; or run `winget install OpenJS.NodeJS.LTS` in PowerShell. Verify with `node -v` in a new terminal. (Slow network? `npm config set registry https://registry.npmmirror.com`.)
2. **Install this desktop app** — download the installer above (or the portable zip) and run it.
3. **Add a model API key** — open the app → open the built-in Web UI (Settings → Service → Open Web UI) → Settings → Models, and enter a model API key (e.g. DeepSeek official). Keys stay on your machine.

> No manual dsh install needed: on first launch the desktop fetches the agent runtime via `npx`.
> Want the QQ bot too? Register a bot on the QQ Open Platform and paste AppID/Secret into Settings → QQ Bot (see [QQ-BOT.md](docs/QQ-BOT.md)).

> 📖 Step-by-step installation, configuration, phone and QQ-bot usage: [Hands-on Guide (bilingual)](docs/USAGE.md). Hook up DingTalk / Feishu / Home Assistant / iOS Shortcuts and more: [Integration Guide](docs/INTEGRATIONS.md). 🤖 Full QQ-bot guide (deploy/permissions/commands/FAQ): [QQ-BOT.md](docs/QQ-BOT.md). 📱 Phone PWA features: [PWA.md](docs/PWA.md).

## Features

## ✨ Highlights

- **Embedded Web UI**: native control bar + the full harness Web UI (sessions, tools, plugins).
- **AI Screensaver (system screensaver replacement)**: after N idle minutes, a fullscreen view shows the agent working live (reasoning, text stream, tool calls); click, key, wheel, or touch exits instantly. Built-in **task timeout guard** prevents runaway CPU loops; can be registered as the Windows system screensaver — idle time becomes productive time.
- **Phone remote control (PWA)**: scan the QR code to connect over LAN — send tasks, watch live streaming progress, stop tasks; **one-tap approval/question cards** — no more waiting forever when the agent asks for permission.
- **QQ / Telegram bot channels**: run tasks from group chat or DM; **proactive push** enabled (QQ 48h interaction window) — task done, failed, or needs approval, the bot comes to you; QQ approvals carry inline **Allow/Deny buttons**; **scan-to-login** grabs bot credentials automatically.
- **QQ bot experience (0.6.0)**: workspace-less tasks merge into one per-user default task session (no more session spam); pick a workspace with `任务 @workspace` or send tasks while inside a workspace chat; `进展` shows the phase (thinking/tool/output/done + product hint); tasks are silent by default, `播报` opts into 25s live digests; robot chats (DM & groups) live in a visible "机器人对话" workspace; **group chat is chat-only, commands are ignored** (plus a safety reminder) so strangers cannot drive your PC; full command set & deployment/permission guide: [QQ-BOT.md](docs/QQ-BOT.md).
- **Default chat mode**: with one toggle, plain messages enter pure chat directly (no workspace bound) — no command prefix needed.
- **Model selection**: quick default-model switching (DeepSeek official, OpenAI, Anthropic, 37+ catalog providers), plus custom OpenAI-compatible gateways (corporate gateways, Ollama local, etc.); API keys are written securely via `credentials.set`.
- **Harness hosting**: auto-detects a running `dsh web`, spawns one if missing (default `npx @deepseek-ai/dsh web`), restarts on crash, and takes over automatically when an external instance disappears.
- **Per-surface wallpapers + beads pixel filter**: separate wallpapers for main window / phone / screensaver, crop editor, position offset, mask; import your own images and pixelate them locally (no copyright issues); built-in whale wallpaper packs, one-click apply.
- **System tray**: auto-start on boot, one-click screensaver, quick Web UI access, update notifications.

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

Enable it in **Settings → Remote Access**. The desktop starts a LAN gateway (default port 3082, configurable, Bearer token auth):

1. Connect the phone to the same Wi-Fi and scan the **QR code** in the settings panel (or open `http://<PC-IP>:3082`).
2. The PWA fills in the address & token automatically; add it to the home screen to use it like an app.

> Security: remote access auto-disables 2 hours after enabling (expiry policy adjustable in settings); LAN only — never expose it via tunneling/port-forwarding.

Phone features:
- **Workspace-first new conversations** (same flow as harness Web): pick or create a workspace first, then start a conversation; new sessions land in the chosen workspace group (preset roots work as workspaces too)
- **Sessions**: list / history / live streaming / stop; send modes: queue, or steer (interrupt & insert)
- **Permission presets** per new session: workspace-write or danger-full-access (harness `/permission`; needs a recent harness)
- **Tasks**: description + workspace + model, run & watch live
- **Workspaces**: list / create / folder browsing; **file preview**: text/Markdown/images/video (mp4/webm)/audio/PDF — when the browser blocks inline PDF, use open-in-new-tab / download
- **Wallpaper**: built-in packs, or **upload a picture from the phone gallery** as wallpaper
- **Settings**: preset workspace roots (view/remove/browse-to-add), scheduled tasks, restart Harness
- **Auto-reconnect**: exponential backoff after network drops; returns to the same conversation
- **Security**: Bearer token + RPC allowlist + file-browse allowlist (workspaces/preset roots only, 403 otherwise), LAN only

## QQ Bot Remote Control (optional)

In **Settings → QQ Bot**, fill in the AppID/AppSecret from the [QQ Open Platform](https://q.qq.com) (empty = disabled). You can also set a **default workspace/directory** (used when a task command does not specify one). Private-chat the bot; sending anything unrecognized replies with the full command set and examples:

| Command | Description | Example |
|---|---|---|
| `状态` / `会话` / `工作区` / `模型` | Status / sessions / workspaces / models | `状态` |
| `任务 <description>` | Run a task in the default workspace | `任务 分析这个仓库的架构` |
| `任务 @<workspace> <description>` | Run in a specific workspace | `任务 @qqbot 修复登录 bug` |
| `任务 目录:<path> <description>` | Run in a specific directory | `任务 目录:D:/work 写一个脚本` |
| `进入` | **Pure chat**: no workspace bound, friend mode | `进入` |
| `进入 <workspace/dir>` | Chat inside that workspace (assistant mode) | `进入 qqbot`、`进入 D:/work` |
| *(chat mode)* | Just send messages, no prefix needed; the agent's reply is **pushed back automatically**, no "sent" noise; `退出` ends it | `帮我看看项目里的 TODO` → 💬 reply → `退出` |
| `进展 <sessionId>` | Live task progress (status / tool stats / latest output) | `进展 session-xxxxxxxx` |
| `停止 <sessionId>` / `打开 <sessionId>` | Stop a task / view session content | `停止 session-xxxxxxxx` |
| `允许` / `拒绝` | **Approval replies**: allow/reject a pending permission request (add a session id when several are pending) | `允许`、`拒绝 session-xxxxxxxx` |
| `选 <number>` | **Question replies**: answer an agent question (multi-select `选 1 3`, custom `选 自定义:…`, batch `#2 选 1`) | `选 2` |
| `定时 <duration> <task>` | **Scheduled tasks**: once (`10分钟`/`5m`/`2小时`/`1天`) or daily (`每天9:00`) | `定时 10分钟 检查更新` |
| `定时列表` / `取消定时 <index>` | List / cancel scheduled tasks | `取消定时 2` |
| `目录 <path>` / `文件 <path>` | Browse workspace dirs / view text files (allowlisted) | `目录 D:/work`、`文件 D:/work/README.md` |
| `导出 <sessionId>` | Export a session to Markdown (saved under the desktop `exports/` dir) | `导出 session-xxxxxxxx` |
| `用量` | Today's usage stats (sessions/turns/tokens) | `用量` |
| `角色 <setting>` | **Role-play**: set a character for chat mode (pure chat only); `角色 无` clears it | `角色 你是温柔的英语老师` |
| *(send an image in DM)* | **Image understanding**: in chat mode, send an image and the agent analyzes it | send a screenshot → `看看这张图有什么问题` |

**Buttons**: after a task starts, inline buttons appear — ⏹ Stop / 📋 Progress / 📖 Open; approvals carry ✅ Allow / ❌ Deny; single-choice questions carry option buttons — tap to act/answer, almost no typing needed.

**Mode prompts**: `任务 xxx` commands run the agent as a **professional assistant**; chat mode speaks like a **friend**. Both prompts are customizable in the desktop app (**Settings → QQ Bot**); leave blank to disable injection. **Role-play**: `角色 <setting>` adds a character to chat mode (e.g. "你是温柔的英语老师"), `角色 无` clears it; a default character can also be preset in the desktop app.

**Image understanding**: in chat mode, just send an image in a DM and the agent analyzes it — no extra configuration needed.

**Chat visibility**: QQ/Telegram chat sessions are pinned at the top of the phone PWA sidebar under "🤖 机器人对话" — open it to see the full conversation and follow it live (streaming).

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
- Key methods: `session.list/create/prompt/cancel/selectModel`, `host.describe`, `host.listEntries/readTextFile` (file explorer), `llm.providers/models/discoverModels`, `settings.update/mutate`, `credentials.set`.

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

### Acknowledgements

This project stands on the shoulders of many excellent open-source projects. Special thanks to:

| Project | Contribution |
|---|---|
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | The core agent engine and the HTTP RPC / event-stream protocol that the desktop app, phone PWA and bot channels are all built on |
| [tencent-connect/qqbot-nodejs](https://github.com/tencent-connect/qqbot-nodejs) | QQ Open Platform bot Node SDK: WebSocket gateway, messaging, proactive push (48h window) and inline-keyboard approval buttons |
| [tencent-connect/qqbot-agent-sdk](https://github.com/tencent-connect/qqbot-agent-sdk) | Reference implementation of scan-to-configure onboarding (`create_bind_task` / AES-GCM credential decryption) and approval inline keyboards |
| [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot) | The official QQ×DSH plugin: design reference for command sets, session mapping and event presentation |
| [Electron](https://github.com/electron/electron) & [electron-builder](https://github.com/electron-userland/electron-builder) | Desktop shell and packaging |
| [node-qrcode](https://github.com/soldair/node-qrcode) | QR generation for phone pairing and QQ scan login |

QQ bot protocol details follow the [QQ Open Platform API v2](https://bot.q.qq.com/wiki/develop/api-v2/) and the [Agent QQBot guide](https://bot.q.qq.com/wiki/agent-qqbot/).

If you maintain any of these projects — thank you for making this possible 🙏

## Support

Found it useful? Join the beta group for feedback and feature requests, or buy the author a coffee ☕

| Beta group (QQ) | WeChat reward |
|---|---|
| ![QQ group](assets/support/qq-group.jpg) | ![WeChat reward](assets/support/wechat-reward.png) |

Inside the group you can try the [QQ bot](docs/USAGE.md) directly — remote control, approvals and proactive reports.

## Known Limitations

- The screensaver is a **viewing mode**: interactions (input, approvals) happen back in the main Web UI; a session that needs confirmation waits and stays visible in the Web UI.
- System screensaver registration is Windows-only (registry-based; original settings are backed up before registering and restored on unregister); macOS/Linux use the built-in idle-detection mode instead.
- The event stream negotiates automatically: older harness versions only accept WebSocket (HTTP 426), newer ones also support SSE; both are compatible.
- The screensaver window follows system screensaver behavior (no auto-wake from sleep).
