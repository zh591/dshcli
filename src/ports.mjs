/**
 * Choosing a listen port for a launched server.
 *
 * A terminal has no port picker, and a port that was free yesterday is often
 * taken today — by a previous run that did not exit, by another checkout, or by
 * something unrelated. Rather than failing, `dshcli` walks a bounded window of
 * candidates and starts on the first one that is actually free, then says which
 * port it used so the printed URL is never a surprise.
 *
 * The walk is deliberately shallow: ten consecutive ports, then the same ten a
 * thousand higher, then it gives up loudly. An unbounded search would silently
 * move a server somewhere the user is not looking.
 *
 * @module dshcli/ports
 */

import { createServer } from 'node:net'

/** Ports tried consecutively before the stride is applied. */
export const PORT_WINDOW = 10

/** How far the window jumps after a full window is taken. */
export const PORT_STRIDE = 1000

/** How many windows are tried before giving up. */
export const PORT_ROUNDS = 2

/**
 * Ask the operating system whether a port can be bound.
 * @param port - the candidate port.
 * @param host - the address the server will bind.
 * @returns true when the port could be bound and was released again.
 */
function isFree(port, host) {
  return new Promise((resolveResult) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', () => {
      probe.close()
      resolveResult(false)
    })
    probe.once('listening', () => {
      probe.close(() => resolveResult(true))
    })
    try {
      probe.listen({ port, host, exclusive: true })
    } catch {
      resolveResult(false)
    }
  })
}

/**
 * Candidate ports in the order they are tried.
 * @param options - the starting port and the window shape.
 * @returns the ordered candidate list.
 */
export function portCandidates({
  start,
  window = PORT_WINDOW,
  stride = PORT_STRIDE,
  rounds = PORT_ROUNDS,
} = {}) {
  const candidates = []
  for (let round = 0; round < rounds; round += 1) {
    for (let offset = 0; offset < window; offset += 1) {
      candidates.push(start + round * stride + offset)
    }
  }
  return candidates
}

/**
 * Find the first free port in the candidate window.
 *
 * Port `0` means "let the operating system choose" and is passed through
 * untouched, since there is nothing to collide with.
 * @param options - the starting port, bind host, and window shape.
 * @returns the chosen port, whether it replaced the requested one, and what was tried.
 * @throws when every candidate is taken.
 */
export async function findFreePort({
  start,
  host = '127.0.0.1',
  window = PORT_WINDOW,
  stride = PORT_STRIDE,
  rounds = PORT_ROUNDS,
  probe = isFree,
} = {}) {
  if (start === 0) return { port: 0, replaced: false, tried: [] }

  const tried = []
  for (const port of portCandidates({ start, window, stride, rounds })) {
    if (await probe(port, host)) {
      return { port, replaced: port !== start, tried }
    }
    tried.push(port)
  }

  throw new Error(
    `every port in the search window is taken, so the server cannot start.\n`
    + `  tried: ${tried.join(', ')}\n`
    + '  free one of them, or pass --port <n> to start the search somewhere else.',
  )
}
