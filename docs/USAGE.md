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
   - **工作区**:列表、新建(在电脑端配置的**预设根目录**下新建文件夹;不能指定任意路径);每个工作区带「📂」按钮**浏览文件夹**,点文件可**预览文本内容**(≤64KB;仅限工作区/预设根内,越权拒绝);
   - **设置**:手机端同样可管理多项设置——**预设工作区根目录**(查看/移除/「浏览文件夹添加」,不必只在电脑上配)、手机壁纸、定时任务、重启 Harness 等。
5. 安全:令牌认证 + RPC 白名单 + 文件浏览白名单(仅工作区/预设根内,越权 403),仅局域网可达;令牌在设置面板可重新生成(旧令牌立即失效)。

**English**

1. **Settings → Remote Access** → enable it; note the port (default 3082).
2. Connect the phone to the **same Wi-Fi**; scan the **QR code** in the settings panel (or open `http://<PC-IP>:3082`).
3. The PWA auto-fills the address and token; "Add to home screen" makes it feel like an app.
4. Features:
   - **Sessions**: list → open → history + real-time streaming chat, stop tasks;
   - **Tasks**: describe → choose workspace → choose model → run and watch live;
   - **Workspaces**: list, create (new folders under the **preset roots** configured on the PC; arbitrary paths are not allowed); each workspace has a "📂" button to **browse its folder** — tap a file to **preview text content** (≤64KB; workspace/preset-roots only, anything else is denied);
   - **Settings**: the phone can manage several settings too — **preset workspace roots** (view / remove / "browse to add", no need to configure only on the PC), phone wallpaper, scheduled tasks, restart Harness, etc.
5. Security: token auth + RPC allowlist + file-browse allowlist (workspaces/preset roots only, 403 otherwise), LAN only; regenerate the token in the settings panel anytime (the old one stops working immediately).

---

## 7. QQ 机器人远程控制 / QQ Bot Remote Control

**中文**

