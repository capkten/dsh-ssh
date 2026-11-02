# 0.4.3 — SSH and Docker workspaces for DSH 0.2.1-rc.5

- Includes the fork's session-isolated SSH and Docker-exec workspace support.
- Adds optional compactionProvider / compactionConfig for remote presets.
- Removes auto-installed host SDK peers to avoid a second host core installation.
- Publishes a compiled `.tgz` with SHA-256 checksums through GitHub Actions.
- Preserves upstream author and MIT attribution; does not publish to upstream npm.

Download `dsh-ssh-0.4.3.tgz` and follow INSTALL.md. The GitHub source ZIP is not
the installation package. Optional session compaction is a separate plugin:
https://github.com/capkten/dsh-compaction-session

This is a prerelease for rc.5. CI runs typechecking, unit tests, build and package
checks. Isolated preset checks are additional maintainer evidence, not complete
live Desktop / real-server acceptance of this release. SSH provides no remote
kernel sandbox. Docker access is privileged and the container boundary does not
prove equivalent sandboxing. UI plugins bypassing workspaceFiles may be incompatible.
