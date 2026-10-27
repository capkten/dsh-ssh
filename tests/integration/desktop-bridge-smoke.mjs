/** Real official controller methods + SSH providers, in isolated Cordis contexts.
 * Does not exercise Typert serialization or the Electron renderer. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { finished } from 'node:stream/promises'
import { CLI_BIN, SSH, SSH2 } from './lib.mjs'

const hostRequire = createRequire(CLI_BIN)
const loadHost = name => import(pathToFileURL(hostRequire.resolve(name)).href)
const loadPlugin = name => import(pathToFileURL(join(process.argv[2], 'lib', `${name}.js`)).href)
const { Context } = await loadHost('@deepseek-ai/cordis')
const { default: WorkspaceFiles } = await loadHost('@deepseek-ai/dsh-api-workspace-files')
const { default: TerminalController } = await loadHost('@deepseek-ai/dsh-api-terminal-controller')
const { default: LocalFs } = await loadHost('@deepseek-ai/dsh-fs-local')
const { default: LocalSubprocess } = await loadHost('@deepseek-ai/dsh-subprocess-local')
const { SshConnection } = await loadPlugin('connection')
const { SshRegistryTransport } = await loadPlugin('registry-ssh')
const { SshSubprocessRuntime } = await loadPlugin('subprocess')
const bridge = await loadPlugin('desktop')
const { quoteShellArg } = await loadPlugin('runtime')
const ctx = new Context()
const localRoot = mkdtempSync(join(tmpdir(), 'dsh-ssh-desktop-test-'))
const signal = AbortSignal.timeout(90000)
const connections = [SSH, SSH2].map((target, index) => new SshConnection({
  id: `c${index + 1}`, label: 'desktop controller test', host: target.host, port: Number(target.port),
  username: target.user, privateKeyPath: target.key, cwd: '/tmp', strictHostKeyChecking: true,
  ...(index === 1 && process.env.DSH_DESKTOP_DOCKER ? { docker: { container: process.env.DSH_DESKTOP_DOCKER } } : {}),
}))
const roots = connections.map(() => `/tmp/dsh-ssh-test-${randomUUID()}`)
const registry = { get: id => connections.find(connection => connection.id === id) }
ctx.provide('sshRegistry', registry)
const localFs = new LocalFs(ctx, { cwd: localRoot, diffBasisMaxBytes: 1024 * 1024 })
const localSubprocess = new LocalSubprocess(ctx)
const remoteSubprocesses = connections.map(connection => {
  const realm = new Context()
  realm.provide('sshRegistry', registry)
  new SshRegistryTransport(realm, { connectionId: connection.id })
  return new SshSubprocessRuntime(realm)
})
const workingDirectory = {
  get: session => session.header.cwd,
  ensure: async agent => agent.session.header.cwd,
}
ctx.provide('workingDirectory', workingDirectory)
ctx.provide('sandboxPolicy', { workspaceRoot: localRoot })
const agents = connections.map((connection, index) => {
  const agentCtx = ctx.extend()
  return { id: `agent-${index}`, ctx: agentCtx, preset: `dsh-ssh:${connection.id}`,
    session: { id: `agent-${index}`, header: { cwd: `ssh://${connection.id}${roots[index]}` } } }
})
ctx.provide('agentPresets', {
  composedPreset: context => agents.find(agent => agent.ctx === context)?.preset,
  serviceFor: (agent, name) => name === 'subprocess' ? remoteSubprocesses[agents.indexOf(agent)] : undefined,
})
// Construct real controllers with only transport registration stubbed. All
// file gates, shell discovery and terminal spawn code remain the official code.
ctx.provide('sessions', { get: () => undefined })
ctx.provide('typert', { lookups: { register: () => () => {} } })
const files = new WorkspaceFiles(ctx, { maxBytes: 4096, maxFileBytes: 4096, maxLines: 100, maxEntries: 100 })
const terminal = new TerminalController(ctx, {
  shellCandidates: ['bash', 'pwsh', 'powershell', 'cmd'], maxTerminals: 8, maxCols: 500, maxRows: 200,
  scrollback: 1000, maxBufferedBytes: 65536, maxInputBytes: 65536, disposeGraceMs: 1000,
  unattendedTimeoutMs: 120000, activityPollIntervalMs: 30000, cleanupRetryMs: 60000,
})
const plugin = ctx.plugin(bridge)
await plugin.await()
const checks = []
try {
  writeFileSync(join(localRoot, 'local.txt'), hostname())
  const scopes = agents.map(agent => ({ sessionId: agent.id, workspaceRoot: agent.session.header.cwd }))
  for (let index = 0; index < connections.length; index++) {
    const outcome = await connections[index].exec(`mkdir -- ${quoteShellArg(roots[index])} && printf ${quoteShellArg(`host-${index}\n`)} > ${quoteShellArg(`${roots[index]}/fixture.txt`)} && mkdir ${quoteShellArg(`${roots[index]}/.git`)}`, { signal })
    assert.equal(outcome.exitCode, 0)
  }
  await Promise.all(scopes.map(async (scope, index) => {
    const listing = await files.list(scope, '.', signal)
    assert.deepEqual(listing.entries.map(entry => entry.name).sort(), ['.git', 'fixture.txt'])
    assert.equal((await files.read(scope, 'fixture.txt', {}, signal)).text, `host-${index}`)
    await assert.rejects(files.list(scope, '..', signal), /outside the workspace/)
    await assert.rejects(files.read(scope, `ssh://c${index === 0 ? 2 : 1}${roots[index]}/fixture.txt`, {}, signal), /refusing another connection/)
    assert.equal(terminal.environment(agents[index], signal).cwd, roots[index])
    const shells = await terminal.shells(agents[index], signal)
    assert.equal(shells[0].name, 'bash')
    assert.ok(shells.every(shell => !/pwsh|powershell|cmd/.test(shell.name)))
    // Call the actual official terminal spawn path. Capture PTY output through
    // a provider wrapper; no GUI terminal automation or business-directory IO.
    const subprocess = remoteSubprocesses[index]
    const spawn = subprocess.spawnTerminal.bind(subprocess)
    let output = ''
    let handle
    subprocess.spawnTerminal = async spec => {
      assert.equal(spec.cwd, roots[index])
      handle = await spawn({ ...spec, argv: ['bash', '-c', 'hostname; pwd; test -t 0'] })
      handle.output.on('data', chunk => { output += chunk })
      return handle
    }
    const owner = { closedIds: new Set(), allocations: new Map() }
    const allocated = await terminal.spawn(agents[index], owner, { id: `pty-${index}`, cols: 80, rows: 24 }, signal)
    assert.equal((await handle.done).exitCode, 0)
    await finished(handle.output)
    assert.ok(output.includes(roots[index]), output)
    await allocated.close()
    subprocess.spawnTerminal = spawn
    checks.push({ check: 'remote-sidebar-files-and-official-terminal-spawn', connection: `c${index + 1}`, ptyOutput: output })
  }))
  const watchController = new AbortController()
  const watching = files.changes(scopes[0], 'fixture.txt', AbortSignal.any([signal, watchController.signal]))
  assert.equal((await watching.next()).value.kind, 'ready')
  const changed = watching.next()
  assert.equal((await connections[0].exec(`printf 'updated\n' > ${quoteShellArg(`${roots[0]}/fixture.txt`)}`, { signal })).exitCode, 0)
  const change = (await changed).value
  assert.equal(change.kind, 'change')
  assert.equal(change.change.absolutePath, `${roots[0]}/fixture.txt`)
  assert.equal((await files.read(scopes[0], 'fixture.txt', {}, signal)).text, 'updated')
  watchController.abort()
  await watching.return()
  checks.push({ check: 'remote-preview-polling-invalidation-and-cancellation' })
  const localScope = { sessionId: 'local', workspaceRoot: localRoot }
  assert.equal((await files.read(localScope, 'local.txt', {}, signal)).text, hostname())
  const localAgent = { ctx, session: { header: { cwd: localRoot } } }
  assert.equal(terminal.execution(localAgent).subprocess[Symbol.for('cordis.original')], localSubprocess)
  assert.ok((await terminal.shells(localAgent, signal)).some(shell => /cmd|pwsh|powershell/.test(shell.name)))
  checks.push({ check: 'local-files-and-Windows-shells-unchanged' })
  agents[0].preset = 'standard'
  assert.throws(() => terminal.execution(agents[0]), /refusing local terminal/)
  agents[0].preset = 'dsh-ssh:c1'
  connections[0].dispose()
  await assert.rejects(files.list(scopes[0], '.', signal), /disposed/)
  await assert.rejects(terminal.shells(agents[0], signal), /disposed/)
  checks.push({ check: 'wrong-preset-and-disposed-connection-fail-closed' })
  console.log(JSON.stringify({ ok: true, checks }, null, 2))
} finally {
  await plugin.dispose()
  for (let index = 0; index < connections.length; index++) {
    connections[index].dispose()
    const cleanup = new SshConnection(connections[index].spec)
    try {
      assert.match(roots[index], /^\/tmp\/dsh-ssh-test-[0-9a-f-]{36}$/)
      const result = await cleanup.exec(`rm -rf -- ${quoteShellArg(roots[index])}`)
      assert.equal(result.exitCode, 0)
    } finally { cleanup.dispose() }
  }
  rmSync(localRoot, { recursive: true, force: true })
}
