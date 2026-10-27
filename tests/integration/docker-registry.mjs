/** Connection form backend: pin, persist and restore in an isolated registry. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { SshRegistry } from '../../lib/registry.js'
const root = mkdtempSync(join(tmpdir(), 'dsh-docker-registry-'))
const stateFile = join(root, 'connections.json')
const ctx = new Context()
const registry = new SshRegistry(ctx, { stateFile })
let restoredContext
try {
  const input = { host: process.env.DSH_DOCKER_HOST ?? '', username: process.env.DSH_DOCKER_USER ?? '', privateKeyPath: process.env.DSH_DOCKER_KEY, docker: { container: process.env.DSH_DOCKER_CONTAINER ?? '' } }
  assert.deepEqual(await registry.test(input), { ok: true })
  const added = await registry.add(input)
  assert.match(added.view.docker.container, /^[a-f0-9]{64}$/)
  assert.equal(input.docker.container, 'turboocr_demo')
  assert.equal(added.view.cwd, '/app')
  await ctx.fiber.dispose()
  const persisted = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(persisted.connections[0].docker.container, added.view.docker.container)
  restoredContext = new Context()
  const restored = new SshRegistry(restoredContext, { stateFile })
  assert.deepEqual(restored.list()[0].docker, added.view.docker)
  const connection = restored.get(added.id)
  const outcome = await connection.exec('hostname;pwd', { cwd: connection.cwd })
  assert.equal(outcome.exitCode, 0)
  assert.ok(outcome.stdout.includes('/app'))
  console.log(JSON.stringify({ ok: true, checks: ['form-test', 'add-pins-without-mutating-input', 'persist-full-ID', 'restore-same-target-and-default-WorkingDir'], view: added.view, output: outcome.stdout }, null, 2))
} finally {
  if (restoredContext) await restoredContext.fiber.dispose()
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
}
