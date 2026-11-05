import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const root = process.argv[2]
if (!root) throw Error('Pass an extracted official DSH runtime directory')
const require = createRequire(root + '/probe.cjs')
const control = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-subagent-control')).href)
const definitions = []
control.apply({ tools: { register: d => { definitions.push(d); return () => {} } }, agents: { get: () => undefined }, subagents: { listChildren: async () => [], listDescendants: async () => [] } })
assert.deepEqual(definitions.map(d => d.name).sort(), ['interrupt_agent', 'list_agents', 'send_message'])
const list = definitions.find(d => d.name === 'list_agents')
assert.deepEqual(await list.execute({}, { agent: { id: 'isolated-parent' }, signal: new AbortController().signal }), [])
assert.throws(() => require.resolve('@deepseek-ai/dsh-tool-subagent-control/list-agents'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
console.log('PASS official DSH 0.2.2-rc.1: unified control registers all three tools; list_agents runs; obsolete subpath is rejected. No child agents or remote commands were started.')
