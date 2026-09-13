#!/usr/bin/env node
/**
 * dshcli — DeepSeek Harness in your terminal.
 *
 * The web UI is a browser page; this entry point is the same harness behind a
 * terminal. It resolves an isolated harness home and a working directory, boots
 * one `dsh --profile sdk` runtime, and renders the session log as plain text,
 * so the agent is usable over SSH, in CI shells, and on machines with no
 * browser at all.
 *
 * @module dshcli/bin
 */

import { createInterface } from 'node:readline'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseArgs, helpText, COMMANDS } from '../src/args.mjs'
import { configureTheme, style } from '../src/theme.mjs'
import { resolveDshLauncher, launcherVersion } from '../src/dsh.mjs'
import { selectWorkingDirectory, writeState, readState } from '../src/cwd.mjs'
import { sourceHome, resolveHome, ensureHome, countSessions } from '../src/home.mjs'
import { loadCatalog, findModel, describeModel, resolveModel, defaultRoute, listModelIds, fetchLiveModels } from '../src/models.mjs'
import { pickDirectory, selectOneNumbered } from '../src/pick.mjs'
import { SLASH_COMMANDS, findCommand, invocationOf } from '../src/commands.mjs'
import { InlineMenu, slashCompleter } from '../src/menu.mjs'
import { Renderer, contentText } from '../src/render.mjs'
import { Runtime } from '../src/runtime.mjs'
import { verifyFrontend, DEFAULT_VISION_PROMPT } from '../src/vision.mjs'
import { runWeb } from '../src/web.mjs'
import { findFreePort } from '../src/ports.mjs'

/** Directory of this entry point, used to read the package manifest. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** Exit code used for every failure path. */
const FAILURE = 1

/** Port the harness web profile serves on when the invocation does not name one. */
const DEFAULT_WEB_PORT = 3080

/** Address the harness web profile binds. It refuses to bind every interface. */
const DEFAULT_WEB_HOST = '127.0.0.1'

/**
 * Choose the port the browser frontend will listen on.
 *
 * A taken port is expected rather than exceptional — a previous run, another
 * checkout, or an unrelated process — so the first free candidate is used and
 * the substitution is reported. Port `0` is passed straight through because the
 * operating system then guarantees a free one.
 * @param flags - the parsed flag map.
 * @param renderer - the renderer used to report a substitution.
 * @returns the port to pass to the web profile.
 */
async function chooseWebPort(flags, renderer) {
  if (flags.port !== undefined && !/^\d+$/.test(String(flags.port))) {
    fatal(`--port must be a number, got ${JSON.stringify(flags.port)}`)
  }
  const requested = flags.port === undefined ? DEFAULT_WEB_PORT : Number(flags.port)
  const host = flags.host ?? DEFAULT_WEB_HOST

  let chosen
  try {
    chosen = await findFreePort({ start: requested, host })
  } catch (error) {
    fatal(error.message)
  }
  if (chosen.replaced) {
    renderer.note(`port ${requested} is in use; using ${chosen.port} instead`, 'warn')
  }
  return chosen.port
}

/**
 * Read the dshcli version from its own manifest.
 * @returns the version string, or `0.0.0` when unreadable.
 */
