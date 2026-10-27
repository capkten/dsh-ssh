/** Stops/replaces only a disposable container created by this test. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { SshConnection } from '../../lib/connection.js'
import { quoteShellArg as q } from '../../lib/runtime.js'
const base = { host: process.env.DSH_DOCKER_HOST ?? '', port: 22, username: process.env.DSH_DOCKER_USER ?? '', privateKeyPath: process.env.DSH_DOCKER_KEY, strictHostKeyChecking: true }
const host = new SshConnection({ ...base, id: 'host', label: 'Docker lifecycle test' })
const name = 'dsh-ssh-test-' + randomUUID()
const ids = []
let connection
const checks = []
async function create(image) {
  const result = await host.exec(['docker', 'create', '--network', 'none', '--name', name, '--entrypoint', '/bin/bash', image, '-c', 'sleep 120'].map(q).join(' '))
  assert.equal(result.exitCode, 0, result.stderr)
  const id = result.stdout.trim()
  assert.match(id, /^[a-f0-9]{64}$/)
  ids.push(id)
  return id
}
try {
  const image = (await host.exec("docker inspect --type container --format '{{.Image}}' turboocr_demo")).stdout.trim()
  assert.match(image, /^sha256:[a-f0-9]{64}$/)
  const first = await create(image)
  connection = new SshConnection({ ...base, id: 'test', label: name, docker: { container: name } })
  await assert.rejects(connection.exec('hostname'), /must be running/)
  checks.push('stopped-container-rejected')
  assert.equal((await host.exec(`docker start ${q(first)}`)).exitCode, 0)
  assert.equal((await connection.exec('hostname')).exitCode, 0)
  assert.equal(connection.spec.docker.container, first)
  checks.push('running-container-pinned-to-full-ID')
  assert.equal((await host.exec(`docker rm -f ${q(first)}`)).exitCode, 0)
  const second = await create(image)
  assert.notEqual(first, second)
  assert.equal((await host.exec(`docker start ${q(second)}`)).exitCode, 0)
  const outcome = await connection.exec('hostname')
  assert.notEqual(outcome.exitCode, 0)
  assert.equal(outcome.stdout.trim(), '')
  const restored = new SshConnection({ ...connection.spec, id: 'restored' })
  try { await assert.rejects(restored.exec('hostname'), /unavailable/) } finally { restored.dispose() }
  checks.push('same-name-replacement-not-selected-live-or-restored')
  console.log(JSON.stringify({ ok: true, checks, ids, scratchContainer: name }, null, 2))
} finally {
  connection?.dispose()
  try {
    for (const id of ids) { assert.match(id, /^[a-f0-9]{64}$/); await host.exec(`docker rm -f ${q(id)}`) }
    assert.notEqual((await host.exec(`docker inspect --type container -- ${q(name)}`)).exitCode, 0)
  } finally { host.dispose() }
}
