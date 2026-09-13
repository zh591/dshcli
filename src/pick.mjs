/**
 * Interactive pickers.
 *
 * Two kinds of selection are needed: choosing a working directory, and choosing
 * one item from a list such as the model catalog. A terminal user expects a
 * real dialog for the first and an arrow-key list for the second, so both are
 * provided here, each falling back to a plain numbered prompt when the richer
 * surface is unavailable (no GUI session, no TTY).
 *
 * @module dshcli/pick
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { emitKeypressEvents } from 'node:readline'
import { pickerCandidates } from './cwd.mjs'
import { style, visibleLength } from './theme.mjs'

/** Longest a folder dialog is allowed to stay open before it is abandoned. */
const DIALOG_TIMEOUT_MS = 10 * 60_000

/**
 * Test whether a path is an existing directory.
 * @param path - candidate path.
 * @returns true when the path names a directory.
 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Run one command and resolve with its trimmed stdout.
 * @param command - the executable.
 * @param args - its arguments.
 * @param options - timeout and stream policy.
 * @returns the trimmed stdout, or undefined when the command failed.
 */
function runCapture(command, args, options = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options })
    let out = ''
    let err = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { out += chunk })
    child.stderr?.on('data', (chunk) => { err += chunk })
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? DIALOG_TIMEOUT_MS)
    child.once('error', () => { clearTimeout(timer); resolveResult(undefined) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolveResult(code === 0 ? out.trim() : undefined)
    })
    void err
  })
}

/**
 * The Windows folder-dialog script.
 *
 * Windows PowerShell 5.1 runs on .NET Framework, whose `FolderBrowserDialog`
 * lacks properties the modern one has (`UseDescriptionForTitle`), so every
 * optional assignment is individually guarded: a missing property must degrade
 * to a plainer dialog, not abort the whole script.
 *
 * `DSHCLI_DIALOG_SELFTEST` makes it validate the assembly and types and exit
 * without ever showing a window, so the plumbing can be tested unattended.
 * @returns the PowerShell source.
 */
function windowsDialogScript() {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
try { $dialog.Description = $env:DSHCLI_DIALOG_TITLE } catch { }
try { $dialog.ShowNewFolderButton = $true } catch { }
try { $dialog.UseDescriptionForTitle = $true } catch { }
if ($env:DSHCLI_DIALOG_START -and (Test-Path $env:DSHCLI_DIALOG_START)) {
  try { $dialog.SelectedPath = $env:DSHCLI_DIALOG_START } catch { }
}
if ($env:DSHCLI_DIALOG_SELFTEST -eq '1') {
  Write-Output 'SELFTEST-OK'
  exit 0
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
  Write-Output $dialog.SelectedPath
}
`.trim()
}

/**
 * Open the operating system's folder chooser.
 *
 * Returns undefined rather than throwing whenever no dialog is possible, so
 * callers can fall back to a terminal list.
 * @param options - dialog title, starting directory, and environment.
 * @returns the chosen directory, or undefined when cancelled or unavailable.
 */
export async function nativeFolderDialog({ title = 'Select a working directory', startIn, env = process.env } = {}) {
  const dialogEnv = {
    ...env,
    DSHCLI_DIALOG_TITLE: title,
    ...(typeof startIn === 'string' && startIn !== '' ? { DSHCLI_DIALOG_START: startIn } : {}),
  }

  if (process.platform === 'win32') {
    const host = env.DSHCLI_DIALOG_SELFTEST === '1' ? 'powershell.exe' : 'powershell.exe'
    const out = await runCapture(
      host,
      ['-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsDialogScript()],
      { env: dialogEnv, timeoutMs: DIALOG_TIMEOUT_MS },
    )
    if (out === undefined) return undefined
    if (out === 'SELFTEST-OK') return { selftest: true }
    const chosen = out.split('\n').map((line) => line.trim()).filter((line) => line !== '').pop()
    return chosen !== undefined && isDirectory(chosen) ? chosen : undefined
  }

  if (process.platform === 'darwin') {
    const script = `POSIX path of (choose folder with prompt "${title.replace(/"/g, '\\"')}")`
    const out = await runCapture('osascript', ['-e', script], { env: dialogEnv })
    return out !== undefined && out !== '' && isDirectory(out) ? out : undefined
  }

  for (const [command, args] of [
    ['zenity', ['--file-selection', '--directory', '--title', title]],
    ['kdialog', ['--getexistingdirectory', startIn ?? env.HOME ?? '.', '--title', title]],
    ['yad', ['--file-selection', '--directory', '--title', title]],
  ]) {
    const out = await runCapture(command, args, { env: dialogEnv })
    if (out !== undefined && out !== '' && isDirectory(out)) return out
  }
  return undefined
}

/**
 * Arrow-key single-choice list drawn on the alternate screen region.
 *
 * The widget owns the terminal for its lifetime: it enables raw mode, hides the
 * cursor, and restores both before resolving. It is therefore only usable when
 * no readline interface holds the input stream.
 * @param options - items, how to label them, and the input/output streams.
 * @returns the chosen item, or undefined when the user cancelled.
 */