function readVersion() {
  try {
    return JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Write a fatal message and terminate.
 * @param message - the message, which may span several lines.
 * @returns never; the process exits.
 */
function fatal(message) {
  // Errors raised inside dshcli already carry the prefix; adding it twice reads
  // as a bug in the tool rather than a report from it.
  const body = String(message).startsWith('dshcli:') ? String(message).slice('dshcli:'.length).trim() : message
  process.stderr.write(`${style.red('dshcli:')} ${body}\n`)
  process.exit(FAILURE)
}

/**
 * Parse a `WxH` viewport flag.
 * @param value - the raw flag value.
 * @returns the parsed width and height.
 * @throws when the value is not `WxH` with positive integers.
 */
function parseViewport(value) {
  const match = /^(\d+)x(\d+)$/i.exec(String(value ?? '').trim())
  if (match === null) throw new Error(`--viewport must look like 1280x800, got ${JSON.stringify(value)}`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

/**
 * Build the renderer for this invocation.
 *
 * In `--json` mode the human-readable progress moves to stderr so stdout
 * carries nothing but the machine-readable document.
 * @param flags - the parsed flag map.
 * @returns the configured renderer.
 */
function makeRenderer(flags) {
  const width = flags.width === undefined ? undefined : Number(flags.width)
  return new Renderer({
    stream: flags.json === true ? process.stderr : process.stdout,
    width: Number.isFinite(width) ? width : undefined,
    showReasoning: flags.reasoning !== false,
    verbose: flags.verbose === true,
  })
}

/**
 * Describe the route for the session banner.
 * @param invocation - the resolved invocation.
 * @returns a display string.
 */
function describeRoute(invocation) {
  const effort = invocation.reasoningEffort === undefined || invocation.reasoningEffort === ''
    ? ''
    : ` (${invocation.reasoningEffort})`
  return `${invocation.provider}/${invocation.model}${effort}`
}

/**
 * Wire a runtime's events into a renderer and collect the assistant's text.
 * @param renderer - the renderer to feed.
 * @returns the event callback plus the collected-answer accessor.
 */
function makeEventSink(renderer) {
  const parts = []
  const onEvent = (event) => {
    renderer.handleEvent(event)
    if (event?.type === 'assistant/message') {
      const blocks = Array.isArray(event.data?.message?.content)
        ? event.data.message.content.filter((block) => block?.type === 'text')
        : undefined
      const text = contentText(blocks ?? event.data?.message?.content)
      if (text.trim() !== '') parts.push(text)
    }
  }
  return { onEvent, answer: () => parts.join('\n\n').trim(), parts }
}

/**
 * Build the environment and home facts every harness command needs.
 * @param flags - the parsed flag map.
 * @param options - whether the home may be created on disk.
 * @returns the home description, the effective environment, and seed results.
 */
function prepareHome(flags, { create = true } = {}) {
  const home = resolveHome({ explicit: flags.home, env: process.env })
  const env = home.isolated ? { ...process.env, DSH_HOME: home.dir } : { ...process.env }
  if (!create || !home.isolated) return { home, env, seed: { created: false, seeded: [], skipped: [] } }
  const seed = ensureHome({ dir: home.dir, seedFrom: sourceHome(process.env), noSeed: flags.seed === false })
  return { home, env, seed }
}

/**
 * A one-question asker for pickers used before the session's readline exists.
 * @returns an `ask` function suitable for the numbered picker.
 */
function makeOneShotAsker() {
  return (question) => new Promise((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true })
    rl.question(question, (answer) => {
      rl.close()
      resolveAnswer(answer)
    })
  })
}

/**
 * Resolve everything the runtime needs from parsed flags.
 * @param flags - the parsed flag map.
 * @param context - the environment and pre-resolved home.
 * @returns the launcher, working directory, catalog, and route settings.
 */
async function resolveInvocation(flags, { home, env }) {
  const launcher = resolveDshLauncher({ explicit: flags.dsh, env })
  const catalog = loadCatalog({ home: home.dir, launcherEntry: launcher.entry })

  let selection
  if (flags.pick === true) {
    const chosen = await pickDirectory({
      from: process.cwd(),
      env,
      allowNative: flags.dialog !== false,
      ask: makeOneShotAsker(),
    })
    if (typeof chosen !== 'string') throw new Error('--pick was cancelled')
    selection = { dir: chosen, source: '--pick', detail: 'chosen interactively' }
  } else {
    selection = selectWorkingDirectory({
      cwd: flags.cwd,
      here: flags.here === true,
      last: flags.last === true,
      env,
    })
  }

  // A provider accepts model ids only, so the requested name is resolved
  // against the catalog rather than forwarded. Anything the catalog does not
  // know would be rejected by the provider at the first turn; failing here
  // names the accepted ids instead.
  const fallback = defaultRoute(catalog)
  let provider = flags.provider ?? fallback.provider
  let model = fallback.id

  if (flags.model !== undefined) {
    const resolved = resolveModel(catalog, flags.model, provider)
    if (resolved === undefined) {
      throw new Error(
        `--model ${JSON.stringify(flags.model)} is not a model this home can run.\n`
        + `  Available: ${listModelIds(catalog)}\n`
        + '  Run `dshcli models` to list them with their provider.',
      )
    }
    provider = resolved.provider
    model = resolved.id
  } else if (flags.provider !== undefined && flags.provider !== fallback.provider) {
    const first = catalog.models.find((entry) => entry.provider === provider)
    model = first?.id ?? fallback.id
  }

  return {
    launcher,
    home,
    env,
    catalog,
    cwd: selection.dir,
    selection,
    profile: flags.profile ?? 'sdk',
    provider,
    model,
    reasoningEffort: flags.effort,
    maxTokens: flags['max-tokens'] === undefined ? undefined : Number(flags['max-tokens']),
  }
}

/**
 * Boot one runtime, run one task, and shut it down.
 * @param invocation - the resolved invocation.
 * @param task - the user task text.
 * @param renderer - the renderer to feed.
 * @returns the answer text, the turn-end reason, and the session id.
 */
async function runOneShot(invocation, task, renderer) {
  const sink = makeEventSink(renderer)
  const runtime = await Runtime.start({
    launcherEntry: invocation.launcher.entry,
    profile: invocation.profile,
    cwd: invocation.cwd,
    provider: invocation.provider,
    model: invocation.model,
    reasoningEffort: invocation.reasoningEffort,
    maxTokens: invocation.maxTokens,
    env: invocation.env,
    onEvent: sink.onEvent,
    onStatus: (status) => renderer.handleStatus(status),
    onStderr: (chunk) => renderer.writeRaw(style.gray(chunk)),
  })

  const sessionId = Runtime.newSessionId()
  try {
    await runtime.prompt(sessionId, [{ type: 'text', text: task }])
    const reason = await runtime.waitForTurnEnd()
    return { answer: sink.answer(), reason, sessionId }
  } finally {
    await runtime.shutdown()
  }
}

/**
 * Read all of stdin as UTF-8.
 * @returns the decoded text.
 */
async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Run the one-shot `run` command.
 * @param invocation - the resolved invocation.
 * @param flags - the parsed flag map.
 * @param operands - the task words.
 * @returns the process exit code.
 */
async function commandRun(invocation, flags, operands) {
  let task = operands.join(' ').trim()
  if (task === '') {
    if (process.stdin.isTTY === true) fatal('run needs a task: dshcli run "what to do"')
    task = await readStdin()
    if (task.trim() === '') fatal('run read no task from stdin')
  }

  const renderer = makeRenderer(flags)
  writeState({ lastCwd: invocation.cwd }, invocation.env)

  if (flags.json !== true) {
    renderer.banner([
      ['cwd', invocation.cwd],
      ['model', describeRoute(invocation)],
      ['home', invocation.home.dir + (invocation.home.isolated ? '' : ' (shared)')],
    ])
  }

  const result = await runOneShot(invocation, task, renderer)

  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify({
      sessionId: result.sessionId,
      cwd: invocation.cwd,
      home: invocation.home.dir,
      model: invocation.model,
      provider: invocation.provider,
      reason: result.reason?.kind ?? 'unknown',
      answer: result.answer,
    }, null, 2)}\n`)
  } else if (result.answer === '') {
    renderer.note('the turn produced no assistant text', 'warn')
  }

  return result.reason?.kind === 'completed' ? 0 : FAILURE
}

/**
 * Run the interactive `chat` command.
 * @param invocation - the resolved invocation.
 * @param flags - the parsed flag map.
 * @returns the process exit code.
 */
async function commandChat(invocation, flags) {
  const renderer = makeRenderer(flags)
  const interactive = process.stdin.isTTY === true
  let current = { ...invocation }
  let runtime
  let sessionId = Runtime.newSessionId()
  let busy = false
  let exiting = false
  let pending = ''
  let inflight = null

  const catalog = current.catalog
  const sink = makeEventSink(renderer)

  const boot = async () => {
    runtime = await Runtime.start({
      launcherEntry: current.launcher.entry,
      profile: current.profile,
      cwd: current.cwd,
      provider: current.provider,
      model: current.model,
      reasoningEffort: current.reasoningEffort,
      maxTokens: current.maxTokens,
      env: current.env,
      onEvent: sink.onEvent,
      onStatus: (status) => renderer.handleStatus(status),
      onStderr: (chunk) => renderer.writeRaw(style.gray(chunk)),
    })
  }

  const homeLabel = current.home.isolated
    ? `${current.home.dir} ${style.gray(`(isolated, ${current.home.source})`)}`
    : `${current.home.dir} ${style.gray('(shared with the browser install)')}`

  renderer.banner([
    ['cwd', `${current.cwd} ${style.gray(`(${current.selection.source}: ${current.selection.detail})`)}`],
    ['model', describeRoute(current)],
    ['home', homeLabel],
    ['session', style.gray(sessionId)],
  ])

  // A settings file written before a model retirement keeps naming the retired
  // model. It usually still works through a provider alias, so say so once
  // rather than refusing to start.
  const declared = catalog.defaultModel?.model
  if (declared !== undefined && resolveModel(catalog, declared) === undefined) {
    renderer.note(
      `this home's agent-default-model names ${JSON.stringify(declared)}, which is not in its catalog; using ${current.model}`,
      'warn',
    )
    renderer.note(style.gray('run "dshcli models --live" to compare the catalog with what the provider serves'))
  }
  renderer.note(style.gray('starting the runtime...'))

  await boot()
  writeState({ lastCwd: current.cwd }, current.env)

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: interactive,
    historySize: 200,
    completer: slashCompleter,
  })

  const menu = interactive ? new InlineMenu({ rl }) : undefined
  // Output must never land on top of the menu rows, so any write hides it first.
  // The next keystroke redraws it.
  renderer.beforeWrite = () => menu?.hide()
  // The spinner paints the current line, which is the prompt line while the menu
  // is open, so it stays quiet until the menu closes.
  renderer.spinnerAllowed = () => menu?.visible !== true
  const setPrompt = () => rl.setPrompt(!interactive ? '' : pending === '' ? style.brightCyan('> ') : style.gray('| '))
  setPrompt()

  // Printed only once the input interface exists: the hint is what a user reads
  // as "ready", so anything typed after it must not be dropped because the
  // runtime was still booting.
  renderer.note(style.gray('type / to list commands, /help for all, Ctrl+C aborts a turn'))

  /** The pending answer to an inline question asked by a slash command. */
  let pendingQuestion = null

  /** The browser frontend this session started, when one is running. */
  let frontend = null
  let frontendUrl = null

  /**
   * Start the browser frontend alongside this session.
   *
   * It is deliberately not awaited: the whole point is that the terminal keeps
   * working while the page is available. Output is attributed to this session so
   * the two never look like one stream.
   * @returns nothing.
   */
  const startFrontend = async () => {
    if (frontend !== null) {
      renderer.note(`the frontend is already running at ${frontendUrl ?? '(starting)'}`)
      return
    }
    const port = await chooseWebPort(flags, renderer)
    renderer.note(`starting the browser frontend on port ${port} (this session keeps running)`)
    const handle = runWeb({
      launcherEntry: current.launcher.entry,
      env: current.env,
      cwd: current.cwd,
      port,
      host: flags.host,
      open: flags.open !== false,
      onUrl: (url) => {
        frontendUrl = url
        renderer.write('')
        renderer.note(`${style.bold('frontend ready')}  ${style.brightCyan(url)}`, 'ok')
        renderer.note(style.gray('open that exact URL; it carries the session token. /web stop ends it'))
        renderer.write('')
      },
      onOutput: (line) => renderer.write(style.dim(`web | ${line}`)),
      onError: (text) => renderer.writeRaw(style.red(text)),
    })
    frontend = handle
    frontendUrl = null
    void handle.done.then((exit) => {
      if (frontend !== handle) return
      frontend = null
      frontendUrl = null
      renderer.note(exit.code === 0 || exit.code === null ? 'the frontend stopped' : `the frontend exited with code ${exit.code}`)
    })
  }

  /**
   * Stop the browser frontend this session started.
   * @returns nothing.
   */
  const stopFrontend = () => {
    if (frontend === null) {
      renderer.note('no frontend was started by this session')
      return
    }
    renderer.note('stopping the frontend...')
    frontend.stop()
  }

  /**
   * Ask one question on the live session prompt.
   * @param question - the text to print before reading a line.
   * @returns the answer line.
   */
  const ask = (question) => new Promise((resolveAnswer) => {
    pendingQuestion = resolveAnswer
    process.stdout.write(question)
  })

  const restart = async (next) => {
    await runtime.shutdown()
    current = { ...current, ...next }
    sessionId = Runtime.newSessionId()
    await boot()
    renderer.note(`now using ${current.cwd} at ${describeRoute(current)}`, 'ok')
    writeState({ lastCwd: current.cwd }, current.env)
  }

  const submit = async (line) => {
    busy = true
    try {
      await runtime.prompt(sessionId, [{ type: 'text', text: line }])
      await runtime.waitForTurnEnd()
    } catch (error) {
      renderer.stopSpinner()
      renderer.note(error.message, 'error')
    } finally {
      busy = false
      if (!exiting && interactive) rl.prompt()
    }
  }

  const startTurn = (line) => {
    inflight = submit(line).finally(() => {
      inflight = null
    })
    return inflight
  }

  /**
   * Choose a model from the catalog and switch the runtime to it.
   * @returns nothing.
   */
  const switchModel = async () => {
    if (catalog.models.length === 0) {
      renderer.note('no models are configured in this home', 'warn')
      return
    }
    const chosen = await selectOneNumbered({
      items: catalog.models,
      title: 'Switch model',
      label: (model) => `${model.provider}/${model.id}`,
      describe: (model) => `${model.name}${describeModel(model) === '' ? '' : ` | ${describeModel(model)}`}`,
      ask,
    })
    if (chosen === undefined) {
      renderer.note('model unchanged')
      return
    }
    await restart({ provider: chosen.provider, model: chosen.id })
  }
  /**
   * Pick a working directory with the folder dialog and switch to it.
   * @returns nothing.
   */
  const switchDirectory = async () => {
    if (interactive) rl.pause()
    let chosen
    try {
      chosen = await pickDirectory({
        from: current.cwd,
        env: current.env,
        allowNative: flags.dialog !== false,
        ask,
      })
    } finally {
      if (interactive) rl.resume()
    }
    if (typeof chosen !== 'string') {
      renderer.note('selection cancelled')
      return
    }
    if (chosen === current.cwd) {
      renderer.note('already using that directory')
      return
    }
    await restart({ cwd: chosen, selection: { source: 'folder dialog', detail: 'chosen interactively' } })
  }

  /**
   * Execute one slash command.
   * @param line - the full command line, including the slash.
   * @returns false when the session should end.
   */
  const handleSlash = async (line) => {
    const [rawName, ...rest] = line.slice(1).split(/\s+/)
    const argument = rest.join(' ').trim()
    const command = findCommand(rawName)
    if (command === undefined) {
      renderer.note(`unknown command /${rawName} - type / for the list`, 'warn')
      return true
    }

    switch (command.name) {
      case 'help': {
        renderer.write(style.bold('commands'))
        const width = Math.max(...SLASH_COMMANDS.map((entry) => invocationOf(entry).length))
        for (const entry of SLASH_COMMANDS) {
          renderer.write(`  ${style.cyan(invocationOf(entry).padEnd(width))}  ${style.gray(entry.summary)}`)
        }
        renderer.write('')
        return true
      }
      case 'pwd':
        renderer.note(current.cwd)
        return true
      case 'cd': {
        if (argument === '') {
          await switchDirectory()
          return true
        }
        const next = resolve(current.cwd, argument)
        if (!existsSync(next)) {
          renderer.note(`${next} does not exist`, 'error')
          return true
        }
        await restart({ cwd: next, selection: { source: '/cd', detail: 'in-session change' } })
        return true
      }
      case 'pick':
        await switchDirectory()
        return true
      case 'web': {
        const action = argument.toLowerCase()
        if (action === '' || action === 'start' || action === 'on') {
          await startFrontend()
          return true
        }
        if (action === 'stop' || action === 'off' || action === 'kill') {
          stopFrontend()
          return true
        }
        if (action === 'status') {
          renderer.note(frontend === null ? 'no frontend is running' : `running at ${frontendUrl ?? '(starting)'}`)
          return true
        }
        renderer.note(`usage: /web [start|stop|status] - got ${JSON.stringify(argument)}`, 'warn')
        return true
      }
      case 'model': {
        if (argument === '') {
          await switchModel()
          return true
        }
        // Only the catalog may produce a model id: a provider rejects a display
        // name, so an unrecognised argument is refused here with the list of
        // ids rather than forwarded and failing on the next turn.
        const resolved = resolveModel(catalog, argument, current.provider)
        if (resolved === undefined) {
          renderer.note(`${JSON.stringify(argument)} is not a model this home can run`, 'error')
          renderer.note(`available: ${listModelIds(catalog)}`)
          renderer.note(style.gray('type /model with no argument to choose from a list'))
          return true
        }
        await restart({ model: resolved.id, provider: resolved.provider })
        return true
      }
      case 'models': {
        const width = Math.max(...catalog.models.map((model) => `${model.provider}/${model.id}`.length))
        renderer.write(style.bold(`models (${catalog.source})`))
        for (const model of catalog.models) {
          const active = model.id === current.model && model.provider === current.provider
          const label = `${model.provider}/${model.id}`.padEnd(width)
          const hint = describeModel(model)
          renderer.write(`  ${active ? style.brightCyan('*') : ' '} ${active ? style.bold(label) : label}  ${style.gray(model.name)}${hint === '' ? '' : style.gray(` | ${hint}`)}`)
        }
        renderer.write('')
        return true
      }
      case 'effort': {
        if (argument === '') {
          renderer.note(current.reasoningEffort ?? '(route default)')
          return true
        }
        await restart({ reasoningEffort: argument })
        return true
      }
      case 'new':
        sessionId = Runtime.newSessionId()
        renderer.note(`new session ${sessionId}`, 'ok')
        return true
      case 'reasoning':
        renderer.showReasoning = !renderer.showReasoning
        renderer.note(`reasoning ${renderer.showReasoning ? 'shown' : 'hidden'}`)
        return true
      case 'home': {
        if (argument === '') {
          renderer.write(style.bold('home'))
          renderer.write(`  dir        ${current.home.dir}`)
          renderer.write(`  source     ${current.home.source}`)
          renderer.write(`  isolated   ${current.home.isolated ? 'yes' : 'no (shared with the browser install)'}`)
          renderer.write(`  sessions   ${countSessions(current.home.dir)}`)
          renderer.write('')
          return true
        }
        const nextHome = resolveHome({ explicit: argument, env: process.env })
        ensureHome({ dir: nextHome.dir, seedFrom: sourceHome(process.env), noSeed: flags.seed === false })
        const nextEnv = nextHome.isolated ? { ...process.env, DSH_HOME: nextHome.dir } : { ...process.env }
        await restart({ home: nextHome, env: nextEnv })
        renderer.note(`home is now ${nextHome.dir}`, 'ok')
        return true
      }
      case 'status': {
        const info = runtime.serverInfo
        renderer.write(style.bold('runtime'))
        renderer.write(`  launcher  ${current.launcher.entry} ${style.gray(`(${current.launcher.source})`)}`)
        renderer.write(`  profile   ${current.profile}`)
        renderer.write(`  model     ${describeRoute(current)}`)
        renderer.write(`  server    ${info?.serverInfo?.name ?? 'unknown'} ${info?.serverInfo?.version ?? ''}`)
        renderer.write(`  pid       ${runtime.pid ?? 'exited'}`)
        renderer.write(`  cwd       ${current.cwd}`)
        renderer.write(`  home      ${current.home.dir}${current.home.isolated ? '' : ' (shared)'}`)
        renderer.write(`  session   ${sessionId}`)
        renderer.write('')
        return true
      }
      case 'clear':
        // The screen is gone, so the menu must forget its rows rather than try
        // to erase rows that now hold other content.
        menu?.forget()
        process.stdout.write('\u001B[2J\u001B[H')
        return true
      case 'abort':
        if (!busy) {
          renderer.note('no turn is running')
          return true
        }
        renderer.note('aborting: the harness exposes no cancel method, so the runtime process ends', 'warn')
        await runtime.abort()
        await boot()
        sessionId = Runtime.newSessionId()
        renderer.note(`runtime restarted with session ${sessionId}`, 'ok')
        return true
      case 'exit':
        return false
      default:
        renderer.note(`/${command.name} is listed but not implemented - please report this`, 'error')
        return true
    }
  }

  const onLine = async (line) => {
    const text = pending === '' ? line : `${pending}\n${line}`
    if (text.endsWith('\\')) {
      pending = text.slice(0, -1)
      setPrompt()
      if (interactive) rl.prompt()
      return
    }
    pending = ''
    setPrompt()

    const trimmed = text.trim()
    if (trimmed === '') {
      if (interactive) rl.prompt()
      return
    }

    if (busy) {
      renderer.note('a turn is already running - wait for it or press Ctrl+C', 'warn')
      if (interactive) rl.prompt()
      return
    }

    if (trimmed.startsWith('/')) {
      const keepGoing = await handleSlash(trimmed)
      if (!keepGoing) {
        rl.close()
        return
      }
      if (!busy && interactive) rl.prompt()
      return
    }

    // readline has already echoed the typed line at the prompt, so echoing it
    // again here would print every prompt twice. Only a piped session, which
    // never echoed, needs the transcript line.
    if (!interactive) {
      renderer.write(`${style.brightCyan('>')} ${trimmed.split('\n')[0]}${trimmed.includes('\n') ? style.gray(' ...') : ''}`)
    }
    await startTurn(text)
  }

  await new Promise((resolveLoop) => {
    // Lines are handled one at a time: a second prompt submitted while a turn
    // runs would otherwise race the first one's session append. Piped stdin
    // reaches EOF before those turns finish, so the loop ends only after the
    // chain drains; otherwise the runtime is torn down mid-conversation.
    let chain = Promise.resolve()
    let closed = false
    const settle = () => {
      if (closed) chain.then(() => resolveLoop())
    }

    rl.on('line', (line) => {
      // An inline question must be answered outside the chain: the chain is
      // currently awaiting the command that asked it, so queueing the answer
      // behind that command would deadlock the session.
      if (pendingQuestion !== null) {
        const resolveAnswer = pendingQuestion
        pendingQuestion = null
        resolveAnswer(line)
        return
      }
      chain = chain.then(() => onLine(line)).catch(() => {})
      chain.then(settle)
    })
    rl.on('SIGINT', () => {
      if (busy) {
        renderer.stopSpinner()
        renderer.note('interrupt - ending the runtime process', 'warn')
        void runtime.abort().then(boot).then(() => {
          busy = false
          sessionId = Runtime.newSessionId()
          renderer.note(`runtime restarted with session ${sessionId}`, 'ok')
          if (interactive) rl.prompt()
        })
        return
      }
      process.stdout.write('\n')
      exiting = true
      rl.close()
    })
    rl.on('close', () => {
      exiting = true
      closed = true
      settle()
    })
    if (interactive) rl.prompt()
  })

  menu?.dispose()
  if (inflight !== null) await inflight
  if (frontend !== null) {
    renderer.note('stopping the frontend this session started...')
    frontend.stop()
  }
  renderer.note('shutting the runtime down...')
  await runtime.shutdown()
  renderer.note('session ended', 'ok')
  return 0
}

