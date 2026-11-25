# TrustChain: revocation freshness and trust assumptions

Completed 36 trials: three fresh-run repetitions of 12 cache/read-policy combinations. All trials observed rejection before the six-second observation limit. A separate unrevoked credential was accepted after each rejection, ruling out a general verifier/status outage as the observed cause. The protocol/service suite passed 49 tests.

## Measurement definition

The verifier first accepts the target credential, priming its active-status cache. The issuer then revokes it. Time zero is the successful revocation acknowledgement; for chain mode this follows the local transaction receipt. A fresh presentation is attempted repeatedly, with a 75 ms pause after each accepted result. The reported delay ends when the first rejecting response returns.

Local empty blocks are mined on the polling loop toward a schedule of one block per 200 ms. Actual mining timestamps are retained. This is a controlled read-lag experiment, not a simulation or proof of consensus finality. A read lag of N means reading state N blocks behind the current head.

## Results

| Status source | Read lag (blocks) | Cache TTL (ms) | Median first rejection (ms) | Range across three trials (ms) |
|---|---:|---:|---:|---:|
| signed-status | 0 | 0 | 4 | 4–5 |
| signed-status | 0 | 500 | 570 | 564–571 |
| signed-status | 0 | 1500 | 1560 | 1559–1564 |
| local-chain | 0 | 0 | 6 | 6–6 |
| local-chain | 0 | 500 | 504 | 501–508 |
| local-chain | 0 | 1500 | 1507 | 1499–1570 |
| local-chain | 2 | 0 | 455 | 454–455 |
| local-chain | 2 | 500 | 501 | 500–511 |
| local-chain | 2 | 1500 | 1518 | 1498–1518 |
| local-chain | 5 | 0 | 1094 | 1090–1102 |
| local-chain | 5 | 500 | 1518 | 1019–1522 |
| local-chain | 5 | 1500 | 1510 | 1495–1570 |

## Findings that can support the paper

1. **Caching creates a deliberate stale-acceptance window.** A cached active result remains usable even after issuer revocation, until the original cache deadline. Cache hits do not extend that deadline.
2. **Historical chain reads can delay revocation visibility.** With no active-status cache, a five-block lag produced roughly 1.1 seconds to observed rejection in this 200 ms/block local schedule.
3. **Cache expiry and chain visibility interact.** With five-block lag and a 500 ms TTL, observed rejection varied between about 1.0 and 1.5 seconds. Refreshing immediately before revocation becomes visible can cache another active result. The policies cannot be evaluated independently.
4. **“Zero TTL” is not zero measured delay.** Fresh-check cases rejected at the first post-acknowledgement poll, but still incurred request and processing time. The experiment does not establish instant revocation across distributed services.

## Correct interpretation of uncertainty

Ranges are descriptive variation across three runs, not confidence intervals. Polling discretizes observations. Last accepted and first rejected response times are saved, but are not strict bounds on the instant the underlying status changed: a status lookup occurs before its response returns. Cache priming and revocation acknowledgement also consume time, so the remaining TTL at time zero may be less than its configured value.

This deliberately primes caches just before revocation and does not sweep arbitrary cache ages. Conditions are executed in a fixed order inside each fresh process/chain run. The issuer and verifier are separate processes on one machine, without added network delay. No public-chain reorganizations, remote RPC integrity, long-run load, or confidence-depth safety claim is tested.

## Implementation changes

- Optional statusCacheMs on a trusted issuer entry; default zero.
- Optional statusLagBlocks in the chain configuration; default zero.
- Cached status remains subordinate to issuer trust, signature, holder proof and credential expiry.
- Expired cache entries are never accepted as a fallback after status retrieval errors.
- Cache capacity is bounded and hits do not renew expiry.
- Prior fresh-status behavior remains the default; old benchmark datasets retain their original source manifests.

## Reproduce

From the repository root:

    node --test server/assertion.test.cjs research/reusable-kyc/*.test.mjs
    node research/reusable-kyc/revocation-study.mjs revocation-results

raw-results.json contains individual polls, mining timestamps, acknowledgement and priming timings, and censored flags. plan.json preserves the experiment definition. trust-and-privacy-model.md documents authority, compromise effects, data exposure and recovery limits.

## Remaining evidence gap

The next useful extension is an independent-host deployment with a controlled cache-age sweep and realistic status/chain availability policy. Issuer-key rotation, production recovery governance and standards interoperability remain separate implementation work. The current results support a freshness-policy trade-off analysis, not a complete KYC security or compliance claim.
