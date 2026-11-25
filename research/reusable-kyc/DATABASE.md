> Blockchain recovery update: administrator-approved requests now have durable recovery plans, startup reconciliation and an administrator retry control. See [CHAIN_RECOVERY.md](CHAIN_RECOVERY.md) for scope and unresolved cases.

# TrustChain database milestone

Implemented in `/Users/manavbahuguna/Desktop/ssi-kyc`.

## What changed

The issuer now stores credentials, passkey counters, pending approvals, approved pickup results, rejection decisions and a minimal operation log in SQLite. Approved pickup results, including the recovery code, are encrypted with AES-256-GCM. Request access secrets remain hashed. The encryption key is derived from the issuer's existing private key with a storage-specific prefix; retain that key with your protected backups. This is not independent key management.

For the signed-status backend, old-credential revocation, replacement issuance and the approval result commit in one database transaction before success is returned. A failed operation restores the last committed state. If the process dies before commit, the pending approval remains available; after commit, the holder can collect the same result. Repeating an approved request cannot issue a second credential: use collection to recover a lost response.

For the blockchain backend, external writes cannot be rolled back with SQLite. Durable checkpoints preserve progress. An approval found in `processing` on restart becomes `needs-review`, preventing blind automatic retries. Failed or interrupted chain operations still require manual reconciliation. Automatic blockchain transaction recovery is not implemented in this milestone.

## Migration and operation

Use Node.js 22.16 or newer; validated on 22.22.2. Its built-in SQLite module currently emits an experimental-feature warning.

Existing issuer configuration continues to work. On startup, `stateFile + '.sqlite'` becomes the default database path. If a JSON state file exists, its credential records are imported on first database initialization. The original file is preserved and is no longer updated. Later restarts use the database and do not reimport stale JSON.

Alternatively, configure `databaseFile` explicitly. `stateFile` is then optional and is only a source for the initial migration. Use one issuer process per database: an exclusive SQLite lock rejects a second owner, avoiding stale cached state. This is a local, single-process implementation; it is not a multi-instance database architecture.

Stop the issuer before copying the database for backup. Keep the database, issuer private key and configuration together in protected backup storage. Do not delete the SQLite file to reset the service: doing so can cause old JSON records to be imported again. No existing live configuration or credential store was started or migrated during this implementation; validation used temporary test data.

Pending and approved pickup requests retain their original 15-minute expiry across restart. Sessions and uncompleted WebAuthn/lifecycle challenges intentionally remain short-lived memory state; sign in again or start a fresh challenge after restart. Once a recovery request is submitted, it is durable and can be approved after restart.

## Validation

59 automated tests passed, the production build passed, and the three-role browser flow passed with virtual passkeys. New tests cover migration, duplicate-process rejection, encrypted recovery results, incorrect storage-key rejection, injected write rollback, forced process termination, pending request recovery, durable approved pickup, and single replacement issuance.

The operation log records timestamps and operation names, without request secrets or identity data. It is not yet a complete staff-attributed audit trail. Database tables currently store serialized records and use snapshot replacement inside transactions; larger deployments need indexed per-record updates and retention policies. Existing benchmark results predate this storage implementation.

## Next work

Implement blockchain transaction reconciliation and safe recovery of interrupted issuance, with explicit retry states and an administrator repair workflow. Real identity review, standard credential formats, issuer-key lifecycle and deployment hardening remain later priorities.

SQLite API reference: https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html
