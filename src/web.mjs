/**
 * One-command launch of the harness's browser frontend.
 *
 * `dshcli` is a terminal client, but the browser UI is still the original
 * product surface and sometimes the right tool — a rich diff, a file tree, a
 * session picker. This module boots that same surface (`dsh --profile web`)
 * using the launcher, and surfaces the authenticated URL the launcher prints so
 * it can be opened, copied, or forwarded over SSH.
 *
 * The web profile runs against whichever harness home the caller selected, so a
 * browser instance started here stays independent of any other running one.
 *
 * @module dshcli/web
 */

import { spawn } from 'node:child_process'

/** Matches the `dsh web: <url>` line the web app prints once it is serving. */
const URL_LINE = /dsh web:\s*(https?:\/\/\S+)/

/**
 * Boot the web profile and report its URL.
 *
 * The returned handle settles when the child exits, so the caller decides
 * whether to wait for it (the `web` command) or keep working while it serves
 * (the `/web` session command). {@link stopWeb} ends it deliberately.
 * @param options - launcher, home, route flags, and output callbacks.
 * @returns a handle with the exit promise, the child pid, and a stop function.
 */
export function runWeb({
  launcherEntry,
  env = process.env,
  cwd,
  port,
  host,
  open = true,
  onUrl = () => {},
  onOutput = () => {},
  onError = () => {},
}) {
  const args = [launcherEntry, '--profile', 'web']
  if (port !== undefined) args.push('--port', String(port))
  if (host !== undefined) args.push('--host', host)
  if (open !== true) args.push('--no-open')

  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let buffered = ''
  const scan = (chunk) => {
    buffered += chunk
    let index
    while ((index = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, index)
      buffered = buffered.slice(index + 1)
      const match = URL_LINE.exec(line)
      if (match !== null) onUrl(match[1])
      else if (line.trim() !== '') onOutput(line)
    }
  }

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => scan(String(chunk)))
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk)
    const match = URL_LINE.exec(text)
    if (match !== null) onUrl(match[1])
    else onError(text)
  })

  // The forwarded signal stops the profile from a plain Ctrl+C at the shell.
  // A session that owns the handle stops it directly instead.
  let stopped = false

  /**
   * Ask the web profile to exit.
   * @param signal - the signal to send.
   * @returns nothing.
   */
  function stop(signal = 'SIGTERM') {
    if (stopped) return
    stopped = true
    try {
      child.kill(signal)
    } catch {
      // The child is already gone; the exit handler has run or is about to.
    }
  }

  const onSigint = () => stop('SIGINT')
  const onSigterm = () => stop('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  const done = new Promise((resolve) => {
    const settle = (result) => {
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
      resolve(result)
    }
    child.once('error', (error) => settle({ code: null, error }))
    child.once('exit', (code, signal) => settle({ code, signal }))
  })

  return { done, stop, pid: child.pid }
}
