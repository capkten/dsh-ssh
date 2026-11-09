import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import ssh2 from 'ssh2'
const { Server } = ssh2
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostKeyStore } from '../../src/hostkeys.ts'
import { SshConnection } from '../../src/connection.ts'

test('first SSH handshake exposes a host-key challenge before authentication', async () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
  let authAttempts = 0
  const server = new Server({ hostKeys: [key] }, client => {
    client.on('error', () => {})
    client.on('authentication', ctx => { authAttempts++; ctx.accept() })
    client.on('session', accept => {
      accept().on('exec', acceptExec => {
        const stream = acceptExec()
        stream.write('HOME=/tmp/hostkey-test\0')
        stream.exit(0)
        stream.end()
      })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-host-key-handshake-'))
  const store = new HostKeyStore(join(dir, 'known_hosts'))
  let challenge: any
  const connection = new SshConnection({ id: 'hostkey-test', label: 'hostkey-test', host: '127.0.0.1', port: address.port, username: 'test', password: 'fixture', readyTimeout: 2000 }, store)
  try {
    await assert.rejects(connection.getRemoteEnvironment(), (error: any) => {
      assert.ok(error.challenge, 'unknown host must expose a structured trust challenge, not just fail verification')
      challenge = error.challenge
      assert.match(error.challenge.fingerprint, /^SHA256:/)
      assert.equal(error.challenge.host, '127.0.0.1')
      return true
    })
    assert.equal(authAttempts, 0)
    store.trust(challenge.id, challenge.fingerprint)
    assert.equal((await connection.getRemoteEnvironment()).HOME, '/tmp/hostkey-test')
    assert.equal(authAttempts, 1, 'explicit trust retries the same connection and reaches authentication')
  } finally {
    connection.dispose()
    rmSync(dir, { recursive: true, force: true })
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

