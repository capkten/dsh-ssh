/**
 * Remote-native `glob` and `grep` tools over the SSH execution world.
 *
 * The stock `@deepseek-ai/dsh-tool-fs-search` spawns the ripgrep binary packaged
 * with the HARNESS (a local file path), so it cannot run over an SSH subprocess
 * seam. These tools keep the model-facing names and semantics but execute the
 * search on the remote host: `find` for file discovery and `grep -r` for
 * content search. Both run through the isolated `ctx.subprocess` provider, so a
 * broken SSH link fails the call instead of falling back to the local disk.
 * @module dsh-ssh/tools
 */

import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubprocessCollectedOutputs } from '@deepseek-ai/dsh-subprocess'
import { parseSshRoute } from './registry.ts'
import { parseSshPlaceholder } from './transport.ts'

/** Services used by the remote search tools. */
export const inject = ['tools', 'subprocess', 'workingDirectory']

const STDOUT_MAX_BYTES = 4 * 1024 * 1024
const STDERR_MAX_BYTES = 64 * 1024
const GRACE_MS = 3000
const SEARCH_TIMEOUT_MS = 60_000
const MAX_GLOB_RESULTS = 2000
const MAX_GREP_MATCHES = 500

/** One finished remote search command. */
interface RemoteRun {
  exitCode: number | null
  stdout: string
  stderr: string
}

/**
 * Run one argv remotely and collect its output.
 * @param ctx - context carrying the subprocess and working-directory services.
 * @param argv - exact argv; the SSH provider quotes each element itself.
 * @param cwd - remote working directory.
 * @param signal - caller cancellation, combined with a safety deadline.
 * @returns exit facts plus collected output.
 */
async function run(ctx: Context, argv: readonly string[], cwd: string, signal: AbortSignal | undefined): Promise<RemoteRun> {
  const deadline = AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  const handle = ctx.subprocess.spawn({
    argv,
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: STDOUT_MAX_BYTES },
      stderr: { maxBytes: STDERR_MAX_BYTES },
    },
    graceMs: GRACE_MS,
    signal: combined,
  })
  let outcome
  try {
    outcome = await handle.done
  } catch (error) {
    throw new Error(`remote search command failed to start: ${error instanceof Error ? error.message : String(error)}`)
  }
  const read = (collected: SubprocessCollectedOutputs): string => collected.stdout?.readFrom(0).text ?? ''
  return { exitCode: outcome.exitCode, stdout: read(handle.collected), stderr: handle.collected.stderr?.readFrom(0).text ?? '' }
}

/** Translate a glob expression into an anchored regular expression (POSIX paths). */
function globToRegExp(pattern: string): RegExp {
  let source = ''
  let index = 0
  const normalized = pattern.replaceAll('\\', '/')
  while (index < normalized.length) {
    const char = normalized[index] as string
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index += 2
        if (normalized[index] === '/') {
          index += 1
          source += '(?:[^/]+/)*'
        } else {
          source += '.*'
        }
        continue
      }
      source += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      source += '[^/]'
      index += 1
      continue
    }
    if (char === '[') {
      const close = normalized.indexOf(']', index + 1)
      if (close > index + 1) {
        source += normalized.slice(index, close + 1)
        index = close + 1
        continue
      }
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    index += 1
  }
  return new RegExp(`^${source}$`)
}

/** Whether a relative POSIX path matches one glob expression. */
function matchesGlob(relative: string, pattern: string): boolean {
  const regexp = globToRegExp(pattern)
  if (regexp.test(relative)) return true
  // A bare pattern such as `*.ts` conventionally matches at any depth.
  if (!pattern.includes('/')) return regexp.test(posix.basename(relative))
  return false
}

/** Resolve the search root: the tool's path argument or the session directory. */
async function resolveRoot(ctx: Context, exec: { agent?: unknown; signal: AbortSignal }, path: string | undefined): Promise<string> {
  const cwd = exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent as never, exec.signal)
  if (cwd === undefined) throw new Error('a remote search requires an agent session')
  // The session cwd is the LOCAL route placeholder; translate it to the real
  // remote directory before handing it to a remote command.
  const route = cwd.startsWith('ssh://') ? parseSshRoute(cwd) : parseSshPlaceholder(cwd)
  const remoteCwd = route === null ? cwd : route.path
  if (!posix.isAbsolute(remoteCwd) || /[\\\0]/.test(remoteCwd)) {
    throw new Error(`remote search cannot use the resolved directory ${JSON.stringify(cwd)}`)
  }
  if (path === undefined || path === '' || path === '.') return remoteCwd
  if (posix.isAbsolute(path)) return posix.normalize(path)
  return posix.resolve(remoteCwd, path)
}

/** Present one relative path list as the tool result. */
function fileListOutput(files: readonly string[], truncated: boolean): { text: string } {
  const body = files.length === 0 ? 'No files found' : files.join('\n')
  return { text: truncated ? `${body}\n[truncated: showing the first ${files.length} matches]` : body }
}

