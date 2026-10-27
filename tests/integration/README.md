# dsh-ssh isolated integration tests

This directory proves the `dsh-ssh` remote-workspace behaviour against the **real**
DeepSeek Harness 0.2.1-rc.2 CLI, the **real** agent loop, and the **real**
model-facing tools — without touching the running Desktop profile, without a
provider key, and without writing anywhere except a throwaway `$DSH_HOME` and a
`/tmp/dsh-ssh-test-*` remote scratch tree.

The scripts print their results and write machine-readable reports under the
operating system temporary directory. Reports may contain environment details;
review them before sharing.

## Files

| File | Purpose |
|---|---|
| `ssh-preflight.mjs` | Verifies SSH reachability and remote capabilities (hostname/uname/glibc, bash/git/python/find/grep, `/tmp` write-edit-delete, `git init`). Creates and removes only its own `/tmp/dsh-ssh-test-*` tree. |
| `lib.mjs` | Shared helpers: isolated `$DSH_HOME`, profile writer, local-package install, scripted Messages mock server, headless runner, remote scratch/SSH helpers. |
| `run-e2e.mjs` | The acceptance driver. Nine stages mapped to the user acceptance list; prints a PASS/FAIL table and writes a JSON report under `%TEMP%`. |

Unit tests (no SSH) live in [`../unit`](../unit) and run with
`npx --yes tsx --tsconfig tests/tsconfig.test.json --test "tests/unit/*.test.ts"`.

## Prerequisites

1. **Built plugin** (the Lead owns this; never edit `package.json`):
   ```powershell
   npm run build          # produces lib/
   ```
2. **Test-only dependencies** (isolated, never installed at the repo root):
   ```powershell
   cd tests/_deps
   npm install --no-audit --no-fund
   ```
   `tests/_deps/node_modules` is already ignored by the repo's `node_modules`
   `.gitignore` pattern.
3. **Node 24 for the CLI.** The shipped `bin.js` uses `import.meta.main` and
   requires Node >= 24. Set `DSH_NODE_BIN` to that runtime; it defaults to the
   current Node executable.
4. **SSH key auth** to targets you control. Set `DSH_SSH_HOST` and
   `DSH_SSH_USER`; optionally set `DSH_SSH_KEY` and the port. For concurrency,
   also configure `DSH_SSH_HOST2` and `DSH_SSH_USER2`.
5. Set `DSH_EXTRACT_ROOT` to the extracted DSH app directory, or set
   `DSH_CLI_BIN` directly to its `dsh/lib/bin.js` entry point.

## Run it

From the repo root, using a Node 20+ executable for the driver and a Node 24+
executable for the DSH CLI:

```powershell
# 1) SSH capability preflight (fast, safe, read-only + its own temp dir)
node tests/integration/ssh-preflight.mjs

# 2) Full acceptance run (≈5–8 minutes: every remote stage installs the local
#    plugin into a fresh isolated profile)
node tests/integration/run-e2e.mjs

# 3) A subset while iterating
& '...\node.exe' tests/integration/run-e2e.mjs --stages=local-hostname,remote-shell

# 4) Keep the isolated DSH_HOME + remote scratch for debugging
$env:DSH_E2E_KEEP='1'; $env:DSH_E2E_KEEP_SCRATCH='1'
```

The driver prints each stage as `PASS` / `FAIL` / `known-gap`, a summary table
with the user-requirement numbers, and the path of the JSON report.

## Stages

| Stage | Requirement | What it proves |
|---|---|---|
| `local-hostname` | 1 | A local headless session's `pwsh` tool runs on the local host (the stock preset is untouched). |
| `remote-shell` | 2, 8 | A session whose cwd is the placeholder `%DSH_HOME%\dsh-ssh-routes\c1\tmp\dsh-ssh-test-*` is switched to the `dsh-ssh:c1` preset; remote `bash` runs **in that remote cwd**, `hostname`/`uname`/`id` come from Linux, and remote `git` lists the fixture repo. No local hostname appears. |
| `remote-read` | 3 | The native `read` tool reads a remote file and the remote `.git/HEAD` through the SFTP-backed filesystem. |
| `remote-glob-grep` | 3 | The remote-preset `glob`/`grep` tools (remote `find`/`grep` through `dsh-ssh/tools`) find remote files by pattern and content. |
| `remote-write` | 4 | The native `write` tool creates a file that is then read back **over OpenSSH** — a real remote mutation. |
| `remote-delete` | 4 | Remote `bash` deletes the file; OpenSSH confirms it is gone. |
| `ssh-down` | 5 | A registry connection to `127.0.0.1:9` yields a failed tool/run and never a local Windows hostname (fails closed). |
| `concurrency` | 6 | Two isolated harness processes with separately configured registry connections run at the same time; each reports its own host, no cross-talk. |
| `local-unaffected` | 7 | A local session still executes locally after the remote worlds have been created (process-level check; same-process Desktop proof is a UI/manual check). |

