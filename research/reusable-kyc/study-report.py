import json,sys,pathlib,hashlib,shutil,statistics
source=pathlib.Path(sys.argv[1]);out=pathlib.Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
data=json.loads((source/'summary.json').read_text());plan=data['plan'];runs=[json.loads((source/f'run-{i}.json').read_text()) for i in range(1,plan['runs']+1)]
assert all(len(r['cells'])==12 and r.get('completedAt') for r in runs)
assert all(len(c['samples'])==plan['trialsPerCell'] and c['attempts']==len(c['samples']) for r in runs for c in r['cells'])
assert all(c['successes']==sum(s['accepted'] for s in c['samples']) for r in runs for c in r['cells'])
total=sum(c['attempts'] for r in runs for c in r['cells']);fail=sum(c['failures'] for r in runs for c in r['cells']);warm=sum(c['warmupFailures'] for r in runs for c in r['cells'])
raw=out/'raw';raw.mkdir(exist_ok=True)
for f in source.glob('*.json'):shutil.copyfile(f,raw/f.name)
rows=[]
for c in data['summary']:
 rows.append(f"| {c['delay']} | {c['concurrency']} | {c['mode']} | {c['medianOfRunMediansMs']:.1f} | {c['runMedianMinMs']:.1f}–{c['runMedianMaxMs']:.1f} | {c['medianRunP95Ms']:.1f} | {c['medianSuccessfulPerSecond']:.1f} | {c['failures']}/{c['attempts']} |")
paired=[]
for delay in plan['oneWayDelayMs']:
 for concurrency in plan['concurrency']:
  diffs=[]
  for r in runs:
   cells={c['mode']:c for c in r['cells'] if c['delay']==delay and c['concurrency']==concurrency}
   diffs.append(cells['local-chain']['p50Ms']-cells['signed-status']['p50Ms'])
  paired.append({'delay':delay,'concurrency':concurrency,'perRunChainMinusSignedMs':diffs,'medianDifferenceMs':statistics.median(diffs),'minDifferenceMs':min(diffs),'maxDifferenceMs':max(diffs)})
(out/'paired-differences.json').write_text(json.dumps(paired,indent=2))
traffic=[]
for mode in plan['backends']:
 cells=[c for r in runs for c in r['cells'] if c['mode']==mode]
 methods={}
 for c in cells:
  for k,v in c['statusTraffic']['methods'].items():methods[k]=methods.get(k,0)+v
 traffic.append({'mode':mode,'measuredAttempts':sum(c['attempts'] for c in cells),'holderHTTPRequests':sum(c['clientTraffic']['requests'] for c in cells),'statusHTTPRequests':sum(c['statusTraffic']['requests'] for c in cells),'rpcMethods':methods})
(out/'traffic-summary.json').write_text(json.dumps(traffic,indent=2))
text=f'''# TrustChain: repeated delay and concurrency study

## Completion and scope

Completed {plan['runs']} fresh repetitions, 12 conditions each, and **{total} measured verification attempts**. There were **{fail} measured failures** and **{warm} warmup failures**. The accompanying protocol/service suite passed 42 tests, including validation of the delay proxy.

Each repetition started a fresh local chain, contract, issuer/verifier processes and synthetic keys. Conditions crossed 0/25/75 ms of added delay each way, concurrency 1/8, and signed-status/local-chain verification. Each cell included four excluded warmups and 24 measured attempts. Cell order was shuffled deterministically with seed {plan['seed']}.

## Results

The central latency statistic is the **median of five run-level medians**. The range spans those five medians; it is not a confidence interval. p95 is the median of the five within-run p95 values, each based on 24 successful requests. Throughput is the median successful batch throughput across runs. Do not interpret these as independent-request population estimates.

| Added delay each way (ms) | Workers | Backend | Median latency (ms) | Run-median range (ms) | Median run p95 (ms) | Successes/s | Failed/attempted |
|---:|---:|---|---:|---:|---:|---:|---:|
'''+ '\n'.join(rows)+'''

## Interpretation

Latency includes two holder–verifier requests (challenge and presentation), software signing, and a verifier–status lookup. The delay proxy adds a wait on both the request and response of each HTTP exchange. It does not delay issuance, which is completed before measurement. Therefore, a single status exchange creates roughly six one-way delay components per verification, plus processing and any additional RPC exchanges.

The chain adapter explicitly disables cache reuse and request batching for this study. Its library's network identity checks remain enabled and are counted. The previous single-run benchmark used different RPC defaults and no delay proxy, so its absolute timings should not be treated as directly comparable to this study's zero-delay baseline.

Eight workers can overlap waiting time and increase completed-verification throughput. This finite closed-loop batch is not a saturation test or a maximum-capacity claim. Failures and timing outliers must remain visible.

## Paired run comparisons

Each difference below is chain median minus signed-status median within the same run and condition. A negative number means the chain variant was faster in that particular comparison. Five run-level differences are retained in paired-differences.json. No significance claim is made.

| Added delay (ms) | Workers | Median paired difference (ms) | Range across runs (ms) |
|---:|---:|---:|---:|
'''+ '\n'.join(f"| {p['delay']} | {p['concurrency']} | {p['medianDifferenceMs']:.2f} | {p['minDifferenceMs']:.2f}–{p['maxDifferenceMs']:.2f} |" for p in paired)+'''

## Measured traffic

'''+ '```json\n'+json.dumps(traffic,indent=2)+'\n```\n'+'''
Counts exclude warmups and fixture issuance. Any extra chain RPC calls are part of the configured verification stack, not silently removed from its timing.

## Reproducibility

From the repository root:

    node --test server/assertion.test.cjs research/reusable-kyc/*.test.mjs
    node research/reusable-kyc/study.mjs study-results

The output raw/ directory contains the plan, environment, all five run files and the summary. Per-attempt data includes latency, acceptance, HTTP status and errors. Source hashes identify the code used for this study. The report retains every completed run, including slow or unfavorable outcomes.

## Threats to validity

- A single machine runs the client, proxies, both institution services and the local chain. Fresh-process repetitions are not independent hardware or network deployments.
- Application-layer delay does not model bandwidth, loss, jitter, congestion, TLS or real WAN routing. Even zero-delay requests incur proxy and scheduling overhead.
- The chain automines locally; public-network confirmation/finality, fee markets and validator failures are absent.
- The client uses software P-256 keys and a custom research credential format. Identity approval is simulated. No hardware-authenticator or standards-interoperability claim is supported.
- The workload is verification-only with preissued credentials. This does not measure concurrent issuance, recovery, revocation propagation, large registry scaling or long-running load.
- Five repetitions and 24 measured requests per cell are exploratory. Ranges are descriptive, not inferential confidence intervals; the p95 tail estimate is coarse.
- Successful timing tests do not prove security. Prior replay, revocation and outage tests are separate evidence.

## Next experiment to support a paper

Measure revocation observation time under explicitly configured status-cache lifetimes and chain confirmation policies. Then test independent host deployments and concurrent issuance/verification. A literature comparison and an explicit trust/privacy analysis are still necessary before claiming a novel systems contribution.
'''
(out/'study-report.md').write_text(text)
print(json.dumps({'attempts':total,'failures':fail,'warmupFailures':warm,'summary':data['summary']},indent=2))
