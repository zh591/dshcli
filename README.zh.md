# dshcli

[English](README.md) | 中文

**把 DeepSeek Harness 装进你的终端。** `dshcli` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的纯命令行客户端。
浏览器页面能做的事——多轮对话、推理过程、工具调用、实时状态——它一模一样地做，只是渲染成纯文本。
因此只要有命令行的地方就能跑：SSH 会话、CI shell、容器，以及完全没有浏览器的机器。

```
dshcli  ·  DeepSeek Harness, terminal session
cwd    C:\work\my-project  (workspace root: nearest ancestor with .git)
model  deepseek-official/deepseek-v4-flash
home   C:\Users\you\.dshcli (isolated, default)
session dshcli-2f9c...

type / to list commands, /help for all, Ctrl+C aborts a turn

> /                       <- 输入斜杠会列出全部命令和说明
  /help              list every command
  /cd [dir]          change the working directory (opens a folder dialog without an argument)
  /pick              choose the working directory from a folder dialog
  /pwd               print the working directory
  /model [id]        show or switch the model
  /models            list the models this home can run
  ...
```

## 安装

```sh
npm install -g dsh-cli        # 安装后命令名是 dshcli
npx dsh-cli --help            # 或者不安装直接运行
```

然后安装它所驱动的 harness：

```sh
npm install -g @deepseek-ai/dsh
```

`dshcli` 会按顺序自动寻找 harness：`--dsh`、`$DSHCLI_DSH`、`PATH`、全局 npm 目录、`npx` 缓存。
`dshcli doctor` 会显示它实际找到的东西。在 shell 中设置 `DEEPSEEK_API_KEY`。

## 与已装的浏览器版互不冲突

默认情况下 `dshcli` 使用**自己的 harness 主目录** `~/.dshcli`，而不是浏览器版使用的 `~/.dsh`。
会话、profile、存储和凭据都是分开的，因此终端会话和正在运行的网页界面不会争抢同一份状态。

唯一继承的是配置：首次使用时，新主目录的 `settings.yaml` 和 home 补丁层会从 `~/.dsh` 复制一份，
所以你本来配好的模型、provider 和权限预设可以直接用。会话永远不会被复制。

```sh
dshcli home                     # 查看主目录、选择依据、以及播种了什么
dshcli --home ~/.dshcli-work    # 再开一个独立主目录
dshcli --home shared            # 不隔离：像浏览器版一样直接用 $DSH_HOME
dshcli --no-seed                # 建一个不继承任何配置的空主目录
```

会话内用 `/home` 查看，`/home <dir>` 切换。

## 命令

| 命令 | 作用 |
|---|---|
| `chat` | 交互式多轮会话，这是默认命令。 |
| `run <task...>` | 执行单个任务、打印最终答案后退出。完成时退出码 0，否则 1。 |
| `web` | 启动 harness 浏览器前端并打印带令牌的 URL。 |
| `models` | 列出当前主目录可运行的模型。 |
| `verify-frontend <target>` | 截图页面并让视觉模型报告实际渲染结果。 |
| `dir` | 打印 `dshcli` 会使用的工作目录后退出。 |
| `home` | 显示 harness 主目录及是否隔离。 |
| `doctor` | 报告启动器、主目录、模型、浏览器与密钥状态。 |

```sh
dshcli                                        # 交互式会话
dshcli run "跑一遍测试，把失败的修好"
echo "总结这个仓库" | dshcli                    # 从管道一次性执行
dshcli --model deepseek-v4-pro                # 用另一个模型开启会话
```

## 一键启动网页前端

浏览器界面仍然是原始的产品形态，有时它才是顺手的工具。一条命令就能让它在同一个隔离主目录下启动，
并打印出那个带会话令牌的 URL：

```sh
dshcli web
# ! port 3080 is in use; using 3081 instead
# ✓ frontend ready  http://127.0.0.1:3081/?token=Z5f7DFTh4oNKOT1Cx53kq8IMf4K331bA6v281IA_wBU

dshcli web --port 8080 --no-open    # 从 8080 开始找，只打印 URL 不打开浏览器
dshcli web --port 0                 # 交给操作系统直接分配
```

