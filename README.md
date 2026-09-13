# dshcli

English | [中文](README.zh.md)

**DeepSeek Harness in your terminal.** `dshcli` is a pure command-line client for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). It does what the
browser page does — a multi-turn agent session with reasoning, tool calls, and a live status — but
renders it as text, so it runs anywhere a command line exists: SSH sessions, CI shells, containers,
and machines with no browser at all.

```
dshcli  ·  DeepSeek Harness, terminal session
cwd    C:\work\my-project  (workspace root: nearest ancestor with .git)
model  deepseek-official/deepseek-v4-flash
home   C:\Users\you\.dshcli (isolated, default)
session dshcli-2f9c...

type / to list commands, /help for all, Ctrl+C aborts a turn

> /                       <- typing a slash lists every command with its hint
  /help              list every command
  /cd [dir]          change the working directory (opens a folder dialog without an argument)
  /pick              choose the working directory from a folder dialog
  /pwd               print the working directory
  /model [id]        show or switch the model
  /models            list the models this home can run
  ...
```

## Install

```sh
npm install -g dsh-cli        # installs the `dshcli` command
npx dsh-cli --help            # or run it without installing
```

Then install the harness it drives:

```sh
npm install -g @deepseek-ai/dsh
```

`dshcli` finds the harness automatically — from `--dsh`, `$DSHCLI_DSH`, `PATH`, the global npm
roots, or the `npx` cache, in that order. `dshcli doctor` shows what it resolved.

Set `DEEPSEEK_API_KEY` in your shell.

## Nothing collides with your browser install

By default `dshcli` runs the harness against **its own home**, `~/.dshcli`, not the `~/.dsh` a
browser install uses. Sessions, profiles, storages, and credentials stay separate, so a terminal
session and a running web UI never contend for the same state.

Configuration is the one thing it inherits: on first use the new home's `settings.yaml` and
home patch layer are copied from `~/.dsh`, so the models, providers, and permission preset you
already configured are available immediately. Sessions are never copied.

```sh
dshcli home                     # show the home, how it was chosen, and what was seeded
dshcli --home ~/.dshcli-work    # a second, independent home
dshcli --home shared            # opt out: reuse $DSH_HOME like the browser install
dshcli --no-seed                # create an empty home with no inherited configuration
```

Inside a session, `/home` reports it and `/home <dir>` switches.

## Commands

| Command | What it does |
|---|---|
| `chat` | Interactive multi-turn session. This is the default. |
| `run <task...>` | One task, final answer, exit. Exit code 0 on completion, 1 otherwise. |
| `web` | Launch the harness browser frontend and print its authenticated URL. |
| `models` | List the models this home can run. |
| `verify-frontend <target>` | Screenshot a page and have a vision model report what renders. |
| `dir` | Print the working directory `dshcli` would use, then exit. |
| `home` | Show the harness home and whether it is isolated. |
| `doctor` | Report the launcher, home, models, browser, and key availability. |

```sh
dshcli                                        # interactive session
dshcli run "run the tests and fix the failures"
echo "summarise this repo" | dshcli           # one-shot from a pipe
dshcli --model deepseek-v4-pro                # start on another model
```

## Launching the browser frontend

The browser UI is still the original product surface and sometimes the right tool. One command
boots it against the same isolated home and prints the URL that carries its session token:

```sh
dshcli web
# ! port 3080 is in use; using 3081 instead
# ✓ frontend ready  http://127.0.0.1:3081/?token=Z5f7DFTh4oNKOT1Cx53kq8IMf4K331bA6v281IA_wBU

dshcli web --port 8080 --no-open    # start the search at 8080, do not open a browser
dshcli web --port 0                 # let the operating system pick one outright
```

Because it runs in the isolated home, this instance is independent of any other frontend already
running.

### A taken port is not an error

A port that was free yesterday is often taken today — a previous run that did not exit, another
checkout, or something unrelated. Rather than failing, `dshcli` walks a bounded window:

1. the requested port, then the next nine (`3080`…`3089`);
2. if all ten are taken, the same ten a thousand higher (`4080`…`4089`);
3. if those are taken too, it stops and names every port it tried.

The walk is deliberately shallow — an unbounded search would quietly move your server somewhere you
are not looking. The substitution is always printed, so the URL is never a surprise. `--port 0` skips
the search and lets the operating system assign one.

### From inside a session

`/web` does the same thing without leaving the session, and the terminal keeps working while the
page is available:

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

