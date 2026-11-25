# TrustChain reusable-credential research

The default browser dashboard now connects to separate issuer and verifier services. The research workflow supports issuer-signed credentials, holder proofs, expiry/revocation, issuer-approved key rotation and recovery, and a reproducible local off-chain-versus-blockchain comparison.

Read SERVICES.md for setup, protocol details, tests, measurement definitions and limitations.

This remains a research prototype with simulated identity approval and software holder keys. Its custom credential format does not claim standards interoperability or production security. The old demo is available via ?legacy=1 and is not the evaluated workflow.

Further evaluation: STUDY.md covers repeated delay/concurrency measurements. REVOCATION.md covers cache/read-lag freshness measurements. TRUST_MODEL.md documents trust, privacy and recovery assumptions.

Status freshness: [STATUS-FRESHNESS.md](STATUS-FRESHNESS.md) distinguishes local caching from acceptance of older signed lists, including zero-cache replay tests.

Privacy evidence: [PRIVACY-TRACE.md](PRIVACY-TRACE.md) documents the browser trace across two verifiers and how to reproduce issuer visibility and credential linkability checks.

Durable chain demo: [DURABLE-DEMO.md](DURABLE-DEMO.md) provides fresh setup commands and the complete browser recovery test with signed-transaction persistence enabled.
