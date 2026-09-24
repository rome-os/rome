# 让 Rome 发送微信消息：开源方案与技术原理调研

调研日期：2026-09-23。作者：Rome 研究助手（受 zhangfan 委托）。

本文只做调研，不改产品代码、不对 `rome-os/rome` 提 PR。

## 背景与问题

Rome 已经有一个"个人微信"连接 `wechat_user`：它在 Rome 自己的 Linux `/desktop` 显示器上运行**官方微信桌面客户端**，用 gdb 在首次登录时抓取数据库密钥，再直接读客户端本地库来展示聊天记录（见 [`docs/wechat-personal.md`](https://github.com/rome-os/rome/blob/main/docs/wechat-personal.md)、[`docs/architecture/channels.md#wechat-personal-account`](https://github.com/rome-os/rome/blob/main/docs/architecture/channels.md)、[`packages/core/src/connections/integrations/wechat-user.ts`](https://github.com/rome-os/rome/blob/main/packages/core/src/connections/integrations/wechat-user.ts)、`packages/core/src/channels/wechat-user*.ts`）。这个连接目前**只读**。

现在的目标是让 Rome 能**从 guardian 本人的个人微信账号**发消息给任意联系人。工作仓库里已经有一份在评审中的交付（`personal-wechat-replies/product-spec.md`、`technical-spec.md`，工作仓库 `zhangfand/rome-work` 提交 `8868d1b`）。它的核心决策 **E1** 是：**用 `xdotool` + 剪贴板（`xclip`）驱动那个已经在跑的桌面客户端**——激活窗口、搜索联系人、粘贴文本、回车；并**明确否决了用 gdb hook 客户端内部函数来发送**（理由：hook 要按每个客户端版本钉死函数地址，还可能把持有密钥的会话搞崩）。

约束前提：**Rome 跑在 Linux 上**；账号是 **guardian 本人的个人号，不是 bot / 企业号**。下面把开源方案按技术路线分组，说明每条路线"跟谁通信、怎么鉴权、消息实际怎么发出去"，并逐条评估封号风险、ToS/法律风险、能否触达任意个人联系人、是否支持 Linux、以及微信更新时怎么坏。

> 一个贯穿全文的大背景：2025 年下半年起腾讯对"违规获取及利用微信终端用户数据"的第三方工具展开集中打击（发律师函、要求删库）。`PyWxDump` 于 2025-10-20 收到律师函后删除全部代码与历史（[仓库现状](https://github.com/xaoyaoo/PyWxDump)）；`Gewechat` 已停止维护并归档，其 README 直接引用了腾讯的打击公告（[仓库现状](https://github.com/Devo919/Gewechat)）；`WeChatFerry`、`ComWeChatRobot` 也已 archived。因此本领域几乎所有非官方项目都处于"能用但随时可能失效/被追责"的灰色状态。

---

## 路线 1：Web / UOS 网页协议（基本已死）

**原理**：模拟 `wx.qq.com` 网页版微信。扫码登录拿到 web session（`sid`/`uin`/`skey` 等 cookie），再轮询 `synccheck`/`webwxsync` 收消息、调 `webwxsendmsg` 发消息。纯 HTTP，跨平台，无需客户端。

**代表开源项目**：
- itchat — [littlecodersh/ItChat](https://github.com/littlecodersh/ItChat)，MIT，最后 push 2023-09，26k★，Python。
- wechat4u — [nodeWechat/wechat4u](https://github.com/nodeWechat/wechat4u)，无 license，最后 push 2024-07，JS。
- [wechaty/puppet-wechat4u](https://github.com/wechaty/puppet-wechat4u)，Apache-2.0，最后 push 2024-05，把 wechat4u 包成 Wechaty puppet。

**为什么基本已死**：微信多年前就对绝大多数个人号封禁了网页登录，扫码后返回"为了你的账号安全，网页版微信已停止登录，请使用 Windows/Mac 客户端"（[实例](https://github.com/koma-private/recipe-wechat/issues/3)）。只有极少数老号还能网页登录，新号一律不行。所以这些库虽然仓库还在、代码也没删，但对绝大多数账号**根本登不上**。

- 封号风险：登录本身就被拦；即使老号能登，行为极易被判异常。
- ToS/法律：违反微信软件许可，属被打击范围。
- 能否触达任意联系人：协议上可以，但登录门槛已使其对新号不可用。
- Linux：✅ 纯 HTTP。
- 微信更新如何坏：已经坏了——服务端直接拒绝网页登录。**不推荐。**

---

## 路线 2：模拟其它客户端的私有协议（iPad / Mac / Android "Pad 协议"）

**原理**：不碰官方 PC 客户端，而是逆向 iPad/安卓/Mac 端的**私有长连接协议**（mmtls 加密、protobuf 报文），用自建服务器冒充那一端登录。扫码/辅助登录后，服务端替你维持在线，通过它收发消息。这类"Pad 协议"在业内最稳、能触达任意联系人和群，但**协议本身几乎都是闭源商业服务**，开源的只是调用它的 SDK/客户端壳。

**代表项目**：
- [wechaty/puppet-padlocal](https://github.com/wechaty/puppet-padlocal)（Apache-2.0，最后 push 2023-07，Node）+ [wechaty/wechaty](https://github.com/wechaty/wechaty)（Apache-2.0，活跃，23k★）。**关键**：SDK 开源，但真正的 Pad 协议实现是 `pad-local.com` 的**付费 token 服务**（7 天免费试用，长期 token 需付费购买，见 [Wechaty token 文档](https://wechaty.js.org/docs/puppet-services/tokens) 与 [padlocal wiki](https://github.com/wechaty/puppet-padlocal/wiki/How-to-Apply-Token)）。也就是说这是"开源 SDK + 闭源/收费后端"。
- Gewechat — [Devo919/Gewechat](https://github.com/Devo919/Gewechat)，Apache-2.0，3.5k★，**已停止维护并归档**，README 明说服务端实现、Docker 镜像、部署方式都不再提供，只留 Java 调用示例；停维原因直接指向腾讯的打击公告。属于典型"开源客户端壳 + 闭源托管服务"，后端已随打击关停。
- [wechaty/puppet-xp](https://github.com/wechaty/puppet-xp)（Apache-2.0，最后 push 2025-07）——严格说是 Windows 注入（见路线 3），但常和上面并列作为 Wechaty 的 provider 之一。

**评估**：
- 封号风险：中高。冒充非官方客户端 + 云端常驻，是风控重点；业内普遍用小号。
- ToS/法律：违反 ToS；付费 token 服务方多在灰色地带，且正被打击（Gewechat 已关停）。
- 能否触达任意联系人：✅ 这是该路线最大优点——能主动发给任意好友和群。
- Linux：✅ 服务端/SDK 可跑在 Linux（PadLocal 后端是远程服务）。
- 微信更新如何坏：协议侧由服务商跟进，对使用者较透明；但**服务商一旦被关停就整条断掉**（Gewechat 即例）。
- 对 Rome 的意义：需要把账号托管到第三方付费服务、或冒充另一端登录，**与"用 guardian 本机上已登录的官方客户端"这一现有架构相冲突**，且引入外部依赖与更高封号/合规风险。

---

## 路线 3：PC 客户端 Hook / 注入（DLL 注入 + 函数偏移）

**原理**：在 Windows 官方客户端进程里**注入 DLL**，直接调用客户端内部的"发送消息 Call"，并把这些能力通过本地 HTTP/gRPC/COM 暴露成 RPC。收发都走客户端自己的逻辑，所以能触达任意联系人和群、稳定性高。代价是**每个微信版本都要重新逆向、把函数地址/偏移钉死**，版本一升就失效。

**代表开源项目**：
- [lich0821/WeChatFerry](https://github.com/lich0821/WeChatFerry)，MIT，6.8k★，**已 archived**（最后 push 2026-07）。RPC 化的 hook，功能清单含"发送文本消息（可 @）/图片/文件/卡片/XML/GIF"等。
- [ttttupup/wxhelper](https://github.com/ttttupup/wxhelper)，MIT，3.2k★，最后 push 2026-06。README 直述原理：逆向定位关键 Call → 写 DLL 调用 → 注入进程 → DLL 内起一个默认 19088 端口的 HTTP 服务，所有功能通过 HTTP 调用；支持 3.8.x–3.9.x 一串具体版本，"分支名即微信版本"。README 自带免责声明并警告"可能造成封号"。
- [ljc545w/ComWeChatRobot](https://github.com/ljc545w/ComWeChatRobot)，无 license，**已 archived**（最后 push 2023-01），把能力封装成 COM 接口供 Python/C# 调用。

**评估**：
- 封号风险：高。注入 + 内部 Call 是最典型的逆向特征，wxhelper 自己都警告封号。
- ToS/法律：明确违反 ToS；属被打击的"逆向/hook"类。
- 能否触达任意联系人：✅ 直接调内部发送 Call，任意好友/群都行。
- Linux：❌ **只针对 Windows 客户端**（PE/DLL 注入）。这一点对 Rome 是硬伤。
- 微信更新如何坏：每次版本更新函数偏移变化即失效，需重新逆向、按版本钉死（正是 Rome E1 否决 gdb hook 的同一理由）。
- 对 Rome 的意义：Rome 是 Linux，本路线的成熟实现都在 Windows，直接不适用；而 Linux 上"hook 客户端内部函数"正是 E1 已论证会"按版本钉死地址、且可能搞崩持密钥会话"而否决的做法。

---

## 路线 4：官方客户端的 UI 自动化（Rome E1 所在路线）

**原理**：不碰协议、不注入内存，把自己当成"一个操作键鼠的人"来驱动**官方客户端的 GUI**：定位并激活窗口、在搜索框输入联系人、把文本放进控件、回车发送。发送走的是客户端自己的正常流程，因此能触达任意联系人；但**没有可靠的"发送成功"返回值**，需要另行确认（读回自己发出的那条消息）。

**代表开源项目 / 技术**：
- Windows：[cluic/wxauto](https://github.com/cluic/wxauto)，Apache-2.0，7.3k★，最后 push 2026-04。基于 Windows **UIAutomation** 驱动 PC 微信（3.9.x），"实现简单的发送、接收微信消息"。README 免责声明明确"仅用于 UIAutomation 技术交流学习，禁止用于实际生产/商业用途"。
- macOS：基于系统 **Accessibility（辅助功能）API** 驱动 Mac 微信的脚本/工具（AppleScript + `AXUIElement`）。零散实现较多，缺少一个公认的主力开源库——**（未核实：没有找到一个高星、活跃、许可清晰的代表仓库）**。
- Linux：**`xdotool` 风格**的 X11 键鼠驱动 + `xclip`/`xsel` 剪贴板——这正是 Rome **E1** 采用的做法（驱动它已经在 `/desktop` 上跑的官方 Linux 客户端）。Linux 微信没有 wxauto/UIAutomation 那样的成熟自动化库，`xdotool` 是通用替代。

**评估**：
- 封号风险：相对最低。行为在客户端看来接近真人操作，不改协议、不改内存、不冒充其它端。这也是它相对其它路线的核心优势。（仍非零：高频/机械化操作理论上可被行为风控注意到。）
- ToS/法律：仍属自动化操作，严格说不被鼓励，但不涉及逆向/数据窃取，处于灰色地带里"最浅"的一档。
- 能否触达任意联系人：✅ 走客户端搜索即可打开任意好友会话（群聊 Rome 按 spec 主动排除）。
- Linux：✅ 唯一在 Linux 官方客户端上原生可行的驱动方式。
- 微信更新如何坏：不依赖函数偏移，但依赖 **UI 布局与搜索行为**。E3 的评审已经踩到一个真实坑：微信搜索会按**拼音和首字母**匹配名字，纯字符串比较复现不了，可能打开错误会话——所以 E3 修订为"只用本人选定的 id（微信号，否则 alias），名字绝不作为搜索键"。窗口焦点、搜索框是否拿到焦点、回显时序等也需一次真机验证（见 E9，目前 **unverified**，因本轮禁止真机发送）。
- 对 Rome 的意义：**与现有 `wechat_user` 架构天然契合**——客户端本就在跑，直接复用同一显示器、同一会话，无需新依赖、无需外部服务、无需第二次登录。

---

## 路线 5：Android 侧路线（Xposed/LSPosed 模块、无障碍机器人）

**原理**：在安卓手机/模拟器上跑微信，两种子路线：
1. **Xposed/LSPosed 模块**：在 Root/免 Root 框架下 hook 安卓微信的 Java/Native 方法，效果类似路线 3 的 hook，但在移动端；能调内部发送逻辑。
2. **无障碍服务（AccessibilityService）机器人**：类似路线 4 的 UI 自动化，但用安卓无障碍 API 读控件、模拟点击输入来发消息。

**代表项目**：这一类有 `WechatSpellbook`/`wechat-xposed` 系列的 Xposed 插件框架，以及各种基于无障碍的自动回复 app。**（未核实：我没有逐一核对这些仓库当前的 star/许可/活跃度与可用微信版本，请勿据本节直接选型。）**

**评估**：
- 封号风险：Xposed 子路线高（同 hook 特征）；无障碍子路线中等。
- ToS/法律：Xposed hook 明确违反 ToS；无障碍相对灰。
- 能否触达任意联系人：✅（两种子路线都能）。
- Linux：⚠️ 需要一台安卓设备或安卓模拟器；模拟器可跑在 Linux 主机，但这等于给 Rome 引入一整套安卓运行环境，与"读官方 Linux 桌面客户端"的现有架构完全不同。
- 微信更新如何坏：Xposed 随版本失效需重做 hook；无障碍随 UI 变化失效。
- 对 Rome 的意义：架构成本过高（要维护安卓栈），不契合。

---

## 路线 6：官方渠道（企业微信 / 公众号 / iLink 个人号 Bot）

这条线**不违反 ToS、不涉及逆向**，但每种都有"能发给谁"的硬限制。

### 6a. 企业微信（WeCom）API 与群机器人
- **原理**：企业微信开放平台提供正式 API。应用消息（`message/send`）只能发给**本企业成员**；客户联系（外部联系人）能力受限且需授权；**群机器人 webhook** 只能把消息推进**它所在的那个群**。
- **能否触达任意个人微信联系人**：❌ 不能主动私聊任意外部个人号。只能覆盖企业成员、已授权的外部客户、或机器人所在群。
- 封号/法律：✅ 官方合规。Linux：✅ 纯 HTTP。
- 对 Rome：与"从 guardian 个人号发给任意私人联系人"的目标不符。

### 6b. 公众号（Official Account）客服消息 / 模板（订阅）消息
- **原理**：客服消息只能在用户与公众号**互动后的 48 小时**窗口内下发；模板/订阅消息有严格格式与触发条件。
- **能否触达任意个人**：❌ 只能发给关注并互动过的粉丝，且受时间窗/格式限制；不能主动私聊任意人。
- 对 Rome：不符合目标。

### 6c. iLink / "微信 ClawBot"——2026 年官方个人号 Bot 通道（重要，且 Rome 已在用）
- **这是 2025-2026 年最重要的新变化**：腾讯首次为**个人号**放出官方合法的 Bot API，底层协议名 **iLink（智联）**，以 `@tencent-weixin/openclaw-weixin` 形式作为 OpenClaw 的 Channel Plugin 发布，社区称"微信 ClawBot"（[概览搜索结果](https://github.com/x1ah/wechat-ilink-demo)、[社区文档](https://github.com/hao-ji-xing/openclaw-weixin/blob/main/weixin-bot-api.md)、[HelloGitHub #3194](https://github.com/521xueweihan/HelloGitHub/issues/3194)）。
- **原理**：纯 HTTP/JSON，接入域名 `ilinkai.weixin.qq.com`，路径前缀 `ilink/bot/`。扫码登录（`bot_type=3`）→ `get_qrcode_status` 长轮询确认 → 返回 `bot_token`/`baseurl`；收消息用 `getupdates` 长轮询（约 35s），发消息用 `sendmessage`。
- **关键限制（决定它不能替代 E1）**：`sendmessage` **必须携带 `context_token`**，而 `context_token` 来自**对方先发来的那条入站消息**；没有它就抛异常——**无法主动私聊、无法给任意联系人发起对话**，本质是"回复"通道，而非"主动发送"通道。
- **这一点在 Rome 代码里可直接证实**：Rome 现有的**官方 bot 通道 `wechat`** 正是走 iLink——[`packages/core/src/channels/wechat.ts`](https://github.com/rome-os/rome/blob/main/packages/core/src/channels/wechat.ts) 里有 `ilink/bot/getupdates`、`ilink/bot/sendmessage`，每个线程存一份 `contextToken`（`this.contextTokens`），发消息时取该线程的 token；取不到就不发。也就是说 iLink 是**独立的 bot 身份**、且**只能回复**，与"用 guardian 本人账号主动发给任意人"是两回事。
- 封号/法律：✅ 官方合法、不怕封号（这正是官方通道的意义）。Linux：✅ 纯 HTTP。
- 对 Rome：`wechat`（bot 通道）**已经在发消息**，spec 也把它列为 out of scope。iLink **不改变 E1 的判断**，因为它给不了"从 guardian 个人号主动发给任意私人联系人"这一能力。

> 说明：iLink 的详细报文来自社区逆向文档，但 Rome 自己的 `wechat.ts` 已在生产中使用同一套端点与 `context_token` 语义，可作为强佐证。

---

## 路线 7：读侧基础件（发送路线所依赖的本地库解密）

发送要能"确认发出去了"，通常要读客户端本地库拿回自己发出的那条消息。读侧的两块基础件是**数据库密钥提取**和**SQLCipher 解密**。

- [xaoyaoo/PyWxDump](https://github.com/xaoyaoo/PyWxDump)——曾是最主流的"取密钥 + 解密 + 读库"工具，**2025-10-20 收到微信官方律师函后删除全部代码与提交历史**，仓库现仅剩一份删除说明。这是本领域法律风险的最直接信号。
- [LC044/WeChatMsg](https://github.com/LC044/WeChatMsg)（无 license，42k★）——聊天记录导出/分析，仍在，但同属被点名的"获取终端用户数据"类。
- [TANGandXUE/wcdb-key-tool](https://github.com/TANGandXUE/wcdb-key-tool)，MIT，最后 push 2026-08——**Linux** 上通过 ELF 静态分析自动适配新版本、用 GDB 提取 WCDB/SQLCipher4 密钥。**Rome 已经在用它**：`packages/core/src/channels/vendor/wcdb_key_tool.py` 就是它的 vendored 版本（Rome 只用其中的 `capture_passphrase(pid)`，密钥派生与所有读操作在 `wechat-user-helper.py`）。

**评估**：读侧本身不发消息，但任何"UI 自动化 + 读回确认"的发送方案都依赖它。封号风险主要来自密钥提取那一步（Rome 用一次性 gdb 抓取、只在首登时派生）；法律风险是这一类工具被打击的核心（PyWxDump 即例）。Linux：wcdb-key-tool ✅。微信更新如何坏：密钥偏移随版本变，wcdb-key-tool 靠 ELF 分析自适应，Rome 另有版本钉定（`wechat-4.1.13.9`）。

---

## 各路线对照表

| 路线 | 代表项目 | 封号风险 | ToS/法律 | 可达任意个人联系人 | Linux | 微信更新时如何坏 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Web/UOS 网页协议 | itchat / wechat4u | 高（且登不上） | 违反 | 协议可，但已登不上 | ✅ | 已死：服务端拒绝网页登录 |
| 2 Pad 协议（iPad/Mac/安卓） | Wechaty+PadLocal(付费)、Gewechat(已停) | 中高 | 违反+被打击 | ✅ | ✅(后端远程) | 服务商跟进，但可能被关停 |
| 3 PC 客户端 hook/注入 | WeChatFerry(归档)、wxhelper、ComWeChatRobot(归档) | 高 | 违反+被打击 | ✅ | ❌ 仅 Windows | 每版本偏移变→需重逆向 |
| 4 官方客户端 UI 自动化 | wxauto(Win)、xdotool(Linux, =E1) | 相对最低 | 灰色最浅 | ✅ | ✅ | UI/搜索行为变→需调 |
| 5 Android 侧 | Xposed 模块 / 无障碍 bot（未核实代表库） | 高/中 | 违反/灰 | ✅ | ⚠️ 需安卓环境 | hook 或 UI 随版本失效 |
| 6 官方渠道 | 企业微信 API、公众号、iLink/ClawBot | 无 | 合规 | ❌（各有硬限制/只能回复） | ✅ | 官方维护，稳定 |
| 7 读侧基础件 | wcdb-key-tool(Rome 在用)、WeChatMsg、PyWxDump(已删) | 中（取密钥步骤） | 被打击核心 | 不适用 | ✅ | 密钥偏移随版本变 |

---

## 建议（面向 Rome：Linux + guardian 本人个人号 + 发给任意私人联系人）

把三条硬约束叠在一起看——**(a) 必须在 Linux 上**、**(b) 用 guardian 本人已登录的账号**、**(c) 能主动发给任意私人联系人**——大多数路线被直接淘汰：

- 路线 1（网页协议）**已死**，新号登不上。
- 路线 3（PC hook）**只在 Windows**，且正是 E1 已论证会"按版本钉死地址、可能搞崩持密钥会话"而否决的做法。
- 路线 2（Pad 协议）能满足 (c)，但要么托管到第三方**付费**服务、要么冒充另一端**二次登录**，与 Rome"读本机官方客户端"的架构冲突，封号/合规风险更高，且 Gewechat 这类已随打击关停。
- 路线 5（Android）要维护整套安卓栈，架构成本过高。
- 路线 6（官方渠道）**合规但发不了**：企业微信/公众号都不能主动私聊任意个人号；iLink/ClawBot 虽是 2026 年官方个人号 Bot 通道，但**必须带对方入站消息给的 `context_token`，只能回复、不能发起**，而且是**独立 bot 身份**，不是 guardian 本人账号——Rome 的 `wechat` 通道已在用它，spec 也已把它排除。

**因此，唯一同时满足 (a)(b)(c) 的就是路线 4——UI 自动化官方 Linux 客户端，也就是 in-review 交付里的 E1。** 调研没有发现任何开源项目能改变这个判断：

1. **E1 的选择是对的，且相较其它路线封号/合规风险最低。** 它不改协议、不注入内存、不冒充别的端、不引入外部服务，行为最接近真人；这在当前腾讯高压打击（律师函、删库、归档）的背景下尤为重要。
2. **值得借鉴/复用的开源项目**：
   - 读侧：[wcdb-key-tool](https://github.com/TANGandXUE/wcdb-key-tool)（Rome 已 vendored 在用）——继续跟进上游对新版本的 ELF 自适应即可。
   - 驱动侧的思路可参考 [wxauto](https://github.com/cluic/wxauto) 的 UIAutomation 设计**理念**（如何定位会话、如何读回确认发送），但它是 Windows-only，无法直接复用到 Linux；Linux 只能用 `xdotool`/`xclip` 自己实现（E1 现状）。
   - 明确**不建议**引入 WeChatFerry/wxhelper（Windows hook、封号高、已归档）或 PadLocal/Gewechat（付费/已关停、二次登录、合规风险）。
3. **E1 尚需补齐的、调研已印证的真实风险点**：
   - **搜索匹配歧义**（E3 已修订）：微信搜索按拼音/首字母匹配，纯字符串比较复现不了——坚持"只用本人选定的 id（微信号/alias），名字不作键"，并在回车前校验打开的会话确是目标。这是 UI 自动化路线所有实现的共同软肋。
   - **发送成功没有返回值**（E2/E9）：必须靠"读回自己发出的那条消息"确认（Rome 已设计），且 E9 标注为 **unverified**——合入前需要一次真机验证（搜索行为、焦点、回显时序），本轮因禁止真机发送未做。
   - **随版本更新会坏在 UI/搜索行为上**（不是函数偏移），维护成本低于 hook，但仍需在微信升级时回归。

一句话：**保持 E1（用 xdotool 驱动 Linux 官方客户端），继续复用 wcdb-key-tool 做读侧确认，不要转向 hook / Pad / 官方 bot 通道**——没有任何现存开源项目能在 Rome 的三条硬约束下做得比 E1 更好。

### 标注为未核实/需注意的部分
- 路线 5 的具体 Android 代表库（星标/许可/活跃度/适配版本）未逐一核对，请勿据此选型。
- 路线 4 中 macOS 无障碍自动化未找到公认主力开源库。
- iLink 的详细报文取自社区逆向文档，但已用 Rome 自身 `wechat.ts` 的端点与 `context_token` 语义交叉印证。
- E9（真机可用性）在 in-review 交付里本就标为 unverified，本调研未做真机验证，沿用其结论。
