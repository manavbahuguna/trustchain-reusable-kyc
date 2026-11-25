# Browser demo with durable transaction signing

Validated 27 October 2026. This local research setup enables transactionKeyFile automatically. It creates a new issuer identity and state; it does not migrate existing ambiguous operations.

Use Node 22.22.2 (the tested runtime), installed root dependencies and the existing Hardhat dependencies. From the project root, start an isolated disposable node in a terminal:

```sh
node hardhat/node_modules/hardhat/internal/cli/cli.js --config research/reusable-kyc/local-chain.cjs node --hostname 127.0.0.1 --port 8545
```

Keep that node running. In another terminal:

```sh
node research/reusable-kyc/setup-chain-local.mjs .trustchain-chain-local
node research/reusable-kyc/service.mjs .trustchain-chain-local/issuer.json
```

Then, in separate terminals:

```sh
node research/reusable-kyc/service.mjs .trustchain-chain-local/verifier.json
npm run dev -- --host localhost
```

Open these views in separate browser profiles or private contexts if you want storage isolation:

- Holder: http://localhost:5173/?role=holder
- Issuer: http://localhost:5173/?role=issuer
- Verifier: http://localhost:5173/?role=verifier

Use issuer address http://127.0.0.1:4101 and verifier address http://127.0.0.1:4102. Read the administrator token locally from the generated issuer.json and enter it only in the issuer view. Request a credential as the holder, approve it with the simulated-review checkbox as issuer, and collect it as holder. Save the recovery code offline. Exchange a verifier request and holder presentation, then verify. Repeat after a rotation request and approval. To exercise recovery, simulate key loss, reload, enter the saved recovery code, request recovery, approve it, and collect the replacement.

## Setup behavior and scope

The setup verifies loopback RPC, chain ID 31337, and the expected default Hardhat account before deploying CredentialStatus. It generates the existing issuer/verifier configurations, writes the signing fixture to transaction.key with owner-only permissions, enables the issuer's durable signing, and configures the verifier to read that contract. The verifier configuration does not contain the signing key path. Existing directories are refused rather than overwritten.

The default Hardhat key is public test data, even though its file is restricted. Use only the disposable local chain and synthetic credentials. Setup changes the local chain by deploying a contract. If a later setup step fails, that contract may remain; use a fresh directory after inspecting the failure. The setup is not an atomic deployment tool.

Restarting the disposable chain discards its state. Do not reconnect an old issuer database to a reset chain and assume continuity. Start a new demo directory after a chain reset; preserve old state separately if needed. The configured services require exclusive ownership of the issuer database and a dedicated transaction account.

The approval flow for issuance, rotation, and recovery uses the durable transaction journal. Direct legacy routes, including the dashboard's direct revocation action, do not gain that journal merely because transactionKeyFile is set. See OUTBOX.md for precise recovery scope.

## Automated browser evidence

```sh
npm run build
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
BROWSER_EXECUTABLE=/absolute/path/to/chrome \
RESULT_PATH=/tmp/durable-browser-result.json \
node research/reusable-kyc/browser-durable-test.mjs
```

The runner starts its own disposable chain, invokes the new setup script, and uses its generated chain settings with isolated test service identities and ports. It exercises browser enrollment, approval, presentation, rotation, recovery after reload, issuer outage/restart, revocation rejection, and logout. It checks the actual encrypted database after shutdown: three approved application plans have confirmed signed registration transactions, and both replacement plans have confirmed signed revocations. It also retains existing passkey negative checks and role-interface separation checks.

The run passed with a virtual CTAP2 authenticator and simulated identity approval. This validates the functional browser integration; it is not a physical-biometric evaluation or a new performance result. Existing experiment results must not be relabeled as durable-signing measurements.
