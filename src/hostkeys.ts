/** Explicit first-use host trust; shared by the registry transport and its UI RPC. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface HostKeyChallenge {
  id: string
  host: string
  port: number
  algorithm: string
  fingerprint: string
  changed: boolean
}

export class HostKeyTrustError extends Error {
  constructor(readonly challenge: HostKeyChallenge) {
    super(`dsh-ssh: ${challenge.changed ? '主机密钥已变化，拒绝连接' : '首次连接需要确认主机密钥'}：${challenge.host}:${String(challenge.port)} ${challenge.fingerprint}`)
  }
}

function hostName(host: string, port: number): string { return port === 22 ? host : `[${host}]:${String(port)}` }
function matches(pattern: string, name: string): boolean {
  if (!pattern.startsWith('|1|')) return pattern.toLowerCase() === name.toLowerCase()
  const parts = pattern.split('|')
  try {
    const actual = createHmac('sha1', Buffer.from(parts[2] ?? '', 'base64')).update(name).digest()
    const expected = Buffer.from(parts[3] ?? '', 'base64')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch { return false }
}

export class HostKeyStore {
  private pending = new Map<string, { challenge: HostKeyChallenge; key: string; expires: number }>()
  constructor(readonly path = join(homedir(), '.ssh', 'known_hosts')) {}

  keys(host: string, port: number): { trusted: string[]; revoked: string[] } {
    const result = { trusted: [] as string[], revoked: [] as string[] }
    if (!existsSync(this.path)) return result
    for (const line of readFileSync(this.path, 'utf8').split(/\r?\n/u)) {
      const fields = line.trim().split(/\s+/u)
      const marker = fields[0]?.startsWith('@') ? fields.shift() : undefined
      const [names, , key] = fields
      if (!names || !key || names.startsWith('#')) continue
      if (!names.split(',').some(name => matches(name, hostName(host, port)))) continue
      if (marker === '@revoked') result.revoked.push(key)
      else if (marker === undefined) result.trusted.push(key)
    }
    return result
  }

  verify(host: string, port: number, key: Buffer, configured: readonly string[] = []): HostKeyTrustError | undefined {
    const raw = key.toString('base64')
    const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`
    const records = this.keys(host, port)
    const trusted = configured.length ? configured : records.trusted
    const accepts = (entry: string): boolean => {
      const token = entry.trim().split(/\s+/u).at(-1) ?? ''
      return token === raw || token.replace(/=+$/u, '') === fingerprint
    }
    if (!records.revoked.some(accepts) && trusted.some(accepts)) return undefined
    const length = key.length >= 4 ? key.readUInt32BE(0) : 0
    const algorithm = length > 0 && length <= key.length - 4 ? key.subarray(4, 4 + length).toString('ascii') : 'unknown'
    const changed = trusted.length > 0 || records.revoked.some(accepts)
    const challenge: HostKeyChallenge = { id: '', host, port, algorithm, fingerprint, changed }
    for (const [id, item] of this.pending) if (item.expires < Date.now()) this.pending.delete(id)
    if (!changed) {
      if (this.pending.size >= 128) this.pending.delete(this.pending.keys().next().value as string)
      challenge.id = randomBytes(24).toString('hex')
      this.pending.set(challenge.id, { challenge, key: raw, expires: Date.now() + 600_000 })
    }
    return new HostKeyTrustError(challenge)
  }

  trust(id: string, fingerprint: string): void {
    const item = this.pending.get(id)
    if (!item || item.expires < Date.now() || item.challenge.fingerprint !== fingerprint) throw new Error('主机密钥确认已失效，请重新连接')
    const { challenge, key } = item
    if (!/^(ssh-|ecdsa-)[A-Za-z0-9@._+-]+$/u.test(challenge.algorithm) || /[\s,|!*?]/u.test(challenge.host)) throw new Error('主机密钥格式无效')
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const lock = `${this.path}.dsh-lock`
    const fd = openSync(lock, 'wx', 0o600)
    try {
      // Recheck while saving: another confirmation may have changed trust.
      const records = this.keys(challenge.host, challenge.port)
      if (records.revoked.includes(key) || records.trusted.some(existing => existing !== key)) throw new Error('可信主机密钥已发生变化，未写入；请核实服务器')
      if (!records.trusted.includes(key)) {
        const previous = existsSync(this.path) ? readFileSync(this.path, 'utf8') : ''
        appendFileSync(this.path, `${previous && !previous.endsWith('\n') ? '\n' : ''}${hostName(challenge.host, challenge.port)} ${challenge.algorithm} ${key}\n`, { mode: 0o600 })
      }
      this.pending.delete(id)
    } finally { closeSync(fd); unlinkSync(lock) }
  }
}

export const hostKeyStore = new HostKeyStore()
