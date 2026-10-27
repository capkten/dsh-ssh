/**
 * Opt-in diagnostics for the SSH execution world. Enabled with
 * `DSH_SSH_DEBUG=1`; messages go to stderr so they never pollute tool output.
 * Never includes secrets (no passwords, passphrases or key material).
 * @module dsh-ssh/debug
 */

/** Whether opt-in SSH diagnostics are enabled for this process. */
export function sshDebugEnabled(): boolean {
  const value = process.env.DSH_SSH_DEBUG
  return value === '1' || value === 'true'
}

/**
 * Emit one diagnostic line when `DSH_SSH_DEBUG` is enabled.
 * @param message - fact to report; callers must not include credentials.
 */
export function sshDebug(message: string): void {
  if (!sshDebugEnabled()) return
  process.stderr.write(`[dsh-ssh] ${message}\n`)
}
