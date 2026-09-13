/**
 * Command-line surface for dshcli.
 *
 * The parser is hand-written so dshcli keeps zero runtime dependencies and so
 * unknown flags fail loudly instead of being silently dropped. It splits argv
 * into a command, its positional operands, and a flag map; every command
 * validates its own operands afterwards.
 *
 * @module dshcli/args
 */

/** Commands dshcli accepts, with the operand arity each expects. */
export const COMMANDS = {
  chat: { operands: 0, summary: 'interactive terminal session (default)' },
  run: { operands: -1, summary: 'run one task, print the final answer, and exit' },
  web: { operands: 0, summary: 'launch the harness browser frontend and print its URL' },
  models: { operands: 0, summary: 'list the models this harness home can run' },
  'verify-frontend': { operands: 1, summary: 'screenshot a frontend and have a vision model review it' },
  dir: { operands: 0, summary: 'print the working directory dshcli would use, then exit' },
  home: { operands: 0, summary: 'show the harness home, and whether it is isolated' },
  doctor: { operands: 0, summary: 'report the environment dshcli resolves' },
  help: { operands: 0, summary: 'print this help' },
}

/** Flags that take a value; every other `--flag` is boolean. */
const VALUE_FLAGS = new Set([
  'cwd',
  'home',
  'profile',
  'dsh',
  'provider',
  'model',
  'effort',
  'width',
  'port',
  'host',
  'vision-model',
  'shot',
  'browser',
  'viewport',
  'max-tokens',
  'cookie',
  'settle',
])
/** Value flags that accumulate instead of overwriting. */
const REPEATABLE_FLAGS = new Set(['cookie'])

/**
 * Boolean flags. A `no-` prefix negates one of these, so `--no-color` and
 * `--no-reasoning` resolve to the bare names below.
 */
const BOOLEAN_FLAGS = new Set([
  'here',
  'last',
  'pick',
  'dialog',
  'seed',
  'live',
  'open',
  'reasoning',
  'verbose',
  'color',
  'json',
  'help',
  'version',
])

/** Single-character aliases. */
const SHORT_FLAGS = {
  C: 'cwd',
  H: 'home',
  h: 'help',
  V: 'version',
}

/**
 * Parse argv into a command, operands, and flags.
 * @param argv - arguments after the node binary and script.
 * @returns the parsed invocation.
 * @throws when a value flag has no value.
 */
export function parseArgs(argv) {
  const flags = {}
  const operands = []
  let command

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (token === '--') {
      operands.push(...argv.slice(index + 1))
      break
    }

    if (token.startsWith('--')) {
      const body = token.slice(2)
      const equals = body.indexOf('=')
      const rawName = equals >= 0 ? body.slice(0, equals) : body
      const name = rawName.startsWith('no-') ? rawName.slice(3) : rawName
      const negated = rawName.startsWith('no-')
      if (VALUE_FLAGS.has(name)) {
        let value = equals >= 0 ? body.slice(equals + 1) : undefined
        if (value === undefined) {
          value = argv[index + 1]
          index += 1
        }
        if (value === undefined) throw new Error(`dshcli: --${rawName} needs a value`)
        if (REPEATABLE_FLAGS.has(name)) flags[name] = [...(flags[name] ?? []), value]
        else flags[name] = value
      } else if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = !negated
      } else {
        throw new Error(`dshcli: unknown flag --${rawName} (see: dshcli help)`)
      }
      continue
    }

    if (token.startsWith('-') && token.length > 1) {
      const letters = token.slice(1)
      for (let position = 0; position < letters.length; position += 1) {
        const letter = letters[position]
        const name = SHORT_FLAGS[letter]
        if (name === undefined) throw new Error(`dshcli: unknown flag -${letter}`)
        if (!VALUE_FLAGS.has(name)) {
          flags[name] = true
          continue
        }
        // A value-taking short flag consumes the rest of the token (`-C/tmp`)
        // or the next argument (`-C /tmp`), and ends the cluster.
        let value = letters.slice(position + 1)
        if (value === '') {
          value = argv[index + 1]
          index += 1
        }
        if (value === undefined) throw new Error(`dshcli: -${letter} needs a value`)
        if (REPEATABLE_FLAGS.has(name)) flags[name] = [...(flags[name] ?? []), value]
        else flags[name] = value
        break
      }
      continue
    }

    if (command === undefined && Object.hasOwn(COMMANDS, token)) command = token
    else operands.push(token)
  }

  if (flags.help === true && command === undefined) command = 'help'
  return { command: command ?? 'chat', operands, flags }
}