**准备**:在 [QQ 开放平台](https://q.qq.com) 注册机器人,获取 AppID / AppSecret(需实名)。也可以直接点设置面板的「**扫码登录**」:用手机 QQ 扫二维码,绑定成功后 AppID/AppSecret 自动填入。

**配置**:「设置 → QQ 机器人」→ 勾选「启用」→ 填入 AppID / AppSecret → 可填「默认工作区/目录」(任务未指定时使用)、勾选「**默认对话模式**」(非指令消息直接进入纯对话,无需先发「进入」)→ 状态显示「✓ 已连接 QQ」即就绪。

**指令**(私聊机器人;发送无法识别的消息会自动回复完整指令集与示例):

| 指令 | 说明 | 示例 |
|---|---|---|
| `状态` / `会话` / `工作区` / `模型` | 查询类 | `状态` |
| `任务 <描述>` | 默认工作区执行 | `任务 分析这个仓库的架构` |
| `任务 @<工作区名> <描述>` | 指定工作区执行 | `任务 @qqbot 修复登录 bug` |
| `任务 目录:<路径> <描述>` | 指定目录执行 | `任务 目录:D:/work 写一个脚本` |
| `进入 <工作区/目录>` | **进入对话模式**(不带参数 = 纯对话,不绑定工作区) | `进入 qqbot` / `进入` |
| *(对话模式)* | 直接发消息连续对话,无需前缀;`退出` 结束 | `帮我看看项目里的 TODO` |
| `进展 <会话id>` | 实时进展(状态/工具统计/最新输出) | `进展 session-xxxxxxxx` |
| `停止 <会话id>` / `打开 <会话id>` | 停止任务 / 查看内容 | `停止 session-xxxxxxxx` |
| `允许` / `拒绝` | **审批应答**:agent 请求权限时,允许/拒绝当前操作(多个待审批时带会话 id) | `允许` / `拒绝 session-xxxxxxxx` |
| `选 <编号>` | **选择题应答**:回答 agent 的提问(多选:`选 1 3`;自定义:`选 自定义:先备份再删`;多题批次:`#2 选 1`) | `选 2` |
| `定时 <时长> <任务>` | **定时任务**:一次性(`10分钟`/`5m`/`2小时`/`1天`)或每天(`每天9:00`) | `定时 10分钟 检查更新` |
| `定时列表` / `取消定时 <编号>` | 查看 / 取消已排定时任务 | `取消定时 2` |
| `目录 <路径>` / `文件 <路径>` | 浏览工作区目录 / 查看文本文件(白名单内) | `目录 D:/work`、`文件 D:/work/README.md` |
| `导出 <会话id>` | 导出会话为 Markdown(保存在桌面端 `exports/` 目录) | `导出 session-xxxxxxxx` |
| `用量` | 今日用量统计(会话数/回合数/Token) | `用量` |
| `角色 <设定>` | **角色扮演**:对话模式叠加角色设定(仅纯对话生效);`角色 无` 清除 | `角色 你是温柔的英语老师` |
| *(私聊发图片)* | **图片理解**:对话模式下直接发图片,agent 看图分析 | 发截图 → `看看这张图有什么问题` |

**典型流程**:`工作区` 看列表 → `进入 qqbot` → 连续对话(修改代码、查资料……)→ `退出`。

**说明**:QQ 官方机器人以**被动回复**为主,但与机器人交互后 48 小时内支持**主动推送**(任务完成/失败汇报、审批/提问即时通知;**审批通知带「允许/拒绝」内联按钮**,点一下即可应答,也可回复文字);长回复自动分段;推送失败时待办仍会附加在下次回复末尾提醒。

**English**

**Preparation**: register a bot on the [QQ Open Platform](https://q.qq.com) to get AppID / AppSecret (real-name required).

**Configuration**: **Settings → QQ Bot** → enable → fill AppID / AppSecret → optionally set a **default workspace/directory** (used when a task command specifies none) and enable **default chat mode** (non-command messages enter pure chat directly, no `进入` needed) → status shows "✓ Connected" when ready.

**Commands** (private-chat the bot; sending anything unrecognized replies with the full command set and examples):

| Command | Description | Example |
|---|---|---|
| `状态` / `会话` / `工作区` / `模型` | Status / sessions / workspaces / models | `状态` |
| `任务 <description>` | Run in the default workspace | `任务 分析这个仓库的架构` |
| `任务 @<workspace> <description>` | Run in a specific workspace | `任务 @qqbot 修复登录 bug` |
| `任务 目录:<path> <description>` | Run in a specific directory | `任务 目录:D:/work 写一个脚本` |
| `进入 <workspace/dir>` | **Enter chat mode** (no argument = pure chat, no workspace bound) | `进入 qqbot` / `进入` |
| *(chat mode)* | Chat freely without prefixes; `退出` ends it | `帮我看看项目里的 TODO` |
| `进展 <sessionId>` | Live progress (status / tool stats / latest output) | `进展 session-xxxxxxxx` |
| `停止 <sessionId>` / `打开 <sessionId>` | Stop a task / view content | `停止 session-xxxxxxxx` |
| `允许` / `拒绝` | **Approval replies**: allow/reject the pending permission request (add a session id when several are pending) | `允许` / `拒绝 session-xxxxxxxx` |
| `选 <number>` | **Question replies**: answer an agent question (multi-select: `选 1 3`; custom: `选 自定义:backup first`; multi-question batch: `#2 选 1`) | `选 2` |
| `定时 <duration> <task>` | **Scheduled tasks**: once (`10分钟`/`5m`/`2小时`/`1天`) or daily (`每天9:00`) | `定时 10分钟 检查更新` |
| `定时列表` / `取消定时 <index>` | List / cancel scheduled tasks | `取消定时 2` |
| `目录 <path>` / `文件 <path>` | Browse workspace dirs / view text files (allowlisted) | `目录 D:/work`、`文件 D:/work/README.md` |
| `导出 <sessionId>` | Export a session to Markdown (saved under the desktop `exports/` dir) | `导出 session-xxxxxxxx` |
| `用量` | Today's usage stats (sessions/turns/tokens) | `用量` |
| `角色 <setting>` | **Role-play**: set a character for chat mode (pure chat only); `角色 无` clears it | `角色 你是温柔的英语老师` |
| *(send an image in DM)* | **Image understanding**: in chat mode, send an image and the agent analyzes it | send a screenshot → `看看这张图有什么问题` |

**Typical flow**: `工作区` to list → `进入 qqbot` → chat continuously (fix code, look things up…) → `退出`.

**Notes**: QQ official bots are mainly **passive-reply**, but within 48h of a user interaction they support **proactive push** (task done/failed reports, instant approval/question notifications; **approval messages carry inline Allow/Deny buttons** — tap to answer, or reply with text); long replies are split automatically; if a push fails, pending items are still appended to the next reply as a reminder.

---

## 8. 常见问题 / FAQ

**中文**

- **Q:顶栏显示「端口被占用」?** A:换一个端口(「设置 → Harness 服务」),或关闭占用该端口的程序。
- **Q:模型下拉框为空?** A:在 Web UI「设置 → Models」配置密钥/模型;桌面端下拉框只列出已配置的模型。
- **Q:屏保不自动触发?** A:确认「启用空闲检测」已勾选、空闲分钟数合理;鼠标/键盘活动会重置空闲计时。
- **Q:手机连不上?** A:确认手机与电脑同一 WiFi、网关已启用、端口未被防火墙拦截;重新扫码。
- **Q:QQ 机器人没反应?** A:确认状态为「✓ 已连接」;私聊需先通过平台开通;检查 AppID/AppSecret 是否正确。
- **Q:任务报「Stream ended without finish_reason」(TRANSPORT 错误)?** A:常见于**第三方中转站(代理)**:中转站等待上游模型返回超时,或上游连接被意外中断。本项目会对该错误**自动重试一次**(同会话仅一次);仍失败请按优先级排查:
  1. **超时配置(最常见)**:中转站通常有「连接超时/读取超时」两个阈值,请求可能刚打到上游就断。把调用方的 read_timeout 调大(建议 ≥120 秒;OpenAI 官方库可设 `httpx.Timeout(300.0, connect=10.0)`)。
  2. **关闭流式做二分法**:把 `"stream": true` 改为 `false`。若非流式正常而流式报错,基本可确定是中转站到上游的**流式通道不稳定**(网络抖动或网关限制);必须用流式时可切换中转站线路或改用 WebSocket 协议。
  3. **检查 max_tokens 是否过大**:接近模型上限(如 8192)时,中转站的硬性输出截断可能未发完 `finish_reason` 就掐断。先设为 500 测试,正常后逐步调大。
  4. **排查内容安全拦截**:部分中转站接入外部审核,触发风控时上游直接 Reset 连接而不返回标准结束符。把输入改成最简单的 `hi` 对比:若 `hi` 正常而复杂 prompt 报错,则是提示词命中敏感词,需修改提示词或联系中转客服。
  5. **网络层面(惊群效应)**:延迟接近 1 秒(TCP 重传超时)时检查到中转站的延迟/丢包(ping、mtr);延迟 >200ms 可开启中转站「跨境加速」或切换更近节点。
  6. **终极确认**:开启中转站 debug 模式查看原始响应;若返回 `{"error":"upstream timeout"}`,直接联系客服申请提高 Upstream Read Timeout 白名单阈值。
- **Q:换电脑/重装后壁纸和配置还在吗?** A:在,它们保存在 `%APPDATA%/DeepSeek Harness Desktop`,卸载不会删除。

**English**

- **Q: The top bar says "port occupied"?** A: Change the port (**Settings → Harness Service**) or close the program using that port.
- **Q: The model dropdown is empty?** A: Configure keys/models in the Web UI **Settings → Models**; the dropdown only lists configured models.
- **Q: The screensaver does not trigger?** A: Make sure "Idle detection" is enabled and the idle minutes are reasonable; mouse/keyboard activity resets the idle timer.
- **Q: The phone cannot connect?** A: Verify the phone and PC are on the same Wi-Fi, the gateway is enabled, and the port is not blocked by a firewall; scan the QR code again.
- **Q: The QQ bot does not respond?** A: Confirm the status shows "✓ Connected"; private chat must be enabled on the platform; double-check AppID/AppSecret.
- **Q: A task fails with "Stream ended without finish_reason" (TRANSPORT error)?** A: Very common with **third-party relay/proxy providers**: the relay timed out waiting for the upstream model, or the upstream connection was cut. The app **auto-retries once** per session; if it still fails, debug in this order:
  1. **Timeout config (most likely)**: relays usually have separate connect/read timeouts — the request may be cut right after reaching upstream. Raise the caller's read_timeout (≥120s; with the official OpenAI lib use `httpx.Timeout(300.0, connect=10.0)`).
  2. **Binary search by disabling streaming**: set `"stream": true` → `false`. If non-streaming works but streaming errors, the relay→upstream **streaming channel** is unstable (jitter or gateway limits); switch relay lines or use WebSocket when streaming is required.
  3. **max_tokens too large**: near the model limit (e.g. 8192), a relay's hard output cap may cut the stream before `finish_reason`. Test with 500 first, then raise gradually.
  4. **Content-safety blocking**: some relays add external review — on a policy hit the upstream resets the connection without a normal terminator. Try the simplest input `hi` as a control: if `hi` works but your complex prompt errors, the prompt hit a sensitive-word filter — revise it or contact relay support.
  5. **Network (thundering herd)**: a delay near 1s smells like TCP retransmission timeout — check latency/packet loss to the relay (ping, mtr); if latency >200ms, enable the relay's "cross-border acceleration" or switch to a nearer node.
  6. **Final confirmation**: enable the relay's debug mode and inspect the raw response; if it returns `{"error":"upstream timeout"}`, ask support to raise the Upstream Read Timeout allowlist.
- **Q: After reinstalling, are my wallpapers and config still there?** A: Yes — they live in `%APPDATA%/DeepSeek Harness Desktop` and uninstallation does not delete them.

---

## 9. 协议与隐私 / License & Privacy

**中文**

- 本项目**自定义许可**:衍生项目不得商用(DeepSeek 官方、作者、有关项目贡献者及书面授权者除外),必须开源;详见 [LICENSE](../LICENSE)。
- 安装包/zip **不含**任何本地配置、壁纸、令牌、密钥、会话数据或日志;用户数据仅在 `%APPDATA%/DeepSeek Harness Desktop`。

**English**

- This project uses a **custom license**: no commercial use of derivative projects (except DeepSeek AI, the author, project contributors, and written-authorized parties); derivatives must stay open source. See [LICENSE](../LICENSE).
- Packages contain **no** local config, wallpapers, tokens, keys, session data, or logs; user data lives only in `%APPDATA%/DeepSeek Harness Desktop`.