/**
 * Run the `verify-frontend` command.
 * @param invocation - the resolved invocation.
 * @param flags - the parsed flag map.
 * @param operands - the target operand.
 * @returns the process exit code.
 */
async function commandVerifyFrontend(invocation, flags, operands) {
  const target = operands[0]
  if (target === undefined) fatal('verify-frontend needs a target: a URL or a file path')

  const { width, height } = flags.viewport === undefined ? {} : parseViewport(flags.viewport)
  const shot = flags.shot === undefined
    ? join(invocation.cwd, `dshcli-frontend-${Date.now()}.png`)
    : resolve(invocation.cwd, flags.shot)

  // The reviewer must be a route this home can actually run and one that accepts
  // an image: prefer an explicit flag, then a vision-capable catalog entry, then
  // the session's own model.
  const catalog = invocation.catalog
  let model
  if (flags['vision-model'] !== undefined) {
    const resolved = resolveModel(catalog, flags['vision-model'], invocation.provider)
    if (resolved === undefined) {
      fatal(`--vision-model ${JSON.stringify(flags['vision-model'])} is not a model this home can run.\n  Available: ${listModelIds(catalog)}`)
    }
    model = resolved.id
  } else {
    model = catalog.models.find((entry) => entry.vision)?.id ?? invocation.model
  }

  const renderer = makeRenderer(flags)
  const sink = makeEventSink(renderer)

  renderer.banner([
    ['target', target],
    ['cwd', invocation.cwd],
    ['vision', `${invocation.provider}/${model}`],
    ['shot', shot],
  ])

  const result = await verifyFrontend({
    target,
    launcherEntry: invocation.launcher.entry,
    cwd: invocation.cwd,
    provider: invocation.provider,
    model,
    reasoningEffort: invocation.reasoningEffort,
    prompt: DEFAULT_VISION_PROMPT,
    width,
    height,
    out: shot,
    browser: flags.browser,
    cookies: flags.cookie ?? [],
    settleMs: flags.settle === undefined ? undefined : Number(flags.settle),
    env: invocation.env,
    onEvent: sink.onEvent,
    onStatus: (status) => renderer.handleStatus(status),
    onStderr: (chunk) => renderer.writeRaw(style.gray(chunk)),
    onProgress: (message) => renderer.note(style.gray(message)),
  })

  const answer = sink.answer()
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify({
      target,
      screenshot: result.capture.path,
      screenshotBytes: result.capture.bytes,
      documentTitle: result.capture.title,
      consoleErrors: result.capture.consoleErrors,
      report: answer,
      reason: result.reason?.kind ?? 'unknown',
    }, null, 2)}\n`)
  } else if (answer === '') {
    renderer.note('the vision model returned no report', 'error')
    return FAILURE
  }

  return result.reason?.kind === 'completed' ? 0 : FAILURE
}

/**
 * Run the `web` command: boot the browser frontend against this home.
 * @param flags - the parsed flag map.
 * @returns the process exit code.
 */
async function commandWeb(flags) {
  const { home, env } = prepareHome(flags)
  const launcher = resolveDshLauncher({ explicit: flags.dsh, env })
  const renderer = makeRenderer(flags)

  renderer.banner([
    ['home', home.isolated ? `${home.dir} ${style.gray('(isolated)')}` : `${home.dir} ${style.gray('(shared)')}`],
    ['launcher', launcher.entry],
    ['port', flags.port === undefined ? `${DEFAULT_WEB_PORT} ${style.gray('(or the next free one)')}` : flags.port],
  ], { heading: null })
  renderer.note(style.gray('starting the harness web frontend; press Ctrl+C to stop'))

  const port = await chooseWebPort(flags, renderer)
  let announced = false
  const handle = runWeb({
    launcherEntry: launcher.entry,
    env,
    cwd: process.cwd(),
    port,
    host: flags.host,
    open: flags.open !== false,
    onUrl: (url) => {
      announced = true
      renderer.write('')
      renderer.note(`${style.bold('frontend ready')}  ${style.brightCyan(url)}`, 'ok')
      renderer.note(style.gray('open that exact URL; it carries the session token'))
      renderer.write('')
    },
    onOutput: (line) => renderer.write(style.gray(line)),
    onError: (text) => renderer.writeRaw(style.red(text)),
  })

  const exit = await handle.done

  if (exit.error !== undefined) {
    fatal(`could not start the web profile: ${exit.error.message}`)
  }
  if (!announced) {
    renderer.note('the web profile exited before reporting a URL', 'error')
    return FAILURE
  }
  return exit.code === 0 || exit.code === null ? 0 : FAILURE
}

/**
 * Run the `models` command.
 * @param flags - the parsed flag map.
 * @returns the process exit code.
 */
async function commandModels(flags) {
  const { home, env } = prepareHome(flags)
  const launcher = resolveDshLauncher({ explicit: flags.dsh, env })
  const catalog = loadCatalog({ home: home.dir, launcherEntry: launcher.entry })

  // `--live` asks the provider what it serves now, which is how a catalog
  // written before a model retirement gets noticed: retired ids can keep
  // working through provider-side aliases, so the difference is advisory.
  let live
  if (flags.live === true) {
    live = await fetchLiveModels({ provider: catalog.models[0]?.provider, providerConfig: catalog.providerConfig, env })
  }

  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify({
      home: home.dir,
      source: catalog.source,
      default: catalog.defaultModel ?? null,
      models: catalog.models,
      ...(live === undefined ? {} : { live }),
    }, null, 2)}\n`)
    return 0
  }

  const renderer = makeRenderer(flags)
  const width = Math.max(...catalog.models.map((model) => `${model.provider}/${model.id}`.length))
  renderer.banner([['home', home.dir], ['catalog', style.gray(catalog.source)]], { heading: null })

  const stale = []
  for (const model of catalog.models) {
    const hint = describeModel(model)
    const retired = live?.ids !== undefined && !live.ids.includes(model.id)
    if (retired) stale.push(model.id)
    const flag = retired ? style.yellow('  (not currently served)') : ''
    renderer.write(`  ${`${model.provider}/${model.id}`.padEnd(width)}  ${model.name}${hint === '' ? '' : style.gray(`  |  ${hint}`)}${flag}`)
    if (model.description !== '') renderer.write(`  ${' '.repeat(width)}  ${style.gray(model.description)}`)
  }
  renderer.write('')

  if (live !== undefined) {
    if (live.error !== undefined) {
      renderer.note(`could not read the live model list: ${live.error}`, 'warn')
    } else {
      const added = live.ids.filter((id) => !catalog.models.some((model) => model.id === id))
      renderer.note(`provider now serves: ${live.ids.join(', ')}`)
      if (added.length > 0) renderer.note(`served but not in this home's settings: ${added.join(', ')}`, 'warn')
    }
  }
  if (stale.length > 0) {
    const plural = stale.length === 1
    renderer.note(
      `${stale.join(', ')} ${plural ? 'is' : 'are'} no longer served; the provider may still alias ${plural ? 'it' : 'them'}`,
      'warn',
    )
    renderer.note(style.gray(`edit ${join(home.dir, 'settings.yaml')} to update the catalog`))
  }

  renderer.note(style.gray('switch with: dshcli --model <id>, or the /model command inside a session'))
  return 0
}

