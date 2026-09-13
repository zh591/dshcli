/**
 * Interactive acceptance tests.
 *
 * The slash-command menu, the pickers, and the session commands only exist
 * behind a TTY, so they are driven here through a real pseudo-terminal using
 * the `node-pty` build that ships with the harness installation. Nothing in
 * these tests calls a model: every case exercises client-side behaviour, so the
 * suite is fast, free, and deterministic.
 *
 * Run: node tests/interactive.mjs
 */

import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveDshLauncher } from '../src/dsh.mjs'
import { SLASH_COMMANDS } from '../src/commands.mjs'

/** Names the menu is expected to list. */
const SLASH_COMMAND_NAMES = SLASH_COMMANDS.map((command) => command.name)

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = join(HERE, '..', 'bin', 'dshcli.mjs')

/** Load node-pty from the harness installation. */
function loadPty() {
  const launcher = resolveDshLauncher({})
  const require = createRequire(launcher.entry)
  return require('node-pty')
}

const results = []
let failures = 0

/**
 * Record one assertion result.
 * @param name - the case name.
 * @param ok - whether it passed.
 * @param detail - extra context printed on failure.
 * @returns nothing.
 */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failures += 1
  process.stdout.write(`${ok ? '  ok  ' : '  FAIL'}  ${name}${ok || detail === '' ? '' : `\n        ${detail}`}\n`)
}

/**
 * Start one interactive dshcli session in a pseudo-terminal.
 * @param options - arguments and environment overrides.
 * @returns a handle for reading output and sending keystrokes.
 */
function startSession({ args, env, cwd }) {
  const pty = loadPty()
  const child = pty.spawn(process.execPath, [BIN, ...args], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd,
    env,
  })

  let buffer = ''
  let exitInfo = null
  child.onData((data) => {
    buffer += data
  })
  child.onExit((info) => {
    exitInfo = info
  })

  return {
    child,
    get output() {
      return buffer
    },
    get exited() {
      return exitInfo
    },
    /** Clear the buffer so a wait only sees output produced after this point. */
    mark() {
      buffer = ''
    },
    /**
     * Wait for a pattern to appear in the accumulated output.
     * @param pattern - a string or regular expression.
     * @param timeoutMs - how long to wait.
     * @returns true when the pattern appeared.
     */
    async waitFor(pattern, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs
      const test = (text) => (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text))
      while (Date.now() < deadline) {
        if (test(buffer)) return true
        if (exitInfo !== null) return test(buffer)
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      return test(buffer)
    },
    /** Wait for the process to exit. */
    async waitForExit(timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline && exitInfo === null) await new Promise((resolve) => setTimeout(resolve, 60))
      return exitInfo
    },
    send(text) {
      child.write(text)
    },
    async stop() {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    },
  }
}

/**
 * Strip ANSI escapes and carriage returns so assertions read plain text.
 * @param text - raw terminal output.
 * @returns the printable text.
 */
function plain(text) {
  return text
    .replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '\n')
    .replace(/\n{2,}/g, '\n')
}

/**
 * Collapse all whitespace, so a value wrapped by the terminal still matches.
 * @param text - raw terminal output.
 * @returns the text with every run of whitespace removed.
 */
function flat(text) {
  return plain(text).replace(/\s+/g, '')
}

/**
 * Run every case, then report and exit.
 * @returns nothing.
 */
