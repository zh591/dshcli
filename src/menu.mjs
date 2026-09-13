/**
 * The inline slash-command suggestion menu.
 *
 * Typing `/` at an empty prompt lists every command with its description
 * underneath, narrowing as the name is typed. The menu is drawn *below* the
 * prompt line and the cursor is returned to the prompt, which requires
 * cooperating with readline rather than replacing it.
 *
 * Three ordering facts make that possible:
 *
 * 1. This module's `keypress` listener is registered before readline's (it
 *    calls `emitKeypressEvents` itself first), so it runs *before* readline
 *    handles the key and can erase the menu over the still-intact prompt line.
 *    That is what keeps a stale menu from surviving a submitted command.
 * 2. readline's key handling is synchronous, so a `setImmediate` scheduled from
 *    that listener runs after readline has refreshed `rl.line` and its display.
 * 3. The cursor is only ever moved by exact, mirrored amounts. Drawing moves
 *    down N rows and back up N; erasing moves the cursor not at all.
 *
 * That third point is the whole design. An earlier version erased by walking
 * down, clearing each row while stepping back up, then moving up N — which
 * lands N-1 rows above the prompt. Every later write then happened on the wrong
 * row and destroyed the conversation above it. Erasing with `ESC[J` (clear from
 * the cursor to the end of the screen) needs no row arithmetic, cannot drift,
 * and is safe after the terminal has scrolled: the menu is always the only
 * content below the prompt.
 *
 * @module dshcli/menu
 */

import { suggestCommands, invocationOf } from './commands.mjs'
import { style, stripAnsi, visibleLength } from './theme.mjs'

/** Rows reserved for the prompt and the surrounding scrollback. */
const RESERVED_ROWS = 6

/** Smallest command list drawn, even on a very short terminal. */
const MIN_ROWS = 5

/** Erase every character from the cursor to the end of the screen. */
const ERASE_BELOW = '\u001B[J'

/**
 * Clip one rendered row to the terminal width.
 * @param text - styled row text.
 * @param width - printable columns available.
 * @returns the row, possibly truncated with an ellipsis.
 */
function clipRow(text, width) {
  if (visibleLength(text) <= width) return text
  // Truncate on the plain text, then re-style the kept prefix so no escape
  // sequence is ever cut in half.
  const plain = stripAnsi(text)
  return `${plain.slice(0, Math.max(0, width - 1))}…`
}

/**
 * Renders and erases the command suggestion menu under a readline prompt.
 */
export class InlineMenu {
  #rl
  #stdout
  #rows
  #drawn = 0
  #lastRows = null
  #active = true
  #keypressHandler
  #stdin

  /**
   * @param options - the readline interface, its streams, and an optional row cap.
   */
  constructor({ rl, stdin = process.stdin, stdout = process.stdout, rows }) {
    this.#rl = rl
    this.#stdin = stdin
    this.#stdout = stdout
    this.#rows = rows

    // Register before readline so this listener runs first on every key.
    this.#keypressHandler = () => {
      if (this.#drawn > 0) this.#erase()
      // readline handles the key synchronously after this returns.
      setImmediate(() => this.refresh())
    }
    stdin.on('keypress', this.#keypressHandler)
  }

  /** Whether the menu currently occupies rows on screen. */
  get visible() {
    return this.#drawn > 0
  }

  /** Whether {@link dispose} has run. */
  get disposed() {
    return !this.#active
  }

  /**
   * The text after `/` when the line is a bare command being typed.
   * @returns the partial name, or undefined when the menu should stay hidden.
   */
  #partialName() {
    const line = this.#rl.line ?? ''
    const match = /^\/([A-Za-z-]*)$/.exec(line)
    return match === null ? undefined : match[1]
  }

