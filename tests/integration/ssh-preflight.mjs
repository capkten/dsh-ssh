#!/usr/bin/env node
/**
 * dsh-ssh integration preflight: prove the SSH targets behind the end-to-end
 * tests are reachable and capable, without touching any real project or home
 * file.
 *
 * Every remote write happens inside a fresh `/tmp/dsh-ssh-test-<random>` tree
 * that this script creates and removes. The script never runs a write command
 * outside that tree.
 *
 * Usage (from the repo root, any Node >= 18):
 *   node tests/integration/ssh-preflight.mjs
 *   node tests/integration/ssh-preflight.mjs --host <host> --user <user>
 *
 * Environment overrides:
 *   DSH_SSH_HOST      primary target        (required unless --host is used)
 *   DSH_SSH_USER      primary user          (required unless --user is used)
 *   DSH_SSH_PORT      primary port          (default 22)
 *   DSH_SSH_KEY       identity file path    (optional; ssh default identities otherwise)
 *   DSH_SSH_HOST2     optional second target (8s budget)
 *   DSH_SSH_USER2     optional second user
 *   DSH_SSH_TIMEOUT   connect timeout secs  (default 8)
 *   DSH_SSH_STRICT    "1" to enforce known_hosts checking (default on)
 *
 * Exit code 0 only when the primary target passes every required check.
 */

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const primary = {
  host: argOf('host', process.env.DSH_SSH_HOST ?? ''),
  user: argOf('user', process.env.DSH_SSH_USER ?? ''),
  port: argOf('port', process.env.DSH_SSH_PORT ?? '22'),
  key: argOf('key', process.env.DSH_SSH_KEY),
}
if (primary.host === '' || primary.user === '') {
  throw new Error('Set DSH_SSH_HOST and DSH_SSH_USER, or pass --host and --user.')
}
const secondary = {
  host: process.env.DSH_SSH_HOST2 ?? '',
  user: process.env.DSH_SSH_USER2 ?? '',
  port: process.env.DSH_SSH_PORT2 ?? '22',
  key: process.env.DSH_SSH_KEY2,
}
const timeoutSeconds = Number(argOf('timeout', process.env.DSH_SSH_TIMEOUT ?? '8'))
const strict = (process.env.DSH_SSH_STRICT ?? '1') === '1'

const OPTIONS = [
  '-o', 'BatchMode=yes',
  '-o', `ConnectTimeout=${timeoutSeconds}`,
  '-o', 'ServerAliveInterval=5',
  '-o', 'ServerAliveCountMax=1',
  '-o', strict ? 'StrictHostKeyChecking=yes' : 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=' + (strict ? (process.env.DSH_SSH_KNOWN_HOSTS ?? '') : 'NUL'),
  '-p', String(primary.port),
]

