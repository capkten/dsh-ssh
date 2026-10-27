import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import { SshFileSystem } from '../../src/filesystem-final.ts'

test('an unconsumed preview iterable does not open an unobserved remote stream', async () => {
  const ctx = new Context()
  let opened = 0
  ctx.provide('ssh', { resolveRemoteCwd: (path: string) => path, getSftp: async () => ({ createReadStream: () => { opened++; return Readable.from(['hello']) } }) } as never)
  const fs = new SshFileSystem(ctx)
  Object.assign(fs, { requireRegular: async () => ({ type: 'file' }) })
  const iterable = await fs.streamText({ targetKey: FsTargetKey('/tmp/probe'), displayPath: '/tmp/probe' })
  assert.equal(opened, 0)
  let text = ''
  for await (const chunk of iterable) text += chunk
  assert.equal(text, 'hello')
  assert.equal(opened, 1)
})
