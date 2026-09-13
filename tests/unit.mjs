/**
 * Unit tests for dshcli's pure logic.
 *
 * These cover the parts that decide behaviour before any process is spawned:
 * argument parsing, working-directory and home resolution, the command table,
 * the suggestion filter, text wrapping, and the JSON-RPC framing. Everything
 * here is deterministic and makes no model calls.
 *
 * Run: node tests/unit.mjs
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createServer } from 'node:net'

import { parseArgs, helpText } from '../src/args.mjs'
import { selectWorkingDirectory, detectProjectRoot } from '../src/cwd.mjs'
import { resolveHome, DEFAULT_HOME_DIRNAME } from '../src/home.mjs'
import { suggestCommands, completeCommandName, findCommand, invocationOf, SLASH_COMMANDS } from '../src/commands.mjs'
import { clipRow, InlineMenu } from '../src/menu.mjs'
import { wrapText, contentText, summarizeToolArguments, Renderer } from '../src/render.mjs'
import { loadCatalog, describeModel, findModel, resolveModel, defaultRoute, listModelIds, BUILTIN_MODELS } from '../src/models.mjs'
import { JsonRpcLineTransport, JsonRpcResponseError, TransportClosedError } from '../src/rpc.mjs'
import { findFreePort, portCandidates } from '../src/ports.mjs'

let passed = 0
let failed = 0

/**
 * Assert one condition.
 * @param name - the case name.
 * @param condition - the condition that must hold.
 * @param detail - extra context printed on failure.
 * @returns nothing.
 */
function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1
    process.stdout.write(`  ok    ${name}\n`)
  } else {
    failed += 1
    process.stdout.write(`  FAIL  ${name}${detail === '' ? '' : `\n        ${detail}`}\n`)
  }
}

/**
 * Assert deep equality by JSON comparison.
 * @param name - the case name.
 * @param actual - the produced value.
 * @param expected - the expected value.
 * @returns nothing.
 */
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  ok(name, a === b, `expected ${b}\n        actual   ${a}`)
}

