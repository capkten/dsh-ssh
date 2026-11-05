import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/preset.ts'

// Export names extracted read-only from the user's official DSH 0.2.2-rc.1 ASAR.
const contracts = JSON.parse(readFileSync(new URL('../support/dsh-022-preset-exports.json', import.meta.url), 'utf8'))
test('remote preset composes only exported official DSH 0.2.2-rc.1 plugins', async () => {
 const ctx = new Context(), definitions: any[] = []
 ctx.provide('agentPresets', { register: async (d: any) => { definitions.push(d); return async () => {} }, select: async () => '' })
 ctx.provide('sshRegistry', { list: () => [{ id: 'c1', label: 'test', username: 'test', host: 'test', port: 22 }] } as never)
 ctx.provide('agents', { roots: () => [] })
 const plugin = ctx.plugin(apply)
 await plugin.await(); await new Promise(resolve => setImmediate(resolve))
 try {
  assert.equal(definitions.length, 1)
  let control = 0
  const visit = (rows: any[]) => { for (const row of rows) {
   if (row.name?.startsWith('@deepseek-ai/')) {
    const [scope, name, ...sub] = row.name.split('/'), pkg = `${scope}/${name}`, entry = sub.length ? './' + sub.join('/') : '.'
    assert.ok(contracts[pkg], `official package missing: ${pkg}`)
    assert.ok(contracts[pkg].exports.includes(entry), `official plugin export missing: ${row.name}`)
    if (row.name === '@deepseek-ai/dsh-tool-subagent-control') control++
   }
   if (Array.isArray(row.config)) visit(row.config)
  } }
  visit(definitions[0].plugins)
  assert.equal(control, 1, 'retain the unified control plugin that registers list_agents/send_message/interrupt_agent')
 } finally { await plugin.dispose() }
})
