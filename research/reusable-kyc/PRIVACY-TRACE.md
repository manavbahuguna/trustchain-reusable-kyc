# TrustChain reproducible privacy trace

27 October 2026. Task 1 completed: observed data exposure and linkability in the implemented protected flow.

## Observed results

A disposable issuer issued one synthetic credential after browser passkey enrollment and administrator approval. The holder presented it to institution B, institution C, and institution B again. B and C ran as separate verifier processes with independently configured identities and trust settings. All three presentations received successful responses. Browser authentication used Chrome's virtual CTAP2 authenticator with user verification enabled; it did not evaluate a human biometric or physical authenticator.

| Check | Observation |
|---|---|
| Issuer receives verifier identity | All three authentication-options requests contained a holder proof naming B, C, and B respectively |
| Issuer receives credential data | Credential ID, issuer, holder public key, status index, level, and passkey-required flag matched the data sent to each verifier |
| Linkability between verifiers | Both verifiers received the same credential ID and holder public key |
| Freshness versus linkability | All three presentation nonces were distinct; this did not change the stable identifiers |
| Issuer availability | After stopping the issuer, a fresh verifier challenge could not produce a new protected presentation |

The comparison also checks that issuer-visible and verifier-visible request IDs, nonces, audiences, and selected credential fields match for each presentation. This establishes exact identifier-based linkage in this fixture. It is not a population-level reidentification estimate or an anonymization benchmark.

## What the trace contains

`trace.json` records six successful HTTP request/response observations: three holder-to-issuer authentication-options requests and three submissions to verifiers. These are browser-observed requests paired with responses, not evidence that the server stores usage logs. Each selected field is decoded from the actual transmitted credential or proof body; it is not a fabricated reconstruction.

Only selected public fields from disposable synthetic identities are retained. Administrator tokens, request pickup secrets, recovery codes, private keys, authenticator assertion responses, and reusable signed envelopes are excluded. Temporary service state and keys are removed by the runner. The public holder key and random IDs remain visible so readers can independently compare them across trace entries.

## Scope and limitations

This run uses nonce-bound signed status, not the blockchain or aggregate-list backend. The observation that the issuer receives the full action comes from the shared authentication path; extension of that finding to other status configurations is a code-based inference, not a separately executed trace here. The prior backend evaluations cover their availability behavior separately.

The outage check establishes failure to obtain a fresh protected presentation. It does not establish that previously obtained, still-valid authorizations stop working. The test observes one holder and two verifier processes; it does not implement collusion infrastructure or measure privacy attack success across a population. It captures no real identity documents or biometrics.

## Reproduce

From the project root, use its installed dependencies and an installed Playwright package:

```sh
npm run build
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
BROWSER_EXECUTABLE=/absolute/path/to/chrome \
OUT=/tmp/trustchain-privacy-trace \
node research/reusable-kyc/privacy-trace.mjs
```

PLAYWRIGHT_MODULE can be omitted when Playwright is resolvable locally; BROWSER_EXECUTABLE can be omitted when its browser is installed. The runner launches disposable local services and the built browser application, completes enrollment/approval/presentation, asserts the privacy observations, writes the trace, and cleans up. A passing run prints PRIVACY TRACE PASS. The accompanying manifest hashes the trace, report, runner, and inspected application sources; hashes identify this run's code but do not by themselves constitute a standalone release.

## Paper wording supported by this evidence

“In the evaluated issuer-mediated passkey flow, the issuer observed the credential and verifier audience for each protected presentation. Stable credential identifiers and holder public keys enabled exact matching across two verifiers despite fresh challenges. The prototype therefore provides holder-bound reuse, but does not provide issuer-unobservable presentation or cross-verifier unlinkability.”

The next project task is to integrate durable signing into the documented demo setup and verify its complete browser recovery flow, followed by reproducible release packaging.
