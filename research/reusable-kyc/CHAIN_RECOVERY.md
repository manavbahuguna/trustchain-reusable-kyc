# TrustChain blockchain recovery

Implemented in `/Users/manavbahuguna/Desktop/ssi-kyc` for administrator-approved issuance, rotation and recovery requests.

## Behavior

Before a blockchain write, the issuer persists a recovery plan containing the exact replacement credential ID, encrypted credential/recovery result, and transaction progress. A retry resumes this plan; it never generates a second replacement ID. A reservation prevents competing requests from replacing the same old credential.

The issuer reads current contract state before sending a transaction. Already-completed actions are reconciled without another broadcast. A known pending transaction is checked by its recorded hash and is not rebroadcast. An unknown broadcast outcome, reverted transaction or conflicting contract state pauses the operation for review. Transaction hashes and safe status codes appear in the administrator queue; private pickup and recovery secrets do not.

On service startup, unfinished plans are reconciled automatically once. If the local RPC is unavailable or a transaction remains unresolved, the request stays visible as `needs-review`. There is no continuous background retry loop.

Recovery confirms old-credential revocation before registering the replacement. A prepared replacement is disabled locally until its registration is confirmed. Once complete, the original request secret retrieves the same credential and recovery code, with a fresh 15-minute pickup window.

## Administrator workflow

1. Sign into the issuer dashboard and refresh requests.
2. Find the request marked `needs-review` and inspect its recovery status.
3. Restore the configured local chain or allow a pending transaction to finish.
4. Choose **Reconcile operation**. The server checks chain state and resumes only safe steps.
5. The holder uses **Check approval** to collect the result.

The reconciliation endpoint requires an administrator session. Holder request secrets cannot invoke it. Already-completed requests cannot be reissued through that endpoint.

`TRANSACTION_PENDING` means the known transaction has not produced a receipt. `BROADCAST_UNKNOWN` means submission began but no transaction hash was durably obtained; if the expected state later appears, reconciliation can complete. Otherwise it remains blocked. `TRANSACTION_REVERTED`, `CHAIN_STATE_CONFLICT`, expiry and unexpected failures require investigation. There is intentionally no force-success or blindly-resend control.

Unfinished plans are retained beyond ordinary application expiry so that outstanding blockchain operations are not forgotten. Completed pickup results return to the existing expiry policy. Chain RPC/address/account configuration is bound to the saved operation; configuration changes cannot silently redirect it.

## Validation

The regression suite, production build, three-role passkey browser flow and isolated local-blockchain recovery test were run. The chain test disables mining to create pending issuance and revocation transactions, checks unauthorized retry rejection, restarts the issuer after mining, and verifies automatic completion, durable pickup, old-credential revocation and exactly one replacement.

Unit tests cover lost registration responses, already-mined state, unknown broadcasts, pending/reverted transactions, conflicting state, secret-free admin listings, retention and competing recovery reservations.

Run the additional integration test with:

    node research/reusable-kyc/chain-recovery-test.mjs

It starts a temporary local Hardhat chain, uses synthetic keys and cleans up its processes and files.

## Limits

This workflow covers the browser approval queue. The legacy administrator-only direct benchmark `/issue`, `/key-change` and `/revoke` endpoints retain their prior behavior and are not covered by the new recovery journal. Older interrupted requests without a saved plan cannot be reconstructed automatically.

A crash between broadcast and saving the transaction hash may still need investigation if chain state does not resolve it. Reverted transactions and chain conflicts are not automatically overridden. A reset or reorganization of the development chain is not a supported disaster-recovery procedure. This remains a local-chain prototype, without public-chain finality policy or production operational guarantees.
