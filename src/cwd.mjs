/**
 * Working-directory selection.
 *
 * A terminal has no directory picker, so dshcli resolves the session working
 * directory from explicit intent first and heuristics second, and always
 * reports which rule won. The resolved directory becomes the SDK
 * `initialize.cwd`, which the harness records on the session header and renders
 * into the model's persona suffix.
 *
 * Precedence, highest first:
 *   1. `--cwd <dir>`            an explicit path
 *   2. `$DSHCLI_CWD`            a per-shell default
 *   3. `--last`                 the directory of the previous dshcli session
 *   4. `--here`                 the shell's own directory, unchanged
 *   5. project-root detection   the nearest ancestor holding a project marker
 *   6. the shell's directory
 *
 * @module dshcli/cwd
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'

/**
 * Markers of a repository or workspace root. These outrank the project-file
 * markers below, so opening dshcli inside one package of a monorepo still
 * selects the monorepo rather than that single package.
 */
export const WORKSPACE_MARKERS = [
  '.git',
  '.hg',
  '.svn',
  'pnpm-workspace.yaml',
  'lerna.json',
  'rush.json',
  'go.work',
]

/**
 * Markers of a standalone project directory, used when no enclosing repository
 * or workspace root exists.
 */
export const PROJECT_MARKERS = [
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
  'CMakeLists.txt',
  'Makefile',
  'composer.json',
  'Gemfile',
  'build.gradle',
  'build.gradle.kts',
]

/** Where the previous session's directory is remembered. */
const STATE_FILENAME = 'dshcli-state.json'

/**
 * Resolve the dshcli state file path.
 * @param env - environment holding DSH_HOME or HOME.
 * @returns the absolute state file path.
 */
export function statePath(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME !== ''
    ? env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, STATE_FILENAME)
}

/**
 * Read the remembered state, tolerating a missing or unreadable file.
 * @param env - environment holding DSH_HOME.
 * @returns the parsed state, or an empty object.
 */
export function readState(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(env), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Remember values across invocations, ignoring write failures.
 *
 * A read-only home directory must not fail a session, so a failed write is
 * swallowed deliberately.
 * @param patch - values to merge into the stored state.
 * @param env - environment holding DSH_HOME.
 * @returns nothing.
 */
export function writeState(patch, env = process.env) {
  try {
    const path = statePath(env)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ ...readState(env), ...patch }, null, 2)}\n`)
  } catch {
    // A session without remembered state is still a complete session.
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
 * Find the directory dshcli should treat as the project root.
 *
 * The walk ascends from `start`. A repository or workspace marker at any
 * ancestor wins immediately — it is the outermost meaningful boundary, and it
 * is why opening one package of a monorepo selects the monorepo. Only when no
 * such marker exists anywhere above does the nearest standalone project marker
 * decide.
 * @param start - absolute directory to begin the walk from.
 * @returns the chosen root, the marker that identified it, and which tier won.
 */
export function detectProjectRoot(start) {
  let current = resolve(start)
  const root = parse(current).root
  let nearestProject

  for (;;) {
    for (const marker of WORKSPACE_MARKERS) {
      if (exists(join(current, marker))) {
        return { dir: current, marker, kind: 'workspace' }
      }
    }
    if (nearestProject === undefined) {
      for (const marker of PROJECT_MARKERS) {
        if (exists(join(current, marker))) {
          nearestProject = { dir: current, marker, kind: 'project' }
          break
        }
      }
    }
    if (current === root) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  return nearestProject
}

/**
 * Test whether a path exists as either a file or a directory.
 * @param path - candidate path.
 * @returns true when the path exists.
 */
function exists(path) {
  return isDirectory(path) || isFileish(path)
}

/**
 * Test whether a path exists as a file.
 * @param path - candidate path.
 * @returns true when the path names a regular file.
 */
function isFileish(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Directories offered by the interactive picker.
 *
 * The shell's directory comes first so pressing Enter keeps the default, then
 * its subdirectories, then its parent, then a few conventional roots. Entries
 * that do not exist are dropped.
 * @param from - the shell's directory.
 * @param env - environment used to locate conventional roots.
 * @returns candidate directories paired with the reason each is offered.
 */
export function pickerCandidates(from, env = process.env) {
  const cwd = resolve(from)
  const seen = new Set()
  const out = []
  const add = (dir, reason) => {
    if (typeof dir !== 'string' || dir === '') return
    const absolute = resolve(dir)
    if (seen.has(absolute) || !isDirectory(absolute)) return
    seen.add(absolute)
    out.push({ dir: absolute, reason })
  }

  add(cwd, 'current directory')
  let children = []
  try {
    children = readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 12)
  } catch {
    children = []
  }
  for (const name of children) add(join(cwd, name), 'subdirectory')

  const parent = dirname(cwd)
  if (parent !== cwd) add(parent, 'parent directory')

  add(homedir(), 'home')
  if (typeof env.DSH_HOME === 'string') add(env.DSH_HOME, 'DSH_HOME')
  if (process.platform === 'win32') {
    for (const letter of 'CDEFG') add(`${letter}:\\`, 'drive root')
  }

  const remembered = readState(env).lastCwd
  if (typeof remembered === 'string') add(remembered, 'last dshcli session')

  return out
}

/**
 * Resolve the working directory for this invocation.
 * @param options - the flags that constrain the choice plus the environment.
 * @returns the chosen directory, the rule that chose it, and a detail string.
 * @throws when an explicit directory is missing or is not a directory.
 */
export function selectWorkingDirectory({
  cwd,
  here = false,
  last = false,
  from = process.cwd(),
  env = process.env,
} = {}) {
  if (typeof cwd === 'string' && cwd !== '') {
    const absolute = resolve(from, cwd)
    if (!isDirectory(absolute)) {
      throw new Error(`dshcli: --cwd ${JSON.stringify(cwd)} is not an existing directory (resolved to ${absolute})`)
    }
    return { dir: absolute, source: '--cwd', detail: 'explicit path' }
  }

  const fromEnv = env.DSHCLI_CWD
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    const absolute = resolve(from, fromEnv)
    if (!isDirectory(absolute)) {
      throw new Error(`dshcli: DSHCLI_CWD ${JSON.stringify(fromEnv)} is not an existing directory (resolved to ${absolute})`)
    }
    return { dir: absolute, source: 'DSHCLI_CWD', detail: 'environment default' }
  }

  if (last) {
    const remembered = readState(env).lastCwd
    if (typeof remembered === 'string' && isDirectory(remembered)) {
      return { dir: remembered, source: '--last', detail: 'previous dshcli session' }
    }
    return { dir: resolve(from), source: 'cwd', detail: 'no remembered session; shell directory' }
  }

  if (here) return { dir: resolve(from), source: '--here', detail: 'shell directory' }

  const detected = detectProjectRoot(from)
  if (detected !== undefined) {
    const label = detected.kind === 'workspace' ? 'workspace root' : 'project root'
    const where = detected.dir === resolve(from) ? 'current directory' : 'nearest ancestor'
    return { dir: detected.dir, source: label, detail: `${where} with ${detected.marker}` }
  }
  return { dir: resolve(from), source: 'cwd', detail: 'no project marker found' }
}
