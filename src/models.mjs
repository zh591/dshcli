/**
 * The model catalog.
 *
 * A switchable model is only useful if the user can see what is switchable, so
 * dshcli reads the harness's own settings file and presents the providers and
 * models the runtime will actually accept. `js-yaml` is resolved from the dsh
 * installation — the launcher already depends on it — which keeps dshcli's own
 * dependency list empty. When the settings file is absent or unreadable, the
 * catalog falls back to the models the DeepSeek provider ships with.
 *
 * The catalog is also the only authority allowed to produce a model id. A
 * provider accepts ids and rejects display names, so every caller that turns
 * user input into a route goes through {@link resolveModel}; nothing else may
 * hand a raw string to the runtime.
 *
 * @module dshcli/models
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Settings filename inside a harness home. */
const SETTINGS_FILENAME = 'settings.yaml'

/** Provider id the built-in models belong to. */
export const BUILTIN_PROVIDER = 'deepseek-official'

/**
 * Models the `deepseek-official` provider serves, used when no settings file
 * describes a catalog. Verified against `GET /v1/models`, which lists exactly
 * these two ids; retired ids such as `deepseek-v4-flash` are aliased to
 * `deepseek-flash` by the provider and are deliberately not offered here.
 */
export const BUILTIN_MODELS = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek-V4-Flash',
    description: 'Fast, efficient, and economical; suited to focused, routine, or parallel tasks.',
    contextWindow: 1_000_000,
    vision: true,
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
    contextWindow: 1_000_000,
    vision: false,
  },
]

/** Model id used when neither settings nor the catalog name a default. */
export const FALLBACK_MODEL = 'deepseek-flash'

/** Reasoning efforts the SDK accepts, in increasing order of spend. */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'max']

/**
 * Load the YAML reader from the harness installation.
 * @param launcherEntry - absolute path of the dsh launcher entry.
 * @returns the `load` function, or undefined when it cannot be resolved.
 */
function loadYamlReader(launcherEntry) {
  try {
    const require = createRequire(launcherEntry)
    const yaml = require('js-yaml')
    return typeof yaml?.load === 'function' ? yaml.load : undefined
  } catch {
    return undefined
  }
}

/**
 * Read and parse a home's settings file.
 * @param home - the harness home directory.
 * @param launcherEntry - the launcher used to resolve the YAML reader.
 * @returns the parsed settings object, or undefined.
 */