`/web` uses the same port search, refuses to start a second copy, and stops the frontend it started
when the session ends. `--no-open` and `--port` apply to it as well.

## Switching models

```sh
dshcli models
#   deepseek-official/deepseek-flash   DeepSeek-V4-Flash  |  vision · 1000k ctx
#   deepseek-official/deepseek-v4-pro  DeepSeek-V4-Pro  |  1000k ctx

dshcli models --live      # also ask the provider which ids it serves today
dshcli --model deepseek-v4-pro
dshcli --model "DeepSeek-V4-Pro"    # the display name works too
```

The catalog is read from the home's own `settings.yaml`, so it always reflects what the runtime will
accept; a home with no settings file falls back to the models the DeepSeek provider ships with.

**Only the catalog can produce a model id.** A provider accepts ids and rejects display names, so
every route — `--model`, `/model <name>`, and the picker — is resolved against the catalog first.
An unknown name is refused before the first turn, with the accepted ids listed, instead of being
forwarded and failing later with a provider error.

`--live` asks the provider's `/models` endpoint and flags entries this home lists but the provider no
longer serves. That comparison is advisory: retired ids often keep working through provider-side
aliases (`deepseek-v4-flash` is currently aliased to `deepseek-flash`), so a stale catalog still runs
— it just is not what the provider advertises any more. If `agent-default-model` names something the
catalog does not contain, `dshcli` says so once at startup and uses the catalog default.

Inside a session, `/models` lists them and `/model` opens a numbered picker — switching restarts the
runtime on the new route and continues in a fresh session.

## Choosing the working directory

A terminal has no folder picker, so `dshcli` resolves the directory explicitly first and by
heuristic second, and always tells you which rule won.

| Priority | Rule |
|---|---|
| 1 | `--cwd <dir>` |
| 2 | `$DSHCLI_CWD` |
| 3 | `--last` — the previous session's directory |
| 4 | `--here` — the shell's directory, unchanged |
| 5 | **Automatic**: the enclosing repository or workspace root (`.git`, `pnpm-workspace.yaml`, …), so opening one package of a monorepo opens the monorepo |
| 6 | **Automatic**: the nearest standalone project marker (`package.json`, `Cargo.toml`, `pyproject.toml`, …) |
| 7 | The shell's directory |

`--pick` opens your operating system's **folder dialog** (Windows, macOS, and Linux/zenity are
supported) and falls back to a numbered terminal list where no dialog is possible. `--no-dialog`
skips the dialog entirely. Inside a session, `/pick` and `/cd` with no argument do the same thing,
and `/cd <dir>` moves directly.

```sh
dshcli --pick                         # folder dialog, then start there
dshcli dir --json                     # {'dir': ..., 'source': 'workspace root', 'detail': ...}
```

The resolved directory becomes the SDK session `cwd`, which the harness records on the session
header and renders into the model's persona, so the agent's file tools are correctly rooted.

## Inside a session

Type `/` at an empty prompt and the command list appears beneath the prompt, narrowing as you type.
`Tab` completes an unambiguous name. `Ctrl+C` aborts a running turn.

| Command | Effect |
|---|---|
| `/help` | List every command |
| `/cd [dir]` | Change the working directory (folder dialog without an argument) |
| `/pick` | Choose the working directory from a folder dialog |
| `/web [start\|stop\|status]` | Start the browser frontend alongside this session |
| `/pwd` | Print the working directory |
| `/model [id]` | Show or switch the model |
| `/models` | List the models this home can run |
| `/effort [id]` | Show or switch the reasoning effort |
| `/new` | Start a new session on the same settings |
| `/reasoning` | Show or hide reasoning blocks |
| `/status` | Show launcher, home, profile, model, session, and runtime details |
| `/home [dir]` | Show the harness home, or switch to another one |
| `/abort` | Stop the running turn |
| `/clear` | Clear the screen |
| `/exit` | Quit |

