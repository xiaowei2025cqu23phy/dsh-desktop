
# DeepSeek Harness Desktop

中文 | [English](README.en.md)

[![build](https://github.com/xiaowei2025cqu23phy/dsh-desktop/actions/workflows/build.yml/badge.svg)](https://github.com/xiaowei2025cqu23phy/dsh-desktop/actions/workflows/build.yml)
[![release](https://img.shields.io/github/v/release/xiaowei2025cqu23phy/dsh-desktop)](https://github.com/xiaowei2025cqu23phy/dsh-desktop/releases)
[![license](https://img.shields.io/badge/license-custom-blue)](LICENSE)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的桌面客户端(Electron + TypeScript)。

## 这是什么

harness 是个很能干的 agent 运行时,但它长在浏览器标签页里:你得记着开、记着看,离开电脑就只能干等。这个项目把它搬进桌面,并补上三件在浏览器里做不到的事:

- **它替你盯着**——agent 卡住等审批时会主动来找你,不用守着标签页;空闲时还能顺手把屏幕变成一块屏保(纯壁纸+时钟,可顶替系统屏保);
- **它让手机也能用**——扫个码,手机上发任务、看流式进展、一键批准;审批队列三端同一份,任一端答应即可;
- **它让 QQ / Telegram 成为你的遥控器**——私聊发一句话就干活,干完主动汇报。

全程本地运行,密钥与会话不出你的机器。

## 目录

- [下载与安装](#下载与安装) · [新手部署三步走](#-新手部署三步走给第一次装的朋友)
- [功能亮点](#-功能亮点) · [演示](#演示)
- [快速开始](#快速开始) · [功能说明](#功能说明)
- [开发](#开发) · [与 harness 的通信协议](#与-harness-的通信协议) · [已知限制](#已知限制)
- [参考与致谢](#参考与致谢--acknowledgements) · [支持与联系](#支持与联系--support)

## 许可证与使用条款

本项目遵循**自定义许可协议**(见 [LICENSE](LICENSE)),核心条款:

- **不得商用**:任何衍生项目不得用于商业用途(DeepSeek 官方、本项目作者本人、有关项目贡献者及作者书面授权的个人/组织除外)。
- **必须开源**:任何衍生项目必须公开源代码,并同样遵守本协议。
- **更宽松授权**:作者保留对特定个人或组织授予更宽松协议条款的权利(包括商业使用许可),须经作者明确书面授权;未获书面授权者一律适用本协议默认条款。
- 第三方依赖组件(DeepSeek Harness、`@tencent-connect/qqbot-nodejs`、Electron 等)遵循各自许可证,详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与下文「参考与致谢」。

## 隐私说明

- 发布包(安装包 exe / zip)只包含应用代码与运行库,**不包含**任何本地配置、壁纸、访问令牌、API 密钥、会话数据或日志。
- 用户的壁纸、令牌与配置保存在系统用户目录(`%APPDATA%/DeepSeek Harness Desktop`),永远不会进入安装包或提交到仓库。
- 安装程序**不会删除**用户数据:卸载时保留 `%APPDATA%` 下的配置与壁纸(`deleteAppDataOnUninstall = false`)。
- 若从源码自行构建,构建产物同样不涉及上述用户数据。
- 发布包随附 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`(第三方组件清单),位于安装目录的 `resources/` 下;免安装版在 `resources/` 同级。

## 下载与安装

从 [GitHub Releases](https://github.com/xiaowei2025cqu23phy/dsh-desktop/releases) 下载,三种形态任选:

| 形态                   | 文件                                     | 说明                                                               |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| **安装版(推荐)** | `DeepSeek-Harness-Desktop-Setup-*.exe` | NSIS 安装程序,双击安装,自动创建开始菜单与桌面快捷方式,可选安装目录 |
| 便携版                 | `DeepSeek.Harness.Desktop-*.win.zip`   | 解压即用,免安装,适合 U 盘携带                                      |
| 源码版                 | 克隆仓库`npm install && npm start`     | 自行构建                                                           |

安装版卸载时保留用户配置与壁纸(不会删除 `%APPDATA%` 数据);如需彻底清理请手动删除 `%APPDATA%/DeepSeek Harness Desktop`。

> 系统要求:**Windows x64**、**Node.js ≥ 22.13**(建议 24 LTS)。
> 打包版自带 Electron 运行时,数据库用其内置的 `node:sqlite`,不需要额外装数据库。系统 Node 只在两种情况下用到:源码构建/跑测试,以及用 `npx` 托管拉起 harness。
> 提示:先运行 `npx @deepseek-ai/dsh web` 并配置好模型密钥,再打开桌面端,体验最佳。

### 🆕 新手部署三步走(给第一次装的朋友)

安装包不包含智能体运行时与任何配置/密钥(隐私设计),新电脑只需三步:

1. **装 Node.js(LTS)**
   - 打开 https://nodejs.org/zh-cn/download ,下载 Windows Installer(.msi,LTS 版 22 或 24),一路「下一步」;
   - 或 PowerShell 执行 `winget install OpenJS.NodeJS.LTS`;
   - 装完重开终端,`node -v` 能看到版本号即成功;
   - 国内网络慢可先执行 `npm config set registry https://registry.npmmirror.com`;
2. **装本桌面端**:下载上方安装版(或便携版解压),双击安装;
3. **配模型密钥**:打开桌面端 → 打开内置 Web UI(「设置 → 服务 → 打开 Web UI」)→ 设置 → Models,填入模型 API Key(如 DeepSeek 官方 Key);密钥只存在本机。

> 不需要手动安装 dsh:桌面端首次启动会用 `npx` 自动下载智能体运行时;
> 想用 QQ 机器人再加一步:QQ 开放平台注册机器人,把 AppID/Secret 填入「设置 → QQ 机器人」(见 [QQ-BOT.md](docs/QQ-BOT.md))。

> 📖 完整安装、配置、手机端与 QQ 机器人使用步骤见 [实操指南(汉英双语)](docs/USAGE.md),接入钉钉/飞书/Home Assistant/iOS 捷径等更多方式见 [接入指南](docs/INTEGRATIONS.md)。
> 🤖 QQ 机器人完整指南(部署/平台权限/指令集/FAQ)见 [docs/QQ-BOT.md](docs/QQ-BOT.md);📱 手机 PWA 特色功能见 [docs/PWA.md](docs/PWA.md)。

## ✨ 功能亮点

- **内嵌 Web UI**:原生控制条 + 内嵌完整 harness Web UI(会话、工具、插件全功能)。**官方 / 本地魔改双实例自由嵌入**:内置页面与顶栏 🧪 按钮可在「官方版(npx 发布)」与「本地自建 fork 版」之间切换,各自独立端口/DSH_HOME/凭据;实例来源与能力**自动探测**——只装官方 dsh 的用户功能完整可用,魔改增强(侧边栏文件浏览、文本/图片预览等)探测到才显示,官方实例上不会出现不可用的入口。
- **屏保(可替换系统屏保)**:空闲 N 分钟自动全屏显示壁纸与时钟,点击/按键/滚轮/触摸立即退出(鼠标移动**不**退出,避免轻微抖动就闪退);**纯展示,不跑 agent 任务**,不消耗 token 与 CPU;可注册为 Windows 系统屏保,注册前自动备份原设置、取消时恢复。
- **手机 PWA 遥控**:扫码配对(自动填地址+令牌),手机上发任务、看流式进展、停止任务;**审批/提问卡片一键应答**——agent 卡住等你批准时不再"失联"。可**添加到主屏幕**当 App 用。远程访问仅面向可信局域网,默认启用 2 小时自动关闭;**禁止使用内网穿透、端口转发或公网反向代理暴露 Harness**。**令牌即访问权**:有效令牌的手机/脚本首次连接即可用;因此**拿到令牌就等于拿到这台电脑的控制权**,真正的保护是「仅局域网可达 + 令牌保密」。控制权在桌面端:可一键暂停全部连接、对单个设备暂停/拉黑(被拉黑或已暂停的设备令牌正确也拒绝)、锁屏/睡眠自动暂停,并支持只监听当前局域网 IP(默认 0.0.0.0 全网卡,含 VPN/虚拟网卡)。
- **PWA 离线外壳(可选 HTTPS)**:设置里可开启 HTTPS(自签证书,含本机全部局域网 IP)。手机信任一次证书后即可注册 Service Worker——应用壳可缓存、断网也能打开,并支持「添加到主屏幕」。明文 HTTP 下浏览器不允许注册 SW,此时 PWA 以普通标签页形态工作。
- **常驻状态条**:顶栏三个实时徽标——运行中的活动数 ▶、今日 Token 用量 💰、已连接的远程设备数 📱,不用发指令或翻设置就能看到当前状态;手机端同样有(运行中/用量两项)。
- **首次启动引导**:首次打开显示三步检查单(① harness 是否就绪 ② 模型是否配好 ③ 开始使用),就地显示每步的实时状态并可直接跳到模型配置,不用翻文档猜下一步。
- **QQ / Telegram 机器人通道**:私聊发指令即干活(群聊只聊天、不响应任何指令);打通**主动推送**(QQ 交互后 48h 窗口),任务完成、失败、要审批都会主动找你;低风险审批带「允许/拒绝」内联按钮,点一下即批(高风险操作转桌面端确认);访问控制为**平台侧关闭「允许被添加为好友」**(首次启用强制确认)+ 可选**openid 白名单**(留空 = 不限制)。
- **QQ 机器人体验(0.6.0+)**:未指定工作区的任务自动并入「默认任务会话」(不再刷屏;重启后仍复用同一会话);指定工作区用 `任务 @工作区名` 或「进入工作区后直接发」;`进展` 显示阶段(思考/工具/输出/完成+产物提示);任务过程默认静默、`播报` 按需开;机器人对话(私聊/群聊)集中放在可见的「机器人对话」工作区;**群聊仅聊天、不响应任何指令(含查询)**并带安全提醒;归档的会话可随时 `恢复 <会话id>`;完整指令集与部署/权限指引见 [QQ-BOT.md](docs/QQ-BOT.md)。
- **默认对话模式**:机器人开启后,普通消息直接进入纯对话(不绑定工作区),无需任何指令前缀。
- **各种模型选择**:快捷切换默认模型(DeepSeek 官方、OpenAI、Anthropic 及 37+ 目录 Provider),添加自定义 OpenAI 兼容网关(公司网关、Ollama 本地等),密钥安全写入 credentials 存储。
- **三端独立壁纸 + 拼豆像素滤镜**:主窗口 / 手机 / 屏保各配一张,导入自己的图片一键拼豆化(本地处理,不碰版权);内置鲸鱼系列壁纸包一键应用。
- **harness 托管**:自动探测已运行的 `dsh web`,没有则自动拉起(默认 `npx @deepseek-ai/dsh web`),崩溃自动重启。
- **AI 活动中心与本地记忆**:统一查看远程任务状态、来源和工作区;按工作区保存本地项目记忆(简介/约定/常用命令/笔记),可从 README 与 package.json 一键生成草稿,默认关闭注入,仅在用户明确启用后加入匹配目录的任务上下文。
- **可信审计与通知分级**:任务、审批、提问和记忆使用形成可导出、可清空的本地时间线;审批、问题、成功和失败通知可独立开关并支持勿扰时段。
- **串行任务调度队列**:任务持久化入队,已有任务运行中时新任务自动排队;失败自动重试(指数退避 30s/60s,最多 2 次),应用重启后中断任务标记失败可手动重试;工作台「任务队列」面板支持取消与立即重试。
- **工作台三页导航**:顶栏「工作台 / 工作区 / 会话」——工作台聚合待处理审批、活动中心、工作区健康、任务队列、用量与审计;工作区页按工作区查看健康状态、编辑本地记忆与关联活动;设置抽屉只保留真正配置项。
- **SQLite 本地存储**:活动、审计与任务队列存入本地 SQLite(userData/local.db,零额外依赖),事务写入与索引查询,旧 JSON 数据首次启动自动迁移。
- **文件预览增强**:手机 PWA 预览支持超大文本分片加载与图片直接查看(≤2MB),仍受工作区白名单限制。
- **系统托盘常驻**:开机自启、一键启动屏保、快速打开 Web UI、更新提示。

## 演示

**主窗口与壁纸穿透**(主窗口壁纸会透出到内嵌对话页):

![主窗口演示](assets/demo-main.gif)

**手机 PWA 远程控制**(扫码连接 → 选择工作区与模型 → 一键运行任务 → 实时流式查看):

![手机远程控制演示](assets/demo-remote.gif)

**屏保**(空闲全屏显示壁纸与时钟,壁纸可自定义):

![屏保演示](assets/demo-screensaver.gif)

> 该演示录制于屏保还能展示 agent 实时画面的时候;当前屏保只显示壁纸与时钟。

> 演示使用内置"鲸鱼海洋"示例壁纸录制,不涉及任何个人壁纸或会话内容。

## 快速开始

```sh
npm install
npm start        # 构建并启动桌面端
```

首次启动会自动探测 `http://127.0.0.1:3080`:已有 harness 则直接接入;没有则自动执行 `npx --yes @deepseek-ai/dsh web --port 3080` 拉起(需要 Node.js ≥ 22.13)。

> 提示:先运行 `npx @deepseek-ai/dsh web` 并配置好模型密钥,再打开桌面端,体验最佳。

## 功能说明

### 模型切换

顶栏的「默认模型」下拉框列出当前已配置的全部 Provider 与模型:

- 选择后通过 `session.selectModel` 写入,harness 会**同时持久化为新会话的默认模型**,热生效、无需重启。
- 「设置 → 添加自定义 Provider」可添加 OpenAI 兼容网关(预设:DeepSeek 官方 / OpenAI / Ollama 本地 / 自定义),支持「从网关拉取模型」自动发现模型列表;API Key 通过 `credentials.set` 安全写入,不会明文落盘到配置。
- 更完整的模型管理(密钥配置、目录 Provider、推理参数)在嵌入式 Web UI 的「设置 → Models」页面。

### 屏保

「设置 → 外观与扩展 → 屏保」:

| 配置             | 说明                            |
| ---------------- | ------------------------------- |
| 启用空闲检测     | 空闲达到阈值后自动进入全屏屏保  |
| 空闲几分钟后触发 | 默认 5 分钟                     |

屏保是**纯屏保**:全屏显示壁纸与时钟,不启动任何 agent 任务、不调用模型、不消耗 token。屏保的职责是遮挡屏幕,不是替你在无人看管时跑任务——那类需求请用「定时任务」或机器人通道,它们有独立的开关与配额。

**退出方式:点击、按键、滚轮、触摸均可立即退出**;鼠标移动不触发退出(避免鼠标抖动导致屏保闪退)。主进程也监听输入事件,即使页面卡住也能退出。

**防循环弹出**:系统屏保拉起(`/s`)与空闲检测自动激活都受 5 分钟退出冷却约束——用户点击退出后,5 分钟内不会被系统/空闲检测再次拉起,避免"关了又弹"。用户主动点击顶栏按钮不受此限制。

**注册为 Windows 系统屏保**:点击「注册为系统屏保」后,Windows 的锁屏/超时机制会用 `/s` 参数拉起本应用直接进入全屏模式(注册表 `HKCU\Control Panel\Desktop\SCRNSAVE.EXE`,无需管理员权限;注册前自动备份原设置,取消时恢复。重复点击只更新超时值,不会覆盖已保存的原设置备份)。

### Harness 服务

- **auto(默认)**:先探测已运行实例(接入 3080 或自定义端口),没有则托管启动。
- **external**:仅连接外部地址(如局域网内的另一台机器)。
- **managed**:始终由桌面端托管启动,启动命令支持**模板一键选择**:官方最新版(`npx @deepseek-ai/dsh` 自动下载)、官方指定版本(如 `@deepseek-ai/dsh@0.1.1-rc.2`)、本机仓库脚本(浏览选择 `run-local.cmd`),也可手动输入自定义命令(如 `pnpm dsh web --port {port}`)。

### 外观 · 壁纸

「设置 → 外观」可分别自定义:

- **主窗口壁纸**:顶栏与设置抽屉呈现毛玻璃透出效果(不影响内嵌 Web UI 的显示区域)。
- **屏保壁纸**:全屏背景图,带可调遮罩(0.1~0.9)保证文字可读。
- 图片会复制到应用数据目录(`%APPDATA%/DeepSeek Harness Desktop/wallpapers`),原图移动/删除不影响;支持 png/jpg/jpeg/gif/webp/bmp。

### 手机远程控制(PWA)

「设置 → 远程访问」启用后,桌面端开一个局域网网关(默认端口 3082,可修改,Bearer token 认证):

1. 手机与电脑连同一 WiFi,用手机扫设置面板中的**二维码**(或浏览器访问 `http://<电脑IP>:3082`)
2. 手机首次连接即直接可用(令牌即访问权),设备会自动登记到桌面端「已连接设备」列表,便于之后暂停或拉黑
3. 连接后页面顶部有**常驻状态条**(运行中的活动数 ▶、今日 Token 用量 💰),与桌面端同一份数据

**安装为 App(PWA)**:

- 默认走明文 HTTP。手机浏览器把 `http://192.168.x.x` 视为非安全上下文,**不会注册 Service Worker**——此时 PWA 仍可正常当浏览器标签页使用(在线收发消息/任务/审批),只是不缓存应用壳;
- 想要完整离线外壳与「添加到主屏幕」:桌面端 **设置 → 远程访问 → 启用 HTTPS**(自签证书,含本机全部局域网 IP 的 SAN,缓存在 userData)。手机首次访问会提示证书不受信任,手动信任一次即可,之后自动注册 Service Worker。设置面板会显示**证书 SHA-256 指纹与覆盖的地址**,信任前可据此核对;换网络/网卡导致 IP 变化时证书会自动重新签发,届时按新指纹再信任一次。
- 详见 [docs/PWA.md](docs/PWA.md)。

> 安全策略:远程访问默认启用 2 小时后自动关闭(可在设置中调整过期策略),到期需在桌面端重新启用;仅可信局域网可达,**禁止内网穿透/公网转发**。**有效令牌即访问权**——拿到令牌的人或程序能像你一样操控这台电脑,所以令牌必须保密,泄露后立即在设置里重新生成。
> 控制权全在桌面端:一键暂停全部连接(会立即断开已建立的连接,而不是等到下次请求)、单设备暂停/拉黑(拉黑或暂停后令牌正确也拒绝)、锁屏/睡眠自动暂停、可只监听当前局域网 IP。

手机端功能:

- **新对话(工作区优先)**:与 harness Web 一致——先选择/新建工作区,再创建对话;新会话自动落入所选工作区分组(预设工作区根也可直接作为工作区)
- **会话**:列表、历史、实时流式收发、停止任务;消息模式可选「排队」或「插入发送(打断当前等待)」
- **权限预设**:新建会话可指定「工作区可写」或「完全访问」(对应 harness 的 `/permission` 命令,需新版 harness)
- **任务**:输入描述 + 选择工作区 + 选择模型,一键运行并实时查看
- **工作区**:列表、新建、浏览文件夹;**文件预览**:文本/Markdown/图片/视频(mp4/webm)/音频/PDF——浏览器不支持内嵌 PDF 时提供「新窗口打开 / 下载」
- **壁纸**:内置壁纸一键切换,也可**从手机相册上传图片设为壁纸**
- **设置**:预设工作区根目录(查看/移除/浏览添加)、定时任务、重启 Harness 等
- **断线自动重连**:网络短暂断开(飞行模式/弱网)自动指数退避重连,恢复后自动回到原会话
- **安全**:Bearer token 认证 + RPC 白名单 + 文件浏览白名单(仅工作区/预设根内,越权 403),仅局域网可达

### QQ 机器人远程控制(可选)

「设置 → QQ 机器人」填入在 [QQ 开放平台](https://q.qq.com) 注册机器人得到的 AppID/AppSecret 即启用(留空自动禁用),**并在开放平台关闭机器人的「允许被添加为好友」**(首次启用时会强制确认:只有你本人能把机器人加为好友/拉进群)。想再收紧可填「允许的用户 openid」(留空 = 不限制;QQ 的 openid 识别需企业主体,个人主体拿不到自己的 openid,发一条消息即可在设置页状态里看到自己的),也可设置**默认工作区/目录**(任务命令未指定时自动使用)。在 QQ 私聊机器人发送指令(发送任意无法识别的消息,机器人会自动回复完整指令集与示例):

| 指令                                        | 说明                                                                                                   | 示例                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `状态` / `会话` / `工作区` / `模型` | 查询类                                                                                                 | `状态`、`工作区`                             |
| `任务 <描述>`                             | 默认工作区执行任务                                                                                     | `任务 分析这个仓库的架构`                      |
| `任务 @<工作区名> <描述>`                 | 指定工作区执行                                                                                         | `任务 @qqbot 修复登录 bug`                     |
| `任务 目录:<路径> <描述>`                 | 指定目录执行(仅限工作区/预设根目录内)                                                                  | `任务 目录:D:/work 写一个脚本`                 |
| `进入`                                    | **纯对话**:不绑定工作区/目录,朋友模式                                                            | `进入`                                         |
| `进入 <工作区名/目录>`                    | 在该工作区对话(助手模式)                                                                               | `进入 qqbot`、`进入 D:/work`                 |
| *(对话模式)*                              | 直接发消息即可,无需前缀;agent 回复**自动推送**给你,全程无"已发送"噪音;`退出` 结束              | `帮我看看项目里的 TODO` → 💬 回复 → `退出` |
| `进展 <会话id>`                           | 任务实时进展(状态/工具统计/最新输出)                                                                   | `进展 session-xxxxxxxx`                        |
| `停止 <会话id>` / `打开 <会话id>`       | 停止任务 / 查看会话内容                                                                                | `停止 session-xxxxxxxx`                        |
| `允许` / `拒绝`                         | **审批应答**:agent 请求权限时允许/拒绝(多个待审批时带会话 id)                                    | `允许`、`拒绝 session-xxxxxxxx`              |
| `选 <编号>`                               | **选择题应答**:回答 agent 提问(多选 `选 1 3`,自定义 `选 自定义:…`,多题批次 `#2 选 1`)     | `选 2`                                         |
| `定时 <时长> <任务>`                      | **定时任务**:`定时 10分钟 检查更新`(10 分钟/5m/2小时/1天 一次性;`定时 每天9:00 写日报` 每天) | `定时 10分钟 检查更新`                         |
| `定时列表` / `取消定时 <编号>`          | 查看/取消已排定时任务                                                                                  | `取消定时 2`                                   |
| `目录 <路径>` / `文件 <路径>`           | 浏览工作区目录 / 查看文本文件(白名单内)                                                                | `目录 D:/work`、`文件 D:/work/README.md`     |
| `导出 <会话id>`                           | 将会话导出为 Markdown(保存在桌面端`exports/` 目录)                                                   | `导出 session-xxxxxxxx`                        |
| `用量`                                    | 今日用量统计(会话数/回合数/Token)                                                                      | `用量`                                         |
| `角色 <设定>`                             | **角色扮演**:设置对话模式角色(仅纯对话生效,与朋友提示词叠加);`角色 无` 清除                    | `角色 你是温柔的英语老师`                      |
| *(私聊发图片)*                            | **图片理解**:对话模式下直接发图片,agent 看图分析                                                 | 发一张截图 →`看看这张图有什么问题`            |

**按钮操作**:任务启动后自动附带「⏹ 停止 / 📋 进展 / 📖 打开」按钮;审批推送带「✅ 允许 / ❌ 拒绝」;单选提问带选项按钮——点一下即操作/应答,基本不用打字。

**模式提示词**:`任务 xxx` 等指令下,agent 以**专业助手**身份工作;对话模式下以**朋友**口吻聊天;两套提示词可在桌面端「设置 → QQ 机器人」自定义(留空 = 不注入)。**角色扮演**:`角色 <设定>` 为对话模式叠加角色(如"你是温柔的英语老师"),`角色 无` 清除,在桌面端同样可预设默认角色。

**图片理解**:对话模式下直接给机器人发图片(私聊),agent 自动"看图说话",无需任何额外配置。

**对话可见性**:QQ/Telegram 的对话会话在手机 PWA 侧边栏「🤖 机器人对话」分组**置顶显示**,点开即可看到完整聊天记录并实时流式同步。

典型流程:`工作区` 查看列表 → `进入 qqbot` → 连续对话 → `退出`。

基于 [@tencent-connect/qqbot-nodejs](https://github.com/tencent-connect/qqbot-nodejs)(WebSocket 长连接),协议参考 [QQ 开放平台 API v2 文档](https://bot.q.qq.com/wiki/develop/api-v2/)(消息收发/消息类型/事件订阅)与 [Agent QQBot 接入指南](https://bot.q.qq.com/wiki/agent-qqbot/)。QQ 官方机器人以**被动回复**为主,但与机器人交互后 48 小时内支持**主动推送**;长回复自动分段。**agent 需要审批/提问时会主动推送通知**(QQ 交互窗口内与 Telegram 均可即时送达;低风险审批带「允许/拒绝」内联按钮,点一下即可应答;**高风险操作——写入/删除/执行等——只转桌面端确认,聊天侧「允许」无效**),推送失败时待办仍会附加在下次消息的回复末尾提醒。手机端同样支持审批:会话中出现审批/提问卡片,一键允许/拒绝或作答。QQ/Telegram 均可开启**默认对话模式**:非指令消息直接进入纯对话(不绑定工作区),无需先发「进入」。

## 开发

```sh
npm run build    # tsc 编译 main/preload/renderer/remote 到 dist/,再 esbuild 打包 PWA、复制静态资源
npm start        # 构建 + electron .

npm test         # 离线测试套件(无需 harness):指令解析、RPC 协议、审批流、任务队列、SQLite、网关断开
npm run lint     # ESLint(flat config,含类型感知规则)
npm run smoke    # 冒烟测试:验证 RPC 客户端与模型目录(需 harness 运行中)

npm run pack         # 打包安装版 + 免安装 zip 到 release/
npm run pack:zip     # 只出免安装 zip
npm run pack:portable # 只出单文件 portable exe
```

类型检查分三套(主进程 / 渲染进程 / PWA);另有 `tsconfig.scripts.json` 对 `scripts/*.mjs` 做 `checkJs` 扫描。CI 在 push 与 PR 上跑:三套类型检查 + 脚本 checkJs + 构建 + ESLint + `npm test`。

> 脚本 checkJs 只以 `scripts/` 目录下的报错判定成败:`scripts/*.mjs` 会 `require` 编译产物 `dist/`,而 `dist/` 是 tsc 的降级输出(类型断言在 emit 时被擦除),对它做 `checkJs` 得到的报错不代表源码有问题——源码已由上面三套类型检查完整覆盖。CI 因此显式过滤掉 `dist/` 的噪声。

调试开关:

- `--remote-debugging-port=9222` 启动时启用 CDP,可用 `node scripts/cdp-eval.mjs '<表达式>'` 检查页面状态。
- `--ss-debug` 启动时,屏保窗口保持打开(禁用空闲退出),便于调试屏保画面。
- `node scripts/mux-test.mjs <baseUrl>` 端到端管线测试:设置默认模型 → 建会话 → 发提示 → 订阅事件流(会消耗少量模型调用)。

### 结构

```
src/main/            主进程
  index.ts           入口(单实例锁、/s 屏保参数、事件桥、启动编排)
  config.ts          配置读写与老配置迁移(userData/config.json)
  ipc.ts             IPC 处理器注册
  harness.ts         harness 进程托管(探测/接管/拉起/健康检查/崩溃重启)
  client.ts          HTTP RPC 客户端(POST /api/<method> + mux 事件流)
  rpc-protocol.ts    RPC 协议适配器(typert 斜杠 / 旧版点协议的能力表与参数壳)
  gateway.ts         局域网网关(Bearer token、设备暂停/拉黑、RPC 与文件白名单、SSE)
  tls-cert.ts        自签 X.509 证书生成(纯 node:crypto,供 PWA 离线外壳用)
  remote-commands.ts 远程指令处理器(QQ/TG/PWA 共用:任务、审批、提问、会话、定时)
  remote-util.ts     远程指令的纯工具函数(可单测)
  qq-bot.ts          QQ 适配器(门禁、按钮身份、推送、诊断)
  qq-commands.ts     QQ 指令解析(纯函数,可单测)
  qq-onboard.ts      QQ 扫码绑定流程
  telegram-bot.ts    Telegram 适配器
  models.ts          模型目录、默认模型切换、自定义 Provider 向导
  screensaver.ts      屏保(空闲检测、全屏窗口、系统屏保注册)
  appearance.ts      三端壁纸与拼豆滤镜
  workspace-registry.ts  工作区注册表与路径白名单
  db.ts              SQLite 本地存储(活动/审计/任务队列,含旧 JSON 迁移)
  event-hub.ts       mux 事件广播
  notifications.ts   通知分级与勿扰时段
  updater.ts         版本检查
  diagnostics.ts     诊断信息收集
  settings-heal.ts   harness 配置自愈(改写前自动备份)
  tray.ts / windows.ts  托盘与窗口管理
src/preload.ts       预加载(IPC 桥,渲染进程不直接接触 Electron)
src/renderer/        渲染进程(经典脚本,无打包器)
  index.html         主窗口(控制条 + 工作台 + webview)
  main.ts            主窗口逻辑
  screensaver.html   全屏屏保(壁纸 + 时钟)
src/remote/          手机 PWA(网关直接托管)
  index.html app.ts  单页应用
  sw.js              离线外壳(仅 HTTPS 下可注册)
  manifest.webmanifest + 图标
scripts/             构建、冒烟、端到端与离线测试脚本
```

### 与 harness 的通信协议

桌面端直接实现 deepseek-harness 的 HTTP RPC 协议,并兼容两代 harness:

- **官方 `@deepseek-ai/dsh` 0.1.2-rc.1+**(typert 斜杠协议):探测时自动协商协议与参数壳,支持浏览器 token 鉴权(`?token=` 换持久 cookie);模型目录走 `session/modelCatalog`、Provider 目录走 `llm/listProviders` / `llm/listConfigurableProviders`,自定义 Provider 写入走 `settings/update` + `settings/mutate` + `credentials/set`。
- **旧版 / 自建 fork**(点协议):`llm.models`、`llm.providers`、`workspace.*`、`host.describe` 等方法自动回退兼容。
- 一元调用:`POST /api/<method>`,body 为 `{type:'client-request', rpcId, method, payload}`,响应 `{type:'server-response', rpcId, result}`;回环地址免令牌。
- 事件流:`GET /api/events.mux`(SSE / WebSocket 自动协商),推送 `session/event` 等帧,手机 PWA 与机器人通道据此实时渲染。
- 会话历史回放(官方版无 `session.history`):先取 `session/list` 的 `projections.asOfSeq`,再调 `session/page` 拉取记录,过滤出 message 级事件回放给手机 / QQ / 屏保。
- 关键方法:`session.list/create/prompt/cancel/rename/selectModel`、`session.modelCatalog`、`session.page`、`llm.listProviders/listConfigurableProviders/discoverModels`、`settings.update/mutate`、`credentials.set`、`workspace.create/rename/delete`。

协议细节随 harness 演进可能变化;桌面端对参数壳(typert:`_request` / `request` / 平铺)按方法自适应,并在官方版缺失旧方法时提供降级或桥接(如 `workspace.list` 由会话 cwd 合成)。

## 已知限制

- 手机浏览器普遍禁用 iframe 内嵌 PDF 预览,手机端提供「新窗口打开 / 下载」两种方式查看 PDF。
- 屏保为纯展示(壁纸 + 时钟),不承载交互;需要看 agent 在做什么请回到主窗口的 Web UI 或手机 PWA。
- 系统屏保注册仅支持 Windows(注册表方案,注册前自动备份原设置,取消时恢复);macOS/Linux 可用内置空闲检测模式。
- 事件流传输自动协商:旧版 harness 只接受 WebSocket(HTTP 返回 426),新版额外支持 SSE;两者都兼容。
- 屏保窗口内禁用了系统休眠时的自动唤醒逻辑(跟随系统屏保行为)。

## 参考与致谢 / Acknowledgements

本项目站在众多优秀开源项目的肩膀上,在设计与实现中参考、依赖并致谢以下项目及其维护者:

| 项目                                                                                                                        | 贡献                                                                                                                              | 许可     |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)                                              | 核心 Agent 引擎与 HTTP RPC / 事件流协议(`dsh-host-apiproxy`:一元 RPC、mux 事件流、settings/credentials/llm 域),桌面端、手机 PWA 与机器人通道都建立在它之上 | MIT      |
| [tencent-connect/qqbot-nodejs](https://github.com/tencent-connect/qqbot-nodejs)                                              | QQ 开放平台机器人 Node SDK:WebSocket 网关、消息收发、主动推送(48h 窗口)与内联键盘审批按钮                                        | MIT      |
| [tencent-connect/qqbot-agent-sdk](https://github.com/tencent-connect/qqbot-agent-sdk)                                        | 扫码登录(onboard:create_bind_task / AES-GCM 凭据解密)与审批内联键盘的协议参考实现                                                | MIT      |
| [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)                                                    | 官方 QQ×DSH 插件:指令集、会话映射与事件展示的设计参考                                                                            | 各自许可 |
| [electron](https://github.com/electron/electron) 与 [electron-builder](https://github.com/electron-userland/electron-builder) | 桌面壳与打包分发                                                                                                                  | MIT      |
| [node-qrcode](https://github.com/soldair/node-qrcode)                                                                        | 手机扫码配对与 QQ 扫码登录的二维码生成                                                                                            | MIT      |

QQ 机器人通道的协议细节参考了 [QQ 开放平台 API v2 文档](https://bot.q.qq.com/wiki/develop/api-v2/) 与 [Agent QQBot 接入指南](https://bot.q.qq.com/wiki/agent-qqbot/)。

同时感谢 DeepSeek Harness 社区与本项目测试过程中提供反馈的各位使用者。完整第三方组件与许可证清单(含间接依赖)见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md),发布包内随附一份。

如果你也是这些项目的维护者——谢谢你们的工作,让这个项目成为可能 🙏

## 支持与联系 / Support

觉得有用?欢迎加入内测交流群反馈问题、提出建议;也可以请作者喝杯咖啡 ☕

| 内测交流群(QQ)                              | 微信赞赏                                        |
| ------------------------------------------- | ----------------------------------------------- |
| <br />![QQ 群](assets/support/qq-group.jpg) | ![微信赞赏码](assets/support/wechat-reward.jpg) |
