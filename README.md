# dsh-ssh

English | [中文](README.zh.md)

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

## How it works (DSH 0.2.1-rc.2)

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

```sh
dsh plugin --profile desktop add dsh-ssh
```

Or use the Web UI: **Plugins → Add plugin → `dsh-ssh`**. Needs DeepSeek Harness 0.2.x and Node ≥ 22.
A plain `npm i dsh-ssh` does not select the bundle; add it to `dsh.profile.bundles` yourself.

## Security

- Host-key verification: registry connections accept `strictHostKeyChecking` and `knownHosts`
  (`SHA256:…` fingerprints or raw base64 keys). With `strictHostKeyChecking: true` and no explicit
  `knownHosts`, the matching entries of `~/.ssh/known_hosts` are used. The default stays permissive
  (`false`) for compatibility with existing saved connections — enable it for new deployments.
- Connection passwords/passphrases persist verbatim in `<dsh home>/dsh-ssh-connections.json`; that
  file is operator-owned and should be protected like `~/.ssh`.
- Remote commands run as the SSH login user. **There is no remote kernel sandbox**: only filesystem
  mutations are fenced (read-only / workspace-write against the remote workspace root) and the host
  approval flow still applies to them. Treat a remote workspace as full shell access to that host.
- A dropped SSH link makes remote tool calls fail; the same host is redialed on the next call. There
  is no fallback to the local filesystem or a local shell.

## Limitations (honest list)

- **Web sidebar File tree / file preview / “Open in app”** and the **Web sidebar terminal** read the
  *host* `fs` / `subprocess` services in DSH 0.2.1, so they stay local for a remote workspace. The
  model-facing terminal tool *is* remote.
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


### Desktop integration gate (2026-10-23)

Host SDKs are peers. Peers alone do not guarantee a single instance: run
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
See `docs/desktop-integration-20261023.md` for evidence and deployment boundaries.
