/**
 * The slash-command table.
 *
 * One table drives three surfaces — the inline suggestion menu, `/help`, and
 * the dispatcher — so a command can never be listed without being handled, or
 * handled without being listed.
 *
 * @module dshcli/commands
 */

/**
 * @typedef {object} SlashCommand
 * @property {string} name - the word typed after `/`.
 * @property {string} args - argument hint shown beside the name.
 * @property {string} summary - one line describing what it does.
 * @property {string[]} aliases - alternative names.
 */

/** Every command the session accepts, in menu order. */
export const SLASH_COMMANDS = [
  { name: 'help', args: '', summary: 'list every command', aliases: ['?'] },
  { name: 'cd', args: '[dir]', summary: 'change the working directory (opens a folder dialog without an argument)', aliases: [] },
  { name: 'pick', args: '', summary: 'choose the working directory from a folder dialog', aliases: ['browse'] },
  { name: 'web', args: '[start|stop|status]', summary: 'start the browser frontend alongside this session', aliases: [] },
  { name: 'pwd', args: '', summary: 'print the working directory', aliases: ['cwd'] },
  { name: 'model', args: '[id]', summary: 'show or switch the model', aliases: [] },
  { name: 'models', args: '', summary: 'list the models this home can run', aliases: [] },
  { name: 'effort', args: '[id]', summary: 'show or switch the reasoning effort', aliases: ['reasoning-effort'] },
  { name: 'new', args: '', summary: 'start a new session on the same settings', aliases: ['reset'] },
  { name: 'reasoning', args: '', summary: 'show or hide reasoning blocks', aliases: [] },
  { name: 'status', args: '', summary: 'show launcher, home, profile, and session details', aliases: ['info'] },
  { name: 'home', args: '[dir]', summary: 'show the harness home, or switch to an isolated one', aliases: [] },
  { name: 'abort', args: '', summary: 'stop the running turn (ends the runtime process)', aliases: ['stop'] },
  { name: 'clear', args: '', summary: 'clear the screen', aliases: ['cls'] },
  { name: 'exit', args: '', summary: 'quit dshcli', aliases: ['quit', 'q'] },
]

/**
 * Render a command as it should be typed.
 * @param command - a table entry.
 * @returns the invocation string, for example `/model [id]`.
 */
export function invocationOf(command) {
  return `/${command.name}${command.args === '' ? '' : ` ${command.args}`}`
}

/**
 * Find the table entry a typed name resolves to.
 * @param name - the word typed after `/`.
 * @returns the matching command, or undefined.
 */
export function findCommand(name) {
  const needle = name.toLowerCase()
  return SLASH_COMMANDS.find((command) => command.name === needle || command.aliases.includes(needle))
}

/**
 * Commands whose name or summary matches what the user has typed so far.
 * @param input - the text after `/`, possibly empty.
 * @returns matching commands, best match first.
 */
export function suggestCommands(input) {
  const needle = input.trim().toLowerCase()
  if (needle === '') return [...SLASH_COMMANDS]
  const starts = SLASH_COMMANDS.filter((command) => command.name.startsWith(needle))
  const contains = SLASH_COMMANDS.filter(
    (command) => !command.name.startsWith(needle) && `${command.name} ${command.aliases.join(' ')} ${command.summary}`.toLowerCase().includes(needle),
  )
  return [...starts, ...contains]
}

/**
 * The command completing a partially typed name, when exactly one matches.
 * @param input - the text after `/`.
 * @returns the completed name, or undefined when completion is ambiguous.
 */
export function completeCommandName(input) {
  const needle = input.trim().toLowerCase()
  if (needle === '') return undefined
  const matches = SLASH_COMMANDS.filter((command) => command.name.startsWith(needle))
  return matches.length === 1 ? matches[0].name : undefined
}