因为它跑在隔离主目录里，这个实例与任何其他正在运行的前端互不影响。

### 端口被占用不是错误

昨天还空着的端口，今天常常已经被占了——上次没退干净的进程、另一个代码副本，或者不相干的东西。
与其直接失败，`dshcli` 会在一个有界的窗口里依次尝试：

1. 指定端口，以及紧随其后的九个（`3080`…`3089`）；
2. 这十个都被占用，就整体上移一千再试同样十个（`4080`…`4089`）；
3. 还是全被占用，就停下，并列出试过的每一个端口。

窗口是故意做浅的——无界搜索会悄悄把服务器挪到你根本不会去看的地方。
每次替换都会打印出来，所以 URL 永远不会让你意外。`--port 0` 跳过搜索，直接让操作系统分配。

### 在会话里启动

`/web` 做同样的事，但不用离开会话；页面可用的同时终端照常工作：

```
> /web
› starting the browser frontend on port 3080 (this session keeps running)

✓ frontend ready  http://127.0.0.1:3080/?token=...
› open that exact URL; it carries the session token. /web stop ends it

> /web status
› running at http://127.0.0.1:3080/?token=...

> /web stop
› stopping the frontend...
```

`/web` 使用同一套端口搜索，不会重复启动第二份，并在会话结束时停掉自己启动的那份。
`--no-open` 和 `--port` 对它同样生效。

## 切换模型

```sh
dshcli models
#   deepseek-official/deepseek-flash   DeepSeek-V4-Flash  |  vision · 1000k ctx
#   deepseek-official/deepseek-v4-pro  DeepSeek-V4-Pro  |  1000k ctx

dshcli models --live      # 顺便问 provider 现在到底提供哪些 id
dshcli --model deepseek-v4-pro
dshcli --model "DeepSeek-V4-Pro"    # 写显示名也可以
```

模型目录来自主目录自己的 `settings.yaml`，所以它始终反映运行时真正接受的模型；
没有 settings 文件时回退到 DeepSeek provider 内置的模型列表。

**只有目录才能产出模型 id。** provider 接受的是 id，不接受显示名，所以所有入口——
`--model`、`/model <名称>`、选择器——都会先经过目录解析。无法识别时会在**第一个回合开始前**就拒绝，
并列出可用的 id，而不是把非法名字转发出去、最后拿回一个 provider 报错。

`--live` 会去问 provider 的 `/models` 接口，标出本主目录列了、但 provider 已经不再提供的条目。
这个对比是提示性的：下架的 id 往往还能通过 provider 侧的别名继续用
（`deepseek-v4-flash` 目前就被别名到 `deepseek-flash`），所以旧目录仍然能跑，只是不再是 provider 官方列出的了。
如果 `agent-default-model` 指向目录里没有的模型，`dshcli` 会在启动时提示一次，并改用目录默认值。

会话内用 `/models` 查看、`/model` 打开编号选择器——切换会以新路由重启运行时并在新会话中继续。

## 选择工作目录

终端没有文件夹选择框，所以 `dshcli` 先看显式意图，再看启发式规则，并且总会告诉你最终是哪条规则生效。

| 优先级 | 规则 |
|---|---|
| 1 | `--cwd <dir>` |
| 2 | `$DSHCLI_CWD` |
| 3 | `--last` —— 上一次会话的目录 |
| 4 | `--here` —— 当前 shell 目录，保持不变 |
| 5 | **自动**：所在的仓库／工作区根目录（`.git`、`pnpm-workspace.yaml` 等），因此在 monorepo 的某个包里启动会打开整个 monorepo |
| 6 | **自动**：最近的项目标志文件（`package.json`、`Cargo.toml`、`pyproject.toml` 等） |
| 7 | 当前 shell 目录 |

