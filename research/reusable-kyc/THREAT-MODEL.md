# TrustChain threat model and privacy review

Reviewed 27 October 2026. Scope: the reusable-credential research implementation in `research/reusable-kyc`, `src/ResearchApp.jsx`, and `src/research-client.js`. This is a code-based assessment with mapped test evidence, not an independent penetration test or a formal proof. Legacy biometric/demo components are outside this review.

## Intended security properties and assumptions

The prototype aims to require issuer approval for issuance and recovery, bind presentations to a holder key and a verifier challenge, reject expired or revoked credentials subject to status freshness, and recover interrupted ledger operations without creating a fresh replacement transaction unnecessarily.

Trusted components are the issuer service and its credential-signing key, configured verifier trust anchors, the browser origin and its delivered JavaScript, the passkey implementation, local storage ownership, and the configured chain/RPC view. A passkey user-verification result establishes authenticator-mediated user verification; it does not establish legal identity, biometric accuracy, or liveness. Identity approval is explicitly simulated.

Adversaries considered include unauthorized API clients, holders replaying or modifying messages, colluding verifiers correlating presentations, an observer with ledger or status-list access, someone stealing a recovery/pickup secret, and an RPC/network failure or stale response. Compromise of trusted keys, origin JavaScript, or the issuer is analyzed as a limitation rather than assumed to be prevented. Local-chain tests do not model Byzantine consensus.

## Data visibility

| Party or location | Observable information | Privacy consequence |
|---|---|---|
| Holder browser | Credential, holder signing CryptoKey, pending pickup secret, passkey interaction, recovery code displayed after collection | Non-extractable keys reduce exportability but do not prevent malicious same-origin JavaScript from invoking signing. IndexedDB is not an isolated hardware wallet. |
| Issuer | Issuance and recovery requests, holder public key, stable credential ID, status index, passkey public credential/counter, credential lifecycle | The issuer can associate these records. Administrative review is a trust dependency. |
| Issuer during presentation | Entire action containing credential and holder proof; the proof body contains audience, request ID, and nonce | The issuer can identify the verifier and correlate use even if status is checked through the chain or an aggregate list. Hashing the action in the returned authorization does not hide the input from the issuer. |
| Verifier | Full credential and proof, stable credential ID and holder public key, status index, assurance level, timestamps | Repeat use is linkable. Colluding verifiers can compare identifiers. There is no selective disclosure or pairwise pseudonym mechanism. |
| Per-credential status endpoint | Credential identifier and query timing; network peer metadata | The query reveals which credential is being checked. Application code need not persist a log for the endpoint operator to observe the request. |
| Aggregate status-list reader | Issuer identifier, record count, indexed revocation bits, issuance/expiry times | Fetches omit a single credential ID, but list contents expose aggregate size and changes. A verifier possessing a credential knows its index. Passkey calls still disclose usage to the issuer. |
| Chain observer and RPC operator | Issuer address, hashes of credential IDs, register/revoke calldata and state, transaction timing and order | Hashes hide direct IDs from an observer without them, but are stable and computable by any party holding a credential. Timing may suggest replacement relationships; this is an inference, not a measured linkage success rate. |
| SQLite reader without issuer key | Plaintext credential records; encrypted application blobs and audit metadata | Application encryption is not full database encryption. Credential records include public identity-binding material and recovery-token hashes. |
| SQLite reader with issuer private key | Application requests/results, including recovery codes and signed outbox transactions | Storage encryption derives from the issuer key. Key compromise also compromises application confidentiality; it is not independent protection. |

Evidence: `protocol.mjs`, `passkeys.mjs`, `status-list.mjs`, `chain.mjs`, `storage.mjs`, `approvals.mjs`, and the two browser source files above.

## Security boundaries and evidence