function readSettings(home, launcherEntry) {
  const path = join(home, SETTINGS_FILENAME)
  if (!existsSync(path)) return undefined
  const load = loadYamlReader(launcherEntry)
  if (load === undefined) return undefined
  try {
    const parsed = load(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Normalise one model entry from the settings catalog.
 * @param provider - the provider the model belongs to.
 * @param raw - the raw YAML entry.
 * @returns the normalised model, or undefined when it has no usable id.
 */
function normalizeModel(provider, raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : undefined
  if (id === undefined) return undefined
  const modalities = Array.isArray(raw.inputModalities) ? raw.inputModalities : raw.input
  return {
    provider,
    id,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : id,
    description: typeof raw.description === 'string' ? raw.description : '',
    contextWindow: typeof raw.contextWindow === 'number' ? raw.contextWindow : undefined,
    vision: Array.isArray(modalities) ? modalities.includes('image') : false,
  }
}

/**
 * Build the catalog of providers and models this home can run.
 * @param options - the harness home and the launcher used to read the settings.
 * @returns the catalog, its provider configuration, and where it came from.
 */
export function loadCatalog({ home, launcherEntry }) {
  const settingsPath = join(home, SETTINGS_FILENAME)
  const settings = readSettings(home, launcherEntry)
  const block = settings?.['llm-deepseek']
  const providers = block?.providers

  const models = []
  const providerConfig = {}
  if (providers !== null && typeof providers === 'object') {
    for (const [provider, config] of Object.entries(providers)) {
      if (config !== null && typeof config === 'object') {
        providerConfig[provider] = {
          apiKeyEnv: typeof config.apiKeyEnv === 'string' ? config.apiKeyEnv : undefined,
          baseURL: typeof config.baseURL === 'string' ? config.baseURL : undefined,
          api: typeof config.api === 'string' ? config.api : undefined,
        }
      }
      const list = Array.isArray(config?.models) ? config.models : []
      for (const raw of list) {
        const model = normalizeModel(provider, raw)
        if (model !== undefined) models.push(model)
      }
    }
  }

  const requestedDefault = settings?.['agent-default-model']
  const defaultModel = requestedDefault !== null && typeof requestedDefault === 'object' && typeof requestedDefault.model === 'string'
    ? {
        provider: typeof requestedDefault.provider === 'string' ? requestedDefault.provider : BUILTIN_PROVIDER,
        model: requestedDefault.model,
        reasoningEffort: requestedDefault.reasoningEffort,
      }
    : undefined

  if (models.length > 0) {
    return { models, providerConfig, defaultModel, source: settingsPath, settingsPresent: true }
  }

  return {
    models: BUILTIN_MODELS.map((model) => ({ ...model, provider: BUILTIN_PROVIDER })),
    providerConfig: {
      [BUILTIN_PROVIDER]: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com/v1', api: 'deepseek' },
    },
    defaultModel,
    source: settings === undefined ? 'built-in defaults' : `${settingsPath} (no model catalog)`,
    settingsPresent: settings !== undefined,
  }
}

/**
 * Describe one model for a menu line.
 * @param model - a catalog entry.
 * @returns a short hint string.
 */
export function describeModel(model) {
  const parts = []
  if (model.vision) parts.push('vision')
  if (typeof model.contextWindow === 'number') parts.push(`${Math.round(model.contextWindow / 1000)}k ctx`)
  return parts.join(' · ')
}

/**
 * Find a catalog entry by id.
 * @param catalog - the catalog returned by {@link loadCatalog}.
 * @param id - the model id to find.
 * @param provider - optional provider to disambiguate.
 * @returns the matching model, or undefined.
 */
export function findModel(catalog, id, provider) {
  return catalog.models.find((model) => model.id === id && (provider === undefined || model.provider === provider))
}

/**
 * The default route this catalog should start on.
 *
 * The home's `agent-default-model` wins; otherwise the first catalog entry; and
 * only when the catalog is empty does the built-in fallback apply.
 * @param catalog - the catalog returned by {@link loadCatalog}.
 * @returns the provider and model id to initialise the runtime with.
 */
export function defaultRoute(catalog) {
  if (catalog.defaultModel !== undefined) {
    const resolved = resolveModel(catalog, catalog.defaultModel.model, catalog.defaultModel.provider)
    if (resolved !== undefined) return { provider: resolved.provider, id: resolved.id }
  }
  const first = catalog.models[0]
  if (first !== undefined) return { provider: first.provider, id: first.id }
  return { provider: BUILTIN_PROVIDER, id: FALLBACK_MODEL }
}

/**
 * Turn user input into a route the provider will accept.
 *
 * A provider rejects a display name where an id is required, so input is
 * matched against everything a user can reasonably copy out of `dshcli models`:
 * the bare id, `provider/id`, and the display name. Matching is case-insensitive
 * after an exact pass, so `deepseek-v4-pro` and `DeepSeek-V4-Pro` both resolve
 * to the id `deepseek-v4-pro`.
 * @param catalog - the catalog returned by {@link loadCatalog}.
 * @param input - what the user typed.
 * @param providerHint - a provider to prefer when the input names only a model.
 * @returns the canonical `{ provider, id, model }`, or undefined when unmatched.
 */
export function resolveModel(catalog, input, providerHint) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw === '') return undefined

  const slash = raw.indexOf('/')
  const asProvider = slash > 0 ? raw.slice(0, slash).trim() : undefined
  const asName = slash > 0 ? raw.slice(slash + 1).trim() : raw

  const matches = (needle) => {
    const exact = catalog.models.filter((model) => model.id === needle || model.name === needle)
    if (exact.length > 0) return exact
    const lower = needle.toLowerCase()
    return catalog.models.filter((model) => model.id.toLowerCase() === lower || model.name.toLowerCase() === lower)
  }

  let candidates = matches(asName)
  if (candidates.length === 0) candidates = matches(raw)
  if (candidates.length === 0) return undefined

  if (asProvider !== undefined) {
    const byProvider = candidates.find((model) => model.provider === asProvider)
    if (byProvider !== undefined) return { provider: byProvider.provider, id: byProvider.id, model: byProvider }
  }
  if (providerHint !== undefined) {
    const preferred = candidates.find((model) => model.provider === providerHint)
    if (preferred !== undefined) return { provider: preferred.provider, id: preferred.id, model: preferred }
  }
  return { provider: candidates[0].provider, id: candidates[0].id, model: candidates[0] }
}

/**
 * The ids a user could pass, for an error message.
 * @param catalog - the catalog returned by {@link loadCatalog}.
 * @returns a comma-separated list of ids.
 */
export function listModelIds(catalog) {
  return catalog.models.map((model) => model.id).join(', ')
}

/**
 * Ask the provider which model ids it currently serves.
 *
 * Retired ids may keep working through provider-side aliases, so this is
 * advisory: it is how a catalog written before a retirement gets noticed.
 * @param options - provider name, its configuration, and the environment.
 * @returns the live ids, or an error description.
 */
export async function fetchLiveModels({ provider, providerConfig, env = process.env }) {
  const config = providerConfig?.[provider] ?? {}
  const baseURL = config.baseURL ?? 'https://api.deepseek.com/v1'
  const keyEnv = config.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
  const apiKey = env[keyEnv]
  if (typeof apiKey !== 'string' || apiKey === '') {
    return { error: `${keyEnv} is not set, so the live model list cannot be read` }
  }
  try {
    const response = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) return { error: `the provider answered HTTP ${response.status}` }
    const body = await response.json()
    const ids = Array.isArray(body?.data)
      ? body.data.map((entry) => (typeof entry?.id === 'string' ? entry.id : undefined)).filter((id) => id !== undefined)
      : []
    return { ids, baseURL }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
