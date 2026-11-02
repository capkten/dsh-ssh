# dsh-ssh

English | [中文](README.zh.md)

**Fork release:** [Download compiled packages](https://github.com/capkten/dsh-ssh/releases)
and follow [INSTALL.md](INSTALL.md). Version 0.4.3 is a prerelease for Desktop
0.2.1-rc.5. The bare npm name belongs to upstream and does not select this fork.
See [UPSTREAM.md](UPSTREAM.md) for attribution and host SDK policy.

<p align="center">
  <img src="https://img.shields.io/npm/v/dsh-ssh" alt="npm version">
  <img src="https://img.shields.io/npm/l/dsh-ssh" alt="license">
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933" alt="node version">
  <img src="https://img.shields.io/github/stars/UynajGI/dsh-ssh" alt="GitHub stars">
</p>

**SSH remote workspaces for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).** Pick
a directory on a remote Linux host from the **Add workspace** flow and the whole coding agent — Bash,
read/write/edit, glob/grep, background jobs, the model-facing terminal — executes there over one SSH
connection. Local workspaces keep the stock tools. Built on [ssh2](https://github.com/mscdex/ssh2);
ProxyJump chains, SFTP, full auth, host-key verification support.

![Add a workspace over SSH](docs/images/add-workspace.png)

## How it works

DSH mounts model-facing tools through **agent presets**, and the stock preset resolves the *host*
`fs` / `subprocess` / `shell` services. dsh-ssh therefore:

1. keeps the connection registry and the **Add workspace** UI at host scope;
2. registers one **isolated agent preset per SSH connection** (`dsh-ssh:c1`, `dsh-ssh:c2`, …) whose
   realm mounts the SSH filesystem, subprocess and bash executor, plus the remote search tools and a
   remote PTY terminal;
3. switches a freshly created session onto that preset **only when its working directory is a remote
   route** — the local placeholder under `<dsh home>/dsh-ssh-routes/<id>/<remote path>` that
   `session.route` creates (DSH mkdirs the session cwd locally and only accepts local absolute
   paths, so the placeholder is the routing key, not a repository mirror);
4. fails the session loudly when a routed session cannot get its remote preset, instead of silently
   running tools on the harness host.

The remote realm is per connection, so two sessions on two servers cannot cross, and local sessions
never see the remote providers.

## Install

Use the versioned GitHub Release `.tgz` and the Profile dependency/bundle steps in
[INSTALL.md](INSTALL.md). Needs Desktop 0.2.1-rc.5 and Node ≥22.19.0.
The automatically generated source ZIP is not the installation package.

## Security

- Host-key verification: registry connections accept `strictHostKeyChecking` and `knownHosts`
  (`SHA256:…` fingerprints or raw base64 keys). With `strictHostKeyChecking: true` and no explicit
  `knownHosts`, the matching entries of `~/.ssh/known_hosts` are used. Strict
  checking defaults to true; do not disable it to bypass an unknown host.
- Connection passwords/passphrases persist verbatim in `<dsh home>/dsh-ssh-connections.json`; that
  file is operator-owned and should be protected like `~/.ssh`.
- Remote commands run as the SSH login user. **There is no remote kernel sandbox**: only filesystem
  mutations are fenced (read-only / workspace-write against the remote workspace root) and the host
  approval flow still applies to them. Treat a remote workspace as full shell access to that host.
- A dropped SSH link makes remote tool calls fail; the same host is redialed on the next call. There
  is no fallback to the local filesystem or a local shell.

## Limitations (honest list)

- The fork bridges official `workspaceFiles` controllers for routed file previews
  and listings. Third-party sidebars bypassing that controller may be incompatible.
  Full Desktop UI acceptance of this release remains pending; do not infer it
  from passing model-tool tests. The model-facing terminal is remote.
- The **changed-files (git) card** (`dsh-workspace-changes`) mixes local scratch files with remote
  git paths, so it is not meaningful for remote workspaces. Running `git` through the Bash tool is
  remote and works normally.
- No LSP integration (the old README promise was aspirational).
- Remote `glob`/`grep` are implemented with remote `find`/`grep` (GNU/POSIX) because the stock tool
  spawns the harness-packaged local ripgrep binary.
- Sessions created **before** this architecture (recorded under the stock preset) and already
  started cannot be switched; opening one fails with a clear error. Start a new session in that
  workspace.
- Remote pid is always `-1`; `terminate` signals the SSH channel rather than a remote process group.
- GNU-only helpers (`realpath -mz`, `base64 -w0`, `ln -T`) are used for canonical paths and atomic
  writes; they are present on mainstream Linux distributions (including old CentOS 7).
- The interactive Web terminal requires host-plane code changes in DSH itself (see above).

## Development

```sh
npm i
npm run typecheck
npm run build      # emits lib/ — the payload the harness loader imports
npm test           # node:test unit suite (routing, placeholders, env scrubbing)
```

The integration driver under `tests/integration/` runs a throwaway DSH home/profile and the real
headless harness against a real SSH target (`npm run test:e2e`; requires the bundled Node ≥ 24 and
`tests/_deps` installed). It never touches the running Desktop profile. See
`tests/integration/README.md` for prerequisites and the acceptance-stage map.

## License

MIT

### Remote compaction configuration

The aggregate `ssh-remote` row accepts optional `compactionProvider` (a plugin package name) and `compactionConfig` (that provider's configuration). Omitting the provider keeps `@deepseek-ai/dsh-compaction-basic`. Settings are copied separately into each SSH/Docker preset's isolated compaction group. Local presets have separate engines; use the companion plugin's shared settings for local and remote compaction together.

For example, a separately installed `dsh-compaction-session` provider can use `compactionConfig: { thresholdTokens: 256000, maxTokens: 8192, headroomTokens: 1024 }`. The model adapter's `contextWindow` remains a separate capacity setting. Output reservations may require an earlier effective threshold. Add an external provider's bundle to the Desktop profile and restart DSH before resuming sessions; a missing provider fails preset activation rather than falling back to local execution.


### Desktop integration gate (2026-10-23)

Host SDKs are supplied by the loader, not auto-installed as dependencies or peers. Run
`node tests/integration/check-host-sdk.mjs <host-dsh-root> <installed-plugin-root>`
before starting an isolated profile. All checked SDK paths must match.
The default bundle keeps the official local browse provider; remote browsing
uses `/dsh-ssh`. The legacy `dsh-ssh/picker` remains available for explicit
host-wide SSH compositions. SSH host-key checking is enabled by default.
Remote version checks require `sha256sum`; replacement writes require the
OpenSSH POSIX rename extension and fail explicitly when unavailable.
Run `node tests/integration/provider-smoke.mjs` for real provider acceptance.
Desktop sidebar terminal, file tree, and changed-files integration remain
outside the verified remote agent tool path. SSH is not a remote kernel sandbox.
See [INSTALL.md](INSTALL.md) for current deployment boundaries. Historical local
investigation logs and private environment evidence are not shipped in this repository.

## Docker exec

Connect to the SSH host, then choose a running Linux container and its workspace
directory. No container sshd/port 22 is required. The host needs Docker CLI/daemon
access and the container needs the required shell and file/search tools; minimal
distroless/scratch images are not generally supported. See INSTALL.md for checks.
