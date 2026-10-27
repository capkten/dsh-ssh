/** File operations inside Docker, preserving the existing filesystem policy layer.
 * This is a private callback facade, not a network SFTP server. No agent is installed.
 */
import { Readable } from 'node:stream'
import type { SFTPWrapper } from 'ssh2'
import { quoteShellArg } from './runtime.ts'
import type { ExecOutcome } from './runtime.ts'

const PYTHON = `import os,sys,json,base64,stat
a=json.loads(base64.b64decode(sys.argv[1]));op=a['op'];p=a['path']
def attrs(s): return dict(mode=s.st_mode,size=s.st_size,mtime=s.st_mtime,atime=s.st_atime,uid=s.st_uid,gid=s.st_gid)
try:
 result=None
 if op=='stat': result=attrs(os.stat(p))
 elif op=='lstat': result=attrs(os.lstat(p))
 elif op=='readdir': result=[dict(filename=n,attrs=attrs(os.lstat(os.path.join(p,n)))) for n in os.listdir(p)]
 elif op=='read':
  with open(p,'rb') as f:
   f.seek(a.get('offset',0)); result=base64.b64encode(f.read(a['length'])).decode()
 elif op=='write':
  flags=os.O_WRONLY|os.O_CREAT|(os.O_TRUNC if a['offset']==0 else 0)
  fd=os.open(p,flags,0o600)
  with os.fdopen(fd,'r+b') as f:
   f.seek(a['offset']);f.write(base64.b64decode(a['data']))
 elif op=='mkdir': os.mkdir(p,0o700)
 elif op=='rmdir': os.rmdir(p)
 elif op=='unlink': os.unlink(p)
 elif op=='rename': os.replace(p,a['destination'])
 else: raise ValueError('unsupported file operation')
 print(json.dumps(dict(value=result)))
except OSError as e:
 print(json.dumps(dict(error=2 if e.errno in (2,20) else 3 if e.errno in (1,13) else 4,message=str(e))))
`

type Attrs = { mode: number; size: number; mtime: number; [key: string]: unknown }
function stats(value: Attrs): Attrs {
  return { ...value, isFile: () => (value.mode & 0o170000) === 0o100000,
    isDirectory: () => (value.mode & 0o170000) === 0o040000,
    isSymbolicLink: () => (value.mode & 0o170000) === 0o120000 }
}

export function dockerFiles(exec: (command: string) => Promise<ExecOutcome>): SFTPWrapper {
  async function request(op: string, path: string, extra: Record<string, unknown> = {}): Promise<any> {
    const data = Buffer.from(JSON.stringify({ op, path, ...extra })).toString('base64')
    const outcome = await exec(['python3', '-c', PYTHON, data].map(quoteShellArg).join(' '))
    if (outcome.exitCode !== 0) throw new Error(`container file operation failed: ${outcome.stderr.trim() || outcome.exitCode}`)
    const result = JSON.parse(outcome.stdout)
    if (result.error !== undefined) throw Object.assign(new Error(result.message), { code: result.error })
    return result.value
  }
  type Callback = (error: Error | undefined, value?: any) => void
  const deliver = (promise: Promise<unknown>, callback: Callback): void => { void promise.then(value => callback(undefined, value), error => callback(error)) }
  const read = (path: string, offset: number, length: number): Promise<Buffer> => request('read', path, { offset, length }).then(value => Buffer.from(value, 'base64'))
  const api = {
    stat: (path: string, cb: Callback) => deliver(request('stat', path).then(stats), cb),
    lstat: (path: string, cb: Callback) => deliver(request('lstat', path).then(stats), cb),
    readdir: (path: string, cb: Callback) => deliver(request('readdir', path).then(values => values.map((entry: any) => ({ ...entry, attrs: stats(entry.attrs) }))), cb),
    mkdir: (path: string, cb: Callback) => deliver(request('mkdir', path), cb),
    rmdir: (path: string, cb: Callback) => deliver(request('rmdir', path), cb),
    unlink: (path: string, cb: Callback) => deliver(request('unlink', path), cb),
    ext_openssh_rename: (path: string, destination: string, cb: Callback) => deliver(request('rename', path, { destination }), cb),
    readFile: (path: string, cb: Callback) => deliver((async () => {
      const chunks: Buffer[] = []
      for await (const chunk of api.createReadStream(path)) chunks.push(Buffer.from(chunk))
      return Buffer.concat(chunks)
    })(), cb),
    writeFile: (path: string, content: string | Buffer, cb: Callback) => deliver((async () => {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
      for (let offset = 0; offset < Math.max(1, bytes.length); offset += 32768) {
        await request('write', path, { offset, data: bytes.subarray(offset, offset + 32768).toString('base64') })
      }
    })(), cb),
    createReadStream: (path: string, options?: { start?: number; end?: number }) => Readable.from((async function* () {
      let offset = options?.start ?? 0
      const end = options?.end ?? Number.POSITIVE_INFINITY
      while (offset <= end) {
        const length = Math.min(65536, end - offset + 1)
        const bytes = await read(path, offset, length)
        if (bytes.length === 0) break
        yield bytes
        offset += bytes.length
        if (bytes.length < length) break
      }
    })(), { objectMode: false }),
    end() {},
  }
  return api as unknown as SFTPWrapper
}