`--pick` 会弹出操作系统的**文件夹选择对话框**（支持 Windows、macOS 和 Linux/zenity），
没有图形环境时回退到终端里的编号列表；`--no-dialog` 则完全跳开对话框。
会话内 `/pick` 和不带参数的 `/cd` 效果相同，`/cd <dir>` 直接跳转。

```sh
dshcli --pick                         # 弹窗选目录，然后在那里启动
dshcli dir --json                     # {'dir': ..., 'source': 'workspace root', 'detail': ...}
```

解析出的目录会成为 SDK 会话的 `cwd`，harness 会把它记录进会话头部并渲染进模型的人设，
因此 agent 的文件工具会正确定位。

## 会话内的操作

在空提示符下输入 `/`，命令列表就会出现在提示符下方，并随输入逐步收窄；`Tab` 可以补全唯一的命令名；
`Ctrl+C` 中止正在执行的回合。

| 命令 | 作用 |
|---|---|
| `/help` | 列出全部命令 |
| `/cd [dir]` | 切换工作目录（不带参数则弹窗选择） |
| `/pick` | 用文件夹对话框选择工作目录 |
| `/web [start\|stop\|status]` | 在会话旁边启动浏览器前端 |
| `/pwd` | 打印当前工作目录 |
| `/model [id]` | 查看或切换模型 |
| `/models` | 列出当前主目录可运行的模型 |
| `/effort [id]` | 查看或切换推理强度 |
| `/new` | 在同一设置上开启新会话 |
| `/reasoning` | 显示／隐藏推理块 |
| `/status` | 显示启动器、主目录、profile、模型、会话与运行时详情 |
| `/home [dir]` | 查看 harness 主目录，或切换到另一个 |
| `/abort` | 中止正在执行的回合 |
| `/clear` | 清屏 |
| `/exit` | 退出 |

