/**
 * Bash executor for one remote SSH execution world. It is the stock
 * `@deepseek-ai/dsh-bash-local` executor: commands are `bash -c` argv spawned
 * through `ctx.subprocess`, so mounting it inside the remote agent-preset realm
 * runs them on the remote host instead of the harness host.
 *
 * LIMITATION: this executor reports no `sandboxMode` because SSH cannot confine
 * a remote process the way the host kernel sandboxes local ones. Commands run
 * as the SSH login user without a kernel sandbox. Filesystem mutations still
 * enforce the remote workspace containment policy (see SshFileSystem).
 * @module dsh-ssh/shell
 */

import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'

/**
 * Remote bash executor over the isolated `ctx.subprocess` seam. The SSH
 * subprocess provider resolves `bash` on the remote host and runs the exact
 * argv the inherited executor builds.
 */
export class SshBashExecutor extends LocalBashExecutor {}

export default SshBashExecutor
