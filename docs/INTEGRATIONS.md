# 远程控制接入指南 / Remote Control Integration Guide

> 汉英双语 / Bilingual (中文 · English)

本文介绍如何通过 **Webhook 命令端点** 把任意设备/服务接入 dsh-desktop 远程控制。
This guide shows how to hook any device or service into dsh-desktop remote control through the **Webhook command endpoint**.

## 0. 准备 / Prerequisites

**中文**
1. 桌面端「设置 → 远程访问」勾选启用,记下:局域网地址(如 `http://192.168.1.5:3082`)、端口、**访问令牌**。
2. 端点:`POST /api/command`,请求头 `Authorization: Bearer <令牌>`,JSON 体 `{"text":"<指令>"}`。
3. 支持的指令与 QQ/Telegram 相同:状态 / 会话 / 工作区 / 任务 / 进入(对话模式)/ 进展 / 停止 / 打开 / 模型 / 退出。

**English**
1. In the desktop app, enable **Settings → Remote Access** and note: the LAN address (e.g. `http://192.168.1.5:3082`), the port, and the **access token**.
2. Endpoint: `POST /api/command` with header `Authorization: Bearer <token>` and JSON body `{"text":"<command>"}`.
3. Supported commands are the same as QQ/Telegram: 状态(status) / 会话(sessions) / 工作区(workspaces) / 任务(run) / 进入(chat mode) / 进展(progress) / 停止(cancel) / 打开(open) / 模型(models) / 退出(exit).

---

## 1. 命令行 / curl (脚本、定时任务)

**中文**:Windows/Linux/macOS 都可直接用 curl 发指令,适合脚本与计划任务。
**English**: Works everywhere with curl — great for scripts and scheduled jobs.

```bash
# 查状态 / status
curl -X POST http://192.168.1.5:3082/api/command \
  -H "Authorization: Bearer <令牌>" \
  -H "Content-Type: application/json" \
  -d '{"text":"状态"}'

# 运行任务 / run a task
curl -X POST http://192.168.1.5:3082/api/command \
  -H "Authorization: Bearer <令牌>" \
  -H "Content-Type: application/json" \
  -d '{"text":"任务 备份项目到 release 分支"}'
```

---

## 2. 钉钉群机器人 / DingTalk Group Bot

**中文**
1. 钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义(Webhook),复制 Webhook 地址。
2. 用「加签」安全设置时,把密钥填入下方脚本;否则留空。
3. 任意成员在群里发 `任务 xxx`,机器人回调 → 桌面端执行 → 结果发回群里。

**English**
1. DingTalk group → Group Settings → Smart Group Assistant → Add bot → Custom (Webhook); copy the webhook URL.
2. If "signature" security is enabled, put the secret in the script below; otherwise leave it empty.
3. Any member can send `任务 xxx` in the group; the bot relays it to the desktop app and posts the result back.

```python
# dingtalk_bridge.py —— 钉钉群机器人转发器(部署在可访问 3082 的机器上)
import hmac, hashlib, base64, time, urllib.parse, urllib.request, json

WEBHOOK = "https://oapi.dingtalk.com/robot/send?access_token=XXXX"
SECRET = ""  # 加签密钥(未启用留空)
DSH = "http://127.0.0.1:3082/api/command"
TOKEN = "<桌面端访问令牌>"

def sign():
    if not SECRET: return ""
    ts = str(round(time.time() * 1000))
    s = f"{ts}\n{SECRET}".encode()
    sig = base64.b64encode(hmac.new(SECRET.encode(), s, digestmod=hashlib.sha256).digest())
    return f"&timestamp={ts}&sign={urllib.parse.quote_plus(sig.decode())}"

def send(text):
    body = json.dumps({"msgtype": "text", "text": {"content": text}}).encode()
    req = urllib.request.Request(WEBHOOK + sign(), data=body, headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=10)

def run_cmd(text):
    body = json.dumps({"text": text}).encode()
    req = urllib.request.Request(DSH, data=body, headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())["reply"]

# 钉钉回调入口(Flask 示例):
# @app.route("/ding", methods=["POST"])
# def on_ding():
#     content = request.json["text"]["content"].strip()
#     reply = run_cmd(content)
#     send(reply)
#     return "ok"
```