/**
 * Run the `home` command.
 * @param flags - the parsed flag map.
 * @returns the process exit code.
 */
async function commandHome(flags) {
  const { home, env, seed } = prepareHome(flags)

  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify({
      ...home,
      ...seed,
      sessions: countSessions(home.dir),
      sourceHome: sourceHome(process.env),
      env: { DSH_HOME: env.DSH_HOME },
    }, null, 2)}\n`)
    return 0
  }

  const renderer = makeRenderer(flags)
  const details = [
    ['dir', home.dir],
    ['selected by', home.source],
    ['isolated', home.isolated ? 'yes' : 'no (shared with the browser install)'],
    ['created now', seed.created ? 'yes' : 'no'],
    ['seeded', seed.seeded.length === 0 ? style.gray('(nothing)') : seed.seeded.join(', ')],
    ['sessions', String(countSessions(home.dir))],
    ['seeded from', sourceHome(process.env)],
  ]
  const width = Math.max(...details.map(([label]) => label.length))
  renderer.write(style.bold('dshcli home'))
  for (const [label, value] of details) renderer.write(`  ${style.gray(label.padEnd(width))}  ${value}`)
  renderer.write('')
  return 0
}

/**
 * Run the `dir` command.
 * @param flags - the parsed flag map.
 * @returns the process exit code.
 */
async function commandDir(flags) {
  if (flags.pick === true) {
    fatal('--pick belongs to session commands; `dir` only reports. Run `dshcli` or `dshcli --pick`.')
  }
  const selection = selectWorkingDirectory({
    cwd: flags.cwd,
    here: flags.here === true,
    last: flags.last === true,
  })
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(selection, null, 2)}\n`)
  } else {
    process.stdout.write(`${selection.dir}\n`)
  }
  return 0
}

