> Blockchain recovery update: administrator-approved requests now have durable recovery plans, startup reconciliation and an administrator retry control. See [CHAIN_RECOVERY.md](CHAIN_RECOVERY.md) for scope and unresolved cases.

> Storage update: see [DATABASE.md](DATABASE.md). Pending approvals and pickup results now survive restart in SQLite; earlier references to volatile approval queues or JSON-only persistence below are superseded.

> Current browser workflow: see [ROLE_WORKFLOWS.md](ROLE_WORKFLOWS.md) and [PASSKEYS.md](PASSKEYS.md). The dashboard now separates holder, issuer and verifier roles and requires passkeys for new public issuance. Older combined-dashboard instructions below are historical.

# TrustChain systems research workspace

## Browser and two institutions

From the repository root (Node 20+):

    node research/reusable-kyc/setup-local.mjs
    node research/reusable-kyc/service.mjs .trustchain-research-local/issuer.json

In separate terminals:

    node research/reusable-kyc/service.mjs .trustchain-research-local/verifier.json
    npm run dev -- --host localhost

Open http://localhost:5173. The research dashboard is now the default; the previous demo remains at ?legacy=1. Enter the adminToken from your local issuer.json into the administrator field. Do not share that configuration. The token is kept in page memory, never in the wallet. If setup already exists, reuse it; the setup script deliberately refuses to overwrite keys. Defaults allow browser origin http://localhost:5173; set browserOrigin in BOTH service configurations for another origin.

1. Select the explicit simulated approval checkbox and issue a credential.
2. Copy the recovery code to an offline location. It is not saved in the wallet.
3. Present to Institution B and inspect the server's decision.
4. Rotate the key, then present the replacement credential.
5. Save the replacement recovery code; simulate key loss and recover with issuer approval.
6. Revoke, then present again to observe rejection.

The browser stores a non-exportable Web Crypto P-256 private key and credential in IndexedDB. Non-exportability is an API property, not hardware attestation or protection from same-origin malicious code. This is not the legacy WebAuthn flow. The credential persists across reloads; the recovery code and administrator token do not. Clearing the wallet does not revoke issuer records. Only use synthetic identities.

## Issuer-controlled rotation and recovery

POST /issue returns {credential, recoveryToken, gasUsed?}; it requires bearer administrator authorization and simulatedIdentityApproved: true. POST /revoke accepts id and also requires administrator authorization. POST /key-change/challenge takes id, mode ('rotate' or 'recover'), and newPublicKey. POST /key-change consumes a one-time requestId plus a signature from the new key. Rotation also requires the old key's signature. Recovery instead requires the offline recovery token AND simulatedRecoveryApproved: true. Both changes require administrator authorization in this prototype.

The signed request binds the issuer, old credential, new key, mode, nonce, and expiry. The issuer revokes the old credential before issuing the replacement; assurance level and original expiry are preserved. Each replacement gets a new recovery token. Failed replacement after revocation can leave the holder without an active credential; manual issuer review is required. No rollback silently reactivates the old credential. Recovery trusts the issuer's re-approval and secrecy of the offline code. Issuer compromise, administrator compromise, and malicious-browser resistance are not solved.

Records are persisted by atomic JSON replacement. Run only one issuer per state file. This is not a transactional database or a crash-durability guarantee. Storage failures stop further operations until operator repair. Restarted verifier challenges are invalidated. Legacy records without the stored signed payload cannot be rotated; reissue through an approved workflow.

## Two status backends

Off-chain: the verifier requests a nonce-bound issuer-signed fresh status response over HTTP. The issuer must be online.

Local-chain: CredentialStatus.sol stores a hash of the random credential ID and an active/revoked state. Only the deploying issuer account may register/revoke. The verifier reads contract state directly from its configured RPC provider; no issuer status signature is substituted for the chain read. The issuer remains responsible for identity approval and credential signing in both variants. Chain outages reject verification. Public hashes, transaction sender/timing and linked status queries expose metadata. There are no identity attributes on-chain, but this is not an unlinkability claim.

A chain configuration is {rpcUrl, contractAddress, account?} on the issuer and trustedIssuers entry on the verifier. The adapter only accepts localhost RPC with chain ID 31337. It uses an unlocked local test account; it cannot deploy to or spend funds on public networks. Never expose the research RPC or services remotely.

## Automated comparison

    node research/reusable-kyc/benchmark.mjs comparison.json

This compiles the contract using the already installed solc, launches an isolated Hardhat node (without loading project .env), deploys it, runs separate issuer/verifier processes for both modes, performs five warmups plus 30 measured trials per mode, alternates mode order, and writes raw samples and descriptive p50/p95/p99 results. Set TRIALS to change the sample count. It also checks contract authorization, rotation/recovery, rejection of old credentials and replay, issuer-outage behavior and fail-closed RPC outages. Deployment, issuance and revocation gas are recorded; no fiat cost is inferred. Temporary processes, keys and state are removed. Verification latency includes challenge fetch, holder signing, presentation, and fresh status lookup.

Results are local synthetic measurements on an automining node. They do not estimate public-chain finality, economic transaction costs, WAN latency, production throughput, or statistical population effects. Serialized issuer JSON size is not total disk use or blockchain storage. A conference study still needs repeated independent runs, controlled concurrency, network conditions, confidence intervals, and a metadata/threat analysis.

## Tests

    node --test server/assertion.test.cjs research/reusable-kyc/*.test.mjs
    npm run build

Browser test (run npm run build first; requires an installed Playwright with Chromium):

    node research/reusable-kyc/browser-test.mjs

PLAYWRIGHT_MODULE may point to an existing Playwright package. BROWSER_EXECUTABLE may point to an installed Chrome executable. SCREENSHOT_PATH optionally saves the tested page. The browser test uses temporary keys/services and exercises issuance, presentation, rotation, key loss, reload, recovery, and revocation rejection. It does not test hardware WebAuthn.

## Remaining research limits

Custom signed credential format, not W3C VC/OpenID conformance. No real identity verification, legal compliance assessment, remote service deployment, issuer-key rotation, or production recovery governance. The narrow legacy assertion verifier remains limited to P-256 and 37-byte authenticator data, with registration trust and persistent counter handling still incomplete. The legacy dashboard's hash-based demos are not research credentials.