function sshArgs(target) {
  const args = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${timeoutSeconds}`]
  args.push('-o', strict ? 'StrictHostKeyChecking=yes' : 'StrictHostKeyChecking=no')
  if (!strict) args.push('-o', 'UserKnownHostsFile=NUL')
  args.push('-p', String(target.port))
  if (target.key !== undefined) args.push('-i', target.key)
  args.push(`${target.user}@${target.host}`, 'bash -s')
  return args
}

const token = randomBytes(6).toString('hex')
const remoteDir = `/tmp/dsh-ssh-test-${token}`
const remoteGit = `${remoteDir}/git-fixture`

const probe = String.raw`
set -u
echo "MARK_begin"
echo "ROOT=${remoteDir}"
echo "hostname=$(hostname 2>/dev/null)"
echo "pwd=$(pwd)"
echo "uname_s=$(uname -s 2>/dev/null)"
echo "uname_r=$(uname -r 2>/dev/null)"
echo "uname_a=$(uname -a 2>/dev/null)"
echo "id=$(id -u 2>/dev/null):$(id -g 2>/dev/null)"
echo "user=$(id -un 2>/dev/null)"
echo "home=$HOME"
echo "shell=$(printenv SHELL 2>/dev/null || true)"
echo "glibc=$(ldd --version 2>&1 | head -1)"
for c in bash sh python3 python git rsync tar sed awk grep find stat unzip; do
  p=$(command -v "$c" 2>/dev/null || true)
  if [ -n "$p" ]; then echo "tool_$c=$p"; else echo "tool_$c=MISSING"; fi
done
echo "bash_version=$(bash --version 2>/dev/null | head -1)"
echo "python3_version=$(python3 --version 2>&1 | head -1)"
echo "git_version=$(git --version 2>&1 | head -1)"
echo "tmp_mode=$(stat -c %a /tmp 2>/dev/null || echo unknown)"
# --- write / edit / delete probe inside the dedicated tree only ---
if mkdir -p "${remoteDir}"; then echo "mkdir=ok"; else echo "mkdir=fail"; fi
printf 'hello dsh-ssh\n' > "${remoteDir}/probe.txt" && echo "write=ok"
printf 'second line\n' >> "${remoteDir}/probe.txt" && echo "append=ok"
echo "content_sha=$(sha256sum "${remoteDir}/probe.txt" 2>/dev/null | cut -d' ' -f1)"
echo "content_lines=$(wc -l < "${remoteDir}/probe.txt" 2>/dev/null | tr -d ' ')"
sed -i 's/hello/HELLO/' "${remoteDir}/probe.txt" 2>/dev/null && echo "edit=ok"
echo "edited_content=$(head -1 "${remoteDir}/probe.txt")"
# --- git visibility probe ---
if mkdir -p "${remoteGit}" && cd "${remoteGit}" && git init -q . && printf 'fixture\n' > tracked.txt && git add tracked.txt && git -c user.email=test@example.invalid -c user.name="dsh test" commit -qm "init" && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "git_init=ok"
  echo "git_head=$(git rev-parse --short HEAD 2>/dev/null)"
  echo "git_tracked=$(git ls-files 2>/dev/null | head -1)"
else
  echo "git_init=fail"
fi
cd /
# --- cleanup: only the tree this script created ---
rm -rf "${remoteDir}"
if [ ! -e "${remoteDir}" ]; then echo "cleanup=ok"; else echo "cleanup=LEFTOVER"; fi
echo "MARK_end"
`

function run(target, budgetMs) {
  const started = Date.now()
  const result = spawnSync('ssh', sshArgs(target), {
    input: probe,
    encoding: 'utf8',
    timeout: budgetMs,
    windowsHide: true,
  })
  const elapsedMs = Date.now() - started
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const begin = stdout.indexOf('MARK_begin')
  const end = stdout.indexOf('MARK_end')
  const block = begin >= 0 && end > begin ? stdout.slice(begin, end) : ''
  const fields = {}
  for (const line of block.split(/\r?\n/u)) {
    const eq = line.indexOf('=')
    if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return {
    target: `${target.user}@${target.host}:${target.port}`,
    exitCode: result.status,
    signal: result.signal ?? null,
    elapsedMs,
    timedOut: result.error?.code === 'ETIMEDOUT' || elapsedMs >= budgetMs,
    stderr: stderr.trim(),
    fields,
    raw: block,
  }
}

function summarize(report) {
  const f = report.fields
  const required = ['hostname', 'pwd', 'uname_a', 'write', 'append', 'edit', 'cleanup', 'git_init']
  const missing = required.filter(key => f[key] === undefined || f[key] === 'fail' || f[key] === 'LEFTOVER')
  return {
    target: report.target,
    exitCode: report.exitCode,
    elapsedMs: report.elapsedMs,
    reachable: report.exitCode === 0 && f.hostname !== undefined,
    checks: Object.fromEntries(required.map(key => [key, f[key] ?? 'MISSING'])),
    missing,
    versions: {
      glibc: f.glibc,
      bash: f.bash_version,
      python3: f.python3_version,
      git: f.git_version,
      uname: f.uname_a,
    },
    tools: Object.fromEntries(Object.entries(f).filter(([key]) => key.startsWith('tool_')).map(([key, value]) => [key.slice(5), value])),
  }
}

const primaryReport = run(primary, timeoutSeconds * 1000 + 15_000)
const primarySummary = summarize(primaryReport)
console.log('=== dsh-ssh preflight: primary target ===')
console.log(JSON.stringify(primarySummary, null, 2))
if (primaryReport.stderr !== '') console.log(`stderr: ${primaryReport.stderr}`)
if (primaryReport.raw !== '') console.log(`--- remote output ---\n${primaryReport.raw}`)

let secondarySummary
if (secondary.host !== '') {
  const secondaryReport = run(secondary, 8000)
  secondarySummary = summarize(secondaryReport)
  console.log('\n=== dsh-ssh preflight: secondary target (read-only budget 8s) ===')
  console.log(JSON.stringify(secondarySummary, null, 2))
  if (secondaryReport.stderr !== '') console.log(`stderr: ${secondaryReport.stderr}`)
}

const extraEvidence = {
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  sshClient: (() => {
    const found = spawnSync('where.exe', ['ssh'], { encoding: 'utf8', windowsHide: true })
    return (found.stdout ?? '').split(/\r?\n/u)[0]
  })(),
  remoteDir,
}
console.log('\n=== environment ===')
console.log(JSON.stringify(extraEvidence, null, 2))

const failures = primarySummary.missing
if (secondarySummary !== undefined && !secondarySummary.reachable) {
  console.log('\nnote: secondary target is not reachable now; concurrency tests should use two reachable entries.')
}
if (failures.length > 0) {
  console.error(`\nPREFLIGHT FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  console.log('\nPREFLIGHT OK')
}
