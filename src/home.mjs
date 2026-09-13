/**
 * Harness home selection.
 *
 * dshcli runs the harness against its own home directory by default, so its
 * sessions, profiles, and storages never mix with a browser install that is
 * already running from `~/.dsh`. Isolation keeps two independent runtimes
 * usable side by side.
 *
 * Configuration is the exception: on first use the new home's `settings.yaml`
 * and home patch layer are seeded from the source home, so the isolated runtime
 * starts with the same model routes, providers, and permission preset the user
 * already configured. Sessions are never copied.
 *
 * @module dshcli/home
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Directory name dshcli creates under the user's home by default. */
export const DEFAULT_HOME_DIRNAME = '.dsh'

/** Directory name of the isolated home. */
export const ISOLATED_HOME_DIRNAME = '.dshcli'

/** `--home` values that mean "reuse the source home instead of isolating". */
const SHARED_ALIASES = new Set(['shared', 'inherit', 'default', 'source'])

/** Files copied into a fresh isolated home so its runtime is configured. */
const SEED_FILES = ['settings.yaml', 'cordis.patch.yml']

/**
 * The harness home an unisolated run would use.
 * @param env - environment holding DSH_HOME.
 * @returns the absolute source home path.
 */
export function sourceHome(env = process.env) {
  const value = env.DSH_HOME
  if (typeof value === 'string' && value !== '') return resolve(value)
  return join(homedir(), DEFAULT_HOME_DIRNAME)
}

/**
 * Resolve which harness home this invocation should use.
 * @param options - the `--home` value and the environment.
 * @returns the chosen home, how it was chosen, and whether it is isolated.
 */
export function resolveHome({ explicit, env = process.env } = {}) {
  const fromFlag = typeof explicit === 'string' && explicit !== '' ? explicit : undefined
  const fromEnv = typeof env.DSHCLI_HOME === 'string' && env.DSHCLI_HOME !== '' ? env.DSHCLI_HOME : undefined
  const requested = fromFlag ?? fromEnv

  if (requested !== undefined && SHARED_ALIASES.has(requested.toLowerCase())) {
    return { dir: sourceHome(env), source: fromFlag !== undefined ? '--home' : 'DSHCLI_HOME', isolated: false }
  }
  if (requested !== undefined) {
    return {
      dir: resolve(requested),
      source: fromFlag !== undefined ? '--home' : 'DSHCLI_HOME',
      isolated: true,
    }
  }
  return { dir: join(homedir(), ISOLATED_HOME_DIRNAME), source: 'default', isolated: true }
}

/**
 * Create the home directory and seed configuration on first use.
 *
 * Seeding only ever fills gaps: an existing `settings.yaml` is never
 * overwritten, so edits made inside the isolated home survive every later run.
 * @param options - target home, the home to copy configuration from, and seed policy.
 * @returns what was created and which files were seeded.
 */
export function ensureHome({ dir, seedFrom, noSeed = false }) {
  const created = !existsSync(dir)
  mkdirSync(dir, { recursive: true })

  const seeded = []
  const skipped = []
  if (!noSeed && typeof seedFrom === 'string' && resolve(seedFrom) !== resolve(dir) && existsSync(seedFrom)) {
    for (const name of SEED_FILES) {
      const target = join(dir, name)
      const source = join(seedFrom, name)
      if (existsSync(target) || !existsSync(source)) continue
      try {
        copyFileSync(source, target)
        seeded.push(name)
      } catch {
        // A configuration file that cannot be copied is reported, not fatal:
        // the harness still boots with its built-in defaults.
        skipped.push(name)
      }
    }
  }
  return { created, seeded, skipped }
}

/**
 * Count the sessions already recorded in a home, for diagnostics.
 * @param dir - the harness home.
 * @returns the number of session directories, or 0 when none exist.
 */
export function countSessions(dir) {
  const sessions = join(dir, 'sessions')
  if (!existsSync(sessions)) return 0
  try {
    return readdirSync(sessions).length
  } catch {
    return 0
  }
}
