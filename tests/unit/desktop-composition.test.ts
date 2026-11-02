import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

test('host SDKs are development-only and cannot auto-install a second runtime core', () => {
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-fs', '@deepseek-ai/dsh-subprocess', '@deepseek-ai/dsh-shell']) {
    assert.equal(manifest.dependencies[name], undefined, name)
    assert.ok(manifest.devDependencies[name], name)
    assert.equal(manifest.peerDependencies?.[name], undefined, name)
  }
})

test('Desktop local directory browsing does not require a host SSH service', () => {
  const patch = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /name: '@deepseek-ai\/dsh-host-directory-picker-browse'/)
  assert.doesNotMatch(patch, /name: dsh-ssh\/picker\s/)
  assert.match(patch, /name: dsh-ssh\/web/)
})
