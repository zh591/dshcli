/**
 * Headless page capture over the Chrome DevTools Protocol.
 *
 * The one-shot `--screenshot` flag cannot authenticate and cannot capture a
 * page that keeps a socket open — it waits for network idle that never comes.
 * Driving DevTools instead lets dshcli install cookies before navigating,
 * decide for itself when the page has settled, and read the raster back from
 * `Page.captureScreenshot`, so a live application behind a session cookie is
 * captured exactly like a static page.
 *
 * Only `node:child_process`, `node:fs`, the global `fetch`, and the global
 * `WebSocket` are used, so dshcli keeps zero runtime dependencies.
 *
 * @module dshcli/browser
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** How long to wait for the browser's DevTools endpoint to appear. */
const DEVTOOLS_STARTUP_MS = 20_000

/** Time added after the load event so first paint and async data settle. */
const DEFAULT_SETTLE_MS = 2_500

/** Longest wait for the load event before capturing anyway. */
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000

/**
 * Candidate Chromium executables for this platform.
 * @param env - environment holding ProgramFiles and LOCALAPPDATA.
 * @returns absolute candidate paths in probe order.
 */
function browserCandidates(env = process.env) {
  const candidates = []
  if (process.platform === 'win32') {
    for (const root of [env['ProgramFiles'], env['ProgramFiles(x86)'], env.LOCALAPPDATA]) {
      if (typeof root !== 'string' || root === '') continue
      candidates.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
      candidates.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium')
  } else {
    for (const dir of (env.PATH ?? '').split(':')) {
      if (dir === '') continue
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
        candidates.push(join(dir, name))
      }
    }
  }
  return candidates
}

/**
 * Locate a Chromium-family browser to drive.
 * @param options - an explicit override plus the environment to probe.
 * @returns the browser executable path and how it was found.
 * @throws when no browser exists, naming the override flag.
 */
export function findBrowser({ explicit, env = process.env } = {}) {
  if (typeof explicit === 'string' && explicit !== '') return { path: explicit, source: '--browser' }
  for (const candidate of browserCandidates(env)) {
    try {
      if (statSync(candidate).isFile()) return { path: candidate, source: 'auto-detected' }
    } catch {
      // Not present; try the next candidate.
    }
  }
  throw new Error(
    'dshcli: no Chromium-family browser found for page capture.\n'
    + '  Install Chrome or Edge, or pass --browser <path-to-browser>.',
  )
}

/**
 * Turn a user-supplied target into a URL the browser can load.
 * @param target - an http(s) URL, a file URL, or a filesystem path.
 * @returns the resolved URL.
 */
export function toTargetUrl(target) {
  if (/^(?:https?|file):\/\//i.test(target)) return target
  return `file:///${target.replace(/\\/g, '/').replace(/^\//, '')}`
}

/**
 * Parse the `name=value` prefix of one `Set-Cookie` header.
 * @param header - a raw `Set-Cookie` header value.
 * @returns the cookie pair, or undefined when the header is unusable.
 */
function parseSetCookie(header) {
  const pair = header.split(';', 1)[0]
  const equals = pair.indexOf('=')
  if (equals <= 0) return undefined
  return { name: pair.slice(0, equals).trim(), value: pair.slice(equals + 1).trim() }
}

/**
 * Exchange a token-bearing URL for the cookies the page sets.
 *
 * `dsh web` prints an authenticated URL whose `token` query parameter is
 * exchanged once for a session cookie through a redirect. Harvesting that
 * cookie here is what lets `dshcli verify-frontend "<printed url>"` review the
 * real application rather than the authentication notice.
 * @param url - the target URL, possibly carrying a token.
 * @param options - extra cookies supplied by the caller.
 * @returns the harvested cookies plus the cookies the caller provided.
 */
export async function harvestCookies(url, { extra = [] } = {}) {
  const cookies = []
  for (const pair of extra) {
    const parsed = parseSetCookie(pair)
    if (parsed !== undefined) cookies.push(parsed)
  }

  if (!/^https?:/i.test(url)) return cookies

  try {
    const response = await fetch(url, { redirect: 'manual', headers: { accept: 'text/html' } })
    for (const header of response.headers.getSetCookie?.() ?? []) {
      const parsed = parseSetCookie(header)
      if (parsed !== undefined) cookies.push(parsed)
    }
  } catch {
    // An unreachable probe is not fatal: the browser reports the real failure
    // with a visible error page, which is itself a useful verification result.
  }
  return cookies
}

/**
 * One DevTools session over a page target's WebSocket.
 */
class DevToolsSession {
  #socket
  #nextId = 1
  #pending = new Map()
  #listeners = new Map()
  #closed = false

  /**
   * @param socket - an open WebSocket to a page target.
   */
  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', (message) => this.#receive(message.data))
  }

  /**
   * Connect to the first page target a browser exposes.
   * @param port - the DevTools HTTP port.
   * @returns the connected session.
   * @throws when the browser exposes no page target or the socket fails.
   */
  static async connect(port) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = Array.isArray(targets) ? targets.find((target) => target.type === 'page') : undefined
    if (page?.webSocketDebuggerUrl === undefined) throw new Error('the browser exposed no page target')
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('the DevTools socket failed to open')), { once: true })
    })
    return new DevToolsSession(socket)
  }

  /**
   * Send one DevTools command.
   * @param method - the DevTools method name.
   * @param params - the command parameters.
   * @returns the command result, or the error object the browser reported.
   */
  send(method, params = {}) {
    if (this.#closed) return Promise.resolve({ error: 'session closed' })
    const id = this.#nextId++
    return new Promise((resolve) => {
      this.#pending.set(id, resolve)
      this.#socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * Resolve when one DevTools event arrives, or when the timeout expires.
   * @param method - the event name to await.
   * @param timeoutMs - maximum wait.
   * @returns true when the event arrived.
   */
  waitForEvent(method, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#listeners.delete(method)
        resolve(false)
      }, timeoutMs)
      const bucket = this.#listeners.get(method) ?? []
      bucket.push(() => {
        clearTimeout(timer)
        resolve(true)
      })
      this.#listeners.set(method, bucket)
    })
  }

  /**
   * Collect events matching a method as they arrive.
   * @param method - the event name to collect.
   * @param into - the array that receives each event's params.
   * @returns nothing.
   */
  collect(method, into) {
    const bucket = this.#listeners.get(method) ?? []
    bucket.push((params) => into.push(params))
    this.#listeners.set(method, bucket)
  }

  /**
   * Route one inbound frame to a pending command or a listener.
   * @param raw - the raw frame text.
   * @returns nothing.
   */
  #receive(raw) {
    let frame
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    if (frame.id !== undefined) {
      this.#pending.get(frame.id)?.(frame.result ?? frame)
      this.#pending.delete(frame.id)
      return
    }
    for (const listener of this.#listeners.get(frame.method) ?? []) listener(frame.params)
  }

  /** Detach the socket. */
  close() {
    this.#closed = true
    this.#pending.clear()
    try {
      this.#socket.close()
    } catch {
      // The socket may already be down; nothing left to release.
    }
  }
}

