import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir,cpus,totalmem,release} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {keyPair,present} from './protocol.mjs';
import {freePort,startService,stop,post} from './harness.mjs';
import {delayProxy} from './delay-proxy.mjs';
const require=createRequire(import.meta.url),{ethers}=require('ethers');
const hardhatRequire=createRequire(new URL('../../hardhat/package.json',import.meta.url)),solc=hardhatRequire('solc');
const runs=Number(process.env.RUNS||3),trials=Number(process.env.TRIALS||40);
if(!Number.isInteger(runs)||runs<1||runs>20||!Number.isInteger(trials)||trials<8||trials>1000)throw Error('Invalid experiment size');
const destination=resolve(process.argv[2]||'trustchain-study');mkdirSync(destination,{recursive:true});
const plan={runs,trialsPerCell:trials,warmupsPerCell:4,oneWayDelayMs:[0,25,75],concurrency:[1,8],backends:['signed-status','signed-list','local-chain'],statusCacheMs:Number(process.env.CACHE_MS||0),authentication:'software-key-only ablation; excludes passkey authorization',seed:182026,
 delayPlacement:'Both request and response at holder-verifier and verifier-status/RPC HTTP links. No delay on issuance. Two sequential holder requests per verification.',
 workload:'Closed-loop finite batch; fresh challenge per attempt, preissued credential per trial, synchronous P-256 software signing in load generator. No issuance load. Same configured maximum cache policy; list cache is shared across credential indices, other caches are per credential.',
 rpcPolicy:'Cache disabled and batching disabled on chain status adapter; normal network identity checks retained. Per-cell RPC method counts recorded.',
 limitations:['Application-layer delays are not WAN emulation: no bandwidth cap, jitter, packet loss or TCP congestion model','Single machine; local automining chain; no public-chain consensus/finality','Three repetitions are exploratory; samples within one run are not independent experimental replications','Closed-loop throughput is observed workload throughput, not maximum sustainable capacity','No statistical significance claim or production-security conclusion']};
