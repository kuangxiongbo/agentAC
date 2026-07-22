import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.join(repo, '.github', 'workflows')
const files = readdirSync(root).filter((name) => /\.ya?ml$/.test(name))
const unpinned = []
for (const file of files) {
  const lines = readFileSync(path.join(root, file), 'utf8').split('\n')
  lines.forEach((line, index) => {
    const match = line.match(/\buses:\s*([^\s#]+)@([^\s#]+)/)
    if (match && !/^[0-9a-f]{40}$/.test(match[2])) unpinned.push(`${file}:${index + 1}: ${match[0]}`)
  })
}
if (!statSync(root).isDirectory() || files.length === 0) throw new Error('No root workflows found')
if (unpinned.length) {
  console.error(`Unpinned workflow actions:\n${unpinned.join('\n')}`)
  process.exit(1)
}
console.log(`Verified immutable action pins in ${files.length} root workflows`)
