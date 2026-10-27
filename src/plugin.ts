/**
 * Aggregate plugin for a Web/Desktop profile: mounts the remote agent-preset
 * controller. Remote capability providers (`fs`, `subprocess`, `shell`, `ssh`)
 * are no longer published into the HOST service realm — that made them collide
 * with the local providers and left every session on the local filesystem.
 * They are mounted per session inside the isolated remote preset instead (see
 * `./preset.ts`), so local sessions keep the stock tools and routed sessions
 * get the remote ones.
 *
 * A host-wide SSH execution world is still available for manual compositions:
 * mount `dsh-ssh/ssh` + `dsh-ssh/subprocess` + `dsh-ssh/fs` yourself (the
 * README documents the provider-disabling setup that requires).
 * @module dsh-ssh/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import SshRuntime from './runtime.ts'
import type { Config as SshConfig } from './runtime.ts'
import { apply as applyContext } from './context.ts'
import { apply as applyPresets } from './preset.ts'
import { apply as applyDesktop } from './desktop.ts'

/** Aggregate config: optional legacy host-wide connection plus preset control. */
export interface Config {
  /** Legacy host-wide target hostname. Omit for the preset-only composition. */
  host?: string
  /** Legacy host-wide SSH port. */
  port?: number
  /** Legacy host-wide login user. */
  username?: string
  /** Legacy host-wide password. */
  password?: string
  /** Legacy host-wide private key (PEM content or local path). */
  privateKey?: string
  /** Legacy host-wide passphrase. */
  passphrase?: string
  /** Legacy host-wide agent socket / `pageant`. */
  agent?: string
  /** Legacy host-wide ProxyJump chain. */
  jump?: SshConfig['jump']
  /** Legacy host-wide remote working directory. */
  cwd?: string
  /** Legacy host-wide connect timeout. */
  readyTimeout?: number
  /** Legacy host-wide keepalive interval. */
  keepaliveInterval?: number
  /** Legacy host-wide keepalive retry budget. */
  keepaliveCountMax?: number
  /** Legacy host-wide strict host-key checking. */
  strictHostKeyChecking?: boolean
  /** Legacy host-wide trusted host keys. */
  knownHosts?: string[]
}

/** Schemastery schema for the aggregate row (all legacy fields optional). */
export const Config: z<Config> = z.object({
  host: z.string(),
  port: z.number(),
  username: z.string(),
  password: z.string(),
  privateKey: z.string(),
  passphrase: z.string(),
  agent: z.string(),
  jump: z.array(z.any()),
  cwd: z.string(),
  readyTimeout: z.number(),
  keepaliveInterval: z.number(),
  keepaliveCountMax: z.number(),
  strictHostKeyChecking: z.boolean(),
  knownHosts: z.array(z.string()),
}) as unknown as z<Config>

/**
 * Mount the aggregate plugin.
 * @param ctx - the mounting Cordis context.
 * @param config - optional legacy host-wide SSH connection.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // A legacy host-wide world stays opt-in: it is only mounted when the row
  // actually names a target, so the default desktop composition never competes
  // with the local `subprocess`/`fs` providers.
  if (config.host !== undefined && config.username !== undefined && config.cwd !== undefined) {
    ctx.plugin(SshRuntime, config as SshConfig)
  }
  applyContext(ctx)
  applyPresets(ctx)
  applyDesktop(ctx)
}
