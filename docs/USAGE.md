# DeepSeek Harness Desktop 实操指南 / Hands-on Guide

> 汉英双语 / Bilingual (中文 · English)

本指南带你从零开始使用 DeepSeek Harness 桌面端:安装、配置、AI 屏保、壁纸、手机远程控制、QQ 机器人。
This guide walks you through the desktop client end to end: installation, configuration, AI screensaver, wallpapers, phone remote control, and the QQ bot.

---

## 1. 安装与启动 / Install & Launch

**中文**

- **安装版(推荐)**:下载 `DeepSeek-Harness-Desktop-Setup-*.exe`,双击安装(可选安装目录),安装完成后自动创建开始菜单与桌面快捷方式。
- **便携版**:下载 `DeepSeek.Harness.Desktop-*.win.zip`,解压后直接运行 `DeepSeek Harness Desktop.exe`。
- **源码版**:`git clone` 后执行 `npm install && npm start`。
- 首次启动会自动探测 `http://127.0.0.1:3080`:
  - 已有 harness(`dsh web`)→ 直接接入;
  - 没有 → 自动执行 `npx --yes @deepseek-ai/dsh web --port 3080` 拉起;
  - 外部实例中途消失 → 桌面端自动接管重新拉起(断线自动接管)。

**English**

- **Installer (recommended)**: download `DeepSeek-Harness-Desktop-Setup-*.exe` and double-click (optional install directory); Start Menu and desktop shortcuts are created automatically.
- **Portable**: download `DeepSeek.Harness.Desktop-*.win.zip`, extract, and run `DeepSeek Harness Desktop.exe`.
- **From source**: `git clone`, then `npm install && npm start`.
- On first launch it probes `http://127.0.0.1:3080`:
  - an existing harness (`dsh web`) is adopted;
  - otherwise it runs `npx --yes @deepseek-ai/dsh web --port 3080` automatically;
  - if an external instance disappears, the desktop app takes over and respawns it automatically.

---

## 2. 首次配置 / First-time Configuration

**中文**

1. 先准备好模型:运行 `npx @deepseek-ai/dsh web`,打开 Web UI 的「设置 → Models」填入 API Key(如 DeepSeek 官方密钥)。
2. 打开桌面端,顶栏显示「已连接外部服务 / 运行中」即就绪;若显示「错误」,打开「设置 → Harness 服务」检查端口与启动命令。
3. 顶栏「默认模型」下拉框选择模型(如 `deepseek-official / deepseek-v4-flash`),选择即热生效并成为新会话默认。

**English**

1. Prepare a model first: run `npx @deepseek-ai/dsh web`, open **Settings → Models** in the Web UI and enter an API key (e.g. the official DeepSeek key).
2. Open the desktop app; the top bar shows "Connected / Running" when ready. If it shows "Error", check **Settings → Harness Service** for port and launch command.
3. Pick a model in the top-bar **Default Model** dropdown (e.g. `deepseek-official / deepseek-v4-flash`); the selection takes effect immediately and becomes the default for new sessions.

---

## 3. 模型管理与切换 / Model Management

**中文**

- **切换默认模型**:顶栏下拉框,选择后经 `session.selectModel` 持久化,无需重启。
- **添加自定义 Provider(OpenAI 兼容网关)**:「设置 → 添加自定义 Provider」→ 选预设(DeepSeek 官方 / OpenAI / Ollama 本地 / 自定义)→ 填 Base URL、模型 ID(逗号分隔)、API Key → 可点「从网关拉取模型」自动发现 → 保存后热生效。
- **完整模型管理**(密钥、目录厂商、推理参数):在内嵌 Web UI 的「设置 → Models」页面。

**English**