/**
 * Run the `doctor` command.
 * @param flags - the parsed flag map.
 * @returns the process exit code.
 */
async function commandDoctor(flags) {
  const renderer = makeRenderer(flags)
  const lines = []
  const record = (label, value) => lines.push([label, value])

  record('node', `${process.version} (${process.platform}/${process.arch})`)
  record('dshcli', readVersion())

  let launcher
  try {
    launcher = resolveDshLauncher({ explicit: flags.dsh })
    record('launcher', launcher.entry)
    record('launcher from', launcher.source)
    record('dsh version', launcherVersion(launcher.entry) ?? 'unknown')
  } catch (error) {
    record('launcher', style.red(error.message.split('\n')[0]))
  }

  const home = resolveHome({ explicit: flags.home, env: process.env })
  record('harness home', `${home.dir} ${style.gray(home.isolated ? `(isolated, ${home.source})` : '(shared with the browser install)')}`)
  record('home exists', existsSync(home.dir) ? `yes, ${countSessions(home.dir)} session dirs` : style.yellow('not created yet'))
  record('seeded from', sourceHome(process.env))

  if (launcher !== undefined) {
    const catalog = loadCatalog({ home: home.dir, launcherEntry: launcher.entry })
    record('models', `${catalog.models.length} from ${catalog.source}`)
  }

  try {
    const selection = selectWorkingDirectory({ cwd: flags.cwd, here: flags.here === true, last: flags.last === true })
    record('working dir', `${selection.dir} (${selection.source}: ${selection.detail})`)
  } catch (error) {
    record('working dir', style.red(error.message))
  }
  record('last session dir', readState(process.env).lastCwd ?? style.gray('(none)'))

  let browser = style.yellow('none found - verify-frontend unavailable')
  try {
    const { findBrowser } = await import('../src/browser.mjs')
    browser = findBrowser({ explicit: flags.browser }).path
  } catch {
    // Keep the warning recorded above.
  }
  record('browser', browser)

  record('DEEPSEEK_API_KEY', process.env.DEEPSEEK_API_KEY ? 'set' : style.yellow('not set in this shell'))

  const width = Math.max(...lines.map(([label]) => label.length))
  renderer.write(style.bold('dshcli doctor'))
  for (const [label, value] of lines) renderer.write(`  ${style.gray(label.padEnd(width))}  ${value}`)
  renderer.write('')
  return 0
}

