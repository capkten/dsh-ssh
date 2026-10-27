/**
 * Model-facing context for remote SSH workspaces: the real remote cwd, the
 * connection endpoint, and the fact that the execution world is remote POSIX.
 *
 * Mounted at HOST scope (not inside the per-session preset realm) because
 * `system-prompt/assemble` dispatches along the Agent's Cordis context chain;
 * the contributing text is derived from the session's cwd route, so local
 * sessions get an empty contribution and are unaffected.
 *
 * This never simulates execution — it only reports route metadata the session
 * already carries (the local placeholder maps back to a registry connection).
 * @module dsh-ssh/context
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { parseSshRoute, SshRegistry } from './registry.ts'
import { parseSshPlaceholder } from './transport.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Session working-directory owner (host-plane service). */
    workingDirectory: {
      get(session: { id: string }): string
      ensure(agent: unknown, signal?: AbortSignal): Promise<string>
      set(agent: unknown, path: string, signal?: AbortSignal): Promise<string>
    }
    /** Deployment sandbox policy (host-plane service). */
    sandboxPolicy: {
      defaultMode: SandboxMode
      resolve(request?: { session?: { header: { cwd?: string } } }): { mode: SandboxMode; workspaceRoot: string }
    }
  }
}

/** Resolved route facts of one working-directory spelling. */
interface RemoteLocation {
  container?: string
  connectionId: string
  path: string
  endpoint: string
  label: string
}

/**
 * Resolve a session working directory into its remote route.
 * @param ctx - context carrying the connection registry.
 * @param cwd - the session's current working-directory spelling.
 * @returns route facts, or undefined for a local (non-routed) directory.
 */
function locate(ctx: Context, cwd: string | undefined): RemoteLocation | undefined {
  if (cwd === undefined) return undefined
  const parsed = cwd.startsWith('ssh://') ? parseSshRoute(cwd) : parseSshPlaceholder(cwd)
  if (parsed === null) return undefined
  const registry = ctx.get('sshRegistry') as SshRegistry | undefined
  const connection = registry?.get(parsed.id)
  if (connection === undefined) return undefined
  return {
    connectionId: parsed.id,
    path: parsed.path,
    endpoint: connection.endpoint,
    label: connection.label,
    ...(connection.spec?.docker === undefined ? {} : { container: connection.spec.docker.container }),
  }
}

/** The remote location a session currently runs in, if its cwd is routed. */
function locationOf(ctx: Context, session: { id: string } & { header: { cwd?: string } }): RemoteLocation | undefined {
  const current = ctx.workingDirectory.get(session as never)
  const located = locate(ctx, current)
  if (located !== undefined) return located
  // A working-directory change was committed as a bare remote POSIX path;
  // fall back to the session's original route for the connection facts.
  const original = locate(ctx, session.header.cwd)
  if (original !== undefined && current.startsWith('/')) return { ...original, path: current }
  return undefined
}

/**
 * Mount the remote workspace context.
 * @param ctx - mounting context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['systemPrompt', 'workingDirectory', 'sshRegistry'], (child) => {
    child.systemPrompt.context({
      name: 'ssh-remote:workspace',
      order: child.systemPrompt.getContextOrder('WORKING_DIRECTORY') + 1,
      text: (context) => {
        const session = context.agent?.session
        if (session === undefined) return ''
        const located = locationOf(child, session)
        if (located === undefined) return ''
        return [
          located.container === undefined
            ? `This session executes on a REMOTE host reached over SSH (${located.label} — ${located.endpoint}).`
            : `This session executes INSIDE Docker container ${located.container}, reached through SSH (${located.label} — ${located.endpoint}). Files, commands and terminals share this container target; the SSH host filesystem is a different workspace.`,
          `The remote working directory is ${JSON.stringify(located.path)}; it is a POSIX path on that host, not a path on the harness host.`,
          'Every shell command, file read/write/edit, glob/grep, background job and terminal in this session runs there.',
          'Use POSIX commands and paths (bash, forward slashes); Windows drive paths and PowerShell are unavailable in this session.',
        ].join(' ')
      },
    })

    // The stock working-directory contribution prints the local route
    // placeholder. Replace it so the model never reads a Windows path as the
    // project location while the providers execute remotely.
    // The stock listener also rewrites after next(); prepend makes this
    // listener the outer one so the remote contribution is applied last.
    child.on('system-prompt/assemble', async (assembly, context, next) => {
      const result = await next()
      const session = context.agent?.session
      if (session === undefined) return result
      const located = locationOf(child, session)
      if (located === undefined) return result
      const contribution = result.contexts.find(entry => entry.name === 'working-directory:current')
      const text = `Current working directory: ${JSON.stringify(located.path)} (remote host ${located.endpoint} over SSH; POSIX paths).`
      if (contribution === undefined) {
        result.contexts.unshift({ name: 'working-directory:current', text, interpolate: false })
      } else {
        contribution.text = text
        contribution.interpolate = false
      }
      return result
    }, { prepend: true })
  })
}
