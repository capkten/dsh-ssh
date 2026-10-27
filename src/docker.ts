/** Docker execution target reached through an authenticated SSH host. */
import { randomUUID } from 'node:crypto'
import { quoteShellArg } from './runtime.ts'
import type { ExecOutcome } from './runtime.ts'
import type { Client, ClientChannel, ExecOptions } from 'ssh2'

export interface DockerTarget {
  /** Name accepted during setup; saved workspaces use a full immutable ID. */
  container: string
  user?: string
}

export function validateDockerTarget(target: DockerTarget): void {
  if (!target || typeof target.container !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(target.container)) throw new Error('dsh-ssh: invalid Docker container name or ID')
  if (target.user !== undefined && (typeof target.user !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(target.user))) throw new Error('dsh-ssh: invalid Docker user')
}

/** Exact argv quoting; the target is never interpolated as shell code. */
export function dockerCommand(target: DockerTarget, argv: string[], pty = false, token?: string): string {
  validateDockerTarget(target)
  if (!/^[a-f0-9]{64}$/.test(target.container)) throw new Error('dsh-ssh: Docker execution requires a pinned full container ID')
  return ['docker', 'exec', '-i', ...(pty ? ['-t'] : []), '--workdir', '/',
    ...(target.user === undefined ? [] : ['--user', target.user]),
    ...(token === undefined ? [] : ['--env', `DSH_SSH_EXEC_TOKEN=${token}`]),
    target.container, ...argv].map(quoteShellArg).join(' ')
}

/** Collect host control operations without passing them through the container. */
export async function hostExec(client: Client, command: string, signal?: AbortSignal): Promise<ExecOutcome> {
  signal?.throwIfAborted()
  return await new Promise((resolve, reject) => {
    let channel: ClientChannel | undefined
    const abort = (): void => { channel?.close(); reject(signal?.reason ?? new Error('Docker setup aborted')) }
    signal?.addEventListener('abort', abort, { once: true })
    client.exec(command, { pty: false }, (error, stream) => {
      if (error != null) { signal?.removeEventListener('abort', abort); reject(error); return }
      channel = stream
      if (signal?.aborted) { abort(); return }
      const out: Buffer[] = [], err: Buffer[] = []
      stream.on('data', (data: Buffer) => out.push(data))
      stream.stderr.on('data', (data: Buffer) => err.push(data))
      stream.on('error', reject)
      stream.on('close', (code: number | null, reason: string | null) => {
        signal?.removeEventListener('abort', abort)
        resolve({ exitCode: code, signal: reason, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
      })
      stream.end()
    })
  })
}

const SUPERVISOR = `import os,sys,subprocess,signal,fcntl,termios
token=os.environ['DSH_SSH_EXEC_TOKEN']
cancel='/tmp/dsh-ssh-exec-'+token+'.cancel'
def stopped():
 return os.path.lexists(cancel)
def setup():
 # Docker already owns the controlling terminal for a PTY execution. Keep
 # that session; a second TIOCSCTTY would fail without CAP_SYS_ADMIN.
 if not os.isatty(0): os.setsid()
if stopped():
 os.unlink(cancel);sys.exit(125)
p=subprocess.Popen(['bash','-c',sys.argv[1]],preexec_fn=setup)
def stop(sig,frame):
 try:
  if os.isatty(0): p.send_signal(sig)
  else: os.killpg(p.pid,sig)
 except ProcessLookupError: pass
for s in (signal.SIGTERM,signal.SIGHUP,signal.SIGINT): signal.signal(s,stop)
if stopped(): stop(signal.SIGTERM,None)
try:
 rc=p.wait()
finally:
 try: os.unlink(cancel)
 except FileNotFoundError: pass
sys.exit(rc if rc>=0 else 128-rc)
`

const STOP = `import os,sys,signal
token=sys.argv[1]; sig=getattr(signal,'SIG'+sys.argv[2])
fd=os.open('/tmp/dsh-ssh-exec-'+token+'.cancel',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600) if not os.path.lexists('/tmp/dsh-ssh-exec-'+token+'.cancel') else None
if fd is not None: os.close(fd)
for entry in os.listdir('/proc'):
 if not entry.isdigit(): continue
 try:
  pid=int(entry)
  env=open('/proc/'+entry+'/environ','rb').read().split(b'\\0')
  if ('DSH_SSH_EXEC_TOKEN='+token).encode() in env and os.getpgid(pid)==pid: os.killpg(pid,sig)
 except (OSError,ProcessLookupError): pass
`

/** Keep the existing SSH channel API, with every exec and signal inside Docker. */
export function dockerClient(host: Client, target: DockerTarget): Client {
  return new Proxy(host, { get(object, key) {
    if (['sftp', 'shell', 'subsys', 'forwardOut'].includes(String(key))) {
      return (...args: unknown[]) => {
        const callback = args.at(-1)
        const error = new Error(`dsh-ssh: raw host ${String(key)} is unavailable in a container workspace`)
        if (typeof callback === 'function') callback(error)
        else throw error
        return object
      }
    }
    if (key !== 'exec') {
      const value = Reflect.get(object, key, object)
      return typeof value === 'function' ? value.bind(object) : value
    }
    return (command: string, options: ExecOptions, callback: (error: Error | undefined, channel: ClientChannel) => void): void => {
      const token = randomUUID()
      const wrapped = dockerCommand(target, ['python3', '-c', SUPERVISOR, command], Boolean(options.pty), token)
      host.exec(wrapped, options, (error, channel) => {
        if (error != null) { callback(error, channel); return }
        let exited = false
        channel.once('close', () => { exited = true })
        const stop = (name: string): void => {
          if (exited) return
          if (!['TERM', 'KILL', 'INT', 'HUP'].includes(name)) throw new Error(`unsupported Docker execution signal ${name}`)
          void hostExec(host, dockerCommand(target, ['python3', '-c', STOP, token, name])).catch(() => {})
        }
        const close = channel.close.bind(channel)
        channel.signal = ((name: string) => { stop(name); return channel }) as typeof channel.signal
        channel.close = (() => { stop('TERM'); return close() }) as typeof channel.close
        callback(undefined, channel)
      })
    }
  } })
}
