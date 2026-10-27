/**
 * Test doubles for the dsh-ssh routing seams.
 *
 * These are deliberately NOT mocks of `src/` behaviour: they only stand in for
 * the two collaborators `resolveSshCwd` / `resolveSshTargetKey` read —
 * the Cordis context (`ctx.get('sshRegistry')`) and the aggregate `ctx.ssh`
 * transport. The functions under test are the real ones from `src/`.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Minimal structural stand-in for `SshTransport` (transport.ts). */
export interface FakeTransport {
  readonly endpoint: string
  readonly cwd: string
  readonly calls: string[]
  getClient(): Promise<never>
  getSftp(): Promise<never>
  getRemoteEnvironment(): Promise<Record<string, string>>
  exec(): Promise<never>
  resolveRemoteCwd(cwd: string | undefined): string
}

/** Build one fake transport whose aggregate mapping is observable. */
export function makeTransport(endpoint: string, defaultCwd: string): FakeTransport {
  const calls: string[] = []
  return {
    endpoint,
    cwd: defaultCwd,
    calls,
    getClient: () => Promise.reject(new Error(`${endpoint}: getClient is not used by routing unit tests`)),
    getSftp: () => Promise.reject(new Error(`${endpoint}: getSftp is not used by routing unit tests`)),
    getRemoteEnvironment: () => Promise.resolve({}),
    exec: () => Promise.reject(new Error(`${endpoint}: exec is not used by routing unit tests`)),
    resolveRemoteCwd(cwd: string | undefined): string {
      calls.push(cwd ?? '<undefined>')
      return cwd ?? defaultCwd
    },
  }
}

/** A fake `SshRegistry.get` table: id -> transport (missing ids are unknown). */
export interface FakeRegistry {
  get(id: string): FakeTransport | undefined
}

/**
 * Compose a fake Cordis context.
 * @param aggregate - the aggregate `ctx.ssh` transport (POSIX/local fallback).
 * @param connections - registry-owned transports by connection id.
 */
export function makeCtx(aggregate: FakeTransport, connections: Record<string, FakeTransport> = {}): Context {
  const registry: FakeRegistry = {
    get: (id: string) => connections[id],
  }
  const ctx = {
    ssh: aggregate,
    get(name: string) {
      return name === 'sshRegistry' ? registry : undefined
    },
  }
  return ctx as unknown as Context
}

/** A context whose `sshRegistry` service is absent (dsh-ssh/web not mounted). */
export function makeCtxWithoutRegistry(aggregate: FakeTransport): Context {
  const ctx = {
    ssh: aggregate,
    get() {
      return undefined
    },
  }
  return ctx as unknown as Context
}
