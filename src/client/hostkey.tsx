import { useEffect, useRef, useState } from 'react'
import type { HostKeyChallenge } from '../hostkeys.ts'
import { withHostKeyTrust } from './hostkey-rpc.ts'
import type { TrustRpc } from './hostkey-rpc.ts'
import { useDialogA11y } from './ui.ts'
import styles from './flow.module.css'

function HostKeyDialog({ challenge, finish }: { challenge: HostKeyChallenge; finish: (accepted: boolean) => void }) {
  const ref = useDialogA11y(true, () => { finish(false) })
  return <div className={styles.overlay}>
    <div className={styles.smallDialog} role="dialog" aria-modal="true" aria-label="SSH 主机密钥验证" ref={ref}>
      <h3 className={styles.formTitle}>{challenge.changed ? '警告：服务器主机密钥已变化' : '首次连接：确认服务器身份'}</h3>
      <p className={styles.confirmText}>服务器：<strong>{challenge.host}:{challenge.port}</strong></p>
      <p className={styles.confirmText}>密钥类型：{challenge.algorithm}</p>
      <p className={styles.confirmText}>SHA256 指纹：</p>
      <code style={{ display: 'block', overflowWrap: 'anywhere', userSelect: 'text' }}>{challenge.fingerprint}</code>
      <p className={styles.confirmText}>{challenge.changed
        ? '该密钥与已信任记录不符，可能是服务器重装或身份被冒用。连接已阻止，请联系管理员核实；不会自动覆盖原记录。'
        : '请通过管理员或其他可信渠道核对指纹。确认后保存至本机 ~/.ssh/known_hosts，后续连接自动验证。此指纹属于服务器身份，不是你的登录私钥。'}</p>
      <div className={styles.formActions}>
        <button type="button" className={styles.button} onClick={() => { finish(false) }}>{challenge.changed ? '关闭' : '取消连接'}</button>
        {!challenge.changed && <button type="button" className={styles.button} onClick={() => { finish(true) }}>信任并连接</button>}
      </div>
    </div>
  </div>
}

/** One visible confirmation, canceled when its flow or request is dismissed. */
export function useHostKeyTrust(raw: TrustRpc, open: boolean) {
  const [challenge, setChallenge] = useState<HostKeyChallenge | null>(null)
  const pending = useRef<((accepted: boolean) => void) | null>(null)
  const finish = (accepted: boolean): void => { pending.current?.(accepted) }
  useEffect(() => { if (!open) finish(false) }, [open])
  useEffect(() => () => { pending.current?.(false) }, [])
  const rpc = withHostKeyTrust(raw, (value, signal) => new Promise<boolean>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    if (pending.current) { reject(new Error('请先完成当前主机密钥确认，再重试')); return }
    const abort = (): void => { done(false) }
    const done = (accepted: boolean): void => {
      signal?.removeEventListener('abort', abort)
      pending.current = null
      setChallenge(null)
      resolve(accepted)
    }
    pending.current = done
    signal?.addEventListener('abort', abort, { once: true })
    setChallenge(value)
  }))
  return { rpc, dialog: challenge && <HostKeyDialog challenge={challenge} finish={finish} /> }
}
