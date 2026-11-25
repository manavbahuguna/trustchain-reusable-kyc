> Storage update: see [DATABASE.md](DATABASE.md). Pending approvals and pickup results now survive restart in SQLite; earlier references to volatile approval queues or JSON-only persistence below are superseded.

# Role-separated application workflows

## Entry points

Start the existing issuer/verifier services and Vite as documented in SERVICES.md. The dashboard now defaults to the holder wallet:

- Holder: http://localhost:5173/?role=holder
- Issuer administrator: http://localhost:5173/?role=issuer
- Verifier: http://localhost:5173/?role=verifier

Separate views are backed by authorization checks. Changing the role URL does not grant issuer authority.

## Issuance

1. Holder selects its issuer service and requests a credential. Keys are generated in the holder browser. The returned request ID and secret are saved with the pending key in IndexedDB.
2. Issuer staff opens the admin view, enters the bootstrap administrator key from issuer.json and signs in. The server returns an opaque 15-minute session. The bootstrap key is cleared from page state, and the session remains in memory only.
3. Staff refreshes the queue and reviews a specific request. Approving requires an explicit simulated-review checkbox. The holder cannot set its own approval, assurance level, or expiry through the queue.
4. Holder checks approval and collects its credential and offline recovery code using the request secret. Admin listing and approval responses do not expose the holder's request secret or recovery code.

This is still simulated identity review. It establishes a separation of authority, not actual identity verification.

## Presentation

The verifier chooses an assurance level and creates a short-lived presentation request. Transfer the request JSON to the holder view. The holder signs a presentation for that verifier and transfers the presentation JSON back. The verifier checks it through its own service. The service consumes the challenge, so reusing the presentation fails. The prototype uses manual transfer; QR/deep-link or a standardized presentation protocol is a later step.

Verifier protocol endpoints are intentionally public: validity checks themselves do not issue credentials or authorize a financial transaction. No issuer token is shown or required in the holder or verifier views.

## Key changes

Holder rotation submits old-key and new-key proofs. Recovery submits the recovery code and new-key proof. The issuer validates those proofs/secrets, queues the request, and requires a separate authenticated administrator decision. At approval it rechecks the old credential is still active. The holder collects the replacement and its new recovery code. Revocation is an issuer-admin action.

## Authorization and operation lifecycle

- `/admin/session` exchanges the configured bootstrap key for a short-lived session.
- `/admin/applications`, `/admin/approve`, `/admin/reject`, `/admin/credentials`, and `/admin/logout` require that session.
- `/applications/issue` and `/applications/key-change` submit requests; they cannot approve them.
- `/applications/collect` requires the request-specific secret.
- Approval is single-use. Failed, rejected and already-approved requests cannot be approved again.
- Administrative mutations remain serialized inside the issuer process.
- The direct research `/issue`, `/revoke`, and `/key-change` APIs still require issuer authority for compatibility with the benchmark clients. They accept the configured bootstrap key or a valid administrator session.

## Limits pending later priorities

The views share a web origin and do not provide isolation against same-origin malicious scripts. Staff identity is represented by possession of a configured high-entropy bootstrap key, not individual organization accounts. Holder signing keys remain Web Crypto software keys; passkey authentication now protects sensitive actions. See PASSKEYS.md. Pending requests, session records and approved pickup results are in memory, expire after 15 minutes and disappear on issuer restart. Issued credential records still use existing file persistence. The planned database milestone should add durable request lifecycle and audit records, while protecting pickup/recovery secrets appropriately.

The server pins/verifies the holder key when the resulting credential is presented. Initial request submission now requires passkey enrollment by default, but does not provide real identity evidence. Do not interpret the simulated approval as KYC compliance.

## Validation

57 automated tests passed after the passkey milestone, including role authorization, request-secret isolation, single-use approval, rejected/expired requests, session expiration and sign-out. The browser test now exercises holder, issuer and verifier in independent browser contexts, with issuance, rotation, recovery, presentation and revocation.

Run:

    node --test server/assertion.test.cjs research/reusable-kyc/*.test.mjs
    npm run build
    node research/reusable-kyc/browser-test.mjs

The browser test supports PLAYWRIGHT_MODULE, BROWSER_EXECUTABLE and SCREENSHOT_PATH as documented in SERVICES.md.
