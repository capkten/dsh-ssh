/**
 * Remote agent presets: one isolated Cordis realm per SSH connection whose
 * tools, shell, filesystem, subprocess and terminal paths all execute on that
 * remote host.
 *
 * DSH 0.2.1 mounts model-facing tools per session through an agent preset, and
 * the stock preset resolves the HOST `fs`/`subprocess`/`shell` services. This
 * module registers a preset per registered SSH connection and switches a newly
 * created session onto it when the session's working directory is a remote
 * route (the local placeholder under `<dsh home>/dsh-ssh-routes/<id>/…`). Local
 * sessions keep the stock preset and are untouched.
 *
 * A routed session that cannot be switched fails loudly instead of silently
 * running its tools on the harness host.
 * @module dsh-ssh/preset
 */

import type { Context } from '@deepseek-ai/cordis'
import { parseSshRoute, SshRegistry } from './registry.ts'
import type { SshConnectionView } from './registry.ts'
import { parseSshPlaceholder } from './transport.ts'
import { replaceMethod } from './desktop.ts'

/** Minimal shape of one live Agent (only the fields this module reads). */
interface AgentLike {
  id: string
  ctx: Context
  session: { id: string; header: { cwd?: string } }
}

/** Minimal shape of the agent-preset registry service. */
interface AgentPresetsLike {
  register(definition: PresetDefinition): Promise<() => Promise<void>>
  select(agent: AgentLike, agentPreset: string): Promise<string>
  composedPreset(ctx: Context): string | undefined
  serviceFor(agent: AgentLike, name: string): unknown
}

/** One declarative agent preset. */
interface PresetDefinition {
  id: string
  name?: string
  description?: string
  order?: number
  plugins: unknown[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentPresets: AgentPresetsLike
    agents: { roots(): AgentLike[] }
  }
  interface Events {
    'agent/created'(payload: { agent: AgentLike; source: string; signal?: AbortSignal }): void | Promise<void>
  }
}

/** Preset identity of one registry connection. */
export function sshRemotePresetId(connectionId: string): string {
  return `dsh-ssh:${connectionId}`
}

/** Where one session working-directory spelling points. */
function routeOf(cwd: string | undefined): { id: string; path: string } | null {
  if (cwd === undefined) return null
  return cwd.startsWith('ssh://') ? parseSshRoute(cwd) : parseSshPlaceholder(cwd)
}

/**
 * The plugin rows of one remote preset. Everything that executes or reads files
 * sits inside one isolated group so the remote providers shadow the host's
 * local `fs`/`subprocess`/`shell` services for this preset only; the rest of
 * the agent composition (prompt, compaction, delegation, skills) is the
 * standard coding-agent set with the PowerShell tool replaced by Bash and the
 * host-ripgrep search tools replaced by the remote search tools.
 * @param connectionId - registry connection the realm is bound to.
 * @returns the preset plugin list.
 */
