/**
 * Shell-quoting and remote-environment scrubbing tests (`src/runtime.ts`,
 * `src/environment.ts`). Both helpers are pure and are used by the SSH
 * subprocess and PTY launchers, so a regression there silently corrupts remote
 * commands or leaks harness credentials into the remote login environment.
 *
 * Run:
 *   npx --yes tsx --tsconfig tests/tsconfig.test.json --test tests/unit
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { serializeEnvironment, scrubRemoteEnvironment } from '../../src/environment.ts'
import { quoteShellArg, wrapCwd } from '../../src/runtime.ts'

describe('quoteShellArg', () => {
  it('single-quotes plain words', () => {
    assert.equal(quoteShellArg('bash'), "'bash'")
    assert.equal(quoteShellArg('a b'), "'a b'")
    assert.equal(quoteShellArg(''), "''")
  })

  it('escapes embedded single quotes for a POSIX shell', () => {
    assert.equal(quoteShellArg("it's"), `'it'"'"'s'`)
    assert.equal(quoteShellArg("a'b'c"), `'a'"'"'b'"'"'c'`)
  })

  it('keeps expansion characters inert', () => {
    assert.equal(quoteShellArg('$HOME `id` $(id) ; & | > <'), "'$HOME `id` $(id) ; & | > <'")
  })
})

describe('wrapCwd', () => {
  it('guards the command with a cd into the quoted remote cwd', () => {
    assert.equal(wrapCwd('/tmp', 'ls -la'), "cd -- '/tmp' && ls -la")
    assert.equal(wrapCwd('/tmp/a b', 'pwd'), "cd -- '/tmp/a b' && pwd")
    assert.equal(wrapCwd("/tmp/it's", 'pwd'), `cd -- '/tmp/it'"'"'s' && pwd`)
  })
})

describe('scrubRemoteEnvironment', () => {
  it('drops harness-private DSH_* names', () => {
    const scrubbed = scrubRemoteEnvironment({ DSH_HOME: 'C:\\x', DSH_SESSION: 's1', PATH: '/usr/bin' })
    assert.deepEqual([...scrubbed.keys()], ['PATH'])
  })

  it('drops credential-shaped names', () => {
    const scrubbed = scrubRemoteEnvironment({
      DEEPSEEK_API_KEY: 'sk-x',
      MY_TOKEN: 't',
      DB_PASSWORD: 'p',
      AWS_SECRET_ACCESS_KEY: 's',
      PATH: '/usr/bin',
      HOME: '/home/test',
      LANG: 'C.UTF-8',
    })
    assert.deepEqual([...scrubbed.keys()].sort(), ['HOME', 'LANG', 'PATH'])
  })
})

describe('serializeEnvironment', () => {
  it('serializes the scrubbed base as shell-quoted `name=value` words', () => {
    const base = scrubRemoteEnvironment({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' })
    const serialized = serializeEnvironment(base, undefined)
    // The whole assignment is one quoted word, which `env -i --` accepts.
    assert.equal(serialized, "'PATH=/usr/bin:/bin' 'LANG=C.UTF-8'")
  })

  it('overlays explicit entries and supports tombstones', () => {
    const base = scrubRemoteEnvironment({ PATH: '/usr/bin:/bin', HOME: '/home/test' })
    const serialized = serializeEnvironment(base, { PATH: '/opt/bin', HOME: undefined, FOO: 'a b' })
    assert.equal(serialized, "'PATH=/opt/bin' 'FOO=a b'")
  })

  it('quotes values that need it', () => {
    const serialized = serializeEnvironment(new Map(), { FOO: "it's", BAR: 'a b' })
    assert.equal(serialized, `'FOO=it'"'"'s' 'BAR=a b'`)
  })

  it('rejects malformed names and values', () => {
    assert.throws(() => serializeEnvironment(new Map(), { '': 'x' }), /non-empty NUL-free names/u)
    assert.throws(() => serializeEnvironment(new Map(), { 'A=B': 'x' }), /non-empty NUL-free names/u)
    assert.throws(() => serializeEnvironment(new Map(), { A: 'x\u0000y' }), /NUL-free values/u)
  })
})