/**
 * Entry point.
 * @returns the process exit code.
 */
async function main() {
  const argv = process.argv.slice(2)
  const version = readVersion()

  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    fatal(error.message)
  }
  const { command, operands, flags } = parsed

  configureTheme({ stream: flags.json === true ? process.stderr : process.stdout, noColor: flags.color === false })

  if (flags.version === true) {
    process.stdout.write(`${version}\n`)
    return 0
  }
  if (command === 'help' || flags.help === true) {
    process.stdout.write(helpText(version))
    return 0
  }
  if (!Object.hasOwn(COMMANDS, command)) fatal(`unknown command ${JSON.stringify(command)}`)

  try {
    if (command === 'dir') return await commandDir(flags)
    if (command === 'doctor') return await commandDoctor(flags)
    if (command === 'models') return await commandModels(flags)
    if (command === 'home') return await commandHome(flags)
    if (command === 'web') return await commandWeb(flags)

    const { home, env } = prepareHome(flags)
    const invocation = await resolveInvocation(flags, { home, env })
    if (command === 'run') return await commandRun(invocation, flags, operands)
    if (command === 'verify-frontend') return await commandVerifyFrontend(invocation, flags, operands)
    return await commandChat(invocation, flags)
  } catch (error) {
    fatal(error instanceof Error ? error.message : String(error))
  }
  return FAILURE
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    // An unexpected rejection is a dshcli defect: keep the stack, but keep it
    // behind the same prefix so it never reads as a harness failure.
    process.stderr.write(`${style.red('dshcli:')} unexpected failure\n${error?.stack ?? error}\n`)
    process.exitCode = FAILURE
  },
)
