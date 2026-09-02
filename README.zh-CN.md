<h1 align="center">DSH Pocket</h1>

<p align="center">
  <strong>把 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 装进口袋——在手机浏览器上看住、接手电脑上的 agent。</strong><br>
  批准一次工具调用、回答一个提问、补一句话、叫停跑偏的任务——不用走回电脑前。
</p>

<p align="center">
  <a href="https://dsh-pocket.a2hmarket.ai"><strong>dsh-pocket.a2hmarket.ai</strong></a>
  — 在手机上打开、登录，你的电脑就在里面
</p>

<p align="center">
  <a href="https://github.com/keman-ai/dsh-pocket"><img src="https://img.shields.io/github/stars/keman-ai/dsh-pocket?style=flat&label=Star&color=4D6BFE" alt="Stars"></a>
  <a href="https://github.com/keman-ai/dsh-pocket/releases"><img src="https://img.shields.io/github/v/release/keman-ai/dsh-pocket?style=flat&label=release&color=08C" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

<p align="center">
  <b>如果它对你有用，点个 Star 是最大的鼓励</b>
</p>

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="screenshots/conversation.png" alt="电脑上的会话，列在手机上" width="100%">
    </td>
    <td width="50%" valign="top">
      <img src="screenshots/detail.png" alt="手机上的一个会话：思考过程、工具调用、折叠的上下文，以及能拍照的输入栏" width="100%">
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>每个会话，都在口袋里</h3>
      <p>电脑上正在跑的会话，按 dsh 的分组列出来。点一个打开，也能从这里开新会话。</p>
    </td>
    <td valign="top">
      <h3>看住它、接手它</h3>
      <p>输出实时流出来——思考和回答都在。批准一次工具调用、补一句话或一张<strong>照片</strong>、叫停一轮。dsh 每轮注入的上下文会折叠起来，留下的是真正的对话。</p>
    </td>
  </tr>
</table>

## 上手

**1 · 装进 web profile**，启动 dsh：

```sh
dsh plugin --profile web add -w github:keman-ai/dsh-pocket
dsh --profile web
```

`-w` 是必需的——profile 是个 pnpm 工作区根目录。从源码跑 harness 就用 `pnpm dsh`。

**2 · 打开它。** Pocket 默认关闭——把一台能跑 shell 的机器接到公网中继，这决定由你来做。在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里启用，重启 dsh：

```yaml
- id: pocket
  config:
    enabled: true
```

**3 · 连账号。** 在 dsh 里打开 **设置 → 手机接管 → 连接 A2H 账号**，在弹出的标签页里确认。之后这台机器显示为在线。

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="screenshots/connection.png" alt="设置 → 手机接管，连接前：连接 A2H 账号按钮" width="100%">
    </td>
    <td width="50%" valign="top">
      <img src="screenshots/plugin.png" alt="连接后：这台机器已连上，1 台手机在看" width="100%">
    </td>
  </tr>
</table>

**4 · 在手机上打开。** 访问 **[dsh-pocket.a2hmarket.ai](https://dsh-pocket.a2hmarket.ai)**，用同一个账号登录，点你的电脑、选一个会话就进去了。批准用的签名密钥会自动下发，不用扫码或手动复制。

## 在手机上能做什么

- **实时看**会话输出——不只是回答，连它的思考过程也能看到，好分辨是在想还是卡住了。
- **批准或拒绝**一次工具调用，就在它开口问的那一刻。这一轮正卡着等你，点一下就放行。
- **回答它的提问**——它停下来问的时候。
- **发消息**，或者**拍张照片**直接丢给 agent——这是电脑那头做不到的事。
- **叫停**一轮跑偏的任务。
- **切换模型**、**改偏好**（语言、外观、默认模型、Agent 循环）、**换皮肤**——全都不用走回电脑前。

dsh 每一轮注入的上下文——运行环境快照、技能清单——会被折叠起来，屏幕上留下的是真正的对话。

<p align="left">
  <img src="screenshots/settings.png" alt="手机上的设置页：皮肤、默认模型、语言、Agent 循环等偏好" width="300">
</p>
<p align="left">
  <sub>皮肤、默认模型、语言、Agent 循环等偏好——都能在手机上改</sub>
</p>

## 安全

- **默认关闭**：不打开、不连账号，就什么都不会连。
- **不开入站端口**：插件和手机都是**朝外**拨到中继，够到你的机器不需要端口转发、内网穿透或隧道；Pocket 不新开任何可供连入的端口。
- **帧只过中继、不进中继**：会话帧在内存里转发，内容不落盘、不落日志。

连上一台机器，就意味着任何登录了那个账号的手机都能批准这台机器上的命令。请把这个账号当成 SSH 私钥来对待。

## 环境要求

| 依赖 | 要求 | 没有会怎样 |
|---|---|---|
| **DeepSeek Harness** | `0.1.2+` | 更早的版本没有按域拆分的控制器和 settings section，插件挂载不上 |
| **profile** | **web** profile | 连接界面和设置面板都是 client UI；headless / tui 没有 web app，插件不会激活 |
| **Node.js** | `>= 22.19` | dsh 自己的下限；中继连接用 Node 内置的全局 `WebSocket`，host 半边因此不带运行时依赖 |
| **账号** | 一个 A2H Market 账号 | 连接是按账号来的，手机用同一个账号登录 |
| **网络** | `account.a2hmarket.ai`、`dsh-pocket.a2hmarket.ai`，以及中继（`api-prod.a2hmarket.ai`） | 所有连接都是朝外的，机器从不监听 |

## 开发

```sh
pnpm install
pnpm run check   # 类型检查
pnpm run test    # node --test
pnpm run build   # lib/index.js + lib/client.js
```

用 pnpm 的 `link:` 装进 profile（别用 `file:`，它会拷贝包、把之后的 rebuild 藏掉）：

```sh
cd ~/.dsh/profiles/<名字> && pnpm add -w link:/path/to/dsh-pocket
```

`lib/` 是有意提交的——git 安装不跑构建——所以改完跑一次 `pnpm run build`，把它一起提交。

`types/dsh.d.ts` 里的 harness 类型是手抄的——`@deepseek-ai/dsh-client-*` 这条链没有完整发布，而且这些模块在运行时本来就是外部注入的。只声明真正用到的部分；host 那边报错时先来这里看。

## 相关

| | |
|---|---|
| [dsh-pocket.a2hmarket.ai](https://dsh-pocket.a2hmarket.ai) | 手机前端。在手机上打开、登录即可 |
| [dsh-skin-market](https://github.com/keman-ai/dsh-skin-market) | 姊妹插件：在浏览器里搜索并安装 dsh 皮肤，不用回终端 |

## 许可

[MIT](LICENSE) © 2026 Science Roam Limited

---

<p align="center">
  <sub>如果它对你有用，点个 Star 是最大的鼓励</sub>
</p>