- **Switching the default model**: top-bar dropdown; persisted via `session.selectModel`, no restart needed.
- **Adding a custom provider (OpenAI-compatible gateway)**: **Settings → Add Custom Provider** → pick a preset (DeepSeek official / OpenAI / Ollama local / custom) → fill in Base URL, model IDs (comma-separated), API key → optionally click "Fetch models from gateway" → save; takes effect immediately.
- **Full model management** (keys, catalog providers, reasoning parameters): in the embedded Web UI's **Settings → Models**.

---

## 4. AI 屏保 / AI Screensaver

**中文**

1. 「设置 → AI 屏保」→ 勾选「启用空闲检测」,设置空闲分钟数(默认 5)。
2. 「自动启动 agent 任务」默认**关闭**——空闲只显示环境画面(时钟/状态),不消耗资源;勾选后填写任务提示词与工作目录,进入屏保时自动创建会话执行。
3. 「任务超时(分钟)」默认 10:超时未完成自动停止,防止失控循环烧 CPU。
4. 点击顶栏「▶ AI 屏保」可立即全屏预览;**点击、按键、滚轮、触摸立即退出**(鼠标移动不退出,避免抖动闪退)。
5. 退出后任务默认后台继续;下次进入「继续上次任务」。
6. 「注册为系统屏保」:Windows 锁屏/超时机制会用 `/s` 拉起应用直接进入全屏(注册前自动备份原设置,取消时恢复)。

**English**

1. **Settings → AI Screensaver** → enable "Idle detection" and set the idle minutes (default 5).
2. "Auto-start agent task" is **off by default** — idle shows only an ambient screen (clock/status) with zero resource use; when enabled, fill in the task prompt and working directory, and a session is auto-created on entry.
3. "Task timeout (minutes)" defaults to 10: tasks stop automatically when overdue, preventing runaway loops from burning CPU.
4. Click the top-bar "▶ AI Screensaver" for an instant fullscreen preview; **click, key, wheel, or touch exits immediately** (mouse movement does not, to avoid jitter flash-exits).
5. After exit the task keeps running in the background by default; the next entry resumes the last task.
6. "Register as system screensaver": Windows lock/timeout launches the app with `/s` straight into fullscreen (original settings are backed up before registering and restored on unregister).

---

## 5. 壁纸 / Wallpapers

**中文**

「设置 → 外观」可分别设置:**主窗口壁纸 / 手机端壁纸 / 屏保壁纸**:

1. 点击对应「选择图片…」,在裁剪编辑器里拖动选区、调整比例(14:9 等)与布设位置,预览实时更新。
2. 拖动「遮罩」滑杆(0.1~0.9)控制暗化程度,保证文字可读。
3. 保存后立即生效;主窗口壁纸会穿透到内嵌 Web UI 背景(对话页透出壁纸)。
4. 图片复制到 `%APPDATA%/DeepSeek Harness Desktop/wallpapers`,原图删除不影响。

**English**

**Settings → Appearance** lets you set **main-window / phone / screensaver wallpapers** separately:

1. Click "Choose image…"; in the crop editor drag the selection, adjust the ratio (14:9, etc.) and layout position; the preview updates live.
2. Drag the **mask** slider (0.1–0.9) to dim the image so text stays readable.
3. Saved immediately; the main-window wallpaper also shows through the embedded Web UI background (chat pages reveal the wallpaper).
4. Images are copied to `%APPDATA%/DeepSeek Harness Desktop/wallpapers`; deleting the original file has no effect.

---

## 6. 手机远程控制(PWA)/ Phone Remote Control (PWA)

**中文**

1. 「设置 → 远程访问」→ 勾选「启用」,记下端口(默认 3082)。
2. 手机与电脑连**同一 WiFi**;手机浏览器扫设置面板中的**二维码**(或访问 `http://<电脑IP>:3082`)。
3. PWA 自动填入地址与令牌并连接;浏览器菜单「添加到主屏幕」可当 App 使用。
4. 功能:
   - **会话**:列表 → 打开 → 历史与实时流式收发消息、停止任务;
   - **任务**:填描述 → 选工作区 → 选模型 → 运行并实时查看;
   - **工作区**:列表、新建(输入完整路径)。