/**
 * Launch a browser with DevTools enabled and wait for its port.
 * @param options - browser path, window size, and profile directory.
 * @returns the child process, the DevTools port, and the profile directory.
 * @throws when the browser never reports a port.
 */
async function launch({ browserPath, width, height }) {
  const profileDir = mkdtempSync(join(tmpdir(), 'dshcli-cdp-'))
  const child = spawn(browserPath, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--mute-audio',
    `--window-size=${width},${height}`,
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })

  const portFile = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + DEVTOOLS_STARTUP_MS
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const first = readFileSync(portFile, 'utf8').split('\n')[0]?.trim()
      if (/^\d+$/.test(first)) return { child, port: Number(first), profileDir }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  child.kill()
  throw new Error(`the browser reported no DevTools port within ${DEVTOOLS_STARTUP_MS} ms`)
}

/**
 * Result of one page capture.
 * @typedef {object} CaptureResult
 * @property {string} path - where the PNG was written.
 * @property {number} bytes - the PNG size.
 * @property {string} url - the URL that was loaded.
 * @property {string} title - the document title the page reported.
 * @property {string[]} consoleErrors - error-level console and log entries.
 */

/**
 * Load a URL in a headless browser and write a PNG of the settled viewport.
 * @param options - target, viewport, cookies, and timing controls.
 * @returns the capture result.
 * @throws when the browser cannot start or the page yields no raster.
 */
export async function capturePage({
  url,
  out,
  width = 1280,
  height = 800,
  cookies = [],
  settleMs = DEFAULT_SETTLE_MS,
  navigationTimeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS,
  browser,
  env = process.env,
}) {
  const resolved = findBrowser({ explicit: browser, env })
  mkdirSync(dirname(out), { recursive: true })

  const { child, port, profileDir } = await launch({ browserPath: resolved.path, width, height })
  let session
  try {
    session = await DevToolsSession.connect(port)

    const consoleErrors = []
    await session.send('Page.enable')
    await session.send('Network.enable')
    await session.send('Runtime.enable')
    await session.send('Log.enable')
    await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    session.collect('Runtime.consoleAPICalled', consoleErrors)
    session.collect('Log.entryAdded', consoleErrors)

    const hostname = new URL(url).hostname
    for (const cookie of cookies) {
      await session.send('Network.setCookie', {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain ?? hostname,
        path: cookie.path ?? '/',
        url: cookie.domain === undefined ? url : undefined,
      })
    }

    const loaded = session.waitForEvent('Page.loadEventFired', navigationTimeoutMs)
    await session.send('Page.navigate', { url })
    await loaded
    await new Promise((resolve) => setTimeout(resolve, settleMs))

    const titleResult = await session.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
    const shot = await session.send('Page.captureScreenshot', { format: 'png' })
    if (typeof shot?.data !== 'string') {
      throw new Error(`the browser returned no raster for ${url}`)
    }
    const bytes = Buffer.from(shot.data, 'base64')
    writeFileSync(out, bytes)

    return {
      path: out,
      bytes: bytes.byteLength,
      url,
      title: typeof titleResult?.result?.value === 'string' ? titleResult.result.value : '',
      consoleErrors: consoleErrors.map(describeConsoleEntry).filter((entry) => entry !== undefined),
      browser: resolved.path,
    }
  } finally {
    session?.close()
    child.kill()
    try {
      rmSync(profileDir, { recursive: true, force: true })
    } catch {
      // A leftover temporary profile is harmless.
    }
  }
}

/**
 * Flatten one console or log entry into a short line, keeping errors only.
 * @param entry - a `Runtime.consoleAPICalled` or `Log.entryAdded` payload.
 * @returns a description, or undefined for a non-error entry.
 */
function describeConsoleEntry(entry) {
  if (entry?.args !== undefined) {
    if (entry.type !== 'error' && entry.type !== 'assert') return undefined
    const text = entry.args.map((arg) => arg.value ?? arg.description ?? arg.type ?? '').join(' ')
    return `console.${entry.type}: ${text.slice(0, 300)}`
  }
  if (entry?.entry !== undefined) {
    if (entry.entry.level !== 'error') return undefined
    return `${entry.entry.source}: ${String(entry.entry.text ?? '').slice(0, 300)}`
  }
  return undefined
}
