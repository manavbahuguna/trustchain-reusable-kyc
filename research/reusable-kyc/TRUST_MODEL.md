# TrustChain: trust, privacy and recovery model

## Scope

This describes the implemented research workflow, not the legacy dashboard or a complete financial onboarding system. Identity approval and recovery re-approval are simulated administrator decisions. Credentials use a custom signed format and software holder keys. No regulatory compliance, hardware attestation, anonymity, or standards-interoperability claim follows from this implementation.

## Parties and authority

| Party | Trusted capability | What a compromise permits |
|---|---|---|
| Issuing institution | Approve identity evidence, sign claims, maintain or publish credential status | Issue false credentials, revoke valid ones, approve improper recovery; blockchain cannot validate the truth of signed claims |
| Holder browser | Protect and use a private key, display the intended operation | Same-origin malicious code can request signatures or steal recovery material; non-exportability alone is not hardware protection |
| Verifying institution | Pin trusted issuer keys, validate presentations and apply freshness policy | Weaken trust/freshness requirements, collect/link credentials or accept invalid claims locally |
| Offline recovery-code holder | Keep a random secret outside the wallet | Code plus compromised issuer authority may authorize replacement; code alone is insufficient in the implemented API |
| Chain RPC provider | Supply correct, timely chain state | Lie, serve stale state or deny service; local prototype has no light-client proof or independent quorum verification |
| Local test chain | Enforce issuer-only writes and record status | Local node operator controls chain history; local block lag is not evidence of public-chain finality |

Issuer trust is provisioned out of band by configuration, not inferred from a credential-supplied URL. The chain contract is also pinned in configuration. No key or endpoint supplied by an untrusted presentation becomes a trusted issuer.

## Security properties supported by implementation and tests

- Holder proof binds the exact credential, verifier audience, fresh challenge, and request ID; replayed consumed requests fail.
- Issuer signatures, expiry and required assurance level are checked before status acceptance.
- Cached active status never bypasses issuer signature, holder proof, credential expiry or issuer removal.
- Rotation requires current-key and replacement-key proofs, and administrator authorization.
- Recovery requires the offline random code, replacement-key proof, explicit simulated re-approval, and administrator authorization.
- Rotation/recovery invalidates the old credential before issuing a replacement; it preserves original expiry and assurance level.
- Expired cache entries are not used as fallback if status retrieval fails. A still-valid active cache entry may admit a revoked credential or continue during an outage, by explicit policy.
- Contract writes require the deploying issuer account. This enforces authorization, not truth of KYC claims.

These are specific tested behaviors, not a formal security proof or audit.

## Privacy inventory

| Location | Visible or stored information | Linkability/exposure |
|---|---|---|
| Browser IndexedDB | Credential, issuer endpoint, non-exportable software CryptoKey | Browser/site compromise can use keys and read claims; refresh persistence is not device independence |
| Browser page memory | Administrator token and recovery code while entered/displayed | This combined local demo represents multiple roles on one page; it is not a production separation of duties |
| Issuer state file | Credential identifier, holder public key and signed payload fields, expiry, revocation state, recovery-code hash | Issuer can correlate all its records; raw identity documents are not collected in this prototype |
| Off-chain status endpoint | Requested credential ID, nonce, request time and transport metadata | Issuer can observe status checks and potentially correlate presentations; no unlinkability guarantee |
| Verifier | Presented credential, stable holder key, claims, challenge response, timing | Repeated presentations and cross-verifier sharing may be linkable |
| Public-chain equivalent | Hash of random credential ID, status, writer account, transaction timing | Hashes can be matched when IDs are known; transaction history is public and revocation does not erase it |
| RPC endpoint | Contract reads, queried identifier hashes, timing and source network metadata | Provider can observe and correlate verification behavior |

No biometric is used by the new research holder-proof flow. This does not establish that the entire legacy application or device never stores biometric information.

## Revocation freshness policy

Default cache TTL is zero and default chain block lag is zero. Optional verifier configuration changes the acceptance window:

1. A valid active status can be reused until its original cache deadline; hits do not extend that deadline.
2. A lagged chain read may still see active state after revocation is recorded at the head.
3. If that older active state is cached again, the additional TTL can extend acceptance past the point when the lagged chain would otherwise expose revocation.
4. Request/response delay and polling resolution affect observed detection time.

Thus cache lifetime and chain read lag must be documented together. More blocks of lag are not automatically safer for revocation freshness. This experiment does not model reorganizations or prove an appropriate confirmation depth for any public network.

## Recovery and compromise response

The implemented flow covers holder-key rotation and issuer-approved holder recovery. It does not implement issuer signing-key rotation or a governance process for compromised issuers. Operationally, a verifier can remove an issuer from its trusted configuration and restart, invalidating its trust and in-memory cache; previously trusted signatures are not automatically repaired by the chain.

After a holder replacement failure that occurs after old-credential revocation, manual issuer review is needed. There is no atomic transaction spanning chain state and local files, nor an automatic rollback to a valid old credential. Local state uses atomic file replacement, not transactional storage or guaranteed crash durability.

## Required work before production claims

Separate issuer administration from the holder UI, implement real identity-evidence review, choose a standard credential/presentation profile, adopt a maintained full WebAuthn enrollment/assertion verifier if hardware credentials are needed, define issuer-key lifecycle and recovery governance, replace single-process files with appropriate transactional state, and evaluate independent host/RPC trust and deployment controls. These are material boundaries of the current prototype, not measured benefits.
