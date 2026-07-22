import { access, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageName = process.argv[2]
if (!['mission-control', 'mission-control-client'].includes(packageName)) throw new Error('Expected package name')
const root = path.join(repo, packageName, '.next', 'standalone')
// public is copied separately by Docker and Edge packaging; keeping it here duplicates multi-GB release assets.
const allowedRoots = new Set(['.next', 'messages', 'node_modules', 'openapi.json', 'ops', 'package.json', 'scripts', 'server.js', 'src'])

await access(path.join(root, 'server.js')).catch(() => { throw new Error('Standalone artifact is missing') })
await access(path.join(root, 'src', 'lib', 'schema.sql')).catch(() => { throw new Error('Runtime schema is missing') })

for (const entry of await readdir(root)) {
  if (!allowedRoots.has(entry)) await rm(path.join(root, entry), { recursive: true, force: true })
}

const sourceRoot = path.join(root, 'src')
for (const entry of await readdir(sourceRoot)) {
  if (entry !== 'lib') await rm(path.join(sourceRoot, entry), { recursive: true, force: true })
}
for (const entry of await readdir(path.join(sourceRoot, 'lib'))) {
  if (entry !== 'schema.sql') await rm(path.join(sourceRoot, 'lib', entry), { recursive: true, force: true })
}

const scriptsRoot = path.join(root, 'scripts')
try {
  for (const entry of await readdir(scriptsRoot)) {
    if (!['mc-mcp-server.cjs', 'mc-base-url.cjs'].includes(entry)) {
      await rm(path.join(scriptsRoot, entry), { recursive: true, force: true })
    }
  }
} catch { /* scripts are optional when tracing does not include them */ }

const opsRoot = path.join(root, 'ops')
try {
  for (const entry of await readdir(opsRoot)) {
    if (entry !== 'templates') await rm(path.join(opsRoot, entry), { recursive: true, force: true })
  }
  for (const entry of await readdir(path.join(opsRoot, 'templates'))) {
    if (entry !== 'openclaw-gateway@.service') await rm(path.join(opsRoot, 'templates', entry), { recursive: true, force: true })
  }
} catch { /* optional Edge runtime surface */ }

console.log(`Sanitized ${packageName} standalone artifact`)
