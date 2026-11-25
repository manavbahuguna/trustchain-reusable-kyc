import { createRequire } from 'node:module';
import { readFileSync,writeFileSync,mkdtempSync,rmSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawn,spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { keyPair,present,seal } from './protocol.mjs';
import { freePort,startService,stop,post } from './harness.mjs';
const require=createRequire(import.meta.url),{ethers}=require('ethers');
const hardhatRequire=createRequire(new URL('../../hardhat/package.json',import.meta.url));
const solc=hardhatRequire('solc');
const trials=5;
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
 const transactionKeyFile=join(dir,'transaction.key');writeFileSync(transactionKeyFile,ethers.HDNodeWallet.fromPhrase('test test test test test test test test test test test junk').privateKey,{mode:0o600});
 const config={role:'issuer',id:'a',port:0,privateKeyFile,publicKeyFile,adminToken:token,stateFile:join(dir,'state'),allowLegacyApplications:true,chain:{transactionKeyFile,rpcUrl,contractAddress:address,rpcNoCache:true}};
 // Kill independent workers around the durable outbox boundary on the real chain.
 const {chainAdapter}=await import('./chain.mjs');
 const {Storage}=await import('./storage.mjs');
 const storageKey=readFileSync(privateKeyFile);
 for(const checkpoint of ['before-commit','prepared','confirmed']){
  const id='outbox-'+checkpoint;
  for(const target of [1,2]){
   const stepFile=join(dir,`step-${checkpoint}-${target}.sqlite`);
   const seed=new Storage(stepFile,storageKey);seed.save(new Map(),new Map([['operation',{secretHash:Buffer.alloc(32),step:{}}]]),'seed');seed.close();
   const worker=`import {readFileSync} from 'node:fs';import {chainAdapter} from ${JSON.stringify(new URL('./chain.mjs',import.meta.url).href)};
    import {Storage} from ${JSON.stringify(new URL('./storage.mjs',import.meta.url).href)};
    const db=new Storage(${JSON.stringify(stepFile)},readFileSync(${JSON.stringify(privateKeyFile)}));const state=db.load();const step=state.applications.get('operation').step;
    const adapter=await chainAdapter(${JSON.stringify(config.chain)},true);
    await adapter.ensure(${JSON.stringify(id)},${target},step,()=>{
      if(step.state==='confirmed'&&${JSON.stringify(checkpoint)}==='confirmed')process.kill(process.pid,'SIGKILL');
      if(step.state==='prepared'&&${JSON.stringify(checkpoint)}==='before-commit'){
       const original=db.db.exec.bind(db.db);db.db.exec=sql=>{if(sql==='COMMIT')process.kill(process.pid,'SIGKILL');return original(sql);};
      }
      db.save(state.records,state.applications,'outbox');
      if(step.state==='prepared'&&${JSON.stringify(checkpoint)}==='prepared')process.kill(process.pid,'SIGKILL');
    });adapter.close();db.close();`;
   const killed=spawnSync(process.execPath,['--input-type=module','-e',worker],{encoding:'utf8',timeout:15000});assert.equal(killed.signal,'SIGKILL',killed.stderr);
   const db=new Storage(stepFile,storageKey),state=db.load(),step=state.applications.get('operation').step;
   if(checkpoint==='before-commit')assert.deepEqual(step,{});else{assert.ok(step.rawTransaction);assert.equal(step.state,'prepared');}
   const originalHash=step.hash,adapter=await chainAdapter(config.chain,true);
   try{
    await adapter.ensure(id,target,step,()=>db.save(state.records,state.applications,'recovered'));
    assert.equal(step.state,'confirmed');if(originalHash)assert.equal(step.hash,originalHash);
    const recoveredHash=step.hash;await adapter.ensure(id,target,step,()=>{});assert.equal(step.hash,recoveredHash);
   }finally{adapter.close();db.close();}
   assert.equal(Number(await contract.status(ethers.id(id))),target);
  }
 }
 console.log('SQLITE OUTBOX CRASH PASS: six real-chain SIGKILL cases before SQLite commit, before broadcast, and after mining; registration and revocation recover.');
 // A second writer consuming the saved nonce must not cause a fresh transaction.
 const conflictAdapter=await chainAdapter(config.chain,true),conflictStep={};
 try{
  await assert.rejects(conflictAdapter.ensure('nonce-conflict',1,conflictStep,()=>{throw Error('interrupt after prepare');}),/interrupt after prepare/);
  const saved=JSON.stringify(conflictStep),signer=await provider.getSigner(0);
  await(await signer.sendTransaction({to:await signer.getAddress(),value:0,nonce:conflictStep.nonce})).wait();
  for(let attempt=0;attempt<2;attempt++)await assert.rejects(conflictAdapter.ensure('nonce-conflict',1,conflictStep,()=>assert.fail('must not replace transaction')),e=>e.code==='OUTBOX_NONCE_CONFLICT');
  assert.equal(JSON.stringify(conflictStep),saved);assert.equal(Number(await contract.status(ethers.id('nonce-conflict'))),0);
 }finally{conflictAdapter.close();}
 console.log('NONCE CONFLICT PASS: competing transaction blocks recovery with a stable error; original signed transaction remains unchanged.');
 const {checkOutboxNetwork}=await import('./outbox-network-checks.mjs');
 await checkOutboxNetwork({config,provider,contract,ethers,dir});
 let a=await startService(config,join(dir,'a.json'));children.push(a);
 async function session(){return(await expect(a.url+'/admin/session',{token})).accessToken;}
 const request=await expect(a.url+'/applications/issue',{holderPublicKey:holder.publicKey.export({type:'spki',format:'pem'})},undefined,201);
 let auth=await session();assert.equal((await post(a.url+'/admin/reconcile',{id:request.id},request.accessToken)).code,401);
 await provider.send('evm_setAutomine',[false]);
 assert.equal((await post(a.url+'/admin/approve',{id:request.id,simulatedIdentityApproved:true},auth)).code,400);
 let list=await expect(a.url+'/admin/applications',{},auth);assert.equal(list.applications[0].status,'needs-review');assert.ok(list.applications[0].transactions.register);
 assert.equal((await post(a.url+'/admin/reconcile',{id:request.id},auth)).code,400);
 await stop(a);await provider.send('evm_mine',[]);await provider.send('evm_setAutomine',[true]);
 a=await startService(config,join(dir,'a.json'));children.push(a);auth=await session();
 const issued=(await expect(a.url+'/applications/collect',request)).result;assert.ok(issued.recoveryToken);assert.equal((await expect(a.url+'/admin/credentials',{},auth)).credentials.length,1);
 const oldId=credentialId(issued.credential),next=keyPair();
 const challenge=await expect(a.url+'/key-change/challenge',{id:oldId,mode:'recover',newPublicKey:next.publicKey.export({type:'spki',format:'pem'}).toString()});
 const recovery=await expect(a.url+'/applications/key-change',{requestId:challenge.id,newProof:seal(challenge,next.privateKey),recoveryToken:issued.recoveryToken},undefined,201);
 await provider.send('evm_setAutomine',[false]);assert.equal((await post(a.url+'/admin/approve',{id:recovery.id,simulatedIdentityApproved:true},auth)).code,400);
 await stop(a);await provider.send('evm_mine',[]);await provider.send('evm_setAutomine',[true]);
 a=await startService(config,join(dir,'a.json'));children.push(a);auth=await session();
 const replacement=(await expect(a.url+'/applications/collect',recovery)).result;
 assert.equal(Number(await contract.status(ethers.id(oldId))),2);assert.equal(Number(await contract.status(ethers.id(credentialId(replacement.credential)))),1);
 assert.equal((await expect(a.url+'/admin/credentials',{},auth)).credentials.length,2);
 assert.equal((await post(a.url+'/admin/reconcile',{id:recovery.id},auth)).code,400);
 console.log('CHAIN RECOVERY PASS: pending transactions, no duplicate retry, startup reconciliation, durable pickup and recovery revocation ordering.');
}finally{provider?.destroy();for(const c of children.reverse())await stop(c);rmSync(dir,{recursive:true,force:true});}
