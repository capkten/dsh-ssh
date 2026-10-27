/** Real Docker providers; all writes are confined to UUID /tmp directories. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { SshConnection } from '../../lib/connection.js'
import { SshRegistryTransport } from '../../lib/registry-ssh.js'
import { SshFileSystem } from '../../lib/filesystem-final.js'
import { SshSubprocessRuntime } from '../../lib/subprocess.js'
import { spawnSshTerminal } from '../../lib/terminal.js'
import { apply as searchTools } from '../../lib/tools.js'
import { quoteShellArg as q } from '../../lib/runtime.js'

const base = { host: process.env.DSH_DOCKER_HOST ?? '', port: 22,
  username: process.env.DSH_DOCKER_USER ?? '', privateKeyPath: process.env.DSH_DOCKER_KEY, strictHostKeyChecking: true }
const host = new SshConnection({ ...base, id: 'host', label: 'host scratch', cwd: '/tmp' })
const container = new SshConnection({ ...base, id: 'container', label: 'container scratch', cwd: '/tmp', docker: { container: process.env.DSH_DOCKER_CONTAINER ?? '' } })
const root = '/tmp/dsh-ssh-test-' + randomUUID()
const checks = []
const record = checks.push.bind(checks)
checks.push = (...values) => { for (const value of values) console.error(value.check); return record(...values) }
const deadline = AbortSignal.timeout(180000)
const ctx = new Context()
const defs = []
ctx.provide('sshRegistry', { get: id => id === 'container' ? container : id === 'host' ? host : undefined })
const transport = new SshRegistryTransport(ctx, { connectionId: 'container' })
const fs = new SshFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 1024 * 1024 })
const subprocess = new SshSubprocessRuntime(ctx)
ctx.provide('workingDirectory', { ensure: async () => root })
ctx.provide('tools', { register: tool => defs.push(tool) })
searchTools(ctx)
try {
  await container.prepareDocker(deadline)
  assert.match(container.spec.docker.container, /^[a-f0-9]{64}$/)
  checks.push({ check: 'pinned-container-ID-and-preflight', id: container.spec.docker.container })
  const created = await container.exec(`mkdir -- ${q(root)}; hostname; pwd; uname -s; id -u`, { cwd: '/tmp', signal: deadline })
  assert.equal(created.exitCode, 0, created.stderr)
  checks.push({ check: 'container-execution', output: created.stdout })
  assert.equal((await host.exec(`test ! -e ${q(root)}`)).exitCode, 0)
  const target = await fs.resolve(root + '/fixture.txt')
  await fs.writeText(target, 'CONTAINER_BEFORE\n', { kind: 'createIfAbsent' }, deadline)
  assert.equal(await fs.readText(target, deadline), 'CONTAINER_BEFORE\n')
  const observed = await fs.stat(target, deadline)
  await fs.editText(target, { oldString: 'CONTAINER_BEFORE', newString: 'CONTAINER_AFTER' }, { version: observed.version }, deadline)
  assert.equal((await container.exec(`cat -- ${q(root + '/fixture.txt')}`)).stdout, 'CONTAINER_AFTER\n')
  await assert.rejects(fs.editText(target, { oldString: 'CONTAINER_AFTER', newString: 'BAD' }, { version: observed.version }, deadline), /changed since/)
  checks.push({ check: 'native-provider-read-write-edit-stale-version' })
  const list = await fs.listDir(await fs.resolve(root), deadline)
  assert.deepEqual(list.map(entry => entry.name), ['fixture.txt'])
  const exec = { agent: {}, signal: deadline }
  const grep = await defs.find(tool => tool.name === 'grep').execute({ pattern: 'CONTAINER_AFTER', path: root + '/fixture.txt' }, exec)
  const glob = await defs.find(tool => tool.name === 'glob').execute({ pattern: '*.txt', path: root }, exec)
  assert.match(grep.text, /fixture.txt:1:CONTAINER_AFTER/)
  assert.match(glob.text, /fixture.txt/)
  checks.push({ check: 'list-glob-single-file-grep', grep, glob })
  const sftp = await container.getSftp(deadline)
  const bytes = Buffer.concat([Buffer.from([0, 255, 10, 13]), Buffer.alloc(100000, 65)])
  await new Promise((resolve, reject) => sftp.writeFile(root + '/binary.dat', bytes, error => error ? reject(error) : resolve()))
  const loaded = await new Promise((resolve, reject) => sftp.readFile(root + '/binary.dat', (error, data) => error ? reject(error) : resolve(data)))
  assert.deepEqual(loaded, bytes)
  const range = await fs.readByteRange(await fs.resolve(root + '/binary.dat'), { offset: 1, length: 3 }, deadline)
  assert.deepEqual(Buffer.from(range), bytes.subarray(1, 4))
  checks.push({ check: 'binary-chunking-and-range' })
  const handle = subprocess.spawn({ argv: ['bash', '-c', 'sleep 0.2; hostname; pwd'], cwd: root,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 1000, signal: deadline })
  assert.equal((await handle.done).exitCode, 0)
  assert.match(handle.collected.stdout.readFrom(0).text, new RegExp(root))
  checks.push({ check: 'subprocess-and-delayed-job' })
  const long = subprocess.spawn({ argv: ['bash', '-c', `echo $$ > ${q(root + '/sleep.pid')}; printf READY; exec sleep 60`], cwd: root,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 2000, signal: deadline })
  for (let attempt = 0; attempt < 100 && !long.collected.stdout.readFrom(0).text.includes('READY'); attempt++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.match(long.collected.stdout.readFrom(0).text, /READY/)
  long.terminate()
  assert.equal(await long.waitForExit(AbortSignal.timeout(10000)), true)
  const dead = await container.exec(`pid=$(cat -- ${q(root + '/sleep.pid')}); test ! -e /proc/"$pid"`)
  assert.equal(dead.exitCode, 0, 'terminated container process is still alive')
  checks.push({ check: 'background-process-termination-no-orphan' })
  const terminal = await spawnSshTerminal(transport, root, { argv: ['bash', '-c', 'hostname;pwd;test -t 0;test -t 1'], rows: 24, cols: 80, graceMs: 1000, signal: deadline })
  let output = ''
  terminal.output.on('data', chunk => { output += chunk })
  const outcome = await terminal.done
  assert.equal(outcome.exitCode, 0, JSON.stringify({ outcome, output }))
  assert.ok(output.includes(root), output)
  checks.push({ check: 'real-container-PTY', output })
  const interactive = await spawnSshTerminal(transport, root, { argv: ['bash', '--noprofile', '--norc'], rows: 24, cols: 80, graceMs: 2000, signal: deadline })
  let transcript = ''
  interactive.output.on('data', chunk => { transcript += chunk })
  await interactive.resize(96, 30)
  await interactive.write("printf 'INTERACTIVE_OK\\n'; pwd; stty size; exit\n")
  assert.equal((await interactive.done).exitCode, 0, transcript)
  assert.match(transcript, /INTERACTIVE_OK/)
  assert.ok(transcript.includes(root), transcript)
  assert.match(transcript, /30 96/)
  checks.push({ check: 'interactive-PTY-input-and-resize', transcript })
  const paired = await Promise.all([host.exec('hostname'), container.exec('hostname')])
  assert.notEqual(paired[0].stdout, paired[1].stdout)
  assert.equal((await host.exec(`test ! -e ${q(root)}`)).exitCode, 0)
  checks.push({ check: 'host-container-concurrency-and-filesystem-isolation', host: paired[0].stdout.trim(), container: paired[1].stdout.trim() })
  const client = await container.getClient(deadline)
  await new Promise(resolve => { client.once('close', resolve); client.end() })
  assert.equal(await fs.readText(target, deadline), 'CONTAINER_AFTER\n')
  checks.push({ check: 'SSH-reconnect-retains-container-ID' })
  const absent = new SshConnection({ ...base, id: 'missing', label: 'missing', docker: { container: 'dsh-no-such-' + randomUUID() } })
  try { await assert.rejects(absent.exec('hostname'), /unavailable/) } finally { absent.dispose() }
  checks.push({ check: 'missing-container-fails-closed' })
  console.log(JSON.stringify({ ok: true, checks }, null, 2))
} finally {
  assert.match(root, /^\/tmp\/dsh-ssh-test-[a-f0-9-]{36}$/)
  try {
    const cleaned = await container.exec(`rm -rf -- ${q(root)}; test ! -e ${q(root)}`)
    assert.equal(cleaned.exitCode, 0)
  } finally { host.dispose(); container.dispose() }
}
