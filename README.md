# DeepSeek Harness Desktop

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的桌面客户端(Electron + TypeScript)。

- **内嵌 Web UI**:原生控制条 + 内嵌完整 harness Web UI(会话、工具、插件全功能)。
- **AI 屏保(替换系统屏保)**:空闲 N 分钟自动全屏显示 agent 实时工作画面(思考过程、文本流、工具调用),移动鼠标或按键立即退出;也可注册为 Windows 系统屏保。
- **各种模型选择**:快捷切换默认模型(DeepSeek 官方、OpenAI、Anthropic 及 37+ 目录 Provider),添加自定义 OpenAI 兼容网关(公司网关、Ollama 本地等),密钥安全写入 credentials 存储。
- **harness 托管**:自动探测已运行的 `dsh web`,没有则自动拉起(默认 `npx @deepseek-ai/dsh web`),崩溃自动重启。
- **系统托盘常驻**:开机自启、一键启动屏保、快速打开 Web UI。

## 快速开始

```sh
npm install
npm start        # 构建并启动桌面端
```

首次启动会自动探测 `http://127.0.0.1:3080`:已有 harness 则直接接入;没有则自动执行 `npx --yes @deepseek-ai/dsh web --port 3080` 拉起(需要 Node.js 18+)。

> 提示:先运行 `npx @deepseek-ai/dsh web` 并配置好模型密钥,再打开桌面端,体验最佳。

## 功能说明

### 模型切换

顶栏的「默认模型」下拉框列出当前已配置的全部 Provider 与模型:

- 选择后通过 `session.selectModel` 写入,harness 会**同时持久化为新会话的默认模型**,热生效、无需重启。
- 「设置 → 添加自定义 Provider」可添加 OpenAI 兼容网关(预设:DeepSeek 官方 / OpenAI / Ollama 本地 / 自定义),支持「从网关拉取模型」自动发现模型列表;API Key 通过 `credentials.set` 安全写入,不会明文落盘到配置。
- 更完整的模型管理(密钥配置、目录 Provider、推理参数)在嵌入式 Web UI 的「设置 → Models」页面。

### AI 屏保

「设置 → AI 屏保」:

| 配置 | 说明 |
|---|---|
| 启用空闲检测 | 空闲达到阈值后自动进入全屏屏保 |
| 空闲几分钟后触发 | 默认 5 分钟 |
| 自动启动 agent 任务 | **默认关闭**。进入屏保只显示环境画面(时钟/状态),不消耗任何资源;勾选后才会自动创建会话执行任务 |
| 任务提示词 | 自定义屏保任务(默认:浏览科技新闻并整理要点) |
| 任务工作目录 | 可选,指定 agent 的工作目录 |
| 任务超时(分钟) | 默认 10 分钟。任务超时未完成自动停止——防止 agent 失控循环烧 CPU(这是重要护栏) |

屏保画面实时渲染 agent 的思考、输出文本与工具调用卡片(流式渲染为增量追加,不因长输出卡顿)。**退出方式:点击、按键、滚轮、触摸均可立即退出**;鼠标移动不触发退出(避免鼠标抖动导致屏保闪退)。退出后任务默认**保留在后台继续运行**,下次进入屏保会「继续上次任务」;关闭「保留任务」则在每次进入时重启新任务。任务会话自动命名「AI 屏保任务 HH:MM」,便于在 Web UI 中识别。

**防循环弹出**:系统屏保拉起(`/s`)与空闲检测自动激活都受 5 分钟退出冷却约束——用户点击退出后,5 分钟内不会被系统/空闲检测再次拉起,避免"关了又弹"。用户主动点击「AI 屏保」按钮不受此限制。

**注册为 Windows 系统屏保**:点击「注册为系统屏保」后,Windows 的锁屏/超时机制会用 `/s` 参数拉起本应用直接进入全屏模式(注册表 `HKCU\Control Panel\Desktop\SCRNSAVE.EXE`,无需管理员权限;注册前自动备份原设置,取消时恢复)。

> 体验提示:AI 屏保是「观看模式」——它全屏展示 agent 正在做什么,而不是接管你的鼠标键盘。空闲时让 agent 干活前,先想清楚任务是否真的需要跑(模型调用消耗 token、工具调用消耗 CPU)。

### Harness 服务

- **auto(默认)**:先探测已运行实例(接入 3080 或自定义端口),没有则托管启动。
- **external**:仅连接外部地址(如局域网内的另一台机器)。
- **managed**:始终由桌面端托管启动,可自定义启动命令(如指向本地仓库的 `pnpm dsh web --port {port}`)。

## 开发

```sh
npm run build    # tsc 编译 main/preload/renderer 到 dist/
npm start        # 构建 + electron .
npm run smoke    # 冒烟测试:验证 RPC 客户端与模型目录(需 harness 运行中)
npm run pack     # 打包 Windows portable 单文件 exe(electron-builder)
```

调试开关:

- `--remote-debugging-port=9222` 启动时启用 CDP,可用 `node scripts/cdp-eval.mjs '<表达式>'` 检查页面状态。
- `--ss-debug` 启动时,屏保窗口保持打开(禁用空闲退出),便于调试屏保画面。
- `node scripts/mux-test.mjs <baseUrl>` 端到端管线测试:设置默认模型 → 建会话 → 发提示 → 订阅事件流(会消耗少量模型调用)。

### 结构

```
src/main/          主进程
  index.ts         入口(单实例锁、/s 屏保参数、mux 事件桥)
  harness.ts       harness 进程托管(探测/拉起/健康检查/崩溃重启)
  client.ts        HTTP RPC 客户端(POST /api/<method> + SSE events.mux)
  models.ts        模型目录、默认模型切换、自定义 Provider 向导
  screensaver.ts   AI 屏保(空闲检测、全屏窗口、任务编排、系统屏保注册)
  tray.ts          系统托盘
src/renderer/      渲染进程(经典脚本,无打包器)
  index.html       主窗口(控制条 + webview)
  screensaver.html 全屏屏保(实时 agent 画面)
scripts/           冒烟与端到端测试脚本
```

### 与 harness 的通信协议

桌面端直接实现 deepseek-harness 的 HTTP RPC 协议(`dsh-host-apiproxy`):

- 一元调用:`POST /api/<method>`,body 为 `{type:'client-request', rpcId, method, payload}`,响应 `{type:'server-response', rpcId, result}`;回环地址免令牌。
- 事件流:`GET /api/events.mux`(SSE),推送 `session/event` 等帧,屏保页面据此实时渲染。
- 关键方法:`session.list/create/prompt/cancel/selectModel`、`host.describe`、`llm.providers/models/discoverModels`、`settings.update/mutate`、`credentials.set`。

协议细节随 harness 演进可能变化;桌面端使用的方法均来自当前 `0.1.0-rc.x` 的 `packages/host/apiproxy`。

## 已知限制

- 屏保实时画面为「观看视图」:交互(输入、审批)请回到主窗口的 Web UI 完成;agent 遇到需要确认的问题会等待,会话在 Web UI 中可见。
- 系统屏保注册仅支持 Windows(注册表方案,注册前自动备份原设置,取消时恢复);macOS/Linux 可用内置空闲检测模式。
- 事件流传输自动协商:旧版 harness 只接受 WebSocket(HTTP 返回 426),新版额外支持 SSE;两者都兼容。
- 屏保窗口内禁用了系统休眠时的自动唤醒逻辑(跟随系统屏保行为)。
