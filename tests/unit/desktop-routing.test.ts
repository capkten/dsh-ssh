import assert from 'node:assert/strict'
import { test } from 'node:test'
import { replaceMethod, workspaceRoute } from '../../src/desktop.ts'
import { Context } from '@deepseek-ai/cordis'
import { apply as presetsPlugin } from '../../src/preset.ts'
import { apply as contextPlugin } from '../../src/context.ts'

test('controller bridge restores inherited methods without leaving a shadow', () => {
  const prototype = { list(value: string) { return `local:${value}` } }
  const owner = Object.create(prototype)
  const restore = replaceMethod(owner, 'list', original => value => value === 'remote' ? 'ssh' : original.call(owner, value))
  assert.equal(owner.list('local'), 'local:local')
  assert.equal(owner.list('remote'), 'ssh')
  restore()
  assert.equal(Object.hasOwn(owner, 'list'), false)
  assert.equal(owner.list('remote'), 'local:remote')
})

test('controller bridge refuses an incompatible API and does not clobber subsequent adapters', () => {
  assert.throws(() => replaceMethod({ ctx: {} } as never, 'missing', x => x), /incompatible/)
  const owner = { ctx: {}, list: () => 'original' }
  const restore = replaceMethod(owner as never, 'list', () => () => 'first')
  owner.list = () => 'later'
  restore()
  assert.equal(owner.list(), 'later')
})

test('workspace routes keep connection identity and reject invalid SSH routes', () => {
  assert.equal(workspaceRoute('C:\\local'), null)
  assert.deepEqual(workspaceRoute('ssh://c2/tmp/repo'), { id: 'c2', path: '/tmp/repo' })
  assert.throws(() => workspaceRoute('ssh://'), /invalid/)
})

test('existing blank remote sessions cannot switch to a local preset; started SSH sessions resume without reselect', async () => {
  const ctx = new Context()
  const selections: string[] = []
  const agent = { id: 'remote', ctx: new Context(), preset: 'standard', started: false,
    session: { id: 'remote', header: { cwd: 'ssh://c1/tmp' } } }
  const originalSelect = async (_agent: unknown, id: string) => {
    if (agent.started) throw new Error('This session has already started')
    selections.push(id)
    agent.preset = id
    return id
  }
  const presets = {
    register: async () => async () => {}, select: originalSelect,
    composedPreset: () => agent.preset, serviceFor: () => undefined,
  }
  ctx.provide('agentPresets', presets)
  ctx.provide('sshRegistry', { list: () => [{ id: 'c1', label: 'test', username: 'test', host: 'test', port: 22 }] } as never)
  ctx.provide('agents', { roots: () => [agent] })
  const plugin = ctx.plugin(presetsPlugin)
  await plugin.await()
  try {
    assert.equal(await presets.select(agent, 'standard'), 'dsh-ssh:c1')
    assert.deepEqual(selections, ['dsh-ssh:c1'])
    agent.started = true
    await ctx.serial('agent/created', { agent, source: 'resume' })
    assert.equal(selections.length, 1)
    agent.preset = 'standard'
    await assert.rejects(ctx.serial('agent/created', { agent, source: 'resume' }), /could not be bound/)
    agent.session.header.cwd = 'C:\\local'
    agent.started = false
    assert.equal(await presets.select(agent, 'standard'), 'standard')
  } finally { await plugin.dispose() }
  assert.equal(presets.select, originalSelect)
})

test('remote cwd contribution survives the stock post-next working-directory rewrite', async () => {
  const ctx = new Context()
  ctx.provide('systemPrompt', { context: () => {}, getContextOrder: () => 0 } as never)
  ctx.provide('workingDirectory', { get: () => 'ssh://c1/tmp/repo' } as never)
  ctx.provide('sshRegistry', { get: () => ({ endpoint: 'test@example', label: 'test' }) } as never)
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const result = await next()
    result.contexts[0]!.text = 'Current working directory: "C:\\placeholder".'
    return result
  }, { prepend: true })
  const plugin = ctx.plugin(contextPlugin)
  await plugin.await()
  try {
    const assembly = { contexts: [{ name: 'working-directory:current', text: '', interpolate: false }] }
    const context = { agent: { session: { id: 'test', header: { cwd: 'ssh://c1/tmp/repo' } } } }
    const result = await ctx.waterfall('system-prompt/assemble', assembly as never, context as never, async () => assembly as never)
    assert.match(result.contexts[0]!.text, /\/tmp\/repo/)
    assert.doesNotMatch(result.contexts[0]!.text, /placeholder/)
  } finally { await plugin.dispose() }
})
