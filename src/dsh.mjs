/**
 * Locating the `dsh` launcher.
 *
 * dshcli never boots the harness itself; it starts `dsh --profile <name>` as a
 * child process and speaks the SDK stdio protocol to it. That keeps one
 * application-launch path (the `dsh` launcher owns profile boot and process
 * exit) and makes dshcli work against any dsh installation — npm global, a
 * source checkout, or an explicit path.
 *
 * The launcher's published entry is `lib/bin.js` next to its `package.json`.
 * On Windows npm also writes `dsh.cmd` shims whose body names that file, so the
 * shim is parsed rather than executed through a shell (shell-wrapped stdio
 * would corrupt the newline-delimited JSON-RPC framing).
 *
 * @module dshcli/dsh
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

/** Relative path from an installed `@deepseek-ai/dsh` package to its launcher entry. */
const LAUNCHER_ENTRY = join('lib', 'bin.js')

/** Package directory name of the launcher inside a `node_modules` tree. */
const LAUNCHER_PACKAGE = join('@deepseek-ai', 'dsh')

/**
 * Test whether a path is an existing regular file.
 * @param path - candidate path.
 * @returns true when the path names a file.
 */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

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
 * Extract the launcher entry a Windows npm shim runs.
 *
 * The shim names `node_modules\@deepseek-ai\dsh\lib\bin.js` relative to its own
 * directory through `%~dp0`. Only the first `.js` literal is considered, which
 * is the script the shim passes to node.
 * @param shimPath - absolute path of a `.cmd` or `.bat` shim.
 * @returns the absolute launcher entry, or undefined when the shim names none.
 */
function launcherFromShim(shimPath) {
  let body
  try {
    body = readFileSync(shimPath, 'utf8')
  } catch {
    return undefined
  }
  const match = body.match(/"([^"]*\.(?:js|mjs|cjs))"/i)
  if (match === null) return undefined
  const named = match[1].replace(/%dp0%|%~dp0/gi, dirname(shimPath))
  const candidate = isAbsolute(named) ? named : resolve(dirname(shimPath), named)
  return isFile(candidate) ? candidate : undefined
}

/**
 * Interpret one user-supplied `--dsh` value.
 * @param value - a launcher entry, an installed package directory, or a shim.
 * @returns the resolved launcher entry, or undefined when nothing matched.
 */
function launcherFromExplicit(value) {
  const path = resolve(value)
  if (isFile(path)) {
    if (/\.(?:js|mjs|cjs)$/i.test(path)) return path
    if (/\.(?:cmd|bat)$/i.test(path)) return launcherFromShim(path)
    return undefined
  }
  if (isDirectory(path)) {
    const direct = join(path, LAUNCHER_ENTRY)
    if (isFile(direct)) return direct
    const nested = join(path, LAUNCHER_PACKAGE, LAUNCHER_ENTRY)
    if (isFile(nested)) return nested
  }
  return undefined
}

/**
 * Read the launcher version from the package manifest beside an entry file.
 * @param entry - absolute path of `lib/bin.js`.
 * @returns the version string, or undefined when it cannot be read.
 */
export function launcherVersion(entry) {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Candidate launcher entries from a PATH scan.
 * @param env - environment holding PATH.
 * @returns candidate entry paths in probe order.
 */
function launcherCandidatesFromPath(env) {
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', '.ps1', ''] : ['']
  const candidates = []
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    for (const extension of extensions) {
      const shim = join(dir, `dsh${extension}`)
      if (!isFile(shim)) continue
      if (extension === '.cmd' || extension === '.bat') {
        const entry = launcherFromShim(shim)
        if (entry !== undefined) candidates.push(entry)
      } else if (extension === '') {
        // A POSIX shell shim is a symlink to lib/bin.js.
        const entry = resolve(shim)
        if (isFile(entry) && /\.(?:js|mjs|cjs)$/i.test(entry)) candidates.push(entry)
      }
    }
  }
  return candidates
}

/**
 * Candidate launcher entries from the global npm layouts of every platform.
 * @param env - environment holding APPDATA, npm_config_prefix, and HOME.
 * @returns candidate entry paths in probe order.
 */