/**
 * Mount the remote glob and grep tools.
 * @param ctx - mounting context.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'glob',
    description: [
      'Find files by glob pattern on the REMOTE SSH host.',
      'Patterns use POSIX glob syntax (* ? ** [...]) and are matched against paths relative to the search root; a bare pattern like *.ts matches at any depth.',
      'Returns matching files sorted by modification time (newest first). .git and node_modules are not descended into.',
    ].join(' '),
    parameters: {
      pattern: { type: 'string', required: true, description: 'Glob pattern such as "src/**/*.ts" or "*.md".' },
      path: { type: 'string', description: 'Directory to search, absolute or relative to the session directory; defaults to the session directory.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true, description: 'Newline-separated matching file paths.' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const root = await resolveRoot(ctx, exec, args.path)
      const findArgv = [
        'find', root,
        '(', '-name', '.git', '-o', '-name', 'node_modules', ')', '-prune',
        '-o', '-type', 'f', '-printf', '%T@\\t%p\\0',
      ]
      let runResult = await run(ctx, findArgv, root, exec.signal)
      let loseMtime = false
      if (runResult.exitCode !== 0) {
        // A find without -printf (non-GNU) falls back to plain NUL-separated paths.
        loseMtime = true
        runResult = await run(ctx, ['find', root, '(', '-name', '.git', '-o', '-name', 'node_modules', ')', '-prune', '-o', '-type', 'f', '-print0'], root, exec.signal)
        if (runResult.exitCode !== 0) {
          throw new Error(`glob failed on the remote host: ${runResult.stderr.trim() || `exit code ${String(runResult.exitCode)}`}`)
        }
      }
      const regexp = globToRegExp(args.pattern)
      const entries: Array<{ path: string; time: number }> = []
      for (const record of runResult.stdout.split('\0')) {
        if (record.length === 0) continue
        let filePath = record
        let time = 0
        if (!loseMtime) {
          const tab = record.indexOf('\t')
          if (tab >= 0) {
            time = Number(record.slice(0, tab))
            filePath = record.slice(tab + 1)
          }
        }
        const relative = filePath === root ? '' : posix.relative(root, filePath)
        if (relative.length === 0) continue
        const matched = regexp.test(relative) || (!args.pattern.includes('/') && regexp.test(posix.basename(relative)))
        if (!matched) continue
        entries.push({ path: relative, time: Number.isFinite(time) ? time : 0 })
      }
      entries.sort((left, right) => loseMtime ? left.path.localeCompare(right.path) : right.time - left.time || left.path.localeCompare(right.path))
      const truncated = entries.length > MAX_GLOB_RESULTS
      return fileListOutput(entries.slice(0, MAX_GLOB_RESULTS).map(entry => entry.path), truncated)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grep',
    description: [
      'Search file contents by regular expression on the REMOTE SSH host (grep -E over the remote tree).',
      'Returns matching lines as path:line:text, capped at 500 matches. .git and node_modules are excluded.',
      'Use the glob argument to restrict the file set, for example "*.ts".',
    ].join(' '),
    parameters: {
      pattern: { type: 'string', required: true, description: 'Extended regular expression to search for.' },
      path: { type: 'string', description: 'File or directory to search; defaults to the session directory.' },
      glob: { type: 'string', description: 'Optional file-name filter such as "*.ts".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true, description: 'Newline-separated matching lines.' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const root = await resolveRoot(ctx, exec, args.path)
      const argv = [
        'grep', '-rInHE',
        '--exclude-dir=.git',
        '--exclude-dir=node_modules',
        ...(args.glob !== undefined && args.glob.trim() !== '' ? ['--include', args.glob] : []),
        '--', args.pattern, root,
      ]
      // The operand may be a file. Never cd into it: a failed cd can return
      // exit 1, which would otherwise be mistaken for grep's "no matches".
      const result = await run(ctx, argv, posix.dirname(root), exec.signal)
      const exitCode = result.exitCode
      // grep: 0 = matches, 1 = no matches, >1 = error.
      if ((exitCode !== 0 && exitCode !== 1) || (exitCode === 1 && result.stderr.trim() !== '')) {
        throw new Error(`grep failed on the remote host: ${result.stderr.trim() || `exit code ${String(exitCode)}`}`)
      }
      const lines = result.stdout.split('\n').filter(line => line.length > 0)
      const truncated = lines.length > MAX_GREP_MATCHES
      const shown = lines.slice(0, MAX_GREP_MATCHES).map(line => {
        // Print paths relative to the search root for a stable, readable result.
        if (line.startsWith(`${root}/`)) return line.slice(root.length + 1)
        if (line.startsWith(`${root}:`)) return `${posix.basename(root)}${line.slice(root.length)}`
        return line
      })
      if (shown.length === 0) return { text: 'No matches found' }
      return { text: truncated ? `${shown.join('\n')}\n[truncated: showing the first ${shown.length} matches]` : shown.join('\n') }
    },
  }))
}