async function main() {
  const home = mkdtempSync(join(tmpdir(), 'dshcli-pty-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'dshcli-pty-work-'))
  const otherDir = join(workspace, 'another-place')
  mkdirSync(otherDir, { recursive: true })

  const env = { ...process.env, DSH_HOME: home, TERM: 'xterm-256color', NO_COLOR: '1' }
  if (!env.DEEPSEEK_API_KEY) {
    process.stdout.write('note: DEEPSEEK_API_KEY is unset; the runtime may fail to initialize\n')
  }

  process.stdout.write('interactive tests\n')

  // --- 1. the slash menu -----------------------------------------------------
  {
    const s = startSession({ args: ['chat', '--no-reasoning', '--cwd', workspace, '--home', home], env, cwd: workspace })
    const ready = await s.waitFor('type / to list commands')
    check('session starts and prints its hint', ready, plain(s.output).slice(-400))

    s.mark()
    s.send('/')
    const listed = await s.waitFor('switch the model')
    check('typing "/" lists commands with descriptions', listed, plain(s.output).slice(-500))

    const text = plain(s.output)
    check('menu shows the cd command with its hint', text.includes('/cd') && text.includes('change the working directory'))
    check('menu shows the model command', text.includes('/model'))
    check('menu shows the exit command', text.includes('/exit'))

    // The menu is drawn under the prompt, so the typed slash must precede the
    // first command row in drawing order. The cursor-restore bytes are asserted
    // in the unit suite: ConPTY re-renders them, so a pty capture would only
    // show the terminal's choice, not what the menu wrote.
    const typedAt = text.indexOf('/')
    const firstRowAt = text.indexOf('/help')
    check('the menu is drawn below the typed line', firstRowAt > typedAt && typedAt >= 0, JSON.stringify(text.slice(0, 120)))
    check('every command is listed', SLASH_COMMAND_NAMES.every((name) => text.includes(`/${name}`)), text.slice(-200))

    s.mark()
    s.send('mo')
    const narrowed = await s.waitFor('list the models this home can run')
    check('typing narrows the menu to matching commands', narrowed, plain(s.output).slice(-400))
    const narrowedText = plain(s.output)
    check('narrowed menu excludes unrelated commands', !narrowedText.includes('change the working directory'))

    // Backspace back to a bare slash, then clear the line.
    s.send('\u007F\u007F\u0015')
    await new Promise((resolve) => setTimeout(resolve, 300))

    s.mark()
    s.send('/help\r')
    const help = await s.waitFor('clear the screen')
    check('/help prints the full command list', help, plain(s.output).slice(-500))

    s.mark()
    s.send('/exit\r')
    await s.waitForExit()
    check('/exit ends the session', s.exited !== null)
    await s.stop()
  }

  // --- 2. the model picker ---------------------------------------------------
  {
    const s = startSession({ args: ['chat', '--no-reasoning', '--cwd', workspace, '--home', home], env, cwd: workspace })
    await s.waitFor('type / to list commands')

    s.mark()
    s.send('/models\r')
    const listed = await s.waitFor('DeepSeek-V4-Pro')
    check('/models lists the catalog', listed, plain(s.output).slice(-500))

    s.mark()
    s.send('/model\r')
    const picker = await s.waitFor('Switch model')
    check('/model opens the numbered picker', picker, plain(s.output).slice(-500))
    check('picker offers the provider-qualified ids', plain(s.output).includes('deepseek-official/deepseek-v4-pro'))

    // The catalog order depends on the home, so read the entry's own number
    // rather than assuming a fixed position.
    const pickerText = plain(s.output)
    const proLine = /^\s*(\d+)\s+deepseek-official\/deepseek-v4-pro\b/m.exec(pickerText)
    check('picker numbers each entry', proLine !== null, pickerText.slice(-400))

    s.mark()
    s.send(`${proLine?.[1] ?? '1'}\r`)
    const switched = await s.waitFor('now using', 25_000)
    check('/model switches the route and restarts the runtime', switched, plain(s.output).slice(-500))
    // The terminal wraps long lines, so compare with whitespace removed.
    check('switch reported the chosen model', flat(s.output).includes('deepseek-official/deepseek-v4-pro'), plain(s.output).slice(-300))

    s.mark()
    s.send('/status\r')
    const status = await s.waitFor('home      ')
    check('/status reports home and cwd', status, plain(s.output).slice(-600))
    check('/status reports the active model', flat(s.output).includes('deepseek-official/deepseek-v4-pro'), plain(s.output).slice(-400))

    s.send('/exit\r')
    await s.waitForExit()
    await s.stop()
  }

  // --- 3. working directory commands ----------------------------------------
  {
    // `--no-dialog` keeps the directory picker in the terminal. Without it the
    // native folder dialog would open and wait for a human, which is correct
    // behaviour but not something an unattended test can answer.
    const s = startSession({
      args: ['chat', '--no-reasoning', '--cwd', workspace, '--home', home, '--no-dialog'],
      env,
      cwd: workspace,
    })
    await s.waitFor('type / to list commands')

    s.mark()
    s.send('/pwd\r')
    check('/pwd prints the working directory', await s.waitFor(workspace.replace(/\\/g, '\\')), plain(s.output).slice(-300))

    s.mark()
    s.send(`/cd ${otherDir}\r`)
    const moved = await s.waitFor('now using', 25_000)
    check('/cd switches the working directory', moved, plain(s.output).slice(-400))
    check('/cd reported the new directory', plain(s.output).includes('another-place'))

    s.mark()
    s.send('/cd\r')
    const picker = await s.waitFor('Select a working directory', 25_000)
    check('/cd without an argument opens the directory picker', picker, plain(s.output).slice(-600))

    s.send('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 500))

    s.send('/exit\r')
    await s.waitForExit()
    await s.stop()
  }

  // --- 4. the folder dialog is reachable without a display ------------------
  {
    const s = startSession({
      args: ['chat', '--no-reasoning', '--cwd', workspace, '--home', home],
      env: { ...env, DSHCLI_DIALOG_SELFTEST: '1' },
      cwd: workspace,
    })
    await s.waitFor('type / to list commands')
    s.mark()
    s.send('/pick\r')
    await new Promise((resolve) => setTimeout(resolve, 4000))
    const text = plain(s.output)
    check(
      'the folder-dialog path runs end to end (self-test)',
      text.includes('already using that directory') || text.includes('selection cancelled') || text.includes('now using'),
      text.slice(-400),
    )
    s.send('/exit\r')
    await s.waitForExit()
    await s.stop()
  }

  // --- 5. model ids: a display name must resolve, garbage must be refused ----
  {
    const s = startSession({ args: ['chat', '--no-reasoning', '--cwd', workspace, '--home', home], env, cwd: workspace })
    await s.waitFor('type / to list commands')

    // The provider rejects a display name where an id is required, so typing the
    // name shown next to a model must still select that model.
    s.mark()
    s.send('/model DeepSeek-V4-Pro\r')
    const byName = await s.waitFor('now using', 25_000)
    check('/model accepts a display name', byName, plain(s.output).slice(-400))
    check('a display name is canonicalised to its id', flat(s.output).includes('deepseek-official/deepseek-v4-pro'), plain(s.output).slice(-300))

    s.mark()
    s.send('/model definitely-not-a-model\r')
    const refused = await s.waitFor('is not a model this home can run')
    check('/model refuses an unknown name', refused, plain(s.output).slice(-300))
    check('the refusal lists the accepted ids', plain(s.output).includes('deepseek-v4-pro'), plain(s.output).slice(-300))

    s.mark()
    s.send('/status\r')
    await s.waitFor('model     ')
    check('a refused switch leaves the route unchanged', flat(s.output).includes('deepseek-official/deepseek-v4-pro'), plain(s.output).slice(-300))

    s.send('/exit\r')
    await s.waitForExit()
    await s.stop()
  }

  // --- 5. the /web command starts and stops the browser frontend -------------
  {
    const s = startSession({
      // Port 0 hands the choice to the operating system, so this case cannot
      // collide with anything already listening on the machine.
      args: ['chat', '--no-reasoning', '--cwd', workspace, '--home', home, '--port', '0', '--no-open'],
      env,
      cwd: workspace,
    })
    await s.waitFor('type / to list commands')

    s.mark()
    s.send('/web\r')
    const ready = await s.waitFor('frontend ready', 60_000)
    check('/web starts the browser frontend from inside the session', ready, plain(s.output).slice(-500))
    check('/web prints an authenticated URL', /http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(s.output), plain(s.output).slice(-300))

    s.mark()
    s.send('/web status\r')
    check('/web status reports the running frontend', await s.waitFor('running at http', 20_000), plain(s.output).slice(-300))

    s.mark()
    s.send('/web\r')
    check('starting it twice does not start a second one', await s.waitFor('already running'), plain(s.output).slice(-300))

    s.mark()
    s.send('/web stop\r')
    check('/web stop ends it', await s.waitFor('stopped', 30_000), plain(s.output).slice(-300))

    s.mark()
    s.send('/web status\r')
    check('/web status reports it is gone', await s.waitFor('no frontend is running', 20_000), plain(s.output).slice(-300))

    s.send('/exit\r')
    await s.waitForExit(30_000)
    await s.stop()
  }

  // --- 6. the prompt is not echoed twice ------------------------------------
  // This is the one case that runs a real turn: the duplicate appeared as an
  // extra transcript line before the model answered, so it can only be observed
  // by submitting a message.
  if (env.DEEPSEEK_API_KEY) {
    const s = startSession({ args: ['chat', '--no-reasoning', '--cwd', workspace, '--home', home], env, cwd: workspace })
    await s.waitFor('type / to list commands')

    const sentinel = 'ECHOCHECK'
    s.mark()
    s.send(`${sentinel}\r`)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    // Everything before the turn rule is the prompt echo and, under the old
    // defect, a second copy of it. Bounding the window this way keeps the model's
    // own answer — which may repeat the sentinel — out of the count, and avoids
    // depending on how ConPTY re-renders the prompt line.
    const beforeTurn = plain(s.output).split('turn 1')[0]
    const echoCount = beforeTurn.split(sentinel).length - 1
    check(
      'the submitted line is echoed exactly once',
      echoCount === 1,
      `the text appeared ${echoCount} times before the turn:\n${beforeTurn.slice(-300)}`,
    )

    s.send('/exit\r')
    await s.waitForExit(60_000)
    await s.stop()
  } else {
    process.stdout.write('  skip  prompt echo (needs DEEPSEEK_API_KEY for the turn)\n')
  }

  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })

  process.stdout.write(`\n${results.length - failures}/${results.length} checks passed\n`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
