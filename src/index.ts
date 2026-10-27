/**
 * dsh-ssh — SSH remote-execution plugin for DeepSeek Harness.
 *
 * The default (`name: dsh-ssh`) composition registers one isolated remote agent
 * preset per SSH connection and routes sessions opened on a remote workspace
 * onto it, so `bash`, read/write/edit, glob/grep, background jobs and the
 * terminal execute on the remote host while local sessions keep the stock
 * tools. Subpath rows (`dsh-ssh/ssh`, `dsh-ssh/subprocess`, `dsh-ssh/fs`,
 * `dsh-ssh/shell`, `dsh-ssh/tools`, …) remain available for manual
 * compositions that replace the host providers themselves.
 * @module dsh-ssh
 */

export { SshRuntime, quoteShellArg, wrapCwd } from './runtime.ts'
export type { Config, JumpConfig, ExecOutcome } from './runtime.ts'
export { SshSubprocessRuntime } from './subprocess.ts'
export { SshFileSystem } from './filesystem-final.ts'
export { SshRegistryTransport } from './registry-ssh.ts'
export type { RegistrySshConfig } from './registry-ssh.ts'
export { SshBashExecutor } from './shell.ts'
export { sshRemotePresetId } from './preset.ts'
export { SshDirectoryPicker } from './picker.ts'
export type { Config as PickerConfig } from './picker.ts'
export { SshRegistry, parseSshRoute } from './registry.ts'
export type { RegistryConfig, SshConnectionView, ResolvedSshConfig, SshRoute } from './registry.ts'
export { parseSshPlaceholder, parseSshTargetKey, isSshRoutePath, resolveSshCwd, resolveSshTargetKey, sshTargetKey } from './transport.ts'
export type { SshCwdRoute, SshTransport } from './transport.ts'
export { SshConnection } from './connection.ts'
export type { SshConnectionSpec } from './connection.ts'
export { apply } from './plugin.ts'
