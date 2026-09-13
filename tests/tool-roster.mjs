// Report the tool roster the SDK profile actually hands the model.
import { Runtime } from '../src/runtime.mjs'
import { resolveDshLauncher } from '../src/dsh.mjs'

const launcher = resolveDshLauncher({})
const runtime = await Runtime.start({
  launcherEntry: launcher.entry,
  profile: 'sdk',
  cwd: process.cwd(),
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  onEvent: (event) => {
    if (event?.type === 'request/header') {
      const tools = event.data?.header?.tools ?? []
      console.log(`tool count: ${tools.length}`)
      for (const tool of tools) console.log(`  ${tool.name}`)
    }
  },
  onStderr: () => {},
})

await runtime.prompt(Runtime.newSessionId(), [{ type: 'text', text: 'Reply with the single word: ok' }])
await runtime.waitForTurnEnd()
await runtime.shutdown()
process.exit(0)
