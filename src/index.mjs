/**
 * Programmatic surface of dshcli.
 *
 * The package is primarily a command-line tool, but the pieces that are useful
 * to embed — working-directory selection, the runtime supervisor, the renderer,
 * and the vision helpers — are re-exported here so a Node script can drive the
 * harness without shelling out to the CLI.
 *
 * @module dshcli
 */

export { resolveDshLauncher, launcherVersion } from './dsh.mjs'
export { selectWorkingDirectory, detectProjectRoot, pickerCandidates, readState, writeState } from './cwd.mjs'
export { resolveHome, sourceHome, ensureHome, countSessions, DEFAULT_HOME_DIRNAME, ISOLATED_HOME_DIRNAME } from './home.mjs'
export { loadCatalog, findModel, describeModel, BUILTIN_MODELS, REASONING_EFFORTS } from './models.mjs'
export { nativeFolderDialog, selectOne, selectOneNumbered, pickDirectory } from './pick.mjs'
export { SLASH_COMMANDS, findCommand, suggestCommands, completeCommandName, invocationOf } from './commands.mjs'
export { InlineMenu, slashCompleter } from './menu.mjs'
export { runWeb } from './web.mjs'
export { JsonRpcLineTransport, JsonRpcResponseError, TransportClosedError } from './rpc.mjs'
export { Runtime } from './runtime.mjs'
export { Renderer, summarizeToolArguments, contentText, wrapText } from './render.mjs'
export { verifyFrontend, findBrowser, imageBlock, toTargetUrl, harvestCookies, capturePage, DEFAULT_VISION_PROMPT } from './vision.mjs'
export { parseArgs, helpText, COMMANDS } from './args.mjs'
export { configureTheme, style, stripAnsi, visibleLength } from './theme.mjs'
