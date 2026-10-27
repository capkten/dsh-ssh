/** Real provider checks in one process; writes only to unique remote scratch trees. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { SshConnection } from '../../lib/connection.js'
import { SshRegistryTransport } from '../../lib/registry-ssh.js'
import { SshFileSystem } from '../../lib/filesystem-final.js'
import { SshSubprocessRuntime } from '../../lib/subprocess.js'
import { spawnSshTerminal } from '../../lib/terminal.js'
import { quoteShellArg } from '../../lib/runtime.js'
import { CLI_BIN, SSH, SSH2 } from './lib.mjs'

const connections = [SSH, SSH2].map((target, index) => new SshConnection({
  id: `c${index + 1}`, label: 'isolated provider smoke', host: target.host,
  port: Number(target.port), username: target.user, privateKeyPath: target.key,
  cwd: '/tmp', strictHostKeyChecking: true,
}))
const roots = connections.map(() => `/tmp/dsh-ssh-test-${randomUUID()}`)
const checks = []
const deadline = AbortSignal.timeout(90_000)
try {
  const hostRequire = createRequire(CLI_BIN)
  const { Context: HostContext } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')).href)
  const { default: Browse } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-host-directory-picker-browse')).href)
  const picker = new Browse(new HostContext(), { maxEntries: 20 })
  const listing = await picker.capability().list(homedir())
  assert.equal(listing.path, homedir())
  checks.push({ check: 'host-local-browse-without-ssh-service', path: listing.path })
  const untrusted = new SshConnection({ ...connections[0].spec, knownHosts: ['SHA256:deliberately-wrong-test-key'] })
  try {
    await assert.rejects(untrusted.getClient(deadline), /verification|host key/i)
    checks.push({ check: 'wrong-host-key-rejected' })
  } finally { untrusted.dispose() }
  const realms = connections.map((connection, index) => {
    const ctx = new Context()
    ctx.provide('sshRegistry', { get: id => connections.find(item => item.id === id) })
    const transport = new SshRegistryTransport(ctx, { connectionId: connection.id })
    const fs = new SshFileSystem(ctx)
    const subprocess = new SshSubprocessRuntime(ctx)
    return { ctx, transport, fs, subprocess, root: roots[index], connection }
  })
  const hosts = await Promise.all(realms.map(async realm => {
    const outcome = await realm.connection.exec(`mkdir -- ${quoteShellArg(realm.root)} && hostname`, { signal: deadline })
    assert.equal(outcome.exitCode, 0)
    return outcome.stdout.trim()
  }))
  assert.notEqual(hosts[0], hosts[1])
  checks.push({ check: 'same-process-two-hosts', hosts })
  const outcomes = await Promise.allSettled(realms.map(async (realm, index) => {
    console.error('provider start', hosts[index])
    const { fs, root, connection, transport } = realm
    const target = await fs.resolve(`${root}/fixture.txt`)
    await fs.writeText(target, `host-${index}\n`, { kind: 'createIfAbsent' }, deadline)
    assert.equal(await fs.readText(target, deadline), `host-${index}\n`)
    const observed = await fs.stat(target, deadline)
    await fs.editText(target, { oldString: `host-${index}`, newString: `edited-${index}` }, { version: observed.version }, deadline)
    assert.equal((await connection.exec(`cat -- ${quoteShellArg(`${root}/fixture.txt`)}`, { signal: deadline })).stdout, `edited-${index}\n`)
    await assert.rejects(fs.editText(target, { oldString: `edited-${index}`, newString: 'stale' }, { version: observed.version }, deadline), /changed since it was read/)
    const editedVersion = (await fs.stat(target, deadline)).version
    const remoteChange = await connection.exec(
      `cp -p -- ${quoteShellArg(`${root}/fixture.txt`)} ${quoteShellArg(`${root}/timestamp-ref`)} && printf 'remote-${index}\\n' > ${quoteShellArg(`${root}/fixture.txt`)} && touch -r ${quoteShellArg(`${root}/timestamp-ref`)} ${quoteShellArg(`${root}/fixture.txt`)}`,
      { signal: deadline },
    )
    assert.equal(remoteChange.exitCode, 0)
    await assert.rejects(fs.editText(target, { oldString: `remote-${index}`, newString: 'stale' }, { version: editedVersion }, deadline), /changed since it was read/)
    await fs.writeText(target, `edited-${index}\n`, { kind: 'replaceIfVersion', version: (await fs.stat(target, deadline)).version }, deadline)
    await assert.rejects(fs.resolve(`ssh://c${index === 0 ? 2 : 1}/tmp/file`), /refusing another connection/)
    checks.push({ check: 'sftp-write-edit-stale-and-target-guard', host: hosts[index] }); console.error('sftp edit passed', hosts[index])
    const terminal = await spawnSshTerminal(transport, root, {
      argv: ['bash', '-c', 'hostname; pwd; test -t 0'], rows: 24, cols: 80, graceMs: 1000, signal: deadline,
    })
    let output = ''
    terminal.output.on('data', chunk => { output += chunk })
    const terminalExit = await terminal.done
    assert.equal(terminalExit.exitCode, 0)
    assert.ok(output.includes(hosts[index]) && output.includes(root), output)
    checks.push({ check: 'real-pty-host-and-cwd', host: hosts[index] })
    const handle = realm.subprocess.spawn({ argv: ['bash', '-c', 'sleep 1; hostname; pwd'], cwd: root,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 1000, signal: deadline })
    assert.equal((await handle.done).exitCode, 0)
    const text = handle.collected.stdout.readFrom(0).text
    assert.ok(text.includes(hosts[index]) && text.includes(root), text)
    checks.push({ check: 'delayed-process-host-and-cwd', host: hosts[index] })
    const client = await connection.getClient(deadline)
    await new Promise(resolve => { client.once('close', resolve); client.end() })
    assert.equal(await fs.readText(target, deadline), `edited-${index}\n`)
    checks.push({ check: 'reconnect-reads-same-host-file', host: hosts[index] })
    connection.dispose()
    await assert.rejects(fs.readText(target, deadline), /disposed/)
    checks.push({ check: 'disposed-connection-file-fails-closed', host: hosts[index] })
  }))
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
  console.log(JSON.stringify({ ok: true, checks }, null, 2))
} finally {
  // The tested connections are intentionally disposed. Use fresh verified
  // connections solely to remove each exact UUID-named fixture we created.
  for (let index = 0; index < connections.length; index++) {
    connections[index].dispose()
    const cleanup = new SshConnection(connections[index].spec)
    try {
      assert.match(roots[index], /^\/tmp\/dsh-ssh-test-[0-9a-f-]{36}$/)
      const result = await cleanup.exec(`rm -rf -- ${quoteShellArg(roots[index])}`)
      assert.equal(result.exitCode, 0)
    } finally { cleanup.dispose() }
  }
}