/**
 * Render the top-level help text.
 * @param version - the dshcli version string.
 * @returns the help text.
 */
export function helpText(version) {
  const commands = Object.entries(COMMANDS)
    .map(([name, spec]) => `  ${name.padEnd(17)}${spec.summary}`)
    .join('\n')
  return `dshcli ${version} — DeepSeek Harness in your terminal

Usage:
  dshcli [command] [options]

Commands:
${commands}

Harness home (session state never mixes with a browser install):
  -H, --home <dir>       harness home to use
                         "shared" reuses $DSH_HOME instead of isolating   [~/.dshcli]
      --home             (the new home's settings.yaml is seeded from $DSH_HOME once)
      --no-seed          skip seeding the new home's configuration

Working directory (first rule that applies wins):
  -C, --cwd <dir>        use this directory
      --here             use the shell's directory, unchanged
      --last             reuse the directory of the previous dshcli session
      --pick             choose a directory in a folder dialog (falls back to a list)
      --no-dialog        never open a GUI dialog; pick in the terminal
      (default)          enclosing repository or workspace root (.git, pnpm-workspace.yaml, ...),
                         else the nearest project marker (package.json, Cargo.toml, ...)

Runtime:
      --dsh <path>       the dsh launcher to spawn (lib/bin.js, a package directory, or a shim)
      --profile <name>   the dsh profile to boot                      [sdk]
      --provider <id>    provider route                    [the home's configured default]
      --model <id>       model on that route, by id or display name
      --effort <id>      reasoning effort for the route               [route default]
      --max-tokens <n>   cap each model output

  --model is resolved against the harness home's own catalog, so a display name
  works and an unknown name is refused before the first turn.  Run
  "dshcli models" to see the ids, or "dshcli models --live" to compare them
  with what the provider serves today.

Display:
      --no-reasoning     hide reasoning blocks
      --verbose          echo every session event
      --width <n>        wrap width                                 [terminal width]
      --no-color         disable ANSI styling
      --json             machine-readable output where supported
  -h, --help             print this help
  -V, --version          print the dshcli version

web options:
      --port <n>         first port to try                                   [3080]
      --host <host>      bind host                                 [127.0.0.1]
      --no-open          print the URL without opening a browser

  A taken port is not an error: the next ten ports are tried, then the same ten
  a thousand higher, and only then does it fail. Pass --port 0 to let the
  operating system pick one outright. The in-session "/web" command runs the
  same search.

models options:
      --live             also ask the provider which ids it serves now

verify-frontend options:
      --vision-model <id>  vision route for the review   [the catalog's vision model]
      --shot <path>        where to write the screenshot
      --browser <path>     Chromium executable to drive
      --viewport <WxH>     viewport size                            [1280x800]
      --cookie <n=v>       session cookie to install before loading (repeatable)
      --settle <ms>        extra wait after the load event           [2500]

  A target carrying a "token" query parameter — the URL "dsh web" prints — is
  exchanged automatically for the session cookie before the page loads.

Inside a session, type / to list every command, or /help for the same list.
"/web" starts the browser frontend without leaving the session; "/web stop" ends
it.

Examples:
  dshcli                                   open a session in the detected project root
  dshcli --here                            open a session in the shell's directory
  dshcli --model deepseek-v4-pro           open a session on another model
  dshcli models                            list the configured models
  dshcli run "run the tests and fix failures"
  dshcli web                               launch the browser frontend alongside
  dshcli verify-frontend http://127.0.0.1:27390/ --shot ui.png
  dshcli --home shared                     reuse the existing browser install's home
`
}
