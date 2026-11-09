# SSH host-key confirmation — 2026-11-09

Branch: fix/host-key-confirmation, based on ef3a946 (0.4.4, Desktop 0.2.2-rc.1). Implementation and isolated verification completed; installed on 2026-11-09.

## Root cause and red test

The strict ssh2 verifier returned false for unknown host keys, with no structured challenge or frontend approval path. Trusted keys were captured at SshConnection construction, so adding a key later could leave an existing connection object using old trust. OpenSSH hashed known_hosts records were skipped.

`npx tsx --tsconfig tests/tsconfig.test.json --test tests/unit/host-key-handshake.test.ts` initially failed with: unknown host must expose a structured trust challenge, not just fail verification.

## Implementation

- `src/hostkeys.ts`: bounded, expiring server-observed challenges; SHA256 fingerprints; host/port-specific known_hosts lookup including hashes/revocations; explicit approval appends the observed key while preserving existing file contents. Changed keys cannot be approved through this endpoint.
- `src/connection.ts`: strict checks per ProxyJump hop; propagate the challenge before login authentication; refresh trust at each handshake; clear failed environment/SFTP promises for an explicit subsequent retry.
- `src/registry.ts`, `src/web.ts`: preserve challenges through connection tests, home and directory RPCs, using valid DSH result envelopes. Trust decisions remain within the existing authenticated channel.
- `src/client/hostkey*.ts*`, `src/client/flow.tsx`: confirmation dialog in add-workspace/test flows, with cancellation and abort handling; retry only after an observed handshake challenge and explicit trust, never ordinary transport errors.
- `src/runtime.ts`: recognize hashed known_hosts entries in legacy lookup too.

## Evidence and limits

- Real loopback ssh2 server: first attempt exposes fingerprint; zero authentication attempts before approval; after approval the same connection object retries and reads HOME successfully. All trust files are under a dedicated temporary directory and are removed after testing.
- Actual React component renderer: fingerprint/host displayed; confirm calls trust then retries; cancel/abort do not call trust; changed keys expose no approval button.
- RPC tests cover connection testing, browse.home and browse.list challenge envelopes.
- Tests cover forged/mismatched confirmation, existing-file preservation, changed/revoked keys, independent ports, OpenSSH hashes, and no retry on ordinary failures.
- With DSH bundled Node v24.21.0: typecheck, build and npm test passed.
- Installed Desktop UI / new real external server: not yet verified. Production package was installed after full DSH exit; an installed-package loopback handshake passed with test-only SDK dependency resolution. Runtime/Desktop manifest still reports 0.2.2-rc.1.
- Background session operations fail closed; to make a new trust decision, return to the add-workspace connection flow. No claim of a global background-session popup.

Candidate: outputs/dsh-ssh-0.4.5-hostkey.1.tgz
SHA256: 5CC8A271E889F0FEC6A9AA7C272FAFA4A6416B3774F79BACDD880A363E637272