export async function selectOne({
  items,
  title = 'Select',
  label = (item) => String(item),
  describe = () => '',
  stdin = process.stdin,
  stdout = process.stdout,
  filterable = true,
  maxVisible = 12,
}) {
  if (items.length === 0) return undefined
  if (stdin.isTTY !== true || stdout.isTTY !== true) return undefined

  let query = ''
  let index = 0
  let offset = 0
  let drawn = 0

  const matches = () => {
    if (query === '') return items
    const needle = query.toLowerCase()
    return items.filter((item) => `${label(item)} ${describe(item)}`.toLowerCase().includes(needle))
  }

  const render = () => {
    const visible = matches()
    if (index >= visible.length) index = Math.max(0, visible.length - 1)
    if (index < offset) offset = index
    if (index >= offset + maxVisible) offset = index - maxVisible + 1
    const window = visible.slice(offset, offset + maxVisible)

    const lines = [style.bold(title)]
    if (filterable) lines.push(style.gray(`  filter: ${query === '' ? '(type to filter)' : query}`))
    if (visible.length === 0) {
      lines.push(style.yellow('  no match'))
    } else {
      for (let i = 0; i < window.length; i += 1) {
        const absolute = offset + i
        const marker = absolute === index ? style.brightCyan('❯') : ' '
        const text = label(window[i])
        const hint = describe(window[i])
        lines.push(`${marker} ${absolute === index ? style.bold(text) : text}${hint === '' ? '' : style.gray(`  ${hint}`)}`)
      }
    }
    lines.push(style.gray('  ↑/↓ move · Enter select · Esc cancel'))

    if (drawn > 0) {
      stdout.write(`\r\u001B[${drawn - 1}A`)
      for (let i = 0; i < drawn; i += 1) {
        stdout.write('\u001B[2K')
        if (i < drawn - 1) stdout.write('\u001B[1B')
      }
      stdout.write(`\r\u001B[${drawn - 1}A`)
    }
    stdout.write(lines.join('\n'))
    drawn = lines.length
  }

  return new Promise((resolveChoice) => {
    const wasRaw = stdin.isRaw
    const finish = (value) => {
      stdin.off('keypress', onKey)
      if (stdin.setRawMode !== undefined) stdin.setRawMode(wasRaw === true)
      stdin.pause()
      stdout.write('\u001B[?25h\n')
      resolveChoice(value)
    }

    const onKey = (str, key) => {
      if (key === undefined) return
      if (key.name === 'escape' || (key.ctrl === true && key.name === 'c')) {
        finish(undefined)
        return
      }
      const visible = matches()
      if (key.name === 'return' || key.name === 'enter') {
        finish(visible[index])
        return
      }
      if (key.name === 'up' || (key.ctrl === true && key.name === 'p')) index = Math.max(0, index - 1)
      else if (key.name === 'down' || (key.ctrl === true && key.name === 'n')) index = Math.min(visible.length - 1, index + 1)
      else if (key.name === 'pageup') index = Math.max(0, index - maxVisible)
      else if (key.name === 'pagedown') index = Math.min(visible.length - 1, index + maxVisible)
      else if (key.name === 'backspace') {
        query = query.slice(0, -1)
        index = 0
        offset = 0
      } else if (filterable && str !== undefined && str.length === 1 && str >= ' ' && key.ctrl !== true && key.meta !== true) {
        query += str
        index = 0
        offset = 0
      } else {
        return
      }
      render()
    }

    emitKeypressEvents(stdin)
    if (stdin.setRawMode !== undefined) stdin.setRawMode(true)
    stdin.resume()
    stdin.on('keypress', onKey)
    stdout.write('\u001B[?25l')
    render()
  })
}

/**
 * Ask for a choice as a numbered list on the normal terminal flow.
 *
 * Used when the input is not a TTY for the widget, or when the caller already
 * owns a readline interface and cannot hand the terminal over.
 * @param options - items, labelling, and the question function.
 * @param options.ask - resolves with the user's answer line.
 * @returns the chosen item, or undefined when cancelled or unmatched.
 */
export async function selectOneNumbered({ items, title = 'Select', label = (item) => String(item), describe = () => '', ask }) {
  if (items.length === 0) return undefined
  const lines = [style.bold(title)]
  items.forEach((item, i) => {
    const hint = describe(item)
    lines.push(`  ${style.cyan(String(i + 1).padStart(2))}  ${label(item)}${hint === '' ? '' : style.gray(`  ${hint}`)}`)
  })
  process.stdout.write(`${lines.join('\n')}\n`)
  const answer = (await ask(style.gray('number, or Enter to cancel › '))).trim()
  if (answer === '') return undefined
  if (!/^\d+$/.test(answer)) return undefined
  return items[Number(answer) - 1]
}

/**
 * Choose a working directory, preferring the native dialog.
 * @param options - the directory to start from and whether a dialog is allowed.
 * @returns the chosen directory, or undefined when cancelled.
 */
export async function pickDirectory({ from = process.cwd(), env = process.env, allowNative = true, allowTerminal = true, ask } = {}) {
  if (allowNative) {
    const native = await nativeFolderDialog({ title: 'Select the working directory for dshcli', startIn: from, env })
    if (typeof native === 'string') return native
    if (native?.selftest === true) return { selftest: true }
  }
  if (!allowTerminal) return undefined
  const candidates = pickerCandidates(from, env)
  const chosen = await selectOneNumbered({
    items: candidates,
    title: 'Select a working directory',
    label: (candidate) => candidate.dir,
    describe: (candidate) => candidate.reason,
    ask,
  })
  return chosen?.dir
}

/**
 * Confirm that a directory exists, for picker callers.
 * @param path - candidate path.
 * @returns true when the directory exists.
 */
export function directoryExists(path) {
  return existsSync(path) && isDirectory(path)
}

export { runCapture }
