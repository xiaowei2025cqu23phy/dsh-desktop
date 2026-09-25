# 兼容性与冻结说明

本项目**已进入冻结状态**:只做必要的正确性修复,不再跟随 deepseek-harness 的版本演进。
本文写清"适配到什么、超出边界会怎样",避免以后拿新版本遇到问题时无从判断。

## 一、实测适配的 harness 版本

| 项目 | 值 |
| --- | --- |
| 桌面端版本 | 0.6.1 |
| 官方 harness(`@deepseek-ai/dsh`) | **0.1.7-rc.2**(`next` 渠道) |
| 协议形态 | typert 斜杠协议(`_request` / `request` 参数壳自动协商) |
| 运行方式 | 托管启动 `npx --yes @deepseek-ai/dsh@next web --port {port} --no-open` |

桌面端直接实现 harness 的 HTTP RPC,不依赖它的内部包。因此**小幅版本变化通常无感**,
但跨越协议变更(方法改名、参数壳改动、事件字段调整)就会失效 —— 见下节。

### ⚠️ 必须跟住 `next` 渠道的原因:会话格式版本

`dsh` 的会话文件是**多版本并存的物理格式**(同一会话可能有 `session.jsonl.zstd`、
`session.v3.jsonl.zstd`、`session.v4.jsonl.zstd`),读取靠一组迁移包:

| harness 版本 | 带的格式迁移包 | 能读的会话 |
| --- | --- | --- |
| `0.1.5-rc.3`(`latest`) | v0→v1、v1→v2、v2→v3 | **只到 v3** |
| `0.1.7-rc.2`(`next`) | 追加 **v3→v4** | v3 + v4 |

**踩过的坑**:本机同时存在官方版桌面端(自带 0.1.7 系 harness)与本项目。官方版把会话
写成了 **v4**,而本项目用 `latest`(0.1.5-rc.3)拉起的 harness **读不了 v4** —— 表现是

```
session.list 只返回 200 条,磁盘上较新的 15 个会话全部不见
(这些会话的格式文件全都含 v4,可见的全部只有 v1/v3)
```

而且**桌面端内嵌页面、手机 PWA、网关三处同时看不到** —— 因为它发生在 harness 层,
与各客户端无关。定位时先看这一点,不要一上来查客户端取数链路。

**结论:本项目必须使用 `next` 渠道**(`@deepseek-ai/dsh@next`)。用 `latest` 会读不到
官方版/较新版本写出的会话。若同一台机器上还有官方版桌面端之类的 v4 写入方,
保持 `next` 是唯一能双向读写的方式。

> 代价:`next` 是预发布渠道,升级会带来行为变化。升级后请回归一遍会话列表、历史回放、
> 网关鉴权(见 `scripts/gateway-stop-test.mjs` 与 `node scripts/pwa-shell-test.mjs`)。


## 二、超出边界时的行为(韧性优先,不做多版本适配)

设计原则:**不认识的版本一律安全降级,绝不静默做错事**。

| 情况 | 行为 |
| --- | --- |
| 实例不可达 | 能力探测返回 `reachable: false`、`source: 'unknown'`、`probes: []`,不逐方法傻等超时 |
| 版本/来源无法判定 | `source: 'unknown'`,界面**隐藏**所有魔改增强入口(侧边栏文件浏览、文本/图片预览等),不出现"点了没反应"的按钮 |
| RPC 方法不存在 | 归类为 `http-404`,该能力标记为不可用并降级;有替代路径的走替代(如 `workspace.list` 由会话 cwd 合成) |
| 方法存在但参数不符 | 归类为参数错误(不是消失),据方法表自适应参数壳 |
| 会话历史接口缺失 | 官方版无 `session.history`:先取 `session/list` 的 `projections.asOfSeq`,再 `session/page` 分页回放 |

**已知会导致失效的变更**(如果将来 harness 这样改,本项目需要人工介入,不是自动兼容):

- `session/list`、`session/page`、`session/prompt` 等方法改名或改参数
- `session/event` 帧结构变化(本项目按 `turn/start`、`assistant/chunk`、`turn/end` 等类型解析)
- 审批/提问帧字段变化(`approvalId` / `toolName` / `reason` / `questions`)
- 会话文件格式再次迁移(见下节)

## 三、会话格式:已知的一次迁移事故与修复

**现象**:某个 461 轮 / 17 万条记录的会话无法加载,报

```
failed to observe session "session-…": assistant/message 4060703 chunk references are not
one complete ordered attempt; source v0 artifact remains unchanged
```

**根因**:v1→v2 迁移的 `matchesChunkSources` 要求 `assistant/message` 声明的
`sourceEventSeqs` 必须**逐元素等于**从 chunk 片段重建出的 attempt。该记录声明了
`[[4059829, 4060702]]` —— 起点 `4059829` 是一个 `session/end-seed`(继承切点),
不是 chunk,于是声明 874 条、重建 873 条,迁移拒绝且**没有恢复模式**,整个会话再也打不开。

**修复**:把起点后移一位

```diff
- "sourceEventSeqs":[[4059829,4060702]]
+ "sourceEventSeqs":[[4059830,4060702]]
```

**修复步骤**(容器是多个独立 zstd 帧,只重编受影响的那一帧,其余帧字节不动):

1. 备份整份文件;
2. 帧起点 = zstd 魔数 `28 B5 2F FD` 的位置(本文件 1359 帧:第 0 帧是 225 字节的
   `session` 头,第 1 帧是 164MB 主体,其余为增量);
3. 逐帧 `zstdDecompressSync`,定位含目标字符串的帧,替换后重编该帧;
4. 重新拼接,校验:帧数一致、解压长度一致、行数一致、全量 `JSON.parse` 通过、
   **只有目标那一行不同**。

**给以后的提示**:这类"声明范围多含一个非 chunk 起点"的 off-by-one 是 v1 写入端的历史缺陷,
只会在 end-seed 恰好落进消息窗口时触发。如果你遇到同样的报错,先按上面的方式核对起点
是不是 `session/end-seed` 之类的结构性事件 —— 是的话改声明即可,不需要重编号,也不需要重建会话。

## 四、已知的打包陷阱(与本项目相关,已在 0.6.1 修复)

- **`ws` 未随 SDK 解包**:`@tencent-connect/qqbot-nodejs` 被 `asarUnpack` 解到磁盘,
  而它的唯一运行时依赖 `ws` 留在 asar 里;SDK 是从磁盘路径加载的,沿文件系统向上找
  `node_modules/ws` 找不到 → 打包版里 QQ 机器人启动即 `ERR_MODULE_NOT_FOUND`。
  修复:`asarUnpack` 增加 `node_modules/ws/**`。
- **监听地址写死**:远程访问若选了「仅当前局域网 IP」,换网络后该地址不再属于本机,
  `listen` 以 `EADDRNOTAVAIL` 失败。修复后:自动回退到 `0.0.0.0` 并在设置面板如实说明;
  监听失败也会清掉内部引用,使「重新启用」真的能重试(此前只能重启应用)。

## 五、对本机运行环境的一个提醒

Electron 应用若在 `ELECTRON_RUN_AS_NODE=1` 的环境下启动,会**以纯 Node 模式运行**,
表现为"双击没反应、无窗口、无日志、退出码 0"。这是环境变量所致,不是应用缺陷。
排查启动问题时先确认这个变量没有设置:

```powershell
[Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE','User')
[Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE','Machine')
```