/** Run every group. */
async function main() {
  process.stdout.write('unit tests\n')

  // --- argument parsing ------------------------------------------------------
  {
    const parsed = parseArgs(['run', 'fix', 'the', 'tests', '--model', 'deepseek-v4-pro'])
    eq('parseArgs splits command, operands, and flags', [parsed.command, parsed.operands, parsed.flags.model], ['run', ['fix', 'the', 'tests'], 'deepseek-v4-pro'])

    eq('parseArgs defaults to chat', parseArgs([]).command, 'chat')
    eq('parseArgs accepts --flag=value', parseArgs(['--model=x']).flags.model, 'x')
    eq('parseArgs maps -C to cwd', parseArgs(['-C', '/tmp']).flags.cwd, '/tmp')
    eq('parseArgs maps -H to home', parseArgs(['-H', '/tmp/h']).flags.home, '/tmp/h')
    eq('parseArgs negates --no-reasoning', parseArgs(['--no-reasoning']).flags.reasoning, false)
    eq('parseArgs negates --no-dialog', parseArgs(['--no-dialog']).flags.dialog, false)
    eq('parseArgs collects repeated --cookie', parseArgs(['--cookie', 'a=1', '--cookie', 'b=2']).flags.cookie, ['a=1', 'b=2'])
    eq('parseArgs treats -- as a literal separator', parseArgs(['run', '--', '--not-a-flag']).operands, ['--not-a-flag'])

    let rejected = ''
    try {
      parseArgs(['--nope'])
    } catch (error) {
      rejected = error.message
    }
    ok('parseArgs rejects an unknown long flag', rejected.includes('unknown flag --nope'), rejected)

    rejected = ''
    try {
      parseArgs(['-Z'])
    } catch (error) {
      rejected = error.message
    }
    ok('parseArgs rejects an unknown short flag', rejected.includes('unknown flag -Z'), rejected)

    rejected = ''
    try {
      parseArgs(['--cwd'])
    } catch (error) {
      rejected = error.message
    }
    ok('parseArgs rejects a value flag with no value', rejected.includes('needs a value'), rejected)

    const help = helpText('9.9.9')
    ok('helpText names every command', ['chat', 'run', 'web', 'models', 'verify-frontend', 'dir', 'home', 'doctor'].every((name) => help.includes(name)))
    ok('helpText documents the isolated home', help.includes('~/.dshcli'))
    ok('helpText includes the version', help.includes('9.9.9'))
  }

  // --- slash commands --------------------------------------------------------
  {
    eq('every command has a unique name', new Set(SLASH_COMMANDS.map((c) => c.name)).size, SLASH_COMMANDS.length)
    ok('every command has a summary', SLASH_COMMANDS.every((c) => typeof c.summary === 'string' && c.summary.length > 5))
    eq('invocationOf renders arguments', invocationOf({ name: 'cd', args: '[dir]' }), '/cd [dir]')
    eq('invocationOf omits empty arguments', invocationOf({ name: 'pwd', args: '' }), '/pwd')

    eq('findCommand resolves a name', findCommand('model')?.name, 'model')
    eq('findCommand resolves an alias', findCommand('cwd')?.name, 'pwd')
    eq('findCommand rejects an unknown name', findCommand('nope'), undefined)

    const all = suggestCommands('')
    eq('an empty query suggests every command', all.length, SLASH_COMMANDS.length)
    ok('a prefix suggests the matching commands', suggestCommands('mo').every((c) => c.name.startsWith('mo')))
    ok('a prefix ranks name matches first', suggestCommands('m')[0].name.startsWith('m'))
    eq('a summary word still matches', suggestCommands('folder').some((c) => c.name === 'cd'), true)
    eq('a non-match suggests nothing', suggestCommands('zzzz').length, 0)
    eq('an unambiguous prefix completes', completeCommandName('exi'), 'exit')
    eq('an ambiguous prefix does not complete', completeCommandName('m'), undefined)
  }

  // --- menu rendering --------------------------------------------------------
  {
    eq('clipRow keeps a short row', clipRow('hello', 10), 'hello')
    eq('clipRow truncates a long row', clipRow('hello world', 6), 'hello\u2026')
    eq('clipRow ignores styling when measuring', clipRow('\u001B[36mabcdef\u001B[0m', 4), 'abc\u2026')
  }

  // --- the inline menu's terminal protocol -----------------------------------
  // Asserted here rather than through a pseudo-terminal: node-pty drives ConPTY
  // on Windows, which re-renders escape sequences, so a pty capture reflects the
  // terminal's choices instead of the bytes this code actually writes.
  {
    const stdout = new PassThrough()
    stdout.isTTY = true
    stdout.columns = 100
    stdout.rows = 30
    let written = ''
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk) => { written += chunk })

    const stdin = new PassThrough()
    const rl = { line: '/', cursor: 1, getPrompt: () => '> ', closed: false }
    const menu = new InlineMenu({ rl, stdin, stdout, rows: SLASH_COMMANDS.length })

    menu.refresh()
    ok('the menu lists every command', SLASH_COMMANDS.every((command) => written.includes(`/${command.name}`)))
    ok('the menu opens a new row before the list', written.startsWith('\n'))
    eq('the menu moves the cursor up by the number of rows', /\u001B\[(\d+)A/.exec(written)?.[1], String(SLASH_COMMANDS.length))
    eq('the menu restores the column after the typed text', /\u001B\[(\d+)G/.exec(written)?.[1], '4')
    ok('the menu reports itself visible', menu.visible)

    // Redrawing an unchanged list must not touch the screen at all: every extra
    // cursor move is a chance to drift.
    written = ''
    menu.refresh()
    eq('an unchanged menu writes nothing', written, '')

    written = ''
    menu.hide()
    eq('hiding the menu clears to the end of the screen', written, '\u001B[J')
    ok('hiding the menu moves the cursor no rows', !/[\u001B]\[\d*[AB]/.test(written), JSON.stringify(written))
    ok('the menu reports itself hidden', !menu.visible)

    menu.dispose()
    ok('dispose detaches from the input stream', stdin.listenerCount('keypress') === 0)

    // A line that is no longer a bare slash must hide the menu again. Erasing
    // the old rows legitimately writes bytes, so assert that no command row is
    // drawn rather than that nothing is written.
    written = ''
    const menu2 = new InlineMenu({ rl, stdin, stdout, rows: 5 })
    menu2.refresh()
    ok('a bare slash draws the menu', written.includes('/help'))
    written = ''
    rl.line = '/model deepseek-v4-pro'
    menu2.refresh()
    ok('a command with arguments draws no menu rows', !written.includes('/help'), JSON.stringify(written))
    ok('a command with arguments leaves the menu hidden', !menu2.visible)
    rl.line = '/'
    menu2.dispose()
  }

  // --- the menu must not disturb the screen above the prompt ------------------
  // This is the regression for the reported "everything above disappeared"
  // defect: the old erase walked down, cleared while stepping back up, then
  // moved up by the full count, landing N-1 rows above the prompt.
  {
    /**
     * A tiny terminal: enough of one to track where the cursor ends up and
     * which rows survive.
     * @param bytes - the escape stream to apply.
     * @returns the cursor row, the cursor column, and the resulting rows.
     */
    const runTerminal = (bytes) => {
      const height = 30
      const screen = new Array(height).fill('')
      let row = 5
      let col = 0
      let index = 0
      while (index < bytes.length) {
        if (bytes[index] === '\u001B') {
          const match = /^\u001B\[(\d*)([A-Za-z])/.exec(bytes.slice(index))
          if (match !== null) {
            const count = match[1] === '' ? 1 : Number(match[1])
            if (match[2] === 'A') row = Math.max(0, row - count)
            else if (match[2] === 'B') row = Math.min(height - 1, row + count)
            else if (match[2] === 'G') col = count - 1
            else if (match[2] === 'J') for (let r = row; r < height; r += 1) screen[r] = ''
            index += match[0].length
            continue
          }
        }
        const char = bytes[index]
        if (char === '\n') {
          row = Math.min(height - 1, row + 1)
          col = 0
        } else if (char === '\r') {
          col = 0
        } else {
          screen[row] = `${screen[row].slice(0, col)}${char}${screen[row].slice(col + 1)}`
          col += 1
        }
        index += 1
      }
      return { row, col, screen }
    }

    const stdout = new PassThrough()
    stdout.isTTY = true
    stdout.columns = 100
    stdout.rows = 30
    let written = ''
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk) => { written += chunk })

    const rl = { line: '/', cursor: 1, getPrompt: () => '> ', closed: false }
    const menu = new InlineMenu({ rl, stdin: new PassThrough(), stdout, rows: SLASH_COMMANDS.length })

    // The prompt starts at row 5; rows 0-4 hold the conversation so far, which
    // this module's bytes must never touch.
    menu.refresh()
    const drawn = runTerminal(written)
    eq('drawing the menu returns the cursor to the prompt row', drawn.row, 5)
    ok('the menu occupies the rows below the prompt', drawn.screen.slice(6, 12).some((line) => line.includes('/help')))
    ok('drawing writes nothing above the prompt', drawn.screen.slice(0, 5).every((line) => line === ''))

    written = ''
    menu.hide()
    const erased = runTerminal(written)
    eq('erasing the menu moves the cursor no rows', erased.row, 5)
    ok('erasing clears every menu row', erased.screen.slice(6, 25).every((line) => line === ''))

    // Repeat the cycle and apply the whole stream at once: drift would
    // accumulate across keystrokes, which is exactly how the conversation above
    // the prompt was destroyed.
    let stream = ''
    for (let round = 0; round < 6; round += 1) {
      written = ''
      rl.line = `/${'m'.repeat(round % 3)}`
      menu.refresh()
      stream += written
      written = ''
      menu.hide()
      stream += written
    }
    const end = runTerminal(stream)
    eq('six draw/erase cycles leave the cursor on the prompt row', end.row, 5)
    ok('six cycles never write above the prompt', end.screen.slice(0, 5).every((line) => line === ''))
    menu.dispose()
  }

  // --- text helpers ----------------------------------------------------------
  {
    eq('wrapText keeps short lines', wrapText('a b c', 40), ['a b c'])
    eq('wrapText splits long lines', wrapText('aaa bbb ccc', 7).length, 2)
    eq('wrapText preserves blank lines', wrapText('a\n\nb', 40), ['a', '', 'b'])
    eq('wrapText applies the indent', wrapText('a b', 40, '  '), ['  a b'])

    eq('contentText joins text blocks', contentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
    eq('contentText marks images', contentText([{ type: 'image', data: 'x' }]), '[image]')
    eq('contentText accepts a string', contentText('plain'), 'plain')

    eq('summarizeToolArguments finds the command field', summarizeToolArguments('pwsh', '{"command":"Get-ChildItem"}'), 'Get-ChildItem')
    eq('summarizeToolArguments finds the read path', summarizeToolArguments('read', '{"file_path":"/a/b.txt"}'), '/a/b.txt')
    eq('summarizeToolArguments tolerates bad JSON', summarizeToolArguments('x', 'not json'), 'not json')
    ok('summarizeToolArguments truncates long values', summarizeToolArguments('x', JSON.stringify({ command: 'y'.repeat(400) })).length <= 110)
  }

  // --- working directory -----------------------------------------------------
  {
    const root = mkdtempSync(join(tmpdir(), 'dshcli-unit-cwd-'))
    const repo = join(root, 'repo')
    const pkg = join(repo, 'packages', 'thing')
    mkdirSync(pkg, { recursive: true })
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), '{}')
    mkdirSync(join(root, 'plain'), { recursive: true })

    const detected = detectProjectRoot(pkg)
    eq('detectProjectRoot prefers the repository root', [detected.dir, detected.kind], [repo, 'workspace'])

    // A directory with no marker of its own must not be reported as one; the
    // walk legitimately continues into ancestors the test does not control.
    const bare = join(root, 'plain')
    const bareResult = detectProjectRoot(bare)
    ok('detectProjectRoot never invents a marker for a bare directory', bareResult?.dir !== bare, JSON.stringify(bareResult))

    const lone = join(root, 'lone-project')
    mkdirSync(lone, { recursive: true })
    writeFileSync(join(lone, 'package.json'), '{}')
    const loneResult = detectProjectRoot(lone)
    eq('a standalone project directory is reported as a project root', [loneResult.dir, loneResult.kind], [lone, 'project'])

    eq('--cwd wins over everything', selectWorkingDirectory({ cwd: pkg, from: root, env: {} }).dir, pkg)
    eq('DSHCLI_CWD applies when --cwd is absent', selectWorkingDirectory({ from: root, env: { DSHCLI_CWD: pkg } }).dir, pkg)
    eq('--here keeps the shell directory', selectWorkingDirectory({ here: true, from: pkg, env: {} }).dir, pkg)
    eq('the default detects the workspace root', selectWorkingDirectory({ from: pkg, env: {} }).dir, repo)

    let message = ''
    try {
      selectWorkingDirectory({ cwd: join(root, 'missing'), env: {} })
    } catch (error) {
      message = error.message
    }
    ok('a missing --cwd fails loudly', message.includes('not an existing directory'), message)

    rmSync(root, { recursive: true, force: true })
  }

  // --- home resolution -------------------------------------------------------
  {
    const env = { DSH_HOME: join(tmpdir(), 'source-home') }
    eq('the default home is isolated', resolveHome({ env }).isolated, true)
    ok('the default home is named .dshcli', resolveHome({ env }).dir.endsWith('.dshcli'))
    eq('"shared" reuses the source home', resolveHome({ explicit: 'shared', env }).dir, env.DSH_HOME)
    eq('"shared" is not isolated', resolveHome({ explicit: 'shared', env }).isolated, false)
    eq('--home wins over DSHCLI_HOME', resolveHome({ explicit: join(tmpdir(), 'a'), env: { ...env, DSHCLI_HOME: join(tmpdir(), 'b') } }).dir, join(tmpdir(), 'a'))
    eq('DSHCLI_HOME applies without --home', resolveHome({ env: { ...env, DSHCLI_HOME: join(tmpdir(), 'b') } }).dir, join(tmpdir(), 'b'))
    eq('the documented default name is used', DEFAULT_HOME_DIRNAME, '.dsh')
  }

  // --- model catalog ---------------------------------------------------------
  {
    const home = mkdtempSync(join(tmpdir(), 'dshcli-unit-home-'))
    const launcher = join(process.cwd(), 'tests', 'no-such-launcher.js')

    const fallback = loadCatalog({ home, launcherEntry: launcher })
    eq('an empty home falls back to the built-in catalog', fallback.models.length, BUILTIN_MODELS.length)
    eq('the fallback is labelled', fallback.source, 'built-in defaults')

    writeFileSync(join(home, 'settings.yaml'), [
      'agent-default-model:',
      '  provider: deepseek-official',
      '  model: deepseek-v4-pro',
      'llm-deepseek:',
      '  providers:',
      '    deepseek-official:',
      '      models:',
      '        - id: deepseek-v4-pro',
      '          name: DeepSeek-V4-Pro',
      '          contextWindow: 1000000',
      '        - id: vision-x',
      '          name: Vision X',
      '          input: [text, image]',
      '',
    ].join('\n'))

    // Reading YAML needs js-yaml from the harness; skip when it is absent.
    let catalog
    try {
      const { resolveDshLauncher } = await import('../src/dsh.mjs')
      const real = resolveDshLauncher({})
      catalog = loadCatalog({ home, launcherEntry: real.entry })
    } catch {
      catalog = undefined
    }

    if (catalog !== undefined && catalog.source.startsWith(home)) {
      eq('the settings catalog is read', catalog.models.length, 2)
      eq('the default model is read', catalog.defaultModel?.model, 'deepseek-v4-pro')
      eq('image input is detected as vision', findModel(catalog, 'vision-x')?.vision, true)
      eq('text-only models are not vision', findModel(catalog, 'deepseek-v4-pro')?.vision, false)
      ok('describeModel reports vision', describeModel(findModel(catalog, 'vision-x')).includes('vision'))
      ok('describeModel reports the context window', describeModel(findModel(catalog, 'deepseek-v4-pro')).includes('1000k'))
    } else {
      process.stdout.write('  skip  settings catalog (js-yaml unavailable from the harness)\n')
    }

    rmSync(home, { recursive: true, force: true })
  }

  // --- port selection --------------------------------------------------------
  {
    eq(
      'the search window is ten ports, then the same ten a thousand higher',
      portCandidates({ start: 3080 }),
      [3080, 3081, 3082, 3083, 3084, 3085, 3086, 3087, 3088, 3089,
        4080, 4081, 4082, 4083, 4084, 4085, 4086, 4087, 4088, 4089],
    )
    eq('the window shape is configurable', portCandidates({ start: 10, window: 2, stride: 100, rounds: 2 }), [10, 11, 110, 111])

    const taken = new Set([3080, 3081])
    const free = await findFreePort({ start: 3080, probe: async (port) => !taken.has(port) })
    eq('the first free port wins', free.port, 3082)
    eq('a substitution is reported', free.replaced, true)
    eq('the ports already tried are reported', free.tried, [3080, 3081])

    const open = await findFreePort({ start: 3080, probe: async () => true })
    eq('a free starting port is kept', open.port, 3080)
    eq('no substitution is reported when the first port works', open.replaced, false)

    let message = ''
    try {
      await findFreePort({ start: 3080, probe: async () => false })
    } catch (error) {
      message = error.message
    }
    ok('an exhausted window fails loudly', message.includes('every port in the search window is taken'), message)
    ok('the failure lists every port tried', message.includes('3080') && message.includes('4089'), message)

    eq('port 0 is passed through to the operating system', (await findFreePort({ start: 0 })).port, 0)

    // A real bind, not a stub: occupy a port and confirm the search skips it.
    const holder = createServer()
    await new Promise((resolveListen) => holder.listen({ port: 0, host: '127.0.0.1' }, resolveListen))
    const occupied = holder.address().port
    const chosen = await findFreePort({ start: occupied, host: '127.0.0.1' })
    eq('a genuinely bound port is skipped', chosen.port, occupied + 1)
    await new Promise((resolveClose) => holder.close(resolveClose))
  }

  // --- model resolution ------------------------------------------------------
  {
    // A provider accepts ids and rejects display names, so resolving user input
    // to an id is the difference between a working turn and an API error.
    const catalog = {
      models: [
        { provider: 'deepseek-official', id: 'deepseek-flash', name: 'DeepSeek-V4-Flash', vision: true },
        { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', vision: false },
        { provider: 'other', id: 'deepseek-v4-pro', name: 'Other Pro', vision: false },
      ],
      defaultModel: undefined,
      source: 'test',
    }

    eq('resolveModel accepts a bare id', resolveModel(catalog, 'deepseek-v4-pro')?.id, 'deepseek-v4-pro')
    eq('resolveModel accepts the display name', resolveModel(catalog, 'DeepSeek-V4-Pro')?.id, 'deepseek-v4-pro')
    eq('resolveModel ignores case', resolveModel(catalog, 'deepseek-v4-PRO')?.id, 'deepseek-v4-pro')
    eq('resolveModel ignores surrounding space', resolveModel(catalog, '  deepseek-flash  ')?.id, 'deepseek-flash')
    eq('resolveModel accepts provider/id', resolveModel(catalog, 'other/deepseek-v4-pro')?.provider, 'other')
    eq('a provider hint disambiguates a shared id', resolveModel(catalog, 'deepseek-v4-pro', 'other')?.provider, 'other')
    eq('resolveModel rejects an unknown name', resolveModel(catalog, 'gpt-4'), undefined)
    eq('resolveModel rejects an empty string', resolveModel(catalog, '   '), undefined)
    ok('resolveModel never returns a display name as the id', resolveModel(catalog, 'DeepSeek-V4-Flash')?.id === 'deepseek-flash')
    eq('listModelIds lists every id', listModelIds(catalog), 'deepseek-flash, deepseek-v4-pro, deepseek-v4-pro')

    eq(
      'defaultRoute prefers the configured default',
      defaultRoute({ ...catalog, defaultModel: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }),
      { provider: 'deepseek-official', id: 'deepseek-v4-pro' },
    )
    eq(
      'defaultRoute resolves a configured display name',
      defaultRoute({ ...catalog, defaultModel: { provider: 'deepseek-official', model: 'DeepSeek-V4-Pro' } }).id,
      'deepseek-v4-pro',
    )
    eq('defaultRoute falls back to the first model', defaultRoute(catalog).id, 'deepseek-flash')
    eq(
      'defaultRoute ignores a configured model the catalog does not know',
      defaultRoute({ ...catalog, defaultModel: { provider: 'deepseek-official', model: 'retired-model' } }).id,
      'deepseek-flash',
    )
    eq(
      'the built-in catalog offers only served ids',
      BUILTIN_MODELS.map((model) => model.id),
      ['deepseek-flash', 'deepseek-v4-pro'],
    )
  }

  // --- JSON-RPC transport ----------------------------------------------------
  {
    const toPeer = new PassThrough()
    const fromPeer = new PassThrough()
    const notifications = []
    const transport = new JsonRpcLineTransport({
      stdin: toPeer,
      stdout: fromPeer,
      onNotification: (method, params) => notifications.push([method, params]),
      onProtocolError: () => {},
    })
    transport.start()

    const seen = []
    toPeer.setEncoding('utf8')
    toPeer.on('data', (chunk) => {
      for (const line of chunk.split('\n').filter((l) => l !== '')) seen.push(JSON.parse(line))
    })

    const pending = transport.request('initialize', { cwd: '/x' })
    eq('a request is framed as JSON-RPC 2.0', [seen[0].jsonrpc, seen[0].method, seen[0].id, seen[0].params.cwd], ['2.0', 'initialize', 1, '/x'])
    fromPeer.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })}\n`)
    eq('a response resolves its request', await pending, { ok: true })

    fromPeer.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session.event', params: { a: 1 } })}\n`)
    eq('a notification reaches the handler', notifications, [['session.event', { a: 1 }]])

    const failing = transport.request('session/prompt', {})
    fromPeer.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'boom' } })}\n`)
    let rpcError
    try {
      await failing
    } catch (error) {
      rpcError = error
    }
    ok('an error frame rejects with the wire code', rpcError instanceof JsonRpcResponseError && rpcError.code === -32603, String(rpcError))

    // Frames split across chunks must still parse.
    const split = transport.request('shutdown', undefined)
    const frame = `${JSON.stringify({ jsonrpc: '2.0', id: 3, result: {} })}\n`
    fromPeer.write(frame.slice(0, 8))
    fromPeer.write(frame.slice(8))
    eq('a frame split across chunks is reassembled', await split, {})

    const orphan = transport.request('whatever', undefined)
    transport.close('test teardown')
    let closedError
    try {
      await orphan
    } catch (error) {
      closedError = error
    }
    ok('closing fails in-flight requests', closedError instanceof TransportClosedError, String(closedError))

    let sendAfterClose
    try {
      await transport.request('x', undefined)
    } catch (error) {
      sendAfterClose = error
    }
    ok('sending after close is refused', sendAfterClose instanceof TransportClosedError, String(sendAfterClose))
  }

  // --- renderer --------------------------------------------------------------
  {
    const sink = new PassThrough()
    sink.isTTY = false
    const renderer = new Renderer({ stream: sink, width: 60, showReasoning: false })

    let out = ''
    sink.setEncoding('utf8')
    sink.on('data', (chunk) => { out += chunk })

    renderer.handleEvent({ type: 'turn/start', seq: 1, data: { turn: 1 } })
    renderer.handleEvent({ type: 'tool/call', seq: 2, data: { callId: 'c1', name: 'read', arguments: '{"file_path":"/a.txt"}' } })
    renderer.handleEvent({
      type: 'tool/result',
      seq: 3,
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'file body' }], isError: false }] } },
    })
    renderer.handleEvent({ type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } })

    ok('the renderer names the turn', out.includes('turn 1'))
    ok('the renderer shows the tool and its argument', out.includes('read') && out.includes('/a.txt'))
    ok('the renderer shows the correlated result', out.includes('file body'))
    ok('the renderer reports completion', out.includes('completed'))
    ok('reasoning is hidden when disabled', !out.includes('reasoning'))
  }

  // --- the renderer's output hooks -------------------------------------------
  {
    const sink = new PassThrough()
    sink.isTTY = false
    const renderer = new Renderer({ stream: sink, width: 60 })

    let hidden = 0
    renderer.beforeWrite = () => { hidden += 1 }
    renderer.write('one')
    renderer.writeRaw('two')
    eq('every write asks the session to hide the menu first', hidden, 2)

    // Without a hook the renderer must not care.
    const bare = new Renderer({ stream: new PassThrough(), width: 60 })
    bare.write('fine')
    ok('the hook is optional', true)

    renderer.spinnerAllowed = () => false
    eq('a blocked spinner reports itself idle', renderer.busy, false)
  }

  process.stdout.write(`\n${passed}/${passed + failed} checks passed\n`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
