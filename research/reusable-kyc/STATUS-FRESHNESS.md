# Status-list freshness: cache lifetime versus response age

Verified 27 October 2026 using deterministic tests in `status-list.test.mjs`.

Disabling the local cache forces another fetch. It does not make a signed aggregate response fresh: the list has no request nonce, and a previously signed response remains acceptable within the reader's timestamp policy. This is an intentional characterization of current behavior; no production policy was changed in this task.

## Exact current policy

A list must have a valid issuer signature, a non-future issuance time, a future expiry, and an issuance-to-expiry interval of at most 60,000 ms. Its age must be no greater than `cacheMs` when positive, or 60,000 ms when `cacheMs` is zero. Acceptance also requires a valid status index and an unset revocation bit.

The cache deadline is the minimum of fetch-start plus cacheMs, list issuance plus cacheMs, and list expiry. Cache hits require the deadline to be strictly in the future. A fetched list whose age equals a positive cacheMs is currently acceptable for that call, but cannot create a usable cache entry. Expiry itself is exclusive: a response is rejected at exactly expiresAt.

| Configuration | Previously signed active list after revocation | Boundary behavior |
|---|---|---|
| cacheMs = 0 | Can be accepted on every refetch while still valid, potentially nearly 60 seconds from list issuance | Reject at signed expiry; zero cache does not mean zero replay window |
| cacheMs = 500 | Can be accepted while age is at most 500 ms | Age 500 ms is accepted only on a fresh fetch; age 501 ms is rejected |
| cacheMs = 60000 | Can be reused until the earlier of its cache deadline and signed expiry | Signed expiry is never extended by cache use |

This policy couples response-age tolerance to positive caching. It is not a separately configurable maximum-age policy. All bounds depend on the verifier's clock; these tests assume aligned clocks. They measure permitted response age, not an unconditional network-wide revocation bound.

## Reproduced scenarios

A genuine issuer-signed active list is captured, the credential is revoked at the issuer, and the fetch callback keeps returning the captured envelope. There is no forged signature or modified payload.

1. With zero cache, the stale list is accepted at ages 1, 30,000, and 59,999 ms, with a fetch each time. It is rejected at ages 60,000 and 60,001 ms.
2. With a 500 ms cache, it is accepted at age 499 ms, refetched and accepted twice at age 500 ms, and rejected at age 501 ms. The original deadline is not renewed.
3. With zero cache, replacing the replayed response with a freshly signed revoked list immediately causes rejection.
4. With a 60,000 ms cache, a cached active response is accepted before signed expiry and rejected exactly at expiry.

These are reader-level adversarial-response tests with a controlled clock. They do not simulate a TLS break, a compromised issuer, a browser flow, or a real transport attacker. They characterize what would happen if a still-valid old signed list were supplied. Existing full-verifier tests separately cover credential/proof checks and credential expiry.

## Implications for the comparison study

Prior current-evaluation runs used an honest status endpoint and measured observed revocation delay under configured cache/chain-read policies. Those results remain measurements of that setup; they do not establish resistance to stale-response substitution. Cite this distinction alongside zero-cache figures.

Nonce-bound per-credential status and aggregate lists have different freshness semantics. Per-credential status responses bind a fresh request nonce; aggregate lists trade that interaction for reusable signed snapshots. Chain freshness additionally depends on the RPC's view, configured block lag, and any verifier cache. None of these status choices removes the issuer-mediated passkey authorization dependency in the current protected flow.

Use: “Zero-cache aggregate verification refetches on every check; a valid older signed list can still be accepted within its permitted age and expiry.” Do not use: “Zero-cache verification guarantees immediate revocation.”

Run `node --test research/reusable-kyc/status-list.test.mjs` for these cases, or the documented full regression command. The added tests preserve current behavior so a future change to response-age policy is explicit and reviewable.