  /**
   * Whether the prompt line still occupies exactly one screen row.
   *
   * Every cursor move here is column-only, so a wrapped prompt line would put
   * the menu on the wrong row. Refusing to draw is the safe answer.
   * @returns true when the prompt line fits on one row.
   */
  #promptFits() {
    const prefix = stripAnsi(this.#rl.getPrompt?.() ?? '')
    const line = this.#rl.line ?? ''
    return visibleLength(prefix) + line.length < (this.#stdout.columns ?? 100)
  }

  /**
   * Redraw the menu for the current line.
   * @returns nothing.
   */
  refresh() {
    if (this.#stdout.isTTY !== true || this.#rl.closed === true) {
      this.#drawn = 0
      return
    }

    const partial = this.#partialName()
    const rows = partial === undefined || !this.#promptFits() ? [] : this.#render(partial)
    const unchanged = this.#lastRows !== null
      && rows.length === this.#lastRows.length
      && rows.every((row, index) => row === this.#lastRows[index])
    if (unchanged) return

    if (this.#drawn > 0) this.#erase()
    this.#lastRows = rows
    if (rows.length === 0) return

    this.#stdout.write(`\n${rows.join('\n')}`)
    this.#stdout.write(`\u001B[${rows.length}A`)
    this.#restoreCursor()
    this.#drawn = rows.length
  }

  /**
   * Build the menu rows for a partial command name.
   * @param partial - the text typed after `/`.
   * @returns the rendered rows, already clipped to the terminal width.
   */
  #render(partial) {
    const width = this.#stdout.columns ?? 100
    // The whole list is shown whenever the terminal is tall enough for it; a
    // short terminal truncates rather than scrolling the prompt off-screen.
    const available = this.#rows ?? Math.max(MIN_ROWS, (this.#stdout.rows ?? 24) - RESERVED_ROWS)
    const suggestions = suggestCommands(partial)
    const shown = suggestions.slice(0, available)
    if (shown.length === 0) return []

    // Measured on the rendered invocation, which includes the leading slash;
    // measuring name + args alone left the longest entry one column wider than
    // every other row.
    const nameWidth = Math.min(
      18,
      Math.max(...shown.map((command) => invocationOf(command).length)),
    )
    const rows = shown.map((command) => clipRow(
      `  ${style.cyan(invocationOf(command).padEnd(nameWidth))}  ${style.gray(command.summary)}`,
      width,
    ))
    const hidden = suggestions.length - shown.length
    if (hidden > 0) rows.push(clipRow(style.gray(`  ... ${hidden} more, keep typing to narrow`), width))
    return rows
  }

  /**
   * Remove the menu from the screen.
   *
   * The cursor already sits on the prompt line at the end of the typed text, so
   * clearing to the end of the screen removes exactly the menu rows and moves
   * the cursor nowhere.
   * @returns nothing.
   */
  #erase() {
    if (this.#drawn === 0) return
    this.#stdout.write(ERASE_BELOW)
    this.#drawn = 0
  }

  /**
   * Erase the menu on behalf of a caller that is about to print.
   *
   * Output arriving while the menu is visible — a background turn finishing
   * mid-typing — would otherwise interleave with the menu rows.
   * @returns nothing.
   */
  hide() {
    if (this.#drawn === 0) return
    this.#erase()
    this.#lastRows = null
  }

  /**
   * Forget the drawn menu because something cleared the screen.
   *
   * Writing here would clear rows that now hold other content.
   * @returns nothing.
   */
  forget() {
    this.#drawn = 0
    this.#lastRows = null
  }

  /**
   * Put the cursor back at the end of the typed text on the prompt line.
   * @returns nothing.
   */
  #restoreCursor() {
    const prefix = stripAnsi(this.#rl.getPrompt?.() ?? '')
    this.#stdout.write(`\r\u001B[${visibleLength(prefix) + (this.#rl.cursor ?? 0) + 1}G`)
  }

  /**
   * Clear the menu and detach from the input stream.
   * @returns nothing.
   */
  dispose() {
    if (this.#drawn > 0) this.#erase()
    this.#stdin.off('keypress', this.#keypressHandler)
    this.#active = false
  }
}

/**
 * A readline-completer that completes slash-command names on Tab.
 * @param line - the current line.
 * @returns the completion candidates and the token being completed.
 */
export function slashCompleter(line) {
  const match = /(^|\s)(\/[A-Za-z-]*)$/.exec(line)
  if (match === null) return [[], line]
  const partial = match[2].slice(1)
  const hits = suggestCommands(partial).map((command) => `/${command.name}`)
  return [hits.length > 0 ? hits : [], match[2]]
}

export { clipRow, ERASE_BELOW }
