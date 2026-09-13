/**
 * Newline-delimited JSON-RPC 2.0 transport.
 *
 * Mirrors the framing rules of `@deepseek-ai/dsh-sdk-protocol` so dshcli stays a
 * dependency-free client: one JSON-RPC message per `\n`-terminated line over
 * byte streams the caller owns. A frame carrying both `id` and `method` is a
 * request, `id` alone is a response, and `method` alone is a notification.
 * Malformed lines are surfaced to the caller rather than throwing, because a
 * stray stdout write must not take the session down.
 *
 * @module dshcli/rpc
 */

/** Error raised when the peer answers a request with a JSON-RPC error frame. */
export class JsonRpcResponseError extends Error {
  /**
   * @param code - the wire error code.
   * @param message - the wire error message.
   * @param data - optional structured error detail.
   */
  constructor(code, message, data) {
    super(`JSON-RPC error ${code}: ${message}`)
    this.name = 'JsonRpcResponseError'
    this.code = code
    this.data = data
  }
}

/** Error raised when the peer disconnects with requests still in flight. */
export class TransportClosedError extends Error {
  /**
   * @param message - why the transport closed.
   */
  constructor(message) {
    super(message)
    this.name = 'TransportClosedError'
  }
}

/**
 * JSON-RPC 2.0 over a pair of newline-framed text streams.
 */
export class JsonRpcLineTransport {
  #stdin
  #stdout
  #onNotification
  #onProtocolError
  #pending = new Map()
  #nextId = 1
  #buffer = ''
  #started = false
  #closed = false
  #onData
  #onEnd

  /**
   * @param options - the streams and handlers this transport drives.
   * @param options.stdin - writable stream that accepts outbound frames.
   * @param options.stdout - readable stream carrying inbound frames.
   * @param options.onNotification - receives `(method, params)` for every notification.
   * @param options.onProtocolError - receives `(error, line)` for unparseable frames.
   */
  constructor({ stdin, stdout, onNotification, onProtocolError }) {
    this.#stdin = stdin
    this.#stdout = stdout
    this.#onNotification = onNotification ?? (() => {})
    this.#onProtocolError = onProtocolError ?? (() => {})
  }

  /** Number of requests awaiting a response. */
  get pendingCount() {
    return this.#pending.size
  }

  /** Whether {@link close} has run. */
  get closed() {
    return this.#closed
  }

  /**
   * Attach stream listeners.
   * @returns nothing.
   */
  start() {
    if (this.#started || this.#closed) return
    this.#started = true
    this.#stdout.setEncoding('utf8')
    this.#onData = (chunk) => this.#ingest(chunk)
    this.#onEnd = () => this.close('the dsh runtime closed its stdout')
    this.#stdout.on('data', this.#onData)
    this.#stdout.on('end', this.#onEnd)
    this.#stdout.on('close', this.#onEnd)
  }

  /**
   * Send one request and await its result.
   * @param method - the JSON-RPC method name.
   * @param params - the request parameters, omitted from the frame when undefined.
   * @returns the result payload.
   * @throws {TransportClosedError} when the transport is already closed.
   * @throws {JsonRpcResponseError} when the peer answers with an error frame.
   */
  request(method, params) {
    if (this.#closed) return Promise.reject(new TransportClosedError(`cannot send ${method}: ${this.#closeReason}`))
    const id = this.#nextId++
    const frame = params === undefined
      ? { jsonrpc: '2.0', id, method }
      : { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method })
      this.#write(frame)
    })
  }

  /**
   * Detach listeners and fail every in-flight request.
   * @param reason - describes the closure to pending callers.
   * @returns nothing.
   */
  close(reason = 'the transport was closed') {
    if (this.#closed) return
    this.#closed = true
    this.#closeReason = reason
    if (this.#onData !== undefined) {
      this.#stdout.off('data', this.#onData)
      this.#stdout.off('end', this.#onEnd)
      this.#stdout.off('close', this.#onEnd)
    }
    for (const [, entry] of this.#pending) {
      entry.reject(new TransportClosedError(`request ${entry.method} failed: ${reason}`))
    }
    this.#pending.clear()
  }

  /** Why the transport closed; empty before it does. */
  #closeReason = ''

  /**
   * Append inbound text and dispatch every complete line.
   * @param chunk - decoded text from the peer.
   * @returns nothing.
   */
  #ingest(chunk) {
    this.#buffer += chunk
    let index
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (line === '') continue
      this.#dispatch(line)
    }
  }

  /**
   * Route one decoded frame.
   * @param line - one non-empty JSON-RPC line.
   * @returns nothing.
   */
  #dispatch(line) {
    let frame
    try {
      frame = JSON.parse(line)
    } catch (error) {
      this.#onProtocolError(error, line)
      return
    }
    if (frame === null || typeof frame !== 'object') {
      this.#onProtocolError(new Error('frame is not a JSON object'), line)
      return
    }
    if (frame.method !== undefined) {
      if (frame.id !== undefined) {
        this.#onProtocolError(new Error(`unsupported server-to-client request ${frame.method}`), line)
        return
      }
      this.#onNotification(frame.method, frame.params)
      return
    }
    if (frame.id === undefined) {
      this.#onProtocolError(new Error('frame carries neither method nor id'), line)
      return
    }
    const entry = this.#pending.get(frame.id)
    if (entry === undefined) return
    this.#pending.delete(frame.id)
    if (frame.error !== undefined && frame.error !== null) {
      entry.reject(new JsonRpcResponseError(frame.error.code, frame.error.message, frame.error.data))
    } else {
      entry.resolve(frame.result)
    }
  }

  /**
   * Serialise and write one frame.
   * @param frame - the JSON-RPC frame to send.
   * @returns nothing.
   */
  #write(frame) {
    try {
      this.#stdin.write(`${JSON.stringify(frame)}\n`)
    } catch (error) {
      this.close(`writing to the runtime failed: ${error.message}`)
    }
  }
}
