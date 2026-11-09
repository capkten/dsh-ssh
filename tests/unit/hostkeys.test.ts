import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HostKeyStore } from '../../src/hostkeys.ts'
import { withHostKeyTrust } from '../../src/client/hostkey-rpc.ts'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hostkeys-'))
  const store = new HostKeyStore(join(dir, 'known_hosts'))
  const key = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), randomBytes(32)])
  return { store, key, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('trust needs an observed challenge and exact fingerprint; persists without replacing existing lines', () => {
  const { store, key, cleanup } = fixture()
  try {
    writeFileSync(store.path, '# existing records\nother ssh-ed25519 AAAA')
    const error = store.verify('first-host', 2200, key)!
    assert.equal(error.challenge.changed, false)
    assert.throws(() => store.trust('invented', error.challenge.fingerprint), /失效/)
    assert.throws(() => store.trust(error.challenge.id, 'wrong'), /失效/)
    assert.equal(readFileSync(store.path, 'utf8'), '# existing records\nother ssh-ed25519 AAAA')
    store.trust(error.challenge.id, error.challenge.fingerprint)
    assert.match(readFileSync(store.path, 'utf8'), /^# existing records\nother ssh-ed25519 AAAA\n\[first-host\]:2200 ssh-ed25519 /)
    assert.equal(store.verify('first-host', 2200, key), undefined)
    assert.equal(store.verify('first-host', 22, key)!.challenge.changed, false, 'ports have independent identities')
    assert.throws(() => store.trust(error.challenge.id, error.challenge.fingerprint), /失效/)
  } finally { cleanup() }
})

test('changed/revoked keys never produce an approvable challenge; concurrent trust changes block saving', () => {
  const { store, key, cleanup } = fixture()
  try {
    const challenge = store.verify('host', 22, key)!.challenge
    writeFileSync(store.path, 'host ssh-ed25519 OTHER\n')
    const changed = store.verify('host', 22, key)!.challenge
    assert.equal(changed.changed, true)
    assert.equal(changed.id, '')
    assert.throws(() => store.trust(challenge.id, challenge.fingerprint), /发生变化/)
    writeFileSync(store.path, `@revoked host ssh-ed25519 ${key.toString('base64')}\n`)
    assert.equal(store.verify('host', 22, key)!.challenge.changed, true)
    assert.throws(() => store.trust(challenge.id, challenge.fingerprint), /发生变化/)
  } finally { cleanup() }
})

test('OpenSSH hashed known_hosts and pinned fingerprints are recognized', () => {
  const { store, key, cleanup } = fixture()
  try {
    const salt = randomBytes(20), hash = createHmac('sha1', salt).update('[hashed-host]:2222').digest('base64')
    writeFileSync(store.path, `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${key.toString('base64')}\n`)
    assert.equal(store.verify('hashed-host', 2222, key), undefined)
    assert.ok(store.verify('hashed-host', 22, key))
    assert.equal(store.verify('pinned', 22, key, ['SHA256:' + createHash('sha256').update(key).digest('base64')]), undefined)
  } finally { cleanup() }
})

for (const accept of [false, true]) test(`UI RPC ${accept ? 'confirmation persists and retries' : 'cancel sends no trust or retry'}`, async () => {
  const { store, key, cleanup } = fixture()
  const challenge = store.verify('host', 22, key)!.challenge
  const calls: string[] = []
  try {
    const rpc = withHostKeyTrust(async (op, payload: any) => {
      calls.push(op)
      if (op === 'hostkeys.trust') { store.trust(payload.id, payload.fingerprint); return { ok: true, value: { trusted: true } } }
      return { ok: true, value: calls.length === 1 ? { hostKeyRequired: challenge } : { path: '/remote' } }
    }, async () => accept)
    if (accept) {
      assert.deepEqual(await rpc('browse.list'), { ok: true, value: { path: '/remote' } })
      assert.deepEqual(calls, ['browse.list', 'hostkeys.trust', 'browse.list'])
      assert.ok(existsSync(store.path))
    } else {
      await assert.rejects(rpc('browse.list'), /取消/)
      assert.deepEqual(calls, ['browse.list'])
      assert.equal(existsSync(store.path), false)
    }
  } finally { cleanup() }
})

test('UI never retries ordinary failures or trusts a changed key', async () => {
  let calls = 0
  const rpc = withHostKeyTrust(async () => { calls++; return { ok: false, error: { code: 'internal', message: 'authentication failed' } } }, async () => { throw Error('must not prompt') })
  assert.equal((await rpc('connections.test')).ok, false)
  assert.equal(calls, 1)
  const changed = withHostKeyTrust(async () => ({ ok: true, value: { hostKeyRequired: { id: '', host: 'host', port: 22, fingerprint: 'SHA256:test', changed: true } } }), async () => true)
  await assert.rejects(changed('browse.list'), /已变化/)
})
