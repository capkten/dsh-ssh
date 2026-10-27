/**
 * One registry-owned SSH connection projected onto the `ctx.ssh` transport face
 * used by the remote capability providers. A remote agent preset mounts this
 * service with the connection id it belongs to, so POSIX absolute paths that
 * carry no `ssh://` spelling still resolve against the same host.
 * @module dsh-ssh/registry-ssh
 */

import { posix } from 'node:path'
import type { Client, SFTPWrapper } from 'ssh2'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parseSshRoute, SshRegistry } from './registry.ts'
import type { SshConnection } from './connection.ts'
import { sshDebug } from './debug.ts'
import type { ExecOutcome } from './runtime.ts'
import type { SshTransport } from './transport.ts'

/** Config of one registry transport row. */
export interface RegistrySshConfig {
  /** Registry entry id (`c1`, `c2`, …). */
  connectionId: string
}

/**
 * `ctx.ssh` implementation backed by one registry connection. The remote
 * providers (`dsh-ssh/fs`, `dsh-ssh/subprocess`, `dsh-ssh/shell`) inject this
 * service inside their own isolated agent-preset realm, so they never share a
 * connection with a different workspace.
 */
export class SshRegistryTransport extends Service implements SshTransport {
  static inject = ['sshRegistry']

  static Config: z<RegistrySshConfig> = z.object({
    connectionId: z.string().required(),
  })

  private readonly connectionId: string

  get boundConnectionId(): string { return this.connectionId }

  constructor(ctx: Context, config: RegistrySshConfig) {
    super(ctx, 'ssh')
    if (!/^[A-Za-z0-9._-]+$/.test(config.connectionId)) {
      throw new Error(`dsh-ssh: invalid connection id ${JSON.stringify(config.connectionId)}`)
    }
    this.connectionId = config.connectionId
    sshDebug(`registry transport bound to connection "${this.connectionId}"`)
  }

  /** The registry connection this transport is bound to. */
  get connection(): SshConnection {
    const registry = this.ctx.get('sshRegistry') as SshRegistry | undefined
    if (registry === undefined) {
      throw new Error('dsh-ssh: the connection registry is not mounted (is dsh-ssh/web loaded?)')
    }
    const connection = registry.get(this.connectionId)
    if (connection === undefined) {
      throw new Error(`dsh-ssh: remote workspace names unknown connection "${this.connectionId}"`)
    }
    return connection
  }

  /** @inheritdoc */
  get endpoint(): string {
    return this.connection.endpoint
  }

  /** @inheritdoc */
  get cwd(): string {
    return this.connection.cwd
  }

  /** @inheritdoc */
  getClient(signal?: AbortSignal): Promise<Client> {
    sshDebug(`dial ${this.connection.endpoint} (connection "${this.connectionId}")`)
    return this.connection.getClient(signal)
  }

  /** @inheritdoc */
  getSftp(signal?: AbortSignal): Promise<SFTPWrapper> {
    return this.connection.getSftp(signal)
  }

  /** @inheritdoc */
  getRemoteEnvironment(signal?: AbortSignal): Promise<Record<string, string>> {
    return this.connection.getRemoteEnvironment(signal)
  }

  /** @inheritdoc */
  exec(command: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<ExecOutcome> {
    return this.connection.exec(command, opts)
  }

  /**
   * Map a caller-supplied working directory onto this bound connection. An
   * `ssh://` spelling naming THIS connection is unwrapped; another connection's
   * route is rejected instead of silently crossing hosts.
   * @inheritdoc
   */
  resolveRemoteCwd(cwd: string | undefined): string {
    if (cwd !== undefined && cwd.startsWith('ssh://')) {
      const route = parseSshRoute(cwd)
      if (route === null || route.id !== this.connectionId) {
        throw new Error(`dsh-ssh: working directory ${JSON.stringify(cwd)} belongs to another connection`)
      }
      return route.path
    }
    // Fail closed: a remote preset must never quietly reinterpret a harness
    // host path (Windows drive/UNC) as somewhere on the remote host.
    if (cwd !== undefined && !posix.isAbsolute(cwd) && (/^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('//') || cwd.startsWith('\\\\'))) {
      throw new Error(`dsh-ssh: local host path ${JSON.stringify(cwd)} cannot be used as a remote working directory`)
    }
    return this.connection.resolveRemoteCwd(cwd)
  }
}

export default SshRegistryTransport