| Threat | Implemented control and existing evidence | Remaining boundary |
|---|---|---|
| Forged or altered credential | Issuer signature and configured trust checks; protocol tests | A stolen issuer signing key can forge issuer statements. No independently enforced real-world identity policy. |
| Replay or cross-verifier use | Holder proof binds credential hash, audience, nonce, request ID; challenge consumed before asynchronous status work; protocol/concurrency tests | Verifier compromise and malicious browser code remain outside the guarantee. |
| Stolen credential alone | Holder-key signature; passkey authorization on protected credentials; passkey/protocol tests | A compromised origin can request signatures; passkey prompts do not necessarily provide a trusted display of the full transaction intent. |
| Unauthorized issuance/admin access | Admin session checks and explicit approval; service/approval tests | Bootstrap-key theft grants administrative power. Recovery approval does not independently verify legal identity. |
| Recovery-code theft | New-key proof plus issuer approval; lifecycle and approval tests | Code theft combined with mistaken/malicious approval can transfer control. Recovery deliberately does not require the lost old key. |
| Secret disclosure through queue listing | Listing selects public fields and transaction hashes; approval/reconciliation tests | Authorized pickup returns credential and recovery code. Code secrecy depends on pickup-secret handling and browser safety. |
| Stale revocation evidence | Bounded caches, expiry checks, signed status freshness, no expired-cache fallback; cache/status-list tests | Freshness differs by backend. Zero local cache is not a universal guarantee of zero revocation delay. |
| Crash during replacement | Revocation before registration, persisted intent, reserved original credential, signed outbox when configured | Durable signing is opt-in. Legacy routes and old ambiguous submissions do not gain the same recovery behavior. |
| Lost broadcast response or eviction | Stored signed bytes are reused; real-chain network fault tests | Fee escalation and reorgs are not resolved. Another writer consuming the nonce blocks recovery for review. |
| Service exhaustion | Request-size and queue limits, serialized mutation, exclusive SQLite owner | Capacity limits are not a denial-of-service defense. Public requests can occupy capacity; rate limiting and hostile-load resilience have not been established. |

The 72-test regression suite and local-chain recovery tests were run successfully in preceding implementation tasks. This review maps those results to claims; it does not represent a new full test execution or a new exploit campaign.

## Freshness and availability distinctions

Nonce-bound signed per-credential status prevents substituting a previously signed response for a different fresh query. Positive local caching still permits a previously accepted status until its configured deadline.

The aggregate list has no query nonce. With zero local cache, the reader refetches but can accept a still-valid signed list up to its allowed lifetime (currently at most 60 seconds). An actor able to substitute responses could replay such a list within that window. This follows from `listReader` timestamp checks; reader-level stale-response replay is now covered by deterministic tests documented in STATUS-FRESHNESS.md; an adversarial transport is not simulated. Positive-cache limits constrain accepted list age further. Do not describe zero-cache aggregate verification as guaranteed instantaneous revocation.

Chain checks depend on the RPC view; optional block lag and positive verifier caching deliberately admit older state. “Old revoked before new registered” describes ledger order, not a guarantee that all cached verifiers stop accepting the old credential at that instant.

Fresh protected presentations require the issuer's passkey authorization service even with chain-backed status. An already obtained, unexpired authorization may remain usable for its bound presentation. Thus an issuer outage prevents fresh authorization, but does not necessarily invalidate every previously authorized presentation immediately.

## Safe research claims

Supported wording: “A research prototype for issuer-approved reusable credentials with holder-bound presentations and issuer-mediated passkey authorization. The study compares status mechanisms and their freshness, information exposure, availability, and recovery trade-offs. Controlled local tests exercise replay rejection and interruption recovery.”

Avoid claiming anonymity, unlinkability, issuer-unobservable usage, fully offline verification, production KYC compliance, validated biometric recognition, W3C credential interoperability, unconditional exactly-once execution, or immediate global revocation. None is established by this implementation and evidence.

## Prioritized follow-up work

1. Completed on 27 October 2026: aggregate-list stale-response and exact expiry/cache-boundary tests. STATUS-FRESHNESS.md records the observed policy and the limitation of earlier honest-endpoint measurements.
2. Completed on 27 October 2026: the browser privacy trace demonstrates issuer-visible audiences and stable identifiers across two verifiers; see PRIVACY-TRACE.md. If issuer-unobservable use becomes a research goal, redesign authorization before making that claim; changing status storage alone cannot achieve it.
3. Establish a deployment boundary: separate role origins if stronger browser isolation is intended, transport security, key provisioning/rotation, rate limits, and recovery approval policy. These require a target deployment rather than assuming the local demo is production-ready.
4. Expand ledger fault coverage for fee changes and reorgs only if such guarantees are in scope. Keep blocked outcomes visible and do not clear ambiguous state automatically.
5. Package a reproducible release with pinned inputs, exact commands, raw results, and an explicit separation between software-key ablations and full passkey flows.
