/**
 * The harness runtime dshcli drives.
 *
 * One `dsh --profile <name>` child process serves one JSON-RPC session over
 * stdio. dshcli owns that child's lifetime: it initialises the process-wide
 * route, submits prompts on a session, and shuts the child down. The harness
 * exposes no cancel method, so aborting a running turn means ending the child —
 * {@link Runtime.abort} does exactly that and reports that the session cannot
 * be resumed afterwards.
 *
 * @module dshcli/runtime
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { JsonRpcLineTransport } from './rpc.mjs'

/** Grace period between the polite end-of-stdin shutdown and a forced kill. */
const SHUTDOWN_GRACE_MS = 8_000

/** Grace period between SIGTERM and SIGKILL when aborting a running turn. */
const ABORT_GRACE_MS = 3_000

/**
 * One supervised `dsh` SDK runtime.
 */
export class Runtime {
  #child
  #transport
  #exitPromise
  #exitInfo
  #onEvent
  #onStatus
  #onStderr
  #onExit
  #turnEndWaiters = []
  #initialized = false

  /**
   * @param options - child handle plus the callbacks it feeds.
   */
  constructor({ child, onEvent, onStatus, onStderr, onExit }) {
    this.#child = child
    this.#onEvent = onEvent ?? (() => {})
    this.#onStatus = onStatus ?? (() => {})
    this.#onStderr = onStderr ?? (() => {})
    this.#onExit = onExit ?? (() => {})
    this.#transport = new JsonRpcLineTransport({
      stdin: child.stdin,
      stdout: child.stdout,
      onNotification: (method, params) => this.#handleNotification(method, params),
      onProtocolError: (error, line) => {
        this.#onStderr(`dshcli: ignoring malformed frame from the runtime: ${error.message}\n  ${line.slice(0, 200)}\n`)
      },
    })

    this.#exitPromise = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        const info = { code, signal }
        this.#exitInfo = info
        this.#transport.close(`the dsh runtime exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`)
        for (const waiter of this.#turnEndWaiters.splice(0)) waiter({ kind: 'runtime-exit' })
        this.#onExit(info)
        resolve(info)
      })
    })
  }

  /**
   * Start one `dsh --profile <name>` runtime and complete the SDK handshake.
   * @param options - launcher entry, profile, route, and cwd for the child.
   * @returns the initialised runtime.
   * @throws when the child cannot spawn or the handshake fails.
   */
  static async start({
    launcherEntry,
    profile = 'sdk',
    cwd,
    provider,
    model,
    reasoningEffort,
    maxTokens,
    env = process.env,
    onEvent,
    onStatus,
    onStderr,
    onExit,
  }) {
    const child = spawn(process.execPath, [launcherEntry, '--profile', profile], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let spawnFailure = null
    child.once('error', (error) => {
      spawnFailure = error
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => (onStderr ?? (() => {}))(chunk))

    const runtime = new Runtime({ child, onEvent, onStatus, onStderr, onExit })
    if (spawnFailure !== null) throw spawnFailure
    runtime.#transport.start()

    const params = { cwd, provider, model }
    if (reasoningEffort !== undefined && reasoningEffort !== '') params.reasoningEffort = reasoningEffort
    if (typeof maxTokens === 'number') params.maxTokens = maxTokens

    try {
      runtime.#serverInfo = await runtime.#transport.request('initialize', params)
    } catch (error) {
      runtime.#transport.close('initialisation failed')
      child.kill()
      throw new Error(`dshcli: could not initialise the dsh runtime: ${error.message}`)
    }
    runtime.#initialized = true
    return runtime
  }

  /** Handshake result reported by the runtime. */
  #serverInfo = undefined

  /** Server identity returned by `initialize`. */
  get serverInfo() {
    return this.#serverInfo
  }

  /** The child process id. */
  get pid() {
    return this.#child.pid
  }

  /** Whether the child has exited. */
  get exited() {
    return this.#exitInfo !== undefined
  }

  /** The child's exit facts once it has exited. */
  get exitInfo() {
    return this.#exitInfo
  }

  /** Resolves with the child's exit facts. */
  get exit() {
    return this.#exitPromise
  }

  /**
   * Create a fresh session id for this dshcli conversation.
   * @returns a unique id suitable for `session/prompt`.
   */
  static newSessionId() {
    return `dshcli-${randomUUID()}`
  }

  /**
   * Submit one user turn.
   * @param sessionId - the session to append the message to; an unknown id creates the pair.
   * @param contentBlocks - prompt blocks, including encoded images.
   * @returns the durable enqueue receipt.
   */
  async prompt(sessionId, contentBlocks) {
    return this.#transport.request('session/prompt', { sessionId, contentBlocks })
  }

  /**
   * Await the end of the turn currently running.
   * @returns the turn-end reason, or a synthetic marker when the runtime exited first.
   */
  waitForTurnEnd() {
    return new Promise((resolve) => {
      if (this.#exitInfo !== undefined) {
        resolve({ kind: 'runtime-exit' })
        return
      }
      this.#turnEndWaiters.push(resolve)
    })
  }

  /**
   * End the child politely: close stdin, then kill if it outlives the grace.
   * @returns the child's exit facts.
   */
  async shutdown() {
    if (this.#exitInfo !== undefined) return this.#exitInfo
    try {
      if (this.#initialized) await this.#transport.request('shutdown', undefined)
    } catch {
      // A shutdown that never answers is exactly what the forced kill covers.
    }
    this.#transport.close('shutdown requested')
    try {
      this.#child.stdin.end()
    } catch {
      // The pipe may already be gone; the exit wait below still settles.
    }
    const timer = setTimeout(() => this.#kill(), SHUTDOWN_GRACE_MS)
    timer.unref?.()
    const info = await this.#exitPromise
    clearTimeout(timer)
    return info
  }

  /**
   * Terminate the runtime because a turn must be cancelled.
   *
   * The SDK protocol has no cancel method: a client abandons a turn by closing
   * the runtime process, and the harness drains its agents before exit.
   * @returns the child's exit facts.
   */
  async abort() {
    if (this.#exitInfo !== undefined) return this.#exitInfo
    this.#transport.close('the turn was aborted')
    this.#child.kill('SIGTERM')
    const timer = setTimeout(() => this.#kill(), ABORT_GRACE_MS)
    timer.unref?.()
    const info = await this.#exitPromise
    clearTimeout(timer)
    return info
  }

  /**
   * Force the child down after a grace period.
   * @returns nothing.
   */
  #kill() {
    try {
      this.#child.kill('SIGKILL')
    } catch {
      // Already gone: the exit promise has settled or is about to.
    }
  }

  /**
   * Route one server notification to the caller's surfaces.
   * @param method - the notification method name.
   * @param params - the notification payload.
   * @returns nothing.
   */
  #handleNotification(method, params) {
    if (method === 'session.event') {
      this.#onEvent(params?.event, params)
      if (params?.event?.type === 'turn/end') {
        for (const waiter of this.#turnEndWaiters.splice(0)) waiter(params.event.data?.reason ?? { kind: 'completed' })
      }
      return
    }
    if (method === 'session.status') {
      this.#onStatus(params?.status, params)
      return
    }
    if (method === 'subagent.started') {
      this.#onEvent({ type: 'dshcli/subagent-started', data: params }, params)
      return
    }
    if (method === 'subagent.finished') {
      this.#onEvent({ type: 'dshcli/subagent-finished', data: params }, params)
    }
  }
}