5. 安全:令牌认证 + RPC 白名单,仅局域网可达;令牌在设置面板可重新生成(旧令牌立即失效)。

**English**

1. **Settings → Remote Access** → enable it; note the port (default 3082).
2. Connect the phone to the **same Wi-Fi**; scan the **QR code** in the settings panel (or open `http://<PC-IP>:3082`).
3. The PWA auto-fills the address and token; "Add to home screen" makes it feel like an app.
4. Features:
   - **Sessions**: list → open → history + real-time streaming chat, stop tasks;
   - **Tasks**: describe → choose workspace → choose model → run and watch live;
   - **Workspaces**: list, create (enter a full path).
5. Security: token auth + RPC allowlist, LAN only; regenerate the token in the settings panel anytime (the old one stops working immediately).

---

## 7. QQ 机器人远程控制 / QQ Bot Remote Control

**中文**

**准备**:在 [QQ 开放平台](https://q.qq.com) 注册机器人,获取 AppID / AppSecret(需实名)。

**配置**:「设置 → QQ 机器人」→ 勾选「启用」→ 填入 AppID / AppSecret → 可填「默认工作区/目录」(任务未指定时使用)→ 状态显示「✓ 已连接 QQ」即就绪。

**指令**(私聊机器人;发送无法识别的消息会自动回复完整指令集与示例):

| 指令 | 说明 | 示例 |
|---|---|---|
| `状态` / `会话` / `工作区` / `模型` | 查询类 | `状态` |
| `任务 <描述>` | 默认工作区执行 | `任务 分析这个仓库的架构` |
| `任务 @<工作区名> <描述>` | 指定工作区执行 | `任务 @qqbot 修复登录 bug` |
| `任务 目录:<路径> <描述>` | 指定目录执行 | `任务 目录:D:/work 写一个脚本` |
| `进入 <工作区/目录>` | **进入对话模式** | `进入 qqbot` |
| *(对话模式)* | 直接发消息连续对话,无需前缀;`退出` 结束 | `帮我看看项目里的 TODO` |
| `进展 <会话id>` | 实时进展(状态/工具统计/最新输出) | `进展 session-xxxxxxxx` |
| `停止 <会话id>` / `打开 <会话id>` | 停止任务 / 查看内容 | `停止 session-xxxxxxxx` |
| `允许` / `拒绝` | **审批应答**:agent 请求权限时,允许/拒绝当前操作(多个待审批时带会话 id) | `允许` / `拒绝 session-xxxxxxxx` |
| `选 <编号>` | **选择题应答**:回答 agent 的提问(多选:`选 1 3`;自定义:`选 自定义:先备份再删`;多题批次:`#2 选 1`) | `选 2` |

**典型流程**:`工作区` 看列表 → `进入 qqbot` → 连续对话(修改代码、查资料……)→ `退出`。

**说明**:QQ 官方机器人为**被动回复**(不能主动推送);长回复自动分段。待审批/待回答事项会在你下次发消息时附加在回复末尾提醒。

**English**

**Preparation**: register a bot on the [QQ Open Platform](https://q.qq.com) to get AppID / AppSecret (real-name required).

**Configuration**: **Settings → QQ Bot** → enable → fill AppID / AppSecret → optionally set a **default workspace/directory** (used when a task command specifies none) → status shows "✓ Connected" when ready.

**Commands** (private-chat the bot; sending anything unrecognized replies with the full command set and examples):

| Command | Description | Example |
|---|---|---|
| `状态` / `会话` / `工作区` / `模型` | Status / sessions / workspaces / models | `状态` |
| `任务 <description>` | Run in the default workspace | `任务 分析这个仓库的架构` |
| `任务 @<workspace> <description>` | Run in a specific workspace | `任务 @qqbot 修复登录 bug` |
| `任务 目录:<path> <description>` | Run in a specific directory | `任务 目录:D:/work 写一个脚本` |
| `进入 <workspace/dir>` | **Enter chat mode** | `进入 qqbot` |
| *(chat mode)* | Chat freely without prefixes; `退出` ends it | `帮我看看项目里的 TODO` |
| `进展 <sessionId>` | Live progress (status / tool stats / latest output) | `进展 session-xxxxxxxx` |
| `停止 <sessionId>` / `打开 <sessionId>` | Stop a task / view content | `停止 session-xxxxxxxx` |
| `允许` / `拒绝` | **Approval replies**: allow/reject the pending permission request (add a session id when several are pending) | `允许` / `拒绝 session-xxxxxxxx` |
| `选 <number>` | **Question replies**: answer an agent question (multi-select: `选 1 3`; custom: `选 自定义:backup first`; multi-question batch: `#2 选 1`) | `选 2` |

**Typical flow**: `工作区` to list → `进入 qqbot` → chat continuously (fix code, look things up…) → `退出`.

**Notes**: QQ official bots are **passive-reply** (no proactive push); long replies are split automatically. Pending approvals/questions are appended to the next reply as a reminder.

---

## 8. 常见问题 / FAQ

**中文**

- **Q:顶栏显示「端口被占用」?** A:换一个端口(「设置 → Harness 服务」),或关闭占用该端口的程序。
- **Q:模型下拉框为空?** A:在 Web UI「设置 → Models」配置密钥/模型;桌面端下拉框只列出已配置的模型。
- **Q:屏保不自动触发?** A:确认「启用空闲检测」已勾选、空闲分钟数合理;鼠标/键盘活动会重置空闲计时。
- **Q:手机连不上?** A:确认手机与电脑同一 WiFi、网关已启用、端口未被防火墙拦截;重新扫码。
- **Q:QQ 机器人没反应?** A:确认状态为「✓ 已连接」;私聊需先通过平台开通;检查 AppID/AppSecret 是否正确。
- **Q:换电脑/重装后壁纸和配置还在吗?** A:在,它们保存在 `%APPDATA%/DeepSeek Harness Desktop`,卸载不会删除。

**English**

- **Q: The top bar says "port occupied"?** A: Change the port (**Settings → Harness Service**) or close the program using that port.
- **Q: The model dropdown is empty?** A: Configure keys/models in the Web UI **Settings → Models**; the dropdown only lists configured models.
- **Q: The screensaver does not trigger?** A: Make sure "Idle detection" is enabled and the idle minutes are reasonable; mouse/keyboard activity resets the idle timer.
- **Q: The phone cannot connect?** A: Verify the phone and PC are on the same Wi-Fi, the gateway is enabled, and the port is not blocked by a firewall; scan the QR code again.
- **Q: The QQ bot does not respond?** A: Confirm the status shows "✓ Connected"; private chat must be enabled on the platform; double-check AppID/AppSecret.
- **Q: After reinstalling, are my wallpapers and config still there?** A: Yes — they live in `%APPDATA%/DeepSeek Harness Desktop` and uninstallation does not delete them.

---

## 9. 协议与隐私 / License & Privacy

**中文**

- 本项目**自定义许可**:衍生项目不得商用(DeepSeek 官方、作者、有关项目贡献者及书面授权者除外),必须开源;详见 [LICENSE](../LICENSE)。
- 安装包/zip **不含**任何本地配置、壁纸、令牌、密钥、会话数据或日志;用户数据仅在 `%APPDATA%/DeepSeek Harness Desktop`。

**English**

- This project uses a **custom license**: no commercial use of derivative projects (except DeepSeek AI, the author, project contributors, and written-authorized parties); derivatives must stay open source. See [LICENSE](../LICENSE).
- Packages contain **no** local config, wallpapers, tokens, keys, session data, or logs; user data lives only in `%APPDATA%/DeepSeek Harness Desktop`.