harness 没有取消方法，因此 `/abort` 和 `Ctrl+C` 会结束运行时进程——这正是其协议对「放弃一个回合」的定义——
之后 `dshcli` 会用新会话重启它。行尾的 `\` 表示续行。

## 前端视觉验证

`verify-frontend` 让命令行具备「像人一样看页面」的能力：用无头 Chromium 打开页面、截取稳定后的视口，
再把这些像素通过同一个 harness 提交给具备视觉能力的模型，由它报告页面上真正渲染出了什么。

```sh
dshcli verify-frontend http://127.0.0.1:5173/
dshcli verify-frontend ./dist/index.html --viewport 1440x900 --shot build.png
dshcli verify-frontend "http://127.0.0.1:3080/?token=..." --json
```

报告包含：结论（`RENDERS` / `BROKEN` / `EMPTY`）、实际可见的区域与内容、具体的可见缺陷，
以及单张静态截图无法证明的部分。抓取到的事实——文档标题与浏览器控制台错误——会作为证据一并附上，
`--json` 会把它们连同报告一起返回。

截图走的是 Chrome DevTools Protocol，而不是 `--screenshot` 命令行开关。
因为真实应用通常位于会话 Cookie 之后，而且通常长期占用一个 socket。
DevTools 让 `dshcli` 能在导航前安装 Cookie，并自行决定页面何时已经稳定。
正因如此，`dsh web` 打印出来的 URL 可以直接使用：启动器打印的 `token` 查询参数会在页面加载前
被换成会话 Cookie，于是被审查的是已认证的真实应用，而不是那张「需要认证」的提示页。

| 参数 | 默认值 | 含义 |
|---|---|---|
| `--vision-model <id>` | 目录里的视觉模型 | 负责审查图像的模型路由 |
| `--shot <path>` | `dshcli-frontend-<时间>.png` | 截图输出路径 |
| `--browser <path>` | 自动探测 | 要驱动的 Chromium 可执行文件 |
| `--viewport <WxH>` | `1280x800` | 截图尺寸 |
| `--cookie <name=value>` | — | 预先安装的会话 Cookie（可重复） |
| `--settle <ms>` | `2500` | 加载事件之后的额外等待时间 |

## 与浏览器版究竟差在哪

`dshcli` 驱动的是 `sdk` profile（`dsh-base` + `dsh-sdk-app`）；网页由 `web` profile
（`dsh-base` + `dsh-web-app`）提供。两者挂载同一个 base，所以 **agent 本身是一样的**——
但两个 profile 并不是同一套组合，这个差别值得说清楚。

用 `dsh --profile <名字> --dump-default-config` 实测：

| | web | sdk（dshcli） |
|---|---|---|
| 组合出的行数 | 152 | 86 |
| 面向模型的工具 | 见下 | 25 |

**完全相同的部分。** agent 循环、提示词组装、工具注册表、权限与沙箱策略、会话持久化与查询、
压缩、plan mode、goal、todo、skill、subagent、workflow、jobs、ralph、网页搜索与抓取、
token 计量、agent instructions、会话标题——全部来自 `dsh-base`，两个 profile 都挂载了它。
MCP、Claude Code/Codex 钩子桥、定时任务在两个 profile 里默认都是未启用的可选行，所以两边一样没有。

`dshcli` 交给模型的 25 个工具（和本 README 这次会话自己用的是同一份清单）：

```
create_goal  edit  exit_plan_mode  get_goal  glob  grep  interrupt_agent
job_kill  job_list  job_output  list_agents  pwsh  ralph  read  read_image
send_message  skill  subagent  subagent_fork  todo_write  update_goal
web_fetch  web_search  workflow  write
```

**只有 web profile 才有的。** 共六十八行，绝大多数是浏览器展示层
（`ui-*`、`locale`、`resources`、传输层、宿主控制器、会话/文件侧栏、设置界面）。
其中有几项不只是展示，而这正是命令行用户真正会缺的：

| 行 | 它给页面带来什么 |
|---|---|
| `agent-presets` | 按会话组装 agent——就是输入框上方那个「标准模式」选择器。web profile 会关掉 base 的进程级工具行，改为每个会话挂载四个内置预设之一（`cordis`、`minimal`、`ptc`、`standard`）。`dshcli` 始终运行 base 的那套清单，不能切换预设。 |
| `code-runtime` | 程序化工具调用（PTC）——让模型跑一段能调用工具的 Python，而不是一步一次调用。 |
| `workspace` | 工作区作用域。 |
| `session-reference`、`file-reference-local` | 在提示里用 `@` 内联引用其他会话和文件。 |
| `subagent-model-selection-settings` | 让子 agent 跑在与父 agent 不同的模型上。 |
| `file-upload`、`directory-picker` | 宿主侧的上传与目录选择。 |
| `session-stats`、`session-turn-outline`、`session-log-download`、`message-feedback`、`open-in-app` | 只读视图与产品功能。 |

**只有 sdk profile 才有的。** 两行：`sdk-app-startup` 和 `sdk-jsonrpc-server`——
也就是本客户端对话的那个 stdio JSON-RPC 服务端。

**而只有 `dshcli` 才有的。** 它不是上面那些的超集，但也不是一无所有：从管道一次性执行的 `run`、
到处都能用的机器可读 `--json`、隔离的 harness 主目录、原生文件夹对话框、
一个不需要浏览器也不监听任何端口、能跑在 SSH 上的会话，以及
`verify-frontend`——截图加视觉审查，这是网页自己做不到的。

## 工作原理

```
dshcli  ──spawn──▶  node <dsh>/lib/bin.js --profile sdk     (DSH_HOME=~/.dshcli)
        ◀─stdio──▶  换行分隔的 JSON-RPC 2.0