function launcherCandidatesFromGlobalRoots(env) {
  const roots = []
  const push = (root) => {
    if (typeof root === 'string' && root !== '') roots.push(root)
  }

  if (process.platform === 'win32') {
    push(env.APPDATA ? join(env.APPDATA, 'npm', 'node_modules') : undefined)
    push(env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'npm', 'node_modules') : undefined)
  }
  push(env.npm_config_prefix ? join(env.npm_config_prefix, 'lib', 'node_modules') : undefined)
  push('/usr/local/lib/node_modules')
  push('/usr/lib/node_modules')
  push('/opt/homebrew/lib/node_modules')
  push(join(homedir(), '.npm-global', 'lib', 'node_modules'))
  push(join(homedir(), '.local', 'lib', 'node_modules'))

  const candidates = roots.map((root) => join(root, LAUNCHER_PACKAGE, LAUNCHER_ENTRY))
  if (isDirectory(join(homedir(), '.nvm', 'versions', 'node'))) {
    for (const version of readdirSync(join(homedir(), '.nvm', 'versions', 'node'))) {
      candidates.push(join(homedir(), '.nvm', 'versions', 'node', version, 'lib', 'node_modules', LAUNCHER_PACKAGE, LAUNCHER_ENTRY))
    }
  }
  return candidates
}

/**
 * Candidate launcher entries from the `npx` cache.
 *
 * `npx @deepseek-ai/dsh web` leaves one hashed directory per resolved install
 * under the npm cache; any of them is a usable launcher.
 * @param env - environment holding LOCALAPPDATA or HOME.
 * @returns candidate entry paths in probe order.
 */
function launcherCandidatesFromNpxCache(env) {
  const cacheRoot = process.platform === 'win32'
    ? (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'npm-cache', '_npx') : undefined)
    : join(homedir(), '.npm', '_npx')
  if (cacheRoot === undefined || !isDirectory(cacheRoot)) return []
  const candidates = []
  for (const hashed of readdirSync(cacheRoot)) {
    candidates.push(join(cacheRoot, hashed, 'node_modules', LAUNCHER_PACKAGE, LAUNCHER_ENTRY))
  }
  return candidates
}

/**
 * Resolve the dsh launcher entry this process should spawn.
 *
 * Probe order is explicit override, `$DSHCLI_DSH`, PATH, global npm roots, then
 * the npx cache. The first existing file wins, so an explicit or PATH-provided
 * installation always outranks a stale cache entry.
 * @param options - explicit override and the environment to probe.
 * @returns the launcher entry and a human-readable description of its origin.
 * @throws when no launcher exists, naming every location that was searched.
 */
export function resolveDshLauncher({ explicit, env = process.env } = {}) {
  const searched = []

  const consider = (candidate, source) => {
    if (candidate === undefined) return undefined
    searched.push(candidate)
    return isFile(candidate) ? { entry: candidate, source } : undefined
  }

  const fromFlag = explicit !== undefined && explicit !== ''
    ? launcherFromExplicit(explicit)
    : undefined
  if (fromFlag !== undefined) return { entry: fromFlag, source: `--dsh ${explicit}` }

  const fromEnv = env.DSHCLI_DSH
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    const resolved = launcherFromExplicit(fromEnv)
    if (resolved !== undefined) return { entry: resolved, source: 'DSHCLI_DSH' }
    searched.push(fromEnv)
  }

  for (const candidate of launcherCandidatesFromPath(env)) {
    const found = consider(candidate, 'PATH')
    if (found !== undefined) return found
  }
  for (const candidate of launcherCandidatesFromGlobalRoots(env)) {
    const found = consider(candidate, 'global npm')
    if (found !== undefined) return found
  }
  for (const candidate of launcherCandidatesFromNpxCache(env)) {
    const found = consider(candidate, 'npx cache')
    if (found !== undefined) return found
  }

  const unique = [...new Set(searched)]
  throw new Error(
    'dshcli: could not find the dsh launcher.\n'
    + '  Install it with:  npm install -g @deepseek-ai/dsh\n'
    + '  Or point at one:  dshcli --dsh <path-to>/lib/bin.js\n'
    + (unique.length > 0 ? `  Searched:\n${unique.map((p) => `    ${p}`).join('\n')}` : ''),
  )
}

/**
 * Report whether a path exists, for diagnostics.
 * @param path - candidate path.
 * @returns true when the path exists.
 */
export function pathExists(path) {
  return existsSync(path)
}
