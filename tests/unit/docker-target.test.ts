import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dockerClient, dockerCommand, validateDockerTarget } from '../../src/docker.ts'
import type { Client } from 'ssh2'
import { SshConnection } from '../../src/connection.ts'

const id = 'a'.repeat(64)
test('Docker execution requires a pinned ID and quotes the command as argv', () => {
  assert.throws(() => dockerCommand({ container: 'demo' }, ['bash']), /pinned/)
  const text = dockerCommand({ container: id, user: '1000:1000' }, ['bash', '-c', 'printf "$HOME"; echo x'], true)
  assert.match(text, /'docker' 'exec' '-i' '-t' '--workdir' '\/' '--user' '1000:1000'/)
  assert.ok(text.endsWith(`'bash' '-c' 'printf "$HOME"; echo x'`))
})
test('Docker target validation rejects option and shell injection', () => {
  for (const container of ['--privileged', 'demo; id', '$(hostname)', '', '../name']) {
    assert.throws(() => validateDockerTarget({ container }), /invalid/)
  }
  assert.throws(() => validateDockerTarget({ container: id, user: 'root; id' }), /invalid/)
})
test('Docker connection keeps a distinct execution endpoint and default cwd', () => {
  const connection = new SshConnection({ id: 'docker', label: 'container', host: 'example.invalid', port: 22, username: 'user', docker: { container: id } })
  assert.equal(connection.cwd, '/')
  assert.match(connection.endpoint, /docker:/)
  connection.dispose()
})
test('container client refuses raw host filesystem and shell channels', () => {
  const client = dockerClient({} as Client, { container: id })
  let error: Error | undefined
  client.sftp(value => { error = value })
  assert.match(String(error), /raw host sftp is unavailable/)
  assert.throws(() => (client.shell as unknown as () => void)(), /raw host shell is unavailable/)
})
