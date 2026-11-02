# Upstream and host SDK provenance

This repository is an independent fork of https://github.com/UynajGI/dsh-ssh.
The original author and MIT license are preserved. Fork releases are published at
https://github.com/capkten/dsh-ssh/releases, not to the upstream npm package.

The fork adds session-scoped remote routing, SSH-host and Docker-exec targets,
Desktop controller bridges and optional compaction-provider selection.

Runtime host modules are supplied by the DSH loader. They are intentionally not
runtime dependencies or auto-installed peer dependencies: a second installation
can break Cordis service / tool scheduler identity even at the same version.
The development SDK dependencies remain pinned by package-lock.json and are not
included in the installation tarball. The existing compile-time SDK uses rc.2;
rc.5 runtime compatibility is separately checked against the extracted Desktop.

The 0.4.3 prerelease declares DSH 0.2.1-rc.5 only. Do not bypass that constraint
for other versions without reviewing their provider and controller interfaces.
