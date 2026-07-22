import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const forbiddenNames = new Set(['.git', '.npmrc', 'id_rsa', 'id_ed25519'])
const forbiddenSuffixes = ['.pem', '.key', '.p12']
const failures = []
const canonicalSanitizer = readFileSync(path.join(repo, 'scripts', 'sanitize-standalone-artifact.mjs'), 'utf8')

function walk(root, current = root) {
  if (!existsSync(current)) return
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name)
    const relative = path.relative(root, full)
    if (forbiddenNames.has(entry.name) || /^\.env(?:\.|$)/.test(entry.name) || forbiddenSuffixes.some((suffix) => entry.name.endsWith(suffix))) {
      failures.push(`${path.relative(repo, root)} contains forbidden artifact ${relative}`)
    }
    if (entry.isDirectory()) walk(root, full)
  }
}

const requestedPackage = process.argv[2]
const packages = requestedPackage ? [requestedPackage] : ['mission-control', 'mission-control-client']
if (packages.some((name) => !['mission-control', 'mission-control-client'].includes(name))) {
  throw new Error('Unknown package boundary')
}
for (const packageName of packages) {
  const packageRoot = path.join(repo, packageName)
  const packageJson = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  const localSanitizerPath = path.join(packageRoot, 'scripts', 'sanitize-standalone-artifact.mjs')
  if (!packageJson.scripts?.build?.includes(`node scripts/sanitize-standalone-artifact.mjs ${packageName}`)) {
    failures.push(`${packageName}: build does not use its Docker-context sanitizer`)
  }
  if (!existsSync(localSanitizerPath) || readFileSync(localSanitizerPath, 'utf8') !== canonicalSanitizer) {
    failures.push(`${packageName}: Docker-context sanitizer differs from canonical script`)
  }
  const standalone = path.join(packageRoot, '.next', 'standalone')
  if (!existsSync(standalone)) failures.push(`${packageName}: missing .next/standalone`)
  walk(standalone)

  const dockerfile = readFileSync(path.join(packageRoot, 'Dockerfile'), 'utf8')
  if (!/^ARG NODE_IMAGE=.*@sha256:[0-9a-f]{64}$/m.test(dockerfile)) failures.push(`${packageName}: unpinned default NODE_IMAGE`)
  if (!dockerfile.includes('COPY --from=build /app/.next/standalone ./')) failures.push(`${packageName}: runtime does not use standalone boundary`)
  const runtime = dockerfile.split(/FROM \$\{NODE_IMAGE\} AS runtime/)[1] || ''
  if (/^COPY\s+\.\s+\./m.test(runtime)) failures.push(`${packageName}: runtime copies the full build context`)
  if (!/USER nextjs/.test(runtime)) failures.push(`${packageName}: runtime is not non-root`)
}

if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log('Standalone and Docker artifact boundaries verified')
