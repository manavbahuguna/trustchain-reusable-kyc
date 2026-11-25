# Durable transaction recovery

Set `chain.transactionKeyFile` in an issuer service configuration to an absolute path containing the hex private key of the configured chain issuer account. Restrict that file to its owner (0600). The adapter checks that its address matches the configured RPC account and contract issuer. This adapter remains restricted to loopback RPC and chain ID 31337. Never use the public Hardhat fixture key for real funds or deployment.

When enabled, approval reconciliation populates and signs a transaction locally, saves its serialized bytes, hash, nonce, and chain ID in the existing encrypted SQLite application journal, and only then broadcasts it. A restart validates the signature's recovered sender, destination, chain, nonce, value, calldata, and hash before using the saved transaction. If still unresolved, it rebroadcasts exactly those bytes. A matching contract state completes reconciliation; a reverted receipt or binding mismatch stops it. A known pending transaction remains pending. There is no automatic nonce replacement or fee bump.

Existing configurations without transactionKeyFile retain RPC-managed signing and the BROADCAST_UNKNOWN limitation. Adding the key does not repair old ambiguous entries without signed bytes. Legacy direct issue/revoke/key-change routes do not use this journal. Do not clear old submitting markers blindly.

Use one dedicated signing account per serialized issuer service. Another writer consuming its nonce can prevent progress; the outbox does not coordinate multiple writers. Chain resets/reorgs and stale verifier caches remain outside this recovery guarantee. The private key itself is never added to the application journal. Existing issuer-key-derived encryption protects the signed transaction at rest, but the transaction is a replayable broadcast artifact and must not be exposed through public/admin responses.

Validation: 72 regression tests pass. The local-chain integration script now uses the production encrypted SQLite Storage module for six actual SIGKILL cases: before preparation commits, after preparation commits but before broadcast, and after mining before confirmation is saved, each for registration and revocation. Restart reopens SQLite, reconciles, and repeats reconciliation. Rolled-back preparation is empty and can be prepared afresh; committed preparation retains the original transaction hash. The tests use a minimal application-journal fixture, not a full HTTP approval workflow at every crash point.

A real-chain competing-writer test consumes a prepared transaction's nonce with a different mined transaction. Two recovery attempts both report OUTBOX_NONCE_CONFLICT, preserve the signed bytes, and leave the intended credential unregistered. No nonce is reassigned automatically. Pending-transaction, full service-restart, durable-pickup, and revocation-order integration checks also pass.

These tests establish behavior for the exercised local cases, not production reliability rates. Remaining scenarios include fee changes, reorgs, disk-full failures, and concurrent service writers. Durable signing is still opt-in through transactionKeyFile; existing RPC-managed signing is unchanged.

Run:

```sh
node --test server/assertion.test.cjs research/reusable-kyc/*.test.mjs
node research/reusable-kyc/chain-recovery-test.mjs
```

## Network recovery checks — 27 October 2026

The integration runner now includes four additional real local-chain cases, covering registration and revocation under each of these faults:

- A forwarding RPC proxy lets the node accept the signed transaction, destroys the broadcast response, and returns HTTP 503 for subsequent calls until recovery starts.
- The node accepts a pending transaction, then the test explicitly removes it using Hardhat's transaction-eviction facility.

Automining is disabled to control the pending state. Each case closes the adapter and encrypted SQLite database, reopens both, and retries from the stored transaction. It verifies the transaction is pending, mines a block, checks the requested contract state, and verifies that every broadcast attempt uses identical signed bytes, hash, and nonce. A final confirmed retry must produce no broadcast. The lost-response cases assert that both intended responses were actually dropped.

All four cases passed, together with the six existing SIGKILL cases, the competing-nonce case, and service-level pending/restart/replacement checks. No production behavior changes were needed for these network scenarios.

These are controlled loopback fault injections against Hardhat, not public-network measurements. The new cases reopen storage and RPC connections in the same test process; process termination is exercised separately by the SIGKILL matrix. Tests cover the signed-transaction path enabled by transactionKeyFile. They do not establish automatic recovery for legacy ambiguous broadcasts, or behavior under chain reorganization and fee escalation.

For a fresh disposable configuration that enables transactionKeyFile automatically, use [DURABLE-DEMO.md](DURABLE-DEMO.md). Its browser test verifies persisted signed transactions for issuance, rotation, and recovery.