const environment={node:process.version,platform:process.platform,arch:process.arch,osRelease:release(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryBytes:totalmem(),solc:solc.version(),hardhat:hardhatRequire('hardhat/package.json').version,ethers:ethers.version};
writeFileSync(join(destination,'plan.json'),JSON.stringify({plan,environment},null,2));
const input={language:'Solidity',sources:{'CredentialStatus.sol':{content:readFileSync(new URL('./CredentialStatus.sol',import.meta.url),'utf8')}},settings:{optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode']}}}};
const compiled=JSON.parse(solc.compile(JSON.stringify(input)));if(compiled.errors?.some(e=>e.severity==='error'))throw Error(JSON.stringify(compiled.errors));const artifact=compiled.contracts['CredentialStatus.sol'].CredentialStatus;
let seed=plan.seed;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const quantile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(p*values.length)-1]:null;
const all=[];
for(let run=1;run<=runs;run++){
 const dir=mkdtempSync(join(tmpdir(),'trustchain-load-')),children=[],proxies=[];let provider;
 const result={run,startedAt:new Date().toISOString(),cells:[]};
 try{
  const port=await freePort(),rpcUrl='http://127.0.0.1:'+port;
  const child=spawn(process.execPath,[hardhatRequire.resolve('hardhat/internal/cli/cli.js'),'--config',new URL('./local-chain.cjs',import.meta.url).pathname,'node','--hostname','127.0.0.1','--port',String(port)],{cwd:new URL('../../hardhat/',import.meta.url).pathname,stdio:['ignore','ignore','pipe']});children.push({child});let errors='';child.stderr.on('data',d=>errors+=d);
  let ready=false;for(let i=0;i<900;i++){
   if(child.exitCode!==null)throw Error(errors);
   try{const r=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}),signal:AbortSignal.timeout(1000)});if((await r.json()).result==='0x7a69'){ready=true;break;}}catch{}
   await new Promise(r=>setTimeout(r,100));
  }if(!ready)throw Error('Chain startup failed');
  provider=new ethers.JsonRpcProvider(rpcUrl);provider.pollingInterval=50;
  const contract=await new ethers.ContractFactory(artifact.abi,artifact.evm.bytecode.object,await provider.getSigner(0)).deploy();await contract.waitForDeployment();
  const keys=keyPair(),holder=keyPair(),token=ethers.hexlify(ethers.randomBytes(32));
  const privateKeyFile=join(dir,'key.pem'),publicKeyFile=join(dir,'key.pub');
  writeFileSync(privateKeyFile,keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});writeFileSync(publicKeyFile,keys.publicKey.export({type:'spki',format:'pem'}));
  const modes={};
  for(const mode of plan.backends){
   const chain=mode==='local-chain'?{rpcUrl,contractAddress:await contract.getAddress(),rpcNoCache:true}:undefined;
   const a=await startService({role:'issuer',id:'a',port:0,privateKeyFile,publicKeyFile,adminToken:token,stateFile:join(dir,mode+'.json'),chain},join(dir,mode+'-a.json'));children.push(a);
   const upstream=await delayProxy(chain?rpcUrl:a.url);proxies.push(upstream);
   const trust={id:'a',publicKeyFile,statusCacheMs:plan.statusCacheMs,...(chain?{chain:{...chain,rpcUrl:upstream.url}}:mode==='signed-list'?{statusListUrl:upstream.url+'/status-list'}:{statusUrl:upstream.url+'/status'})};
   const b=await startService({role:'verifier',id:'b',port:0,trustedIssuers:[trust]},join(dir,mode+'-b.json'));children.push(b);
   const client=await delayProxy(b.url);proxies.push(client);
   const credentials=[];
   for(let t=0;t<trials;t++){
    const issued=await post(a.url+'/issue',{holderPublicKey:holder.publicKey.export({type:'spki',format:'pem'}),simulatedIdentityApproved:true,ttlMs:3600000},token);
    if(issued.code!==201)throw Error('Fixture issuance failed');credentials.push(issued.body.credential);
   }
   modes[mode]={client,upstream,credentials};
  }
  const cells=[];for(const delay of plan.oneWayDelayMs)for(const concurrency of plan.concurrency)for(const mode of plan.backends)cells.push({delay,concurrency,mode});
  for(let i=cells.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[cells[i],cells[j]]=[cells[j],cells[i]];}
  for(const cell of cells){
   await new Promise(r=>setTimeout(r,plan.statusCacheMs+20));
   const {client,upstream,credentials}=modes[cell.mode];client.setDelay(cell.delay);upstream.setDelay(cell.delay);
   async function attempt(index){
    const started=performance.now();let code=null,error=null,accepted=false;
    try{
     const challenge=await post(client.url+'/challenge',{});code=challenge.code;if(code!==200)throw Error('challenge '+code);
     const response=await post(client.url+'/present',{requestId:challenge.body.id,presentation:present(credentials[index%trials],challenge.body,holder.privateKey)});
     code=response.code;accepted=code===200&&response.body.accepted===true;if(!accepted)error='presentation '+code;
    }catch(e){error=e.message;}
    return {trial:index,elapsedMs:performance.now()-started,accepted,httpStatus:code,error};
   }
   const warmup=[];for(let i=0;i<plan.warmupsPerCell;i++)warmup.push(await attempt(i));
   const before=structuredClone({client:client.stats,upstream:upstream.stats});
   let cursor=0;const samples=[];const started=performance.now();
   await Promise.all(Array.from({length:cell.concurrency},async()=>{while(cursor<trials){const index=cursor++;samples.push(await attempt(index));}}));
   const wallMs=performance.now()-started;const good=samples.filter(s=>s.accepted).map(s=>s.elapsedMs);
   const diff=(after,before)=>({requests:after.requests-before.requests,failures:after.failures-before.failures,methods:Object.fromEntries(Object.entries(after.methods).map(([k,v])=>[k,v-(before.methods[k]||0)]))});
   const record={...cell,order:result.cells.length,warmupFailures:warmup.filter(s=>!s.accepted).length,attempts:trials,successes:good.length,failures:trials-good.length,wallMs,successfulPerSecond:good.length/(wallMs/1000),p50Ms:quantile(good,.5),p95Ms:quantile(good,.95),p99Ms:quantile(good,.99),clientTraffic:diff(client.stats,before.client),statusTraffic:diff(upstream.stats,before.upstream),samples:samples.sort((a,b)=>a.trial-b.trial)};
   result.cells.push(record);writeFileSync(join(destination,'run-'+run+'.json'),JSON.stringify(result,null,2));
   console.log(`Run ${run}/${runs}: ${cell.mode}, delay ${cell.delay}ms each way, concurrency ${cell.concurrency}: ${good.length}/${trials} accepted, p50 ${record.p50Ms?.toFixed(1)}ms`);
  }
  result.completedAt=new Date().toISOString();writeFileSync(join(destination,'run-'+run+'.json'),JSON.stringify(result,null,2));all.push(result);
 }finally{for(const p of proxies.reverse())await p.close();for(const c of children.reverse())await stop(c);provider?.destroy();rmSync(dir,{recursive:true,force:true});}
}
const summary=[];
for(const delay of plan.oneWayDelayMs)for(const concurrency of plan.concurrency)for(const mode of plan.backends){
 const cells=all.flatMap(r=>r.cells.filter(c=>c.delay===delay&&c.concurrency===concurrency&&c.mode===mode));
 const medians=cells.map(c=>c.p50Ms).filter(x=>x!==null),throughputs=cells.map(c=>c.successfulPerSecond);
 summary.push({delay,concurrency,mode,runs:cells.length,attempts:cells.reduce((n,c)=>n+c.attempts,0),failures:cells.reduce((n,c)=>n+c.failures,0),medianOfRunMediansMs:quantile(medians,.5),runMedianMinMs:medians.length?Math.min(...medians):null,runMedianMaxMs:medians.length?Math.max(...medians):null,medianRunP95Ms:quantile(cells.map(c=>c.p95Ms).filter(x=>x!==null),.5),medianSuccessfulPerSecond:quantile(throughputs,.5)});
}
writeFileSync(join(destination,'summary.json'),JSON.stringify({generatedAt:new Date().toISOString(),plan,environment,summary},null,2));console.log('Study complete: '+destination);