The harness exposes no cancel method, so `/abort` and `Ctrl+C` end the runtime process — exactly how
its protocol defines abandoning a turn — and `dshcli` restarts it with a new session. A line ending
in `\` continues on the next line.

## Visual frontend verification

`verify-frontend` makes the CLI able to check a page the way a person would: it loads the page in a
headless Chromium, captures the settled viewport, and submits those pixels to a vision-capable model
through the same harness, which reports what actually renders.

```sh
dshcli verify-frontend http://127.0.0.1:5173/
dshcli verify-frontend ./dist/index.html --viewport 1440x900 --shot build.png
dshcli verify-frontend "http://127.0.0.1:3080/?token=..." --json
```

The report covers a verdict (`RENDERS` / `BROKEN` / `EMPTY`), the regions and content that are
visible, concrete visible defects, and what a static screenshot cannot prove. The capture facts —
document title and browser console errors — are attached as evidence, and `--json` returns them
alongside the report.

Screenshots are taken over the Chrome DevTools Protocol rather than the `--screenshot` flag, because
a real application is usually behind a session cookie and usually holds a socket open forever.
DevTools lets `dshcli` install cookies before navigating and decide for itself when the page has
settled. That is why a `dsh web` URL works directly: the `token` query parameter the launcher prints
is exchanged for the session cookie before the page loads, so the authenticated application is
reviewed instead of the authentication notice.

| Flag | Default | Meaning |
|---|---|---|
| `--vision-model <id>` | the catalog's vision model | Model route that reviews the image |
| `--shot <path>` | `dshcli-frontend-<time>.png` | Where to write the screenshot |
| `--browser <path>` | auto-detected | Chromium executable to drive |
| `--viewport <WxH>` | `1280x800` | Capture size |
| `--cookie <name=value>` | — | Session cookie to install first (repeatable) |
| `--settle <ms>` | `2500` | Extra wait after the load event |

## What differs from the browser UI

`dshcli` drives the `sdk` profile (`dsh-base` + `dsh-sdk-app`); the page is served by the `web`
profile (`dsh-base` + `dsh-web-app`). Both mount the same base, so **the agent is the same** —
but the two profiles are not the same composition, and the difference is worth stating plainly.

Measured with `dsh --profile <name> --dump-default-config`:

| | web | sdk (dshcli) |
|---|---|---|
| Composed rows | 152 | 86 |
| Model-facing tools | see below | 25 |

**Identical.** The agent loop, prompt assembly, tool registry, permission and sandbox policy,
session persistence and query, compaction, plan mode, goals, todos, skills, subagents, workflow,
jobs, ralph, web search and fetch, token metering, agent instructions, and session titles all come
from `dsh-base`, which both profiles mount. MCP, the Claude Code/Codex hook bridges, and scheduling
are opt-in rows in neither profile by default, so they are equally absent from both.

The 25 tools `dshcli` hands the model — the same roster this README's own session uses:

```
create_goal  edit  exit_plan_mode  get_goal  glob  grep  interrupt_agent
job_kill  job_list  job_output  list_agents  pwsh  ralph  read  read_image
send_message  skill  subagent  subagent_fork  todo_write  update_goal
web_fetch  web_search  workflow  write
```

**Only in the web profile.** Sixty-eight rows, almost all of them the browser presentation layer
(`ui-*`, `locale`, `resources`, the transport, the host controllers, the session/file sidebar, the
settings screens). A handful are more than presentation, and they are what a CLI user actually
misses:

| Row | What it gives the page |
|---|---|
| `agent-presets` | Per-session agent composition — the "标准模式 / standard mode" selector in the composer. The web profile disables the base's process-wide tool rows and mounts one of four shipped presets (`cordis`, `minimal`, `ptc`, `standard`) per session. `dshcli` always runs the base roster and cannot switch presets. |
| `code-runtime` | Programmatic tool calling — letting the model run Python that calls tools, instead of one call per step. |
| `workspace` | Workspace scoping. |
| `session-reference`, `file-reference-local` | Inline `@` references to other sessions and files, resolved into the prompt. |
| `subagent-model-selection-settings` | Running subagents on a different model from the parent. |
| `file-upload`, `directory-picker` | Host-side upload and folder choosing. |
| `session-stats`, `session-turn-outline`, `session-log-download`, `message-feedback`, `open-in-app` | Read-only views and product affordances. |

**Only in the sdk profile.** Two rows: `sdk-app-startup` and `sdk-jsonrpc-server` — the stdio
JSON-RPC server this client speaks to.

**And what only `dshcli` has.** Not a superset of the above, but not nothing either: one-shot
`run` from a pipe, machine-readable `--json` everywhere, an isolated harness home, a native folder
dialog, a session that works over SSH with no browser and no listening port, and
`verify-frontend` — screenshot plus vision review, which the page cannot do for itself.

## How it works

```
dshcli  ──spawn──▶  node <dsh>/lib/bin.js --profile sdk     (DSH_HOME=~/.dshcli)
        ◀─stdio──▶  newline-delimited JSON-RPC 2.0
