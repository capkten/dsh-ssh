/**
 * Pure routing-parser tests for `ssh://` targets.
 *
 * The functions under test are imported from `src/` unchanged; only the two
 * collaborators that `resolveSshCwd` reads are substituted (see
 * `tests/support/fakes.ts`).
 *
 * Run:
 *   npx --yes tsx --tsconfig tests/tsconfig.test.json --test tests/unit
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { parseSshRoute } from '../../src/registry.ts'
import { isSshRoutePath, parseSshPlaceholder, parseSshTargetKey, sshRoutePlaceholder, sshTargetKey } from '../../src/transport.ts'

describe('parseSshRoute', () => {
  it('parses ssh://<id>/<absolute posix path>', () => {
    assert.deepEqual(parseSshRoute('ssh://c1/tmp/x'), { id: 'c1', path: '/tmp/x' })
    assert.deepEqual(parseSshRoute('ssh://c12/'), { id: 'c12', path: '/' })
    assert.deepEqual(parseSshRoute('ssh://c1/home/test/a b/c.txt'), { id: 'c1', path: '/home/test/a b/c.txt' })
  })

  it('accepts the registry id alphabet (letters, digits, dot, underscore, dash)', () => {
    assert.deepEqual(parseSshRoute('ssh://c1.2_3-4/tmp'), { id: 'c1.2_3-4', path: '/tmp' })
  })

  it('returns null for non-ssh spellings', () => {
    assert.equal(parseSshRoute(''), null)
    assert.equal(parseSshRoute('/tmp/x'), null)
    assert.equal(parseSshRoute('C:\\repo\\x.txt'), null)
    assert.equal(parseSshRoute('sftp://c1/tmp'), null)
    assert.equal(parseSshRoute('ssh:c1/tmp'), null)
  })

  it('returns null for a missing id or a non-absolute path', () => {
    assert.equal(parseSshRoute('ssh://'), null)
    assert.equal(parseSshRoute('ssh:///tmp'), null)
    assert.equal(parseSshRoute('ssh://c1'), null)
    assert.equal(parseSshRoute('ssh://c1tmp'), null)
  })

  it('returns null for an id outside the registry alphabet', () => {
    assert.equal(parseSshRoute('ssh://c 1/tmp'), null)
    assert.equal(parseSshRoute('ssh://c%201/tmp'), null)
  })

  it('keeps the remote path verbatim (no posix normalization at parse time)', () => {
    assert.deepEqual(parseSshRoute('ssh://c1//tmp//x'), { id: 'c1', path: '//tmp//x' })
    assert.deepEqual(parseSshRoute('ssh://c1/tmp/../x'), { id: 'c1', path: '/tmp/../x' })
    assert.deepEqual(parseSshRoute('ssh://c1/tmp/../../etc'), { id: 'c1', path: '/tmp/../../etc' })
  })
})

describe('sshTargetKey / parseSshTargetKey', () => {
  it('builds the opaque target key', () => {
    assert.equal(sshTargetKey('c1', '/tmp/x'), 'ssh://c1/tmp/x')
    assert.equal(sshTargetKey('c1', '/'), 'ssh://c1/')
  })

  it('round-trips a remote target key', () => {
    const key = sshTargetKey('c9', '/home/aitest/some dir/file.txt')
    assert.deepEqual(parseSshTargetKey(key), { connectionId: 'c9', path: '/home/aitest/some dir/file.txt' })
  })

  it('treats an unmatched target key as a plain local path', () => {
    for (const local of ['C:\\repo\\a.txt', '/tmp/local.txt', 'relative/file.txt', '']) {
      assert.deepEqual(parseSshTargetKey(local), { path: local })
    }
  })

  it('does not claim ssh-looking strings that are not valid routes', () => {
    // 'ssh://' with an empty id is not a route: it stays a plain local path.
    assert.deepEqual(parseSshTargetKey('ssh:///tmp'), { path: 'ssh:///tmp' })
  })
})

describe('parseSshPlaceholder / isSshRoutePath', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-ssh-unit-route-'))
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('recognizes both route spellings and rejects local paths', () => {
    const placeholder = sshRoutePlaceholder('c1', '/tmp/x')
    assert.equal(isSshRoutePath('ssh://c1/tmp/x'), true)
    assert.equal(isSshRoutePath(placeholder), true)
    assert.equal(isSshRoutePath('C:\\repo\\x.txt'), false)
    assert.equal(isSshRoutePath('/tmp/x'), false)
  })

  it('parses a placeholder back to connection id and absolute remote path', () => {
    assert.deepEqual(parseSshPlaceholder(sshRoutePlaceholder('c2', '/home/aitest/repo')), { id: 'c2', path: '/home/aitest/repo' })
    assert.deepEqual(parseSshPlaceholder(sshRoutePlaceholder('c2', '/')), { id: 'c2', path: '/' })
  })

  it('returns null for local paths and for placeholders of another home', () => {
    const placeholder = sshRoutePlaceholder('c1', '/tmp/x')
    assert.equal(parseSshPlaceholder('C:\\repo\\x.txt'), null)
    assert.equal(parseSshPlaceholder('/tmp/x'), null)
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-ssh-unit-other-'))
    assert.equal(parseSshPlaceholder(placeholder), null)
  })
})
