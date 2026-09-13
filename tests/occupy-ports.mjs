// Occupy the first ports in the search window so the CLI must fall back.
import { createServer } from 'node:net'

const start = Number(process.argv[2] ?? 3080)
const count = Number(process.argv[3] ?? 3)

const servers = []
const ports = []
for (let offset = 0; offset < count; offset += 1) {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port: start + offset, host: '127.0.0.1' }, resolve)
  })
  servers.push(server)
  ports.push(start + offset)
}
console.log(`occupying ${ports.join(', ')}`)
process.on('SIGTERM', () => {
  for (const server of servers) server.close()
  process.exit(0)
})
setInterval(() => {}, 60_000)
