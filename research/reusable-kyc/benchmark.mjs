import { createRequire } from 'node:module';
import { readFileSync,writeFileSync,mkdtempSync,rmSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { keyPair,present,seal } from './protocol.mjs';
import { freePort,startService,stop,post } from './harness.mjs';
const require=createRequire(import.meta.url),{ethers}=require('ethers');
const hardhatRequire=createRequire(new URL('../../hardhat/package.json',import.meta.url));
const solc=hardhatRequire('solc');
const trials=Number(process.env.TRIALS || 30);
if(!Number.isInteger(trials)||trials<5||trials>1000)throw Error('TRIALS must be 5–1000');
const dir=mkdtempSync(join(tmpdir(),'trustchain-compare-')),children=[];let provider;
const samples=[],checks=[];let chainProbe;
const credentialId=c=>JSON.parse(Buffer.from(c.body,'base64url')).id;
async function expect(url,body,token,code=200){const r=await post(url,body,token);assert.equal(r.code,code,JSON.stringify(r.body));return r.body;}
try{
 const port=await freePort();
 const child=spawn(process.execPath,[hardhatRequire.resolve('hardhat/internal/cli/cli.js'),'--config',new URL('./local-chain.cjs',import.meta.url).pathname,'node','--hostname','127.0.0.1','--port',String(port)],{cwd:new URL('../../hardhat/',import.meta.url).pathname,stdio:['ignore','ignore','pipe']});
 children.push({child});let chainErrors='';child.stderr.on('data',d=>chainErrors+=d);
 let ready=false;
 for(let i=0;i<900;i++){
  if(child.exitCode!==null)throw Error('Local chain exited: '+chainErrors);
  try{const r=await fetch('http://127.0.0.1:'+port,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})});if((await r.json()).result==='0x7a69'){ready=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,100));
 }
 if(!ready)throw Error('Local chain did not start: '+chainErrors);
 console.log('Local chain ready; compiling and deploying research contract.');
 const rpcUrl='http://127.0.0.1:'+port;provider=new ethers.JsonRpcProvider(rpcUrl);provider.pollingInterval=50;
 const compilerInput={language:'Solidity',sources:{'CredentialStatus.sol':{content:readFileSync(new URL('./CredentialStatus.sol',import.meta.url),'utf8')}},settings:{optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode']}}}};
 const output=JSON.parse(solc.compile(JSON.stringify(compilerInput)));
 if(output.errors?.some(e=>e.severity==='error'))throw Error(JSON.stringify(output.errors));
 const artifact=output.contracts['CredentialStatus.sol'].CredentialStatus;
 const contract=await new ethers.ContractFactory(artifact.abi,artifact.evm.bytecode.object,await provider.getSigner(0)).deploy();await contract.waitForDeployment();
 const address=await contract.getAddress();
 const deploymentGas=(await contract.deploymentTransaction().wait()).gasUsed.toString();
 await assert.rejects(contract.connect(await provider.getSigner(1)).register(ethers.id('unauthorized')));checks.push('Contract rejects unauthorized issuer');
 const keys=keyPair(),holder=keyPair(),token='test-'+ethers.hexlify(ethers.randomBytes(32));
 const privateKeyFile=join(dir,'issuer.pem'),publicKeyFile=join(dir,'issuer.pub');
 writeFileSync(privateKeyFile,keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});writeFileSync(publicKeyFile,keys.publicKey.export({type:'spki',format:'pem'}));
 const modes=[];
 for(const mode of ['signed-status','local-chain']){
  const stateFile=join(dir,mode+'.state');const chain=mode==='local-chain'?{rpcUrl,contractAddress:address}:undefined;
  const a=await startService({role:'issuer',id:'a',port:0,privateKeyFile,publicKeyFile,adminToken:token,stateFile,chain},join(dir,mode+'-a.json'));children.push(a);
  const b=await startService({role:'verifier',id:'b',port:0,trustedIssuers:[{id:'a',publicKeyFile,statusUrl:a.url+'/status',chain}]},join(dir,mode+'-b.json'));children.push(b);
  modes.push({mode,a,b,stateFile});
 }
 async function presentTo(b,c,key=holder.privateKey){const r=await expect(b.url+'/challenge',{});return post(b.url+'/present',{requestId:r.id,presentation:present(c,r,key)});}
 for(let i=-5;i<trials;i++){
  if(i===0 || (i>0 && i%10===0))console.log('Measured trial '+i+'/'+trials);
  // Alternate order to reduce simple warm-up/order bias.
  for(const {mode,a,b,stateFile} of i%2 ? [...modes].reverse():modes){
   const begin=performance.now();const issued=await expect(a.url+'/issue',{holderPublicKey:holder.publicKey.export({type:'spki',format:'pem'}),simulatedIdentityApproved:true,ttlMs:600000},token,201);
   const issueMs=performance.now()-begin;
   const vStart=performance.now();assert.equal((await presentTo(b,issued.credential)).body.accepted,true);const verifyMs=performance.now()-vStart;
   const rStart=performance.now();const revoked=await expect(a.url+'/revoke',{id:credentialId(issued.credential)},token);const revokeMs=performance.now()-rStart;
   const rejectStart=performance.now();assert.equal((await presentTo(b,issued.credential)).code,400);const rejectMs=performance.now()-rejectStart;
   if(i>=0)samples.push({trial:i,mode,issueMs,verifyMs,revokeMs,rejectMs,issuanceGas:issued.gasUsed || null,revocationGas:revoked.gasUsed || null,issuerStateBytes:statSync(stateFile).size});
  }
 }
 // Exercise complete replacement and recovery against BOTH status implementations.
 for(const {mode,a,b} of modes){
  let issued=await expect(a.url+'/issue',{holderPublicKey:holder.publicKey.export({type:'spki',format:'pem'}),simulatedIdentityApproved:true,ttlMs:600000},token,201);
  let currentKey=holder.privateKey;
  for(const operation of ['rotate','recover']){
   const previous=issued.credential,next=keyPair();
   const r=await expect(a.url+'/key-change/challenge',{id:credentialId(previous),newPublicKey:next.publicKey.export({type:'spki',format:'pem'}).toString(),mode:operation});
   const body={requestId:r.id,newProof:seal(r,next.privateKey),...(operation==='rotate'?{oldProof:seal(r,currentKey)}:{recoveryToken:issued.recoveryToken,simulatedRecoveryApproved:true})};
   assert.equal((await post(a.url+'/key-change',body)).code,401);
   issued=await expect(a.url+'/key-change',body,token,201);
   assert.equal((await presentTo(b,previous,currentKey)).code,400);
   assert.equal((await presentTo(b,issued.credential,next.privateKey)).body.accepted,true);
   assert.equal((await post(a.url+'/key-change',body,token)).code,400);
   currentKey=next.privateKey;checks.push(mode+': '+operation+' invalidates old credential, accepts new key, rejects replay and unauthorized request');
  }
  // Availability difference: signed status needs the issuer; chain reads do not.
  await stop(a);
  const r=await presentTo(b,issued.credential,currentKey);
  assert.equal(r.code,mode==='local-chain'?200:400);if(mode==='local-chain')chainProbe={b,credential:issued.credential,key:currentKey};checks.push(mode+': issuer outage behavior verified');
 }
 await stop(children[0]);
 assert.equal((await presentTo(chainProbe.b,chainProbe.credential,chainProbe.key)).code,400);checks.push('local-chain: RPC outage fails closed');
 const summary={};
 for(const mode of ['signed-status','local-chain']){
  summary[mode]={};for(const metric of ['issueMs','verifyMs','revokeMs','rejectMs']){
   const values=samples.filter(s=>s.mode===mode).map(s=>s[metric]).sort((a,b)=>a-b);
   const q=p=>values[Math.ceil(p*values.length)-1];summary[mode][metric]={p50:q(.5),p95:q(.95),p99:q(.99)};
  }
 }
 const result={deploymentGas,generatedAt:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch,solc:solc.version(),chain:'Hardhat 31337, automine, local loopback',trialsPerMode:trials,warmupsPerMode:5},limitations:['Single-machine local measurements; no WAN or consensus finality','Sequential synthetic workload; custom credential format; software holder key','Verification includes challenge fetch, holder signing, presentation and fresh status lookup','No general security/scalability conclusions; percentiles are descriptive, not confidence intervals','Issuer state size is serialized JSON, not total disk or blockchain storage'],checks,summary,samples};
 const destination=resolve(process.argv[2] || 'research-comparison.json');writeFileSync(destination,JSON.stringify(result,null,2));console.log(JSON.stringify({destination,summary,checks},null,2));
}finally{for(const child of children.reverse())await stop(child);provider?.destroy();rmSync(dir,{recursive:true,force:true});}
