/**
 * `sshRoutePlaceholder` / `routeFromPlaceholder` tests — the local placeholder
 * tree that stands in for a remote route when the harness insists on a local
 * absolute workspace path.
 *
 * The placeholder root is derived from `$DSH_HOME` at call time, so each test
 * points `$DSH_HOME` at an isolated temporary directory.
 *
 * Run:
 *   npx --yes tsx --tsconfig tests/tsconfig.test.json --test tests/unit
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'

import { parseSshTargetKey, sshRoutePlaceholder, sshRoutesRoot } from '../../src/transport.ts'

const homes: string[] = []
let home: string

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-unit-home-'))
  homes.push(dir)
  return dir
}

beforeEach(() => {
  home = freshHome()
  process.env.DSH_HOME = home
})

after(() => {
  delete process.env.DSH_HOME
  for (const dir of homes) rmSync(dir, { recursive: true, force: true })
})

describe('sshRoutesRoot', () => {
  it('honours $DSH_HOME', () => {
    assert.equal(sshRoutesRoot(), resolve(home, 'dsh-ssh-routes'))
  })
})

describe('sshRoutePlaceholder', () => {
  it('puts a remote directory under <DSH_HOME>/dsh-ssh-routes/<id>/', () => {
    const root = sshRoutesRoot()
    assert.equal(sshRoutePlaceholder('c1', '/tmp/x'), join(root, 'c1', 'tmp', 'x'))
    assert.equal(sshRoutePlaceholder('c1', '/'), join(root, 'c1'))
    assert.equal(sshRoutePlaceholder('c1', '/tmp/a b'), join(root, 'c1', 'tmp', 'a b'))
  })

  it('round-trips through parseSshTargetKey', () => {
    for (const remote of ['/', '/tmp', '/tmp/x', '/tmp/x/', '/home/test/.git/config', '/a b/c d']) {
      const placeholder = sshRoutePlaceholder('c1', remote)
      const parsed = parseSshTargetKey(placeholder)
      const expected = remote === '/' ? '/' : remote.replace(/\/+$/u, '')
      assert.equal(parsed.connectionId, 'c1', `${remote} must stay on connection c1`)
      assert.equal(parsed.path, expected, `${remote} must round-trip`)
    }
  })

  it('normalizes duplicate separators and dot segments', () => {
    const root = sshRoutesRoot()
    assert.equal(sshRoutePlaceholder('c1', '//tmp//x'), join(root, 'c1', 'tmp', 'x'))
    assert.equal(sshRoutePlaceholder('c1', '/tmp/./x'), join(root, 'c1', 'tmp', 'x'))
  })

  it('clamps `..` traversal at the connection root', () => {
    const root = sshRoutesRoot()
    const connectionRoot = join(root, 'c1')
    for (const remote of ['/../../etc/passwd', '/a/../../b', '/..', '/../../../..']) {
      const placeholder = sshRoutePlaceholder('c1', remote)
      const resolved = resolve(placeholder)
      assert.equal(
        resolved === connectionRoot || resolved.startsWith(connectionRoot + sep),
        true,
        `${remote} escaped ${connectionRoot} (got ${resolved})`,
      )
      const parsed = parseSshTargetKey(placeholder)
      assert.equal(parsed.connectionId, 'c1')
      assert.equal(parsed.path.startsWith('/..'), false)
    }
  })

  it('rejects connection ids outside the registry alphabet', () => {
    for (const id of ['a/b', 'a b', '', 'c$1', 'c1\n']) {
      assert.throws(() => sshRoutePlaceholder(id, '/tmp'), /invalid connection id/iu, `id ${JSON.stringify(id)}`)
    }
  })

  it('rejects remote paths whose characters cannot be represented in a local route placeholder', () => {
    for (const remote of ['C:/tmp/x', '\\\\..\\\\..\\\\evil', '/tmp/a\\b', '/tmp/a:b', '/tmp/a\u0000b']) {
      assert.throws(
        () => sshRoutePlaceholder('c1', remote),
        /cannot be represented in a local route placeholder/u,
        `remote ${JSON.stringify(remote)}`,
      )
    }
  })

  it('rejects ids that would alias the route root (`.` / `..`)', () => {
    for (const id of ['.', '..']) {
      assert.throws(() => sshRoutePlaceholder(id, '/tmp'), /invalid connection id/iu, `id ${JSON.stringify(id)}`)
    }
  })
})

describe('$DSH_HOME handling', () => {
  it('falls back to ~/.dsh/dsh-ssh-routes when $DSH_HOME is unset', () => {
    delete process.env.DSH_HOME
    assert.equal(sshRoutesRoot(), resolve(homedir(), '.dsh', 'dsh-ssh-routes'))
  })

  it('ignores placeholder spelling of a different home', () => {
    // A placeholder from another home is not a route for this process.
    const other = sshRoutePlaceholder('c1', '/tmp/x')
    const otherHome = freshHome()
    process.env.DSH_HOME = otherHome
    const parsed = parseSshTargetKey(other)
    assert.equal(parsed.connectionId, undefined)
    assert.equal(parsed.path, other)
  })
})
