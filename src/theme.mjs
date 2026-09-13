/**
 * Terminal styling for dshcli.
 *
 * Colour is opt-out at three levels, in precedence order: the `--no-color`
 * flag, the `NO_COLOR` environment variable, and the TTY check on the target
 * stream. Every helper degrades to the bare string, so callers never branch on
 * whether colour is enabled.
 *
 * @module dshcli/theme
 */

/** Whether ANSI styling may be emitted at all. */
let enabled = false

/**
 * Decide once whether styling is allowed.
 * @param options - stream to test plus the `--no-color` flag.
 * @returns nothing; later calls read the decision through {@link style}.
 */
export function configureTheme({ stream = process.stdout, noColor = false, force } = {}) {
  const noColorEnv = typeof process.env.NO_COLOR === 'string' && process.env.NO_COLOR !== ''
  enabled = force === true || (!noColor && !noColorEnv && stream?.isTTY === true)
}

/**
 * Wrap text in an SGR sequence when styling is enabled.
 * @param code - the SGR parameter list, for example `'1;36'`.
 * @param text - the text to wrap.
 * @returns the wrapped text, or `text` unchanged when styling is off.
 */
export function sgr(code, text) {
  return enabled ? `\u001B[${code}m${text}\u001B[0m` : text
}

/** Style helpers; each returns its input unchanged when colour is disabled. */
export const style = {
  get enabled() {
    return enabled
  },
  dim: (t) => sgr('2', t),
  bold: (t) => sgr('1', t),
  italic: (t) => sgr('3', t),
  underline: (t) => sgr('4', t),
  red: (t) => sgr('31', t),
  green: (t) => sgr('32', t),
  yellow: (t) => sgr('33', t),
  blue: (t) => sgr('34', t),
  magenta: (t) => sgr('35', t),
  cyan: (t) => sgr('36', t),
  gray: (t) => sgr('90', t),
  brightCyan: (t) => sgr('96', t),
  brightGreen: (t) => sgr('92', t),
  brightYellow: (t) => sgr('93', t),
  brightRed: (t) => sgr('91', t),
}

/**
 * Strip ANSI escape sequences, for measuring and for non-TTY sinks.
 * @param text - text that may contain SGR sequences.
 * @returns the text with escapes removed.
 */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex -- matching the escape we emit is the point
  return text.replace(/\u001B\[[0-9;]*m/g, '')
}

/**
 * Visible length of a string, ignoring SGR sequences.
 * @param text - the string to measure.
 * @returns its printable width in characters.
 */
export function visibleLength(text) {
  return stripAnsi(text).length
}