## How the run is isolated

- Fresh `%TEMP%\dsh-ssh-e2e-*` **`$DSH_HOME`** per stage; `%TEMP%\dsh-ssh-e2e-*`
  profile directories contain their own `node_modules`.
- The real Desktop profile (`~/.dsh/profiles/desktop`) is never read, written or
  patched.
- The test profile is `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` +
  `dsh-ssh` (installed with `npm install file:D:\codes\dsh-ssh`, so the whole
  package and its production dependencies resolve; `--ignore-scripts` skips the
  repo's husky `prepare`).
- The profile patch mounts what headless lacks (the headless bundle has no Web
  host): `dsh-ssh/registry` (`ctx.sshRegistry`), `@deepseek-ai/dsh-agent-preset-registry`
  and the stock `standard` preset (`--patch` copy of
  `dsh-web-app/presets/standard.patch.yml`), and disables the Web-only
  `directory-picker-ssh` / `ssh-web-channel` rows.
- The connection registry is seeded by writing
  `<home>\dsh-ssh-connections.json`, and the CLI's process cwd is the local
  placeholder directory, which is what makes the session header carry the remote
  route.
- The LLM is the published `@deepseek-ai/dsh-llm-mock-server` started in-process
  on `127.0.0.1:<random>`; a two-entry script (`tool_call_success`, `success`)
  makes the real agent loop call exactly one real tool per run. The
  `session-title-llm` row is disabled so the script stays deterministic.
- Remote writes happen only under `/tmp/dsh-ssh-test-<random>` (or
  `$DSH_E2E_SCRATCH_ROOT`), removed in a `finally` block guarded by the prefix.

## Interesting environment facts the driver works around

- Remote git is **1.8.3.1**: `git -C <dir>` is unsupported; use `cd <dir> && git …`.
- Remote hosts have **no ripgrep** and `/tmp` is 100% full (246 MB free on the
  root filesystem at test time). Keep fixtures small.
- After the headless run prints its `final` event, the process does **not exit**
  while an SSH world is mounted (open ssh2 handles; see findings). The driver
  terminates it 2.5 s after `final` (`DSH_E2E_FINAL_GRACE_MS`) and treats that as
  a healthy run.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `DSH_CLI_BIN` | unset | CLI entry to spawn; alternatively configure `DSH_EXTRACT_ROOT` |
| `DSH_NODE_BIN` | current Node executable | DSH CLI interpreter (must be >= 24) |
| `DSH_EXTRACT_ROOT` | unset | extracted DSH app root and source of the stock preset patch |
| `DSH_SSH_HOST/USER/PORT/KEY` | unset / unset / `22` / SSH default identities | primary target |
| `DSH_SSH_HOST2/USER2/PORT2/KEY2` | unset | optional second target (concurrency) |
| `DSH_E2E_SCRATCH_ROOT` | `/tmp` | remote scratch root |
| `DSH_E2E_RUN_TIMEOUT_MS` | `180000` (stage default 120000) | per-run watchdog |
| `DSH_E2E_FINAL_GRACE_MS` | `2500` | grace after the `final` event before terminating the CLI |
| `DSH_E2E_KEEP` | unset | keep the isolated `$DSH_HOME` |
| `DSH_E2E_KEEP_SCRATCH` | unset | keep the remote scratch tree (debug only) |
| `DSH_E2E_EXPECT_HOSTNAME` | unset | extra assertion on the remote hostname |

## Not covered (see findings for the honest list)

Interactive PTY `terminal` round-trip, background jobs (`tool-bash
run_in_background`), the `edit` tool (needs a read+edit dialogue, but the mock
server scripts one tool name per server), same-process/multi-session concurrency
(needs the Desktop Web UI or SDK session API), session resume onto a remote
preset, and the real Desktop UI path. Those are the next automation steps once
the acceptance semantics are signed off.
