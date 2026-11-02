import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const archive = process.argv[2]
assert(archive, 'Usage: node scripts/check-package.mjs <archive.tgz>')
const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/)
const manifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }))
for (const file of ['lib/index.js', 'lib/plugin.js', 'lib/preset.js', 'lib/docker.js', 'lib/docker-files.js', 'lib/desktop.js', 'lib/client.js', 'cordis.patch.yml', 'INSTALL.md', 'LICENSE']) {
  assert(files.includes('package/' + file), 'Missing release payload: ' + file)
}
assert(files.every(f => !/(?:^|\/)(?:node_modules|\.env|\.git|evidence)(?:\/|$)/.test(f)), 'Unexpected private/dependency payload')
assert(!Object.keys(manifest.dependencies ?? {}).some(n => n.startsWith('@deepseek-ai/')), 'Host SDK must not be a runtime dependency')
assert(!Object.keys(manifest.peerDependencies ?? {}).some(n => n.startsWith('@deepseek-ai/')), 'Host SDK peers can cause a second core installation')
assert.equal(manifest.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version)
console.log('PACKAGE_OK', manifest.version, files.length, 'files')
