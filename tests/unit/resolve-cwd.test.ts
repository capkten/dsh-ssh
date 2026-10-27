/**
 * `resolveSshCwd` / `resolveSshTargetKey` routing tests: the real functions from
 * `src/transport.ts` are driven against fake transports and a fake registry, so
 * the route selection logic (aggregate `ctx.ssh` vs. registry connection, error
 * paths, concurrency) is exercised without opening a socket.
 *
 * Run:
 *   npx --yes tsx --tsconfig tests/tsconfig.test.json --test tests/unit
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

it('rejects explicit cross-host cwd and filesystem routes inside a bound session', () => {
  const bound = Object.assign(makeTransport('one', '/tmp'), { boundConnectionId: 'c1' })
  const other = makeTransport('two', '/tmp')
  const ctx = makeCtx(bound, { c1: bound, c2: other })
  assert.equal(resolveSshCwd(ctx, 'ssh://c1/tmp').transport, bound)
  assert.throws(() => resolveSshCwd(ctx, 'ssh://c2/tmp'), /refusing another connection/)
  assert.throws(() => resolveSshTargetKey(ctx, 'ssh://c2/tmp/file'), /refusing another connection/)
  assert.throws(() => resolveSshCwd(ctx, sshRoutePlaceholder('c2', '/tmp')), /refusing another connection/)
})

import { resolveSshCwd, resolveSshTargetKey, sshRoutePlaceholder } from '../../src/transport.ts'
import { makeCtx, makeCtxWithoutRegistry, makeTransport } from '../support/fakes.ts'

describe('resolveSshCwd', () => {
  const aggregate = makeTransport('aggregate@local', '/home/aggregate')
  const c1 = makeTransport('test@192.0.2.10', '/home/test')
  const c2 = makeTransport('aitest@192.0.2.20', '/data/aitest')
  const ctx = makeCtx(aggregate, { c1, c2 })

  it('routes an undefined cwd to the aggregate transport', () => {
    const route = resolveSshCwd(ctx, undefined)
    assert.equal(route.transport, aggregate)
    assert.equal(route.connectionId, undefined)
    assert.equal(route.cwd, '/home/aggregate')
  })

  it('routes local/POSIX paths through the aggregate transport', () => {
    const route = resolveSshCwd(ctx, '/var/log')
    assert.equal(route.transport, aggregate)
    assert.equal(route.connectionId, undefined)
    assert.equal(route.cwd, '/var/log')
    assert.equal(aggregate.calls.at(-1), '/var/log')
  })

  it('routes ssh://<id>/<path> to the live registry connection', () => {
    const route = resolveSshCwd(ctx, 'ssh://c1/tmp/work')
    assert.equal(route.transport, c1)
    assert.equal(route.connectionId, 'c1')
    assert.equal(route.cwd, '/tmp/work')
  })

  it('routes the local placeholder of an ssh:// target to the same connection', () => {
    const before = process.env.DSH_HOME
    process.env.DSH_HOME = 'C:\\Temp\\dsh-ssh-unit-routes'
    try {
      const placeholder = sshRoutePlaceholder('c2', '/data/aitest/repo')
      const route = resolveSshCwd(ctx, placeholder)
      assert.equal(route.transport, c2)
      assert.equal(route.connectionId, 'c2')
      assert.equal(route.cwd, '/data/aitest/repo')
    } finally {
      if (before === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = before
    }
  })

  it('fails closed for an unknown connection id', () => {
    assert.throws(() => resolveSshCwd(ctx, 'ssh://c404/tmp'), /unknown connection "c404"/u)
  })

  it('fails closed for a malformed ssh:// working directory', () => {
    assert.throws(() => resolveSshCwd(ctx, 'ssh://c1'), /invalid remote working directory/u)
    assert.throws(() => resolveSshCwd(ctx, 'ssh:///tmp'), /invalid remote working directory/u)
  })

  it('reports the missing registry as a configuration error, never a local fallback', () => {
    const bare = makeCtxWithoutRegistry(aggregate)
    assert.equal(resolveSshCwd(bare, '/var/log').transport, aggregate)
    assert.throws(() => resolveSshCwd(bare, 'ssh://c1/tmp'), /is dsh-ssh\/web mounted/u)
  })

  it('keeps concurrent routes on their own connections (no cross-talk)', async () => {
    const jobs: Promise<void>[] = []
    for (let index = 0; index < 25; index += 1) {
      const id = index % 2 === 0 ? 'c1' : 'c2'
      const expected = index % 2 === 0 ? c1 : c2
      const suffix = `/tmp/job-${index}`
      jobs.push(
        (async () => {
          const route = resolveSshCwd(ctx, `ssh://${id}${suffix}`)
          await new Promise<void>(resolve => setTimeout(resolve, index % 3))
          assert.equal(route.transport, expected, `job ${index} routed to ${route.connectionId}`)
          assert.equal(route.connectionId, id)
          assert.equal(route.cwd, suffix)
        })(),
      )
    }
    await Promise.all(jobs)
  })
})

describe('resolveSshTargetKey', () => {
  const aggregate = makeTransport('aggregate@local', '/home/aggregate')
  const c1 = makeTransport('test@192.0.2.10', '/home/test')
  const ctx = makeCtx(aggregate, { c1 })

  it('resolves a remote target key to its connection', () => {
    const route = resolveSshTargetKey(ctx, 'ssh://c1/home/test/.git/config')
    assert.equal(route.transport, c1)
    assert.equal(route.connectionId, 'c1')
    assert.equal(route.path, '/home/test/.git/config')
    assert.equal(route.cwd, '/home/test/.git/config')
  })

  it('resolves a local target key through the aggregate transport', () => {
    const route = resolveSshTargetKey(ctx, 'C:\\repo\\a.txt')
    assert.equal(route.transport, aggregate)
    assert.equal(route.connectionId, undefined)
    assert.equal(route.path, 'C:\\repo\\a.txt')
  })

  it('fails closed for an unknown connection', () => {
    assert.throws(() => resolveSshTargetKey(ctx, 'ssh://c404/tmp/x'), /unknown connection "c404"/u)
  })
})
