import {createRequire} from 'node:module';import {readFileSync,writeFileSync,mkdtempSync,rmSync,mkdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawn} from 'node:child_process';import {performance} from 'node:perf_hooks';import assert from 'node:assert/strict';
import {keyPair,present} from './protocol.mjs';import {freePort,startService,stop,post} from './harness.mjs';
const require=createRequire(import.meta.url),{ethers}=require('ethers'),hh=createRequire(new URL('../../hardhat/package.json',import.meta.url)),solc=hh('solc');
const output=resolve(process.argv[2]||'revocation-results');mkdirSync(output,{recursive:true});
const plan={runs:3,ttlMs:[0,500,1500],statusLagBlocks:[0,2,5],blockIntervalMs:200,pollPauseMs:75,timeoutMs:6000,baseline:'Revoke immediately after priming an active-status cache. Time zero is revocation acknowledgement, not submission. Chain then mines empty blocks on the polling loop.',limits:['Local chain only; block lag is a read policy, not probabilistic finality','No cache-age sweep or network delay; deliberately freshly primed caches','Observation bounded by polling and request time; interval brackets retained','Independent process/chain per run, single machine; exploratory 3 repetitions']};
writeFileSync(join(output,'plan.json'),JSON.stringify(plan,null,2));const results=[];
for(let run=1;run<=plan.runs;run++){
 const dir=mkdtempSync(join(tmpdir(),'trustchain-revoke-')),children=[];let provider;
 try{
  const port=await freePort(),rpcUrl='http://127.0.0.1:'+port;
  const child=spawn(process.execPath,[hh.resolve('hardhat/internal/cli/cli.js'),'--config',new URL('./local-chain.cjs',import.meta.url).pathname,'node','--hostname','127.0.0.1','--port',String(port)],{cwd:new URL('../../hardhat/',import.meta.url).pathname,stdio:['ignore','ignore','pipe']});children.push({child});child.stderr.resume();
  let ready=false;for(let i=0;i<300;i++){try{const r=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}),signal:AbortSignal.timeout(1000)});if((await r.json()).result==='0x7a69'){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ready)throw Error('Chain unavailable');
  provider=new ethers.JsonRpcProvider(rpcUrl,undefined,{cacheTimeout:-1,batchMaxCount:1});provider.pollingInterval=50;
  const compiled=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'CredentialStatus.sol':{content:readFileSync(new URL('./CredentialStatus.sol',import.meta.url),'utf8')}},settings:{outputSelection:{'*':{'*':['abi','evm.bytecode']}}}})));
  if(compiled.errors?.some(e=>e.severity==='error'))throw Error('Compilation failed');const artifact=compiled.contracts['CredentialStatus.sol'].CredentialStatus;
  const contract=await new ethers.ContractFactory(artifact.abi,artifact.evm.bytecode.object,await provider.getSigner(0)).deploy();await contract.waitForDeployment();
  const keys=keyPair(),holder=keyPair(),token=ethers.hexlify(ethers.randomBytes(32)),privateKeyFile=join(dir,'key.pem'),publicKeyFile=join(dir,'key.pub');writeFileSync(privateKeyFile,keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});writeFileSync(publicKeyFile,keys.publicKey.export({type:'spki',format:'pem'}));
  for(const mode of ['signed-status','local-chain'])for(const lag of mode==='signed-status'?[0]:plan.statusLagBlocks)for(const ttl of plan.ttlMs){
   const label=`${mode}-${lag}-${ttl}`,chain=mode==='local-chain'?{rpcUrl,contractAddress:await contract.getAddress(),rpcNoCache:true}:undefined;
   const a=await startService({role:'issuer',id:'a',port:0,privateKeyFile,publicKeyFile,adminToken:token,stateFile:join(dir,label+'.state'),chain},join(dir,label+'-a.json'));children.push(a);
   const b=await startService({role:'verifier',id:'b',port:0,trustedIssuers:[{id:'a',publicKeyFile,statusCacheMs:ttl,statusUrl:a.url+'/status',chain:chain?{...chain,statusLagBlocks:lag}:undefined}]},join(dir,label+'-b.json'));children.push(b);
   const issue=async()=>{const r=await post(a.url+'/issue',{holderPublicKey:holder.publicKey.export({type:'spki',format:'pem'}),simulatedIdentityApproved:true,ttlMs:60000},token);assert.equal(r.code,201);return r.body.credential;};
   const credential=await issue(),control=await issue();
   for(let i=0;i<lag;i++)await provider.send('evm_mine',[]);
   async function verify(c){const r=await post(b.url+'/challenge',{});assert.equal(r.code,200);return post(b.url+'/present',{requestId:r.body.id,presentation:present(c,r.body,holder.privateKey)});}
   assert.equal((await verify(control)).body.accepted,true);
   const primingStart=performance.now();assert.equal((await verify(credential)).body.accepted,true);const primed=performance.now();
   const id=JSON.parse(Buffer.from(credential.body,'base64url')).id;const submitted=performance.now();const revoke=await post(a.url+'/revoke',{id},token);assert.equal(revoke.code,200);const acknowledged=performance.now();
   let mined=0,observed=null,lastAccepted=null;const polls=[],blocks=[];
   while(performance.now()-acknowledged<plan.timeoutMs){
    if(chain){const due=Math.floor((performance.now()-acknowledged)/plan.blockIntervalMs);while(mined<due){await provider.send('evm_mine',[]);mined++;blocks.push({block:mined,atMs:performance.now()-acknowledged});}}
    const startMs=performance.now()-acknowledged;const decision=await verify(credential);const endMs=performance.now()-acknowledged;
    const accepted=decision.code===200&&decision.body.accepted===true;polls.push({startMs,endMs,httpStatus:decision.code,accepted,minedBlocks:mined});
    if(!accepted){assert.equal(decision.code,400);assert.equal((await verify(control)).body.accepted,true,'control must remain valid to rule out service outage');observed=endMs;break;}
    lastAccepted=endMs;await new Promise(r=>setTimeout(r,plan.pollPauseMs));
   }
   const row={run,mode,statusLagBlocks:lag,statusCacheMs:ttl,primingRequestMs:primed-primingStart,primeResponseToRevokeAckMs:acknowledged-primed,revokeAcknowledgementMs:acknowledged-submitted,firstRejectionObservedMs:observed,lastAcceptanceObservedMs:lastAccepted,censored:observed===null,polls,blocks};results.push(row);
   writeFileSync(join(output,'results.json'),JSON.stringify({plan,environment:{node:process.version,solc:solc.version(),hardhat:hh('hardhat/package.json').version},results},null,2));
   console.log(`Run ${run}: ${mode} lag=${lag} TTL=${ttl}: first rejection ${observed?.toFixed(0)??'censored'} ms, ${polls.filter(p=>p.accepted).length} post-ack accepts`);
   await stop(b);await stop(a);
  }
 }finally{for(const c of children.reverse())await stop(c);provider?.destroy();rmSync(dir,{recursive:true,force:true});}
}
console.log('Revocation study complete');
