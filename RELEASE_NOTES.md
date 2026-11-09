# 0.4.5-hostkey.1 — first-connection host-key confirmation

Compatible with DSH Desktop 0.2.2-rc.1 (exact engine requirement). This prerelease is based on 0.4.4.

- Add a fingerprint confirmation dialog to SSH workspace creation, directory browsing and connection tests.
- Trust only a server-observed key after explicit approval; append it to known_hosts without replacing existing records.
- Support OpenSSH hashed known_hosts, independent ports and ProxyJump hop confirmation.
- Reject changed or revoked keys; never automatically accept a new key or fall back to local execution.
- Refresh trust on each handshake and allow retry after explicit approval.

## Verification and limits

Typecheck, build, unit tests and isolated real SSH handshake tests passed on Windows. The installed package was also tested with a temporary loopback SSH server: no authentication before approval; successful retry after approval. Existing connection configuration and known_hosts were preserved.

Desktop popup acceptance against a new external server remains unverified. Background session operations fail closed; use the workspace connection flow to approve a new host. Remote permissions are not a complete local sandbox equivalent.

Download the .tgz asset and follow INSTALL.md. SHA256SUMS.txt is generated for the GitHub-built package.