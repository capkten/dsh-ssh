import type { WireResult } from './index.ts'
import type { HostKeyChallenge } from '../hostkeys.ts'

export type TrustRpc = (endpoint: string, payload?: unknown, signal?: AbortSignal) => Promise<WireResult>

/** Only an explicit, server-issued handshake challenge permits a retry. */
export function withHostKeyTrust(raw: TrustRpc, confirm: (challenge: HostKeyChallenge, signal?: AbortSignal) => Promise<boolean>): TrustRpc {
  return async (endpoint, payload, signal) => {
    for (let attempt = 0; attempt < 16; attempt++) {
      signal?.throwIfAborted()
      const result = await raw(endpoint, payload, signal)
      const value = result.ok ? result.value : null
      if (!value || typeof value !== 'object' || !('hostKeyRequired' in value)) return result
      const challenge = value.hostKeyRequired as HostKeyChallenge
      if (!challenge || typeof challenge.id !== 'string' || typeof challenge.host !== 'string' || typeof challenge.port !== 'number' || typeof challenge.fingerprint !== 'string' || typeof challenge.changed !== 'boolean') throw new Error('主机密钥确认格式无效')
      const accepted = await confirm(challenge, signal)
      signal?.throwIfAborted()
      if (!accepted || challenge.changed) throw new Error(challenge.changed ? '主机密钥已变化，连接已阻止。请联系管理员核实，不会自动覆盖可信密钥。' : '已取消主机密钥信任，未连接服务器')
      const trusted = await raw('hostkeys.trust', { id: challenge.id, fingerprint: challenge.fingerprint }, signal)
      if (!trusted.ok) throw new Error(trusted.error.message)
    }
    throw new Error('主机密钥确认次数过多，请检查跳板配置')
  }
}
