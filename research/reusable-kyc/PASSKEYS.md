> Storage update: see [DATABASE.md](DATABASE.md). Pending approvals and pickup results now survive restart in SQLite; earlier references to volatile approval queues or JSON-only persistence below are superseded.

# TrustChain passkey milestone

Implemented in `/Users/manavbahuguna/Desktop/ssi-kyc`.

## Use the application

Use Node.js 22 or newer. Start the issuer, verifier and dashboard using the existing SERVICES.md instructions. Open the dashboard at `http://localhost:5173` (the configured browser origin must match exactly).

1. In the holder view, request a credential. Register a passkey when prompted. Your device may offer a fingerprint, face unlock, PIN, security key or synced passkey; the application does not receive biometric data.
2. In the issuer view, sign in and approve the simulated identity review. In the holder view, collect the credential and save its recovery code offline.
3. Transfer a verifier request to the holder. Creating a presentation now prompts for passkey authentication. Transfer the resulting presentation back to the verifier.
4. Rotation authenticates the current passkey and registers a replacement before submitting for issuer review.
5. Recovery uses the offline recovery code and a replacement passkey, followed by issuer approval. Approval revokes the old credential. Its passkey cannot authenticate actions against that revoked credential. This does not delete a passkey from the user's device or cloud account.

An existing software-only credential is not silently upgraded. Rotating through the new browser flow enrolls a passkey for its replacement.

## Enforcement

SimpleWebAuthn verifies registration and authentication against the configured origin and RP ID, with user verification required. Registration also proves possession of the application signing key. Challenges expire after two minutes and are consumed before verification, including unsuccessful attempts. Enrollment tickets bind the registered authenticator to that exact signing key and are single use.

The issuer persists the authenticator public key, credential identifier and signature counter in the credential record. No authenticator private key or biometric template is stored. A signed credential policy marks passkey protection; stripping that policy invalidates the issuer signature.

For presentations, a fresh authentication yields a signed authorization bound to the exact presentation, expiring after one minute. The verifier checks this in addition to the holder signature, audience, nonce, credential expiry and revocation status. Rotation authorization binds the exact key-change request. Recovery requires the offline secret, a new-key proof, replacement enrollment, and separate issuer approval.

Public issuance requires enrollment by default. `allowLegacyApplications: true` is an explicit compatibility setting used by the old role API regression test; do not enable it in a passkey-required demo. The authenticated direct research issuance endpoint remains software-key compatible for existing benchmark clients. Direct key replacement cannot bypass passkey requirements on an enrolled credential.

## Validation

The production build and all 57 regression tests passed, alongside the Chrome browser test with a virtual CTAP2 authenticator. Coverage includes enrollment, authenticated presentations, rotation, recovery after reload, issuer restart persistence, revocation, wrong origin, wrong challenge, unknown authenticator and replay rejection. Protocol tests independently check missing, expired and wrong-action authorization rejection using fresh verifier challenges.

Virtual-authenticator tests do not establish compatibility with every physical device. A manual Touch ID/security-key check is still needed on the intended deployment devices.

## Remaining limits and next milestone

Credential signing keys remain browser software keys; passkeys authenticate their sensitive use through server-enforced authorization. This is not a biometric KYC system. Identity review is simulated, and the credential/presentation format is still custom.

Issued passkeys and counters survive issuer restarts in the existing JSON state file. Pending approvals, enrollment challenges and administrative sessions do not. The next project priority is transactional database persistence for approval, recovery and issuance state. Revoking before replacement issuance remains fail-closed but can require staff repair if issuance fails midway.

The interfaces share an origin, and the legacy demo remains available. This is a local prototype, not a hardened multi-tenant deployment. Existing performance studies predate passkeys and must not be presented as performance measurements of this new flow.

Implementation reference: https://simplewebauthn.dev/docs/packages/server
