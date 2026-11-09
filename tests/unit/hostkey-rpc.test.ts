import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../../src/web.ts'
import { HostKeyTrustError } from '../../src/hostkeys.ts'

test('RPC carries host trust through both connection testing and directory browsing without invalid error codes', async () => {
  const challenge = { id: 'observed-only', host: 'fixture', port: 22, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:fixture', changed: false }
  const failure = () => { throw new HostKeyTrustError(challenge) }
  let handler: any
  const registry = { test: failure, get: () => ({ spec: {}, getRemoteEnvironment: failure, getSftp: failure }) }
  const ctx: any = {
    plugin: () => {}, get: () => registry,
    connection: { register: (_owner: unknown, _channel: string, fn: unknown) => { handler = fn } },
    inject: (_services: unknown, fn: (owner: unknown) => void) => { fn({}) },
  }
  apply(ctx, {})
  for (const [op, input] of [['connections.test', { host: 'fixture', username: 'test' }], ['browse.list', { id: 'fixture' }], ['browse.home', { id: 'fixture' }]] as const) {
    const result = await handler(op, input, new AbortController().signal)
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, { hostKeyRequired: challenge })
  }
})
