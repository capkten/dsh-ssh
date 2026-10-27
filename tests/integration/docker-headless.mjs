/** Real Agent/scheduler/tools integration in a disposable Profile. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SshConnection } from '../../lib/connection.js'
import { quoteShellArg as q } from '../../lib/runtime.js'
import { makeIsolatedHome, destroyHome, writeProfile, installLocalDshSsh, startMockLlm, runHeadless } from './lib.mjs'

const home = makeIsolatedHome('dsh-docker-headless')
const root = '/tmp/dsh-ssh-test-' + randomUUID()
const connection = new SshConnection({ id: 'c1', label: 'Docker isolated', host: process.env.DSH_DOCKER_HOST ?? '', port: 22, username: process.env.DSH_DOCKER_USER ?? '',
  privateKeyPath: process.env.DSH_DOCKER_KEY, strictHostKeyChecking: true, cwd: root, docker: { container: process.env.DSH_DOCKER_CONTAINER ?? '' } })
let mock
try {
  await connection.prepareDocker()
  assert.equal((await connection.exec(`mkdir -- ${q(root)} && cd -- ${q(root)} && git init -q && printf 'DOCKER_FIXTURE\n' > fixture.txt`)).exitCode, 0)
  const profile = writeProfile({ home, name: 'docker', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'dsh-ssh'], patchYaml: `
- id: session-title-llm
  disabled: true
- id: tools
  config:
    mode: ptc
- insert:
    - id: ssh-registry
      name: dsh-ssh/registry
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: standard
- id: ssh-remote
  name: dsh-ssh
  config: {}
- id: directory-picker-ssh
  disabled: true
- id: ssh-web-channel
  disabled: true
` })
  installLocalDshSsh(profile)
  const preset = join(profile, 'standard.patch.yml')
  const extractRoot = process.env.DSH_EXTRACT_ROOT ?? ''
  assert.ok(extractRoot, 'Set DSH_EXTRACT_ROOT to the extracted DSH package directory')
  writeFileSync(preset, readFileSync(join(extractRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml')))
  writeFileSync(join(home, 'dsh-ssh-connections.json'), JSON.stringify({ connections: [connection.spec] }))
  const placeholder = join(home, 'dsh-ssh-routes', 'c1', ...root.split('/').filter(Boolean))
  mkdirSync(placeholder, { recursive: true })
  const code = `const shell=await tools.bash({command:'hostname;pwd;uname -s;git rev-parse --is-inside-work-tree',description:'Docker target verification'});
const read=await tools.read({file_path:'fixture.txt'});
const git=await tools.read({file_path:'.git/HEAD'});
const write=await tools.write({file_path:'written.txt',content:'DOCKER_WRITE_OK\\n'});
const observed=await tools.read({file_path:'written.txt'});
const edit=await tools.edit({file_path:'written.txt',old_string:'DOCKER_WRITE_OK',new_string:'DOCKER_EDIT_OK'});
const glob=await tools.glob({pattern:'*.txt'});
const grep=await tools.grep({pattern:'DOCKER_EDIT_OK',path:'written.txt'});
return {shell,read,git,write,observed,edit,glob,grep};`
  mock = await startMockLlm({ sequence: ['tool_call_success', 'success'], toolName: 'run_code', toolArguments: JSON.stringify({ code, description: 'Real Docker native tools' }), successText: 'mock finished' })
  const run = await runHeadless({ home, profile: 'docker', cwd: placeholder, llmBaseURL: mock.baseURL, task: 'Verify the isolated Docker fixture', extraArgs: ['--patch', preset], timeoutMs: 180000 })
  const actual = run.toolResults.map(result => String(result.result ?? '')).join('\n')
  const file = await connection.exec(`cat -- ${q(root + '/written.txt')}`)
  const report = { ok: run.toolResults.some(result => result.status === 'completed') && actual.includes('DOCKER_FIXTURE') && actual.includes('DOCKER_EDIT_OK') && file.stdout.includes('DOCKER_EDIT_OK'),
    exitCode: run.exitCode, terminatedAfterFinal: run.terminatedAfterFinal, toolCalls: run.toolCalls, toolResults: run.toolResults, externalFile: file.stdout, stderr: run.stderr }
  console.log(JSON.stringify(report, null, 2))
  assert.equal(report.ok, true)
} finally {
  if (mock) await mock.close()
  try { assert.match(root, /^\/tmp\/dsh-ssh-test-[a-f0-9-]{36}$/); assert.equal((await connection.exec(`rm -rf -- ${q(root)}; test ! -e ${q(root)}`)).exitCode, 0) }
  finally { connection.dispose(); destroyHome(home) }
}