```

`dshcli` never boots the harness itself. It starts `dsh --profile sdk` as a child process and speaks
the harness's own SDK wire protocol to it, which keeps exactly one application-launch path — the
`dsh` launcher owns profile boot, module resolution, and process exit — and lets `dshcli` work
against any installation.

The protocol is small: three requests (`initialize`, `session/prompt`, `shutdown`) and four
notifications (`session.event`, `session.status`, `subagent.started`, `subagent.finished`). The
`initialize` request is where the working directory, provider, and model are chosen, which is what
makes automatic directory selection and model switching a one-line handshake.

`session.event` carries the full session log, and each event becomes one region of terminal text:

| Event | Rendered as |
|---|---|
| `turn/start` / `turn/end` | A rule naming the turn, and its outcome and elapsed time |
| `assistant/message` | The reasoning block (dim) then the assistant prose (light markdown) |
| `tool/call` | `⏺ name(summarised arguments)` |
| `tool/result` | `⎿ result` plus a bounded, indented preview; failures in red |
| `user/message` | Skipped for your own prompt; plugin-injected context collapses to one line |
| `session.status` | The working spinner |

### A note on streaming

The harness's current session format folds token deltas into the settled `assistant/message` of each
step, so the SDK wire delivers assistant text per step rather than per token. `dshcli` renders the
step when it settles and shows live progress with a spinner plus the `tool/call` events, which do
arrive as they happen.

## Layout

```
bin/dshcli.mjs     command dispatch: chat, run, web, models, verify-frontend, dir, home, doctor
src/args.mjs       argv parsing and help text
src/dsh.mjs        locating the dsh launcher across npm layouts and platforms
src/home.mjs       isolated harness home, first-run configuration seeding
src/cwd.mjs        working-directory selection, project-root detection, remembered state
src/pick.mjs       native folder dialog and the arrow-key / numbered pickers
src/commands.mjs   the slash-command table shared by the menu, /help, and the dispatcher
src/menu.mjs       the inline "/" suggestion menu and Tab completion
src/models.mjs     the model catalog read from the home's settings
src/rpc.mjs        newline-delimited JSON-RPC 2.0 transport
src/runtime.mjs    the dsh --profile sdk child: handshake, prompts, shutdown, abort
src/render.mjs     session events to terminal text
src/browser.mjs    headless capture over the Chrome DevTools Protocol
src/vision.mjs     screenshot plus vision-model review
src/web.mjs        launching the browser frontend profile
src/theme.mjs      ANSI styling with NO_COLOR and non-TTY handling
tests/unit.mjs     pure-logic tests
tests/interactive.mjs  pty-driven tests for the menu, pickers, and session commands
```

## Tests

```sh
npm test                  # 127 pure-logic checks, no model calls
npm run test:interactive  # 36 checks driven through a real pseudo-terminal
```

The interactive suite uses the `node-pty` build that ships with the harness, so it exercises the
real TTY path rather than simulating one. Only one check runs a real turn (the prompt-echo check);
everything else is client-side and costs nothing.

Three diagnostics are useful when the environment changes:

```sh
node tests/tool-roster.mjs    # the exact tool list the model receives
node tests/model-probe.mjs    # which model ids the provider accepts, and which take images
node tests/occupy-ports.mjs 3080 3   # hold the first ports so the fallback can be exercised
```

## Requirements

- Node.js 20.11 or newer
- A `dsh` installation (`npm install -g @deepseek-ai/dsh`)
- `DEEPSEEK_API_KEY` for the route you use
- For `verify-frontend`: Chrome, Edge, or Chromium

## Publishing

The npm name `dshcli` is already taken, so the package is named **`dsh-cli`** while the installed
command stays `dshcli`. Other free names if you prefer: `dshcli-tui`, `dsh-cli-terminal`.

```sh
npm login
npm pack --dry-run     # review the contents
npm publish
```

Set `repository`, `homepage`, and `bugs` in `package.json` before publishing.

## Related

- [`deepseek-harness/`](deepseek-harness/) — the upstream DeepSeek Harness source, cloned into this
  workspace, including the [SDK protocol](deepseek-harness/packages/sdk/protocol/README.md) this
  client implements.

## License

MIT