```

`dshcli` 从不自己启动 harness。它把 `dsh --profile sdk` 作为子进程拉起，并用 harness 自己的
SDK 线协议与之通信。这样应用启动路径始终只有一条——由 `dsh` 启动器负责 profile 引导、模块解析
与进程退出——同时让 `dshcli` 可以对接任意一份安装。

协议很小：三个请求（`initialize`、`session/prompt`、`shutdown`）与四个通知
（`session.event`、`session.status`、`subagent.started`、`subagent.finished`）。
工作目录、provider 与模型都在 `initialize` 中确定，这也正是「自动选择工作目录」和「切换模型」只需一次握手的原因。

`session.event` 承载完整的会话日志，每个事件对应终端上的一段文本：

| 事件 | 渲染为 |
|---|---|
| `turn/start` / `turn/end` | 一条标注回合编号、结果与耗时的分隔线 |
| `assistant/message` | 先推理块（暗色），后助手正文（轻量 Markdown） |
| `tool/call` | `⏺ 名称(摘要后的参数)` |
| `tool/result` | `⎿ result` 加上有长度上限的缩进预览；失败显示为红色 |
| `user/message` | 你自己的提问会被跳过；插件注入的上下文折叠成一行 |
| `session.status` | 工作指示器 |

### 关于流式输出

harness 当前的会话格式会把 token 增量折叠进每一步最终的 `assistant/message`，
因此 SDK 线协议是按「步」而不是按 token 交付助手文本。`dshcli` 在每步落定后渲染该步，
并用指示器加上实时到达的 `tool/call` 事件展示进行中的进展。

## 目录结构

```
bin/dshcli.mjs     命令分发：chat、run、web、models、verify-frontend、dir、home、doctor
src/args.mjs       参数解析与帮助文本
src/dsh.mjs        跨 npm 布局与平台定位 dsh 启动器
src/home.mjs       隔离的 harness 主目录与首次运行的配置播种
src/cwd.mjs        工作目录选择、项目根识别、状态记忆
src/pick.mjs       原生文件夹对话框，以及方向键／编号选择器
src/commands.mjs   斜杠命令表（菜单、/help、分发器共用同一份）
src/menu.mjs       内联的 "/" 建议菜单与 Tab 补全
src/models.mjs     从主目录 settings 读取的模型目录
src/rpc.mjs        换行分隔的 JSON-RPC 2.0 传输层
src/runtime.mjs    dsh --profile sdk 子进程：握手、提问、关闭、中止
src/render.mjs     会话事件到终端文本
src/browser.mjs    基于 Chrome DevTools Protocol 的无头抓取
src/vision.mjs     截图加视觉模型审查
src/web.mjs        启动浏览器前端 profile
src/theme.mjs      ANSI 样式，处理 NO_COLOR 与非 TTY
tests/unit.mjs     纯逻辑测试
tests/interactive.mjs  通过真实伪终端驱动的菜单、选择器与会话命令测试
```

## 测试

```sh
npm test                  # 127 项纯逻辑检查，不调用模型
npm run test:interactive  # 36 项检查，通过真实伪终端驱动
```

交互测试使用 harness 自带的 `node-pty` 构建，走的是真实 TTY 路径而不是模拟。
只有一项检查会真正跑一个回合（提示回显检查），其余都是客户端行为，不产生任何调用费用。

环境变化时，三个诊断脚本很有用：

```sh
node tests/tool-roster.mjs    # 模型实际收到的工具清单
node tests/model-probe.mjs    # provider 接受哪些模型 id，哪些能收图
node tests/occupy-ports.mjs 3080 3   # 占住前几个端口，用来验证回退逻辑
```

## 运行要求

- Node.js 20.11 或更高版本
- 一份 `dsh` 安装（`npm install -g @deepseek-ai/dsh`）
- 所用路由对应的 `DEEPSEEK_API_KEY`
- `verify-frontend` 需要 Chrome、Edge 或 Chromium

## 发布

npm 上的 `dshcli` 名字已被占用，所以包名是 **`dsh-cli`**，而安装后的命令仍然是 `dshcli`。
其他可用名字：`dshcli-tui`、`dsh-cli-terminal`。

```sh
npm login
npm pack --dry-run     # 检查打包内容
npm publish
```

发布前请在 `package.json` 里补上 `repository`、`homepage`、`bugs`。

## 相关

- [`deepseek-harness/`](deepseek-harness/) —— 克隆到本工作区的上游 DeepSeek Harness 源码，
  其中包括本客户端所实现的 [SDK 协议](deepseek-harness/packages/sdk/protocol/README.md)。

## 许可证

MIT
