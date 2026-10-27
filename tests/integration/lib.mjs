/**
 * Shared helpers for the dsh-ssh end-to-end integration driver.
 *
 * Isolation rules enforced here:
 *  - every run gets a fresh `$DSH_HOME` under the OS temp directory;
 *  - the real profile directory (`~/.dsh/profiles/desktop`) is never opened,
 *    created, or patched;
 *  - remote writes happen only inside a `/tmp/dsh-ssh-test-<random>` tree that
 *    the driver creates and removes.
 *
 * Node: use the DSH-bundled Node >= 24 runtime for the CLI itself (the shipped
 * `bin.js` gates on `import.meta.main`, which Node 22 silently ignores).
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DEPS_DIR = join(REPO_ROOT, 'tests', '_deps', 'node_modules')
export const MOCK_SERVER_ENTRY = join(DEPS_DIR, '@deepseek-ai', 'dsh-llm-mock-server', 'lib', 'index.js')

/** Absolute path of the extracted DSH 0.2.1-rc.2 CLI bin.js. */
export const CLI_BIN = process.env.DSH_CLI_BIN
  ?? (process.env.DSH_EXTRACT_ROOT
    ? join(process.env.DSH_EXTRACT_ROOT, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    : '')

/** Node >= 24 interpreter shipped with DSH Desktop (bin.js needs import.meta.main). */
export const DSH_NODE = process.env.DSH_NODE_BIN
  ?? process.execPath

export const SSH = {
  host: process.env.DSH_SSH_HOST ?? '',
  user: process.env.DSH_SSH_USER ?? '',
  port: process.env.DSH_SSH_PORT ?? '22',
  key: process.env.DSH_SSH_KEY ?? join(process.env.USERPROFILE ?? '', '.ssh', 'id_ed25519'),
}

export const SSH2 = {
  host: process.env.DSH_SSH_HOST2 ?? '',
  user: process.env.DSH_SSH_USER2 ?? '',
  port: process.env.DSH_SSH_PORT2 ?? '22',
  key: process.env.DSH_SSH_KEY2 ?? SSH.key,
}

export function assertPrerequisites() {
  const missing = []
  for (const [label, path] of [
    ['DSH CLI bin.js', CLI_BIN],
    ['DSH bundled Node >= 24', DSH_NODE],
    ['mock LLM server package', MOCK_SERVER_ENTRY],
  ]) {
    if (!existsSync(path)) missing.push(`${label}: ${path}`)
  }
  if (missing.length > 0) {
    throw new Error(`integration prerequisites missing:\n  ${missing.join('\n  ')}\n` +
      'Install with: cd tests/_deps && npm install --no-audit --no-fund')
  }
  const version = spawnSync(DSH_NODE, ['--version'], { encoding: 'utf8', windowsHide: true })
  const major = Number((version.stdout ?? '').replace(/^v/u, '').split('.')[0])
  if (!(major >= 24)) throw new Error(`DSH_NODE_BIN must be Node >= 24 (got ${version.stdout ?? '<none>'}); Node 22 makes bin.js exit 0 with no output`)
}

/** Create a fresh isolated Harness home (`$DSH_HOME`) under the OS temp dir. */
export function makeIsolatedHome(label = 'dsh-ssh-e2e') {
  return mkdtempSync(join(tmpdir(), `${label}-`))
}

export function profileDir(home, name) {
  return join(home, 'profiles', name)
}

/**
 * Write one isolated profile.
 * @param options.home - isolated DSH home.
 * @param options.name - profile name.
 * @param options.bundles - `dsh.profile.bundles` in mount order.
 * @param options.patchYaml - body of the profile's `cordis.patch.yml`.
 * @param options.dependencies - optional `dependencies` map for the manifest.
 */
export function writeProfile(options) {
  const dir = profileDir(options.home, options.name)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    name: `dsh-profile-${options.name}`,
    private: true,
    dependencies: options.dependencies ?? {},
    dsh: { profile: { bundles: options.bundles } },
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  writeFileSync(join(dir, 'cordis.yml'), '# isolated test profile root\n[]\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), options.patchYaml ?? '# no user patch\n[]\n')
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  return dir
}

/**
 * Copy the plugin distributable into a throwaway profile, sharing the extracted
 * host SDK namespace. Never link back to the development checkout's SDKs.
 * The read-only SDK identity gate must pass before booting the profile.
 */
export function installLocalDshSsh(dir, _extraPackages = []) {
  const lib = join(REPO_ROOT, 'lib', 'index.js')
  if (!existsSync(lib)) {
    throw new Error(`dsh-ssh is not built: ${lib} is missing; run 'npm run build' in the repo first (do not edit package.json)`)
  }
  // A file: symlink resolves SDK imports back into the development checkout,
  // hiding the Desktop's duplicate-SDK bug. Copy the distributable instead and
  // resolve every host SDK to the extracted host's actual package instance.
  const modules = join(dir, 'node_modules')
  const installed = join(modules, 'dsh-ssh')
  mkdirSync(installed, { recursive: true })
  for (const name of ['package.json', 'cordis.patch.yml', 'lib']) {
    cpSync(join(REPO_ROOT, name), join(installed, name), { recursive: true })
  }
  const hostModules = resolve(dirname(CLI_BIN), '../../..')
  symlinkSync(join(hostModules, '@deepseek-ai'), join(modules, '@deepseek-ai'), 'junction')
  symlinkSync(join(REPO_ROOT, 'node_modules', 'ssh2'), join(modules, 'ssh2'), 'junction')
  const gate = spawnSync(DSH_NODE, [join(REPO_ROOT, 'tests/integration/check-host-sdk.mjs'),
    dirname(hostModules), installed], { encoding: 'utf8', windowsHide: true })
  if (gate.status !== 0) throw new Error(`isolated profile SDK identity gate failed: ${gate.stdout} ${gate.stderr}`)

}

/** Packages the isolated remote profile needs beyond the local bundles. */
export const REMOTE_PROFILE_PACKAGES = ['@deepseek-ai/dsh-agent-preset-registry@0.2.1-rc.2']

/** Run one ssh CLI command against a target; returns stdout/stderr/exit. */
export function sshExec(target, command, timeoutMs = 30_000) {
  const args = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
    '-o', 'StrictHostKeyChecking=yes', '-p', String(target.port)]
  if (target.key !== undefined && target.key !== '') args.push('-i', target.key)
  args.push(`${target.user}@${target.host}`, command)
  return spawnSync('ssh', args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
}

/** Root of the dedicated remote scratch tree (default /tmp; /tmp may be shared). */
export const SCRATCH_ROOT = process.env.DSH_E2E_SCRATCH_ROOT ?? '/tmp'

/** Unique name prefix of every scratch tree this driver creates or removes. */
const SCRATCH_PREFIX = 'dsh-ssh-test-'

/** Create a unique remote scratch tree and return its absolute POSIX path. */
export function createRemoteScratch(target) {
  const remote = `${SCRATCH_ROOT}/${SCRATCH_PREFIX}${randomBytes(5).toString('hex')}`
  const result = sshExec(target, `mkdir -p '${remote}' && cd '${remote}' && pwd`)
  if (result.status !== 0) throw new Error(`cannot create remote scratch dir ${remote}: ${result.stderr}`)
  return remote
}

/** Remove the remote scratch tree; never removes anything else. */
export function removeRemoteScratch(target, remote) {
  if (process.env.DSH_E2E_KEEP_SCRATCH === '1') { console.log(`[debug] skip removeRemoteScratch ${remote}`); return }
  const expected = `${SCRATCH_ROOT}/${SCRATCH_PREFIX}`
  if (!remote.startsWith(expected)) throw new Error(`refusing to remove non-test remote path ${remote}`)
  sshExec(target, `rm -rf '${remote}'`)
}

/**
 * Start the scriptable Messages mock server.
 * @param options.sequence - FIFO of behaviors consumed one per /v1/messages request.
 * @param options.toolName - tool the scripted `tool_call_success` invokes.
 * @param options.toolArguments - JSON string arguments for that tool call.
 * @param options.successText - final assistant text returned by `success`.
 */
export async function startMockLlm(options) {
  const module = await import(pathToFileURL(MOCK_SERVER_ENTRY).href)
  const handle = await module.startMockLlmServer({
    host: '127.0.0.1',
    port: 0,
    sequence: options.sequence,
    toolName: options.toolName,
    toolArguments: options.toolArguments,
    successText: options.successText ?? 'mock done',
    chunkDelayMs: 1,
    ...options.apiKey === undefined ? {} : { apiKey: options.apiKey },
  })
  const address = handle.baseURL
  return {
    handle,
    /** Base URL the DeepSeek adapter expects (`/v1` root). */
    baseURL: address.endsWith('/v1') ? address : `${address}/v1`,
    requests: () => handle.requests,
    close: () => handle.close(),
  }
}

/**
 * Run one headless `dsh` turn in an isolated home.
 * @param options.home - isolated $DSH_HOME.
 * @param options.profile - profile name.
 * @param options.task - task text handed to the agent loop.
 * @param options.llmBaseURL - mock server `/v1` root.
 * @param options.cwd - process working directory (headless session cwd fallback).
 * @param options.timeoutMs - process timeout.
 * @returns captured exit code, stdout/stderr, parsed JSON events, and elapsed time.
 */
export function runHeadless(options) {
  return runHeadlessAsync(options)
}

/** Like {@link runHeadless} but async, so several isolated sessions can overlap. */
export function runHeadlessAsync(options) {
  const args = [CLI_BIN, '--profile', options.profile, ...(options.extraArgs ?? []), '--json', options.task]
  const env = {
    ...process.env,
    DSH_HOME: options.home,
    DEEPSEEK_BASE_URL: options.llmBaseURL,
    DEEPSEEK_API_KEY: 'mock-key',
    DSH_TELEMETRY_DISABLED: '1',
    ...options.env,
  }
  const started = Date.now()
  return new Promise((resolveRun) => {
    const child = spawn(DSH_NODE, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let terminatedAfterFinal = false
    let finalSeen = false
    const graceMs = Number(process.env.DSH_E2E_FINAL_GRACE_MS ?? 2500)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, options.timeoutMs ?? Number(process.env.DSH_E2E_RUN_TIMEOUT_MS ?? 180_000))
    // The harness currently keeps the process alive after the final event while
    // the preset's SSH connection holds open handles (see findings-test.md).
    // Once the durable final event is on stdout the run is complete; terminate
    // the child so the driver can move on instead of waiting for the watchdog.
    const scheduleFinalTeardown = () => {
      if (finalSeen) return
      finalSeen = true
      terminatedAfterFinal = true
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, graceMs)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.includes('"type":"final"')) scheduleFinalTeardown()
    })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const finished = finishRun(options, args, started, { status: code, signal, stdout, stderr })
      finished.terminatedAfterFinal = terminatedAfterFinal
      resolveRun(finished)
    })
  })
}

function finishRun(options, args, started, result) {
  const events = []
  const nonJson = []
  for (const line of (result.stdout ?? '').split(/\r?\n/u)) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      nonJson.push(line)
    }
  }
  return {
    command: `"${DSH_NODE}" ${args.map(arg => JSON.stringify(arg)).join(' ')}`,
    home: options.home,
    profile: options.profile,
    exitCode: result.status,
    signal: result.signal ?? null,
    elapsedMs: Date.now() - started,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    events,
    nonJson,
    finalText: events.filter(event => event.type === 'final').map(event => event.text ?? event.message ?? '').join('\n'),
    toolCalls: events.filter(event => event.type === 'tool_call'),
    toolResults: events.filter(event => event.type === 'tool_result'),
  }
}

/** Best-effort teardown of one isolated home. */
export function destroyHome(home) {
  if (process.env.DSH_E2E_KEEP === '1') {
    console.log(`kept isolated DSH_HOME: ${home}`)
    return
  }
  rmSync(home, { recursive: true, force: true })
}

/** Read a JSON file if present (diagnostics from failed runs). */
export function readFileIfPresent(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
