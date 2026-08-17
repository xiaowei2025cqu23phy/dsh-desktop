## DSH Desktop — DeepSeek Harness 桌面客户端(已开源)

给 DeepSeek Harness 做的**桌面客户端**(Electron + TypeScript):让 agent 真正融入日常——AI 屏保、聊天机器人、手机遥控,三端一体。

**仓库**: https://github.com/xiaowei2025cqu23phy/dsh-desktop
**下载**: GitHub Releases(Windows 安装包 / zip)

---

### 🖥️ AI 屏保模式
空闲后全屏展示 agent 正在做什么(实时流式输出、工具调用过程),像一块"会思考的鱼缸"。可注册为系统屏保,自动启动任务、超时护栏防失控。

### 🤖 QQ 机器人远程控制
- **扫码登录**:设置面板扫二维码,自动获取 AppID/AppSecret,不用手填
- **审批/提问按钮**:agent 要权限、要选择题答案时,主动推送带「允许/拒绝」「选项按钮」的消息,点一下即应答
- **图片理解**:对话里直接发图片,agent 看图分析
- **流式输出**:QQ 私聊打字机效果,实时显示 agent 回复
- **定时任务**:`定时 10分钟 xxx` / `定时 每天9:00 写日报`,重启保留
- **角色扮演**:`角色 你是温柔的英语老师`,对话模式叠加人设
- **Token 用量**:`用量` 查看今日会话/回合/Token 统计
- 更多:目录/文件浏览、会话导出 Markdown、模型切换、任务进展/停止/打开

### ✈️ Telegram 机器人
同样的指令集与审批/提问应答,telegram 即时推送,无需 48h 窗口。

### 📱 手机 PWA 遥控(局域网)
- 扫码配对,自动填地址与令牌;添加到主屏幕即当 App 用
- 会话列表/历史/实时流式聊天/停止任务;一键新任务(描述+工作区+模型)
- **文件夹浏览与文件预览**:手机上直接看电脑上的项目文件(仅限工作区/预设根,越权 403)
- **手机端也能设置**:预设工作区根目录、手机壁纸、定时任务、重启服务
- 安全:Bearer token + RPC 白名单 + 文件浏览白名单,仅局域网可达

### 🎨 壁纸体系
主窗口 / 手机 / 屏保**三端独立壁纸**;导入图片一键**拼豆像素滤镜**(本地处理);内置鲸鱼壁纸包 + 自建壁纸包收纳。

### 🐳 桌面宠物
右下角小鲸鱼动画,agent 忙碌时游得更快、泡泡更多;可拖动,双击隐藏。

### 🔒 隐私优先
- 发布包**不含**任何本地配置/壁纸/访问令牌/API 密钥/会话数据
- 用户数据只在系统用户目录;仓库内置提交前隐私检查脚本
- 自定义开源许可证:衍生作品非商用(DeepSeek 官方与作者除外)

---

### 演示
- 主界面 + 屏保: https://raw.githubusercontent.com/xiaowei2025cqu23phy/dsh-desktop/master/assets/demo-main.gif
- 手机 PWA: https://raw.githubusercontent.com/xiaowei2025cqu23phy/dsh-desktop/master/assets/demo-remote.gif
- AI 屏保: https://raw.githubusercontent.com/xiaowei2025cqu23phy/dsh-desktop/master/assets/demo-screensaver.gif

### English Summary
**dsh-desktop** is an open-source Electron desktop client for DeepSeek Harness: an AI screensaver that visualizes the agent's work, QQ/Telegram bot channels with inline approval/question buttons, image understanding, streaming output, scheduled tasks and role-play, plus a phone PWA remote (LAN gateway, QR pairing, session/task control, folder browsing, wallpaper & preset-root management). Three-surface wallpaper system with a beads-pixel filter, session export, token usage stats and a desktop pet. Privacy-first: release packages contain no local config, wallpapers, tokens or keys. Try it via GitHub Releases, feedback and PRs welcome!
