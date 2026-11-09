import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
const require = createRequire(import.meta.url)
const React = require('react')
const { act, create } = require('react-test-renderer')

for (const mode of ['accept', 'cancel', 'changed', 'abort']) test(`actual host-key React dialog: ${mode}`, async () => {
  const output = await build({ entryPoints: ['src/client/hostkey.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], plugins: [{ name: 'css-test-stub', setup(build) { build.onLoad({ filter: /\.css$/ }, () => ({ contents: 'export default {}', loader: 'js' })) } }] })
  const module = { exports: {} as any }
  runInNewContext(output.outputFiles[0]!.text, { module, exports: module.exports, require, console })
  let api: any, renderer: any
  const calls: string[] = [], controller = new AbortController()
  const raw = async (op: string) => {
    calls.push(op)
    return { ok: true, value: calls.length === 1 ? { hostKeyRequired: { id: 'server-issued', host: 'test.example', port: 2222, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:fixture-fingerprint', changed: mode === 'changed' } } : { ok: true } }
  }
  function Harness() { api = module.exports.useHostKeyTrust(raw, true); return api.dialog }
  await act(async () => { renderer = create(React.createElement(Harness)) })
  let operation: Promise<unknown>
  await act(async () => {
    operation = api.rpc('connections.test', {}, controller.signal)
    operation.catch(() => {})
    await new Promise(resolve => setImmediate(resolve))
  })
  try {
    assert.match(JSON.stringify(renderer.toJSON()), /SHA256:fixture-fingerprint/)
    assert.match(JSON.stringify(renderer.toJSON()), /test.example/)
    const buttons = renderer.root.findAllByType('button')
    if (mode === 'changed') assert.equal(buttons.length, 1, 'changed key has no trust action')
    await act(async () => {
      if (mode === 'abort') controller.abort()
      else buttons[mode === 'accept' ? 1 : 0].props.onClick()
      if (mode === 'accept') await operation!
      else await assert.rejects(operation!)
    })
    assert.deepEqual(calls, mode === 'accept' ? ['connections.test', 'hostkeys.trust', 'connections.test'] : ['connections.test'])
    assert.equal(renderer.toJSON(), null)
  } finally { await act(async () => { renderer.unmount() }) }
})
