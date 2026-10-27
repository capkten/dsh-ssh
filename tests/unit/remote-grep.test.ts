import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/tools.ts'

function harness(exitCode = 0, stderr = '') {
  const definitions: any[] = []
  const requests: any[] = []
  const ctx = {
    tools: { register: (tool: unknown) => definitions.push(tool) },
    workingDirectory: { ensure: async () => '/tmp/project' },
    subprocess: { spawn: (request: any) => {
      requests.push(request)
      return { done: Promise.resolve({ exitCode }), collected: {
        stdout: { readFrom: () => ({ text: '/tmp/project/config.json:4:bind\n' }) },
        stderr: { readFrom: () => ({ text: stderr }) },
      } }
    } },
  }
  apply(ctx as unknown as Context)
  return { grep: definitions.find(tool => tool.name === 'grep'), requests }
}

test('grep accepts a single file and retains its filename and line number', async () => {
  const { grep, requests } = harness()
  const result = await grep.execute({ pattern: 'bind', path: 'config.json' }, { agent: {}, signal: new AbortController().signal })
  assert.equal(requests[0].cwd, '/tmp/project')
  assert.ok(requests[0].argv.includes('-rInHE'))
  assert.equal(result.text, 'config.json:4:bind')
})

test('grep does not misreport a failed command setup as no matches', async () => {
  const { grep } = harness(1, 'bash: cd: permission denied')
  await assert.rejects(grep.execute({ pattern: 'bind', path: 'config.json' }, { agent: {}, signal: new AbortController().signal }), /permission denied/)
})