function remotePresetPlugins(connectionId: string, compaction: PresetCompactionConfig): unknown[] {
  return [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: {
        prefix: 'You are a coding agent powered by the {{model}} model. '
          + 'This session is a REMOTE SSH workspace: every command, file operation, search, background job and terminal runs on the remote host, '
          + 'and the project lives there. Use POSIX/bash tooling and paths; do not assume the harness host filesystem is reachable.',
      },
    },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    {
      id: 'remote-world',
      name: 'cordis:group',
      group: true,
      isolate: { fs: true, subprocess: true, shell: true, ssh: true, terminals: true },
      config: [
        { id: 'ssh', name: 'dsh-ssh/registry-ssh', config: { connectionId } },
        { id: 'subprocess', name: 'dsh-ssh/subprocess' },
        { id: 'fs', name: 'dsh-ssh/fs' },
        { id: 'shell', name: 'dsh-ssh/shell' },
        // Model-facing persistent terminal over the remote PTY primitive.
        { id: 'terminals', name: '@deepseek-ai/dsh-terminal' },
        { id: 'terminal-bash', name: '@deepseek-ai/dsh-terminal-bash', config: { shellDialect: 'bash' } },
        { id: 'tool-terminal', name: '@deepseek-ai/dsh-tool-terminal' },
        { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
        { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
        { id: 'tool-search', name: 'dsh-ssh/tools' },
        { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
        { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
        { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
        { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
        { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
        { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
        {
          id: 'planning',
          name: 'cordis:group',
          group: true,
          isolate: { planMode: true },
          config: [{
            id: 'plan-mode',
            name: '@deepseek-ai/dsh-plan-mode',
            config: {
              section: [
                'You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it.',
                'Explore first with non-mutating reads, searches and checks that run on the remote SSH host. Do not edit or write files, change configuration, commit, or otherwise carry out the plan.',
                'Make the plan decision-complete: goal and success criteria, implementation changes grouped by subsystem, public API/schema/data-flow changes, edge cases, failure modes, tests and acceptance criteria.',
                'When ready, call exit_plan_mode with the complete plan markdown starting with a # title; make it the only and final tool call in that response.',
              ].join('\n\n'),
            },
          }],
        },
        {
          id: 'compaction',
          name: 'cordis:group',
          group: true,
          isolate: { compaction: true, toolResultPruner: true },
          config: [
            {
              id: 'compaction-basic',
              name: compaction.compactionProvider ?? '@deepseek-ai/dsh-compaction-basic',
              ...(compaction.compactionConfig === undefined ? {} : { config: structuredClone(compaction.compactionConfig) }),
            },
            { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
            { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner' },
          ],
        },
        {
          id: 'delegation',
          name: 'cordis:group',
          group: true,
          isolate: { workflowEngine: true },
          config: [
            { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
            // DSH 0.2.2 integrates list_agents into the control plugin; the old subpath is no longer exported.
            { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', toolName: 'subagent' } },
            { id: 'tool-subagent-fork', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'fork', toolName: 'subagent_fork' } },
            { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' } },
            { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
          ],
        },
        { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
        { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
        { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
        { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
      ],
    },
  ]
}

/**
 * Build the preset declaration for one registry connection.
 * @param view - secret-free connection view.
 * @returns the preset definition.
 */
function presetDefinition(view: SshConnectionView, compaction: PresetCompactionConfig): PresetDefinition {
  return {
    id: sshRemotePresetId(view.id),
    name: `${view.docker === undefined ? 'SSH' : 'Docker'} — ${view.label}`,
    description: `Remote workspace on ${view.username}@${view.host}:${view.port} over SSH (${view.id}).`,
    order: 90,
    plugins: remotePresetPlugins(view.id, compaction),
  }
}

/** Optional provider selection for every isolated remote compaction realm. */
export interface PresetCompactionConfig {
  /** Provider package; omitted values use the official compaction engine. */
  compactionProvider?: string
  /** Provider-owned settings copied into every isolated remote preset. */
  compactionConfig?: Record<string, unknown>
}

/**
 * Mount remote presets and bind routed sessions before their first turn.
 * @param ctx - mounting context.
 * @param compaction - optional compaction provider and its configuration.
 */
export function apply(ctx: Context, compaction: PresetCompactionConfig = {}): void {
  ctx.inject(['agentPresets', 'sshRegistry', 'agents'], (child) => {
    const presets = child.agentPresets
    const registry = child.sshRegistry as SshRegistry
    const agents = child.agents as { roots(): AgentLike[] }
    const disposers = new Map<string, () => Promise<void>>()
    const registering = new Map<string, Promise<() => Promise<void>>>()
    let disposed = false

    const viewOf = (id: string): SshConnectionView | undefined => registry.list().find(view => view.id === id)

    /** Register (idempotently) the remote preset of one connection. */
    const ensurePreset = async (connectionId: string): Promise<string> => {
      const id = sshRemotePresetId(connectionId)
      if (disposers.has(connectionId)) return id
      const inflight = registering.get(connectionId)
      if (inflight !== undefined) {
        await inflight
        return id
      }
      const view = viewOf(connectionId)
      if (view === undefined) throw new Error(`dsh-ssh: cannot create a remote preset for unknown connection "${connectionId}"`)
      const registration = presets.register(presetDefinition(view, compaction)).then((dispose) => {
        if (disposed) {
          void dispose()
        } else {
          disposers.set(connectionId, dispose)
          registering.delete(connectionId)
        }
        return dispose
      }).catch((error: unknown) => {
        registering.delete(connectionId)
        throw error
      })
      registering.set(connectionId, registration)
      await registration
      return id
    }

    /** Drop the preset of a removed connection. */
    const dropPreset = async (connectionId: string): Promise<void> => {
      const dispose = disposers.get(connectionId)
      if (dispose === undefined) return
      disposers.delete(connectionId)
      try {
        await dispose()
      } catch (error) {
        child.logger.warn(`dsh-ssh: failed to dispose the preset of connection "${connectionId}": ${String(error)}`)
      }
    }

    /** Align live presets with the registry's current connection list. */
    const sync = async (): Promise<void> => {
      const ids = new Set(registry.list().map(view => view.id))
      for (const connectionId of [...disposers.keys()]) {
        if (!ids.has(connectionId)) await dropPreset(connectionId)
      }
      for (const connectionId of ids) {
        try {
          await ensurePreset(connectionId)
        } catch (error) {
          child.logger.warn(`dsh-ssh: cannot register the remote preset of connection "${connectionId}": ${String(error)}`)
        }
      }
    }

    const stopRegistry = child.on('ssh-registry/change', () => { void sync() })
    // Existing blank sessions can be reused by the UI without agent/created.
    // Enforce their workspace binding on every preset selection as well.
    const restoreSelect = replaceMethod(presets as never, 'select', original => async function (agent: AgentLike, requested: string) {
      const route = routeOf(agent.session.header.cwd)
      const target = route === null ? requested : await ensurePreset(route.id)
      return original.call(presets, agent, target)
    })
    const stopAgents = child.on('agent/created', async ({ agent, source }) => {
      // Child agents inherit their parent's preset through composeFrom; only a
      // top-level Agent gets its preset decided here.
      if (!agents.roots().some(root => root.id === agent.id)) return
      const route = routeOf(agent.session.header.cwd)
      if (route === null) return
      const presetId = await ensurePreset(route.id)
      // select() deliberately rejects started sessions even when the requested
      // preset matches. A correctly composed resumed session needs no switch.
      if (presets.composedPreset(agent.ctx) === presetId) return
      try {
        await presets.select(agent, presetId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (source === 'resume') {
          // Fail closed: a routed session that cannot get the remote preset
          // would silently run every tool on the harness host.
          throw new Error(
            `dsh-ssh: session "${agent.id}" belongs to a remote workspace but could not be bound to preset "${presetId}" (${message}). `
            + 'This session was created before remote routing or has already started; start a new session in this workspace.',
            { cause: error },
          )
        }
        throw new Error(`dsh-ssh: failed to bind session "${agent.id}" to remote preset "${presetId}": ${message}`, { cause: error })
      }
    })

    child.effect(() => async () => {
      disposed = true
      stopRegistry()
      stopAgents()
      restoreSelect()
      const all = [...disposers.values()]
      disposers.clear()
      await Promise.allSettled(all.map(dispose => dispose()))
    }, 'dsh-ssh remote presets')

    void sync()
  })
}