---

## 3. 飞书群机器人 / Feishu (Lark) Group Bot

**中文**
1. 飞书群 → 设置 → 群机器人 → 添加机器人 → 自定义机器人,复制 Webhook。
2. 与钉钉思路相同:机器人收到群消息 → 调用 `/api/command` → 结果回传。

**English**
1. Feishu group → Settings → Group bots → Add bot → Custom bot; copy the webhook URL.
2. Same idea as DingTalk: the bot receives group messages → calls `/api/command` → posts the reply back.

```python
# feishu_bridge.py —— 飞书群机器人转发器
import urllib.request, json

WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/XXXX"
DSH = "http://127.0.0.1:3082/api/command"
TOKEN = "<桌面端访问令牌>"

def send(text):
    body = json.dumps({"msg_type": "text", "content": {"text": text}}).encode()
    req = urllib.request.Request(WEBHOOK, data=body, headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=10)

def run_cmd(text):
    body = json.dumps({"text": text}).encode()
    req = urllib.request.Request(DSH, data=body, headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())["reply"]

# 飞书回调入口(Flask 示例):接收 event → 解析 text → run_cmd → send
```

---

## 4. Home Assistant

**中文**:在 configuration.yaml 里加一个 REST 命令开关,即可用自动化/语音控制电脑。
**English**: Add a REST command switch in configuration.yaml to control the PC from automations or voice.

```yaml
rest_command:
  dsh_command:
    url: "http://192.168.1.5:3082/api/command"
    method: post
    content_type: application/json
    headers:
      Authorization: "Bearer <令牌>"
    payload: '{"text": "{{ command }}"}'
```

然后就能在自动化/脚本里:`service: rest_command.dsh_command`,data:`command: 任务 备份数据库`。语音:`“好的,执行任务 备份数据库”`。
Then use it in automations/scripts: `service: rest_command.dsh_command` with `command: 任务 备份数据库`, even via voice assistants.

---

## 5. iOS 快捷指令 (Shortcuts)

**中文**
1. 快捷指令 App → 新建快捷指令 → 添加「获取 URL 内容」。
2. URL:`http://192.168.1.5:3082/api/command`;方法 POST;请求头加 `Authorization: Bearer <令牌>`;请求体 JSON:`{"text": "状态"}`。
3. 把快捷指令加到主屏幕/锁屏/语音(Siri),即可一键查状态、发任务。

**English**
1. Shortcuts app → New Shortcut → add "Get Contents of URL".
2. URL: `http://192.168.1.5:3082/api/command`; method POST; add header `Authorization: Bearer <令牌>`; request body JSON: `{"text": "状态"}`.
3. Add the shortcut to Home Screen / Lock Screen / Siri — one tap to check status or launch tasks.

---

## 6. 其他 Webhook 服务 / Other Webhook Services

**中文**:任何能发 HTTP POST 的服务(IFTTT Webhook、Zapier、n8n、Node-RED、Windows 任务计划)都可以按同一格式接入:
`POST /api/command` + `Authorization: Bearer <令牌>` + `{"text":"<指令>"}`,响应 `{"ok":true,"reply":"<结果>"}`。

**English**: Any service that can send an HTTP POST (IFTTT Webhook, Zapier, n8n, Node-RED, Windows Task Scheduler) can integrate the same way:
`POST /api/command` + `Authorization: Bearer <token>` + `{"text":"<command>"}` → `{"ok":true,"reply":"<result>"}`.

---

## 安全提示 / Security Notes

**中文**
- 令牌等同于电脑控制权,请勿泄露;在「设置 → 远程访问」可随时重新生成(旧令牌立即失效)。
- 建议仅在可信局域网使用;如需公网接入,请通过 VPN/隧道并保持令牌强度。
- Webhook 端点与手机 PWA 共用同一端口与令牌,关闭「远程访问」即同时关闭。

**English**
- The token is full control of your PC — never share it; regenerate it anytime in **Settings → Remote Access** (the old one stops working immediately).
- Use it on trusted LANs only; for internet access, go through a VPN/tunnel and keep the token strong.
- The Webhook endpoint shares the port and token with the phone PWA; disabling "Remote Access" disables both.
