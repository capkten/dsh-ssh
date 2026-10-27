/** DSH 0.2.1 Desktop compatibility bridge. All routing is request scoped. */
import { Context } from '@deepseek-ai/cordis'
import { setTimeout } from 'node:timers/promises'
import { SshRegistryTransport } from './registry-ssh.ts'
import { SshFileSystem } from './filesystem-final.ts'
import { parseSshRoute } from './registry.ts'
import { parseSshPlaceholder } from './transport.ts'

export function workspaceRoute(cwd: string | undefined): { id: string; path: string } | null {
  if (cwd === undefined) return null
  const route = cwd.startsWith('ssh://') ? parseSshRoute(cwd) : parseSshPlaceholder(cwd)
  if (route === null && cwd.startsWith('ssh://')) throw new Error('dsh-ssh: invalid workspace route')
  return route
}

// These controllers expose no execution-provider extension in 0.2.1. Keep the
// compatibility surface here, preserve the official methods and their caps,
// and restore every replaced method when this plugin is unloaded.
type Method = (...args: any[]) => any
type Controller = { ctx: Context; [key: string]: any }

export function replaceMethod(owner: Controller, name: string, wrap: (original: Method) => Method): () => void {
  // Cordis traces service methods with fresh function proxies on every get.
  // Patch the underlying instance so equality checks and disposal are stable.
  owner = owner[Symbol.for('cordis.original') as never] ?? owner
  const original = owner[name]
  if (typeof original !== 'function') throw new Error(`dsh-ssh: incompatible Desktop controller: ${name}`)
  const own = Object.getOwnPropertyDescriptor(owner, name)
  const replacement = wrap(original)
  Object.defineProperty(owner, name, { configurable: true, writable: true, value: replacement })
  return () => {
    if (owner[name] !== replacement) return
    if (own === undefined) delete owner[name]
    else Object.defineProperty(owner, name, own)
  }
}

/** Mount optional UI bridges without replacing any host execution provider. */
export function apply(ctx: Context): void {
  ctx.inject(['workspaceFiles', 'sshRegistry'] as never, (child) => {
    const traced = child.get('workspaceFiles' as never) as unknown as Controller
    const controller = traced[Symbol.for('cordis.original') as never] ?? traced
    for (const name of ['read', 'readBytes', 'stat', 'list', 'changes']) {
      if (typeof controller[name] !== 'function') throw new Error(`dsh-ssh: incompatible workspaceFiles.${name}`)
    }
    const files = new Map<string, SshFileSystem>()
    const remoteFs = (id: string): SshFileSystem => {
      if (child.sshRegistry.get(id) === undefined) throw new Error(`dsh-ssh: unknown workspace connection ${id}`)
      let fs = files.get(id)
      if (fs === undefined) {
        // Independent roots also prevent Cordis's caller-context tracing from
        // rebinding providers created lazily in the same injection fiber.
        const realm = new Context()
        realm.provide('sshRegistry', child.sshRegistry)
        new SshRegistryTransport(realm, { connectionId: id })
        fs = new SshFileSystem(realm)
        child.effect(() => () => realm.fiber.dispose(), `SSH sidebar fs ${id}`)
        files.set(id, fs)
      }
      return fs
    }
    const receiver = (scope: { workspaceRoot: string }): Controller => {
      const route = workspaceRoute(scope.workspaceRoot)
      if (route === null) return controller
      const fs = remoteFs(route.id)
      // A fresh receiver per request prevents two sessions changing each
      // other's filesystem, including across awaits in the stock controller.
      const scopedContext = controller.ctx.extend({ fs })
      return Object.create(controller, { ctx: { value: scopedContext } }) as Controller
    }
    const undo = ['read', 'readBytes', 'stat', 'list'].map(name => replaceMethod(controller, name, original =>
      function (scope, ...args) { return original.call(receiver(scope), scope, ...args) }))
    undo.push(replaceMethod(controller, 'changes', original => function (scope, path, signal) {
      if (workspaceRoute(scope.workspaceRoot) === null) return original.call(controller, scope, path, signal)
      const remote = receiver(scope)
      // SFTP has no native watch. Poll the same confined listing / file stat
      // gates as previews; transport errors propagate and never use local fs.
      return (async function* () {
        const fs = remote.ctx.fs
        const target = await fs.resolve(path, { cwd: scope.workspaceRoot, signal })
        const snapshot = async () => {
          const info = await fs.stat(target, signal)
          const content = info?.type === 'directory' ? await remote.list(scope, path, signal) : info
          return { info, signature: JSON.stringify(content) }
        }
        let previous = await snapshot()
        yield { kind: 'ready' }
        while (!signal.aborted) {
          try { await setTimeout(2000, undefined, { signal }) } catch (error) {
            if (signal.aborted) return
            throw error
          }
          const current = await snapshot()
          if (current.signature !== previous.signature) {
            yield { kind: 'change', change: {
              absolutePath: fs.processPath(target),
              ...(current.info === undefined ? { absent: true } : { version: current.info.version }),
            } }
            previous = current
          }
        }
      })()
    }))
    child.effect(() => () => { for (const restore of undo.reverse()) restore() }, 'SSH workspace file bridge')
  })

  ctx.inject(['terminalController', 'agentPresets', 'workingDirectory'] as never, (child) => {
    const traced = child.get('terminalController' as never) as unknown as Controller
    const controller = traced[Symbol.for('cordis.original') as never] ?? traced
    const presets = child.agentPresets
    const undo = replaceMethod(controller, 'execution', original => function (agent) {
      const route = workspaceRoute(agent.session.header.cwd)
      if (route === null) return original.call(controller, agent)
      if (presets.composedPreset(agent.ctx) !== `dsh-ssh:${route.id}`) {
        throw new Error('dsh-ssh: remote workspace has an incompatible preset; refusing local terminal execution')
      }
      const subprocess = presets.serviceFor(agent, 'subprocess')
      if (subprocess === undefined) throw new Error('dsh-ssh: remote subprocess provider unavailable')
      const host = original.call(controller, agent)
      const convert = (cwd: string) => {
        const current = workspaceRoute(cwd)
        if (current !== null && current.id !== route.id) throw new Error('dsh-ssh: workspace target changed')
        if (current !== null) return current.path
        if (cwd.startsWith('/')) return cwd
        throw new Error('dsh-ssh: invalid remote terminal directory')
      }
      return { ...host, subprocess, workingDirectory: {
        get: (session: unknown) => convert(host.workingDirectory.get(session)),
        ensure: async (owner: unknown, signal?: AbortSignal) => convert(await host.workingDirectory.ensure(owner, signal)),
      } }
    })
    child.effect(() => undo, 'SSH sidebar terminal bridge')
  })
}
