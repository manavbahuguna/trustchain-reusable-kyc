// Abrupt-process fault study: real SQLite and reconciliation, deterministic ledger model.
// This is NOT an Ethereum/RPC performance benchmark. No production fault hooks.
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';import {createPrivateKey,createPublicKey} from 'node:crypto';
import assert from 'node:assert/strict';import {performance} from 'node:perf_hooks';
import {Issuer,keyPair} from './protocol.mjs';import {Lifecycle} from './lifecycle.mjs';
import {Storage} from './storage.mjs';import {reconcile,ensureChainState} from './reconcile.mjs';
const cases=['intent','revoke-before-broadcast','revoke-after-broadcast','old-revoked','register-before-broadcast','register-after-broadcast','approved','sqlite-before-commit','rpc-unavailable'];
const [mode,dir,point]=process.argv.slice(2);
if(mode==='worker'){
 const pem=readFileSync(join(dir,'key.pem'));const privateKey=createPrivateKey(pem);
 const issuer=new Issuer('study',{privateKey,publicKey:createPublicKey(privateKey)});
 const db=new Storage(join(dir,'state.sqlite'),pem);const loaded=db.load();issuer.records=loaded.records;
 const item=loaded.applications.get('replacement');const lifecycle=new Lifecycle(issuer);
 let ledger=JSON.parse(readFileSync(join(dir,'ledger.json')));let fired=false;
 function crash(name){if(point===name&&!fired){fired=true;process.kill(process.pid,'SIGKILL');}}
 function save(event){
  // Interrupt a real transaction before COMMIT, without modifying production Storage.
  if(point==='sqlite-before-commit'&&event==='chain-old-revoked'){
   const original=db.db.exec.bind(db.db);db.db.exec=sql=>{if(sql==='COMMIT')crash(point);return original(sql);};
  }
  db.save(issuer.records,loaded.applications,event);
  if(event==='chain-intent')crash('intent');
  if(event==='chain-old-revoked')crash('old-revoked');
  if(event==='chain-approved')crash('approved');
  for(const action of ['revoke','register'])if(event===`chain-${action}-progress`&&item.chainPlan[action].state==='submitting')crash(`${action}-before-broadcast`);
 }
 if(item.status==='processing')item.status='needs-review';
 // Initial seed represents an approved operation entering reconciliation.
 if(!item.chainPlan)item.status='processing';
 const adapter=async()=>({ensure:async(id,target,step,persist)=>ensureChainState({id,target,step,save:persist,
  status:async id=>{if(point==='rpc-unavailable')throw Object.assign(Error('Injected RPC outage'),{code:'RPC_UNAVAILABLE'});return ledger.states[id]||0;},
  receipt:async()=>({status:1}),
  submit:async(id,target)=>{ledger.states[id]=target;ledger.submissions.push({id,target});writeFileSync(join(dir,'ledger.json'),JSON.stringify(ledger));crash(`${target===2?'revoke':'register'}-after-broadcast`);return{hash:`tx-${ledger.submissions.length}`};}
 })});
 const start=performance.now();let error=null;try{await reconcile(item,{issuer,lifecycle,adapter,save});}catch(e){error=e.code||e.message;}
 const states=ledger.states;const old=item.operation?.request.credentialId||item.chainPlan.oldId;
 const result={status:item.status,error,recoveryMs:performance.now()-start,records:issuer.records.size,oldState:states[old],newState:states[item.chainPlan?.id]||0,newId:item.chainPlan?.id,submissions:ledger.submissions.length,dualActive:states[old]===1&&states[item.chainPlan?.id]===1};
 db.close();process.stdout.write(JSON.stringify(result));
}else{
 const out=resolve(process.env.OUT||'failure-study-results');mkdirSync(out,{recursive:true});const rows=[];
 for(let run=1;run<=3;run++)for(const fault of cases){
  const temp=mkdtempSync(join(tmpdir(),'trustchain-fault-'));
  try{
   const keys=keyPair(),pem=keys.privateKey.export({type:'pkcs8',format:'pem'});writeFileSync(join(temp,'key.pem'),pem,{mode:0o600});
   const issuer=new Issuer('study',keys),holder=keyPair(),next=keyPair();
   const credential=issuer.issue(holder.publicKey,{simulatedIdentityApproved:true,ttlMs:3600000});const oldId=JSON.parse(Buffer.from(credential.body,'base64url')).id;
   const item={id:'replacement',status:'processing',secretHash:Buffer.alloc(32),operation:{request:{credentialId:oldId,newPublicKey:next.publicKey.export({type:'spki',format:'pem'})}},expiresAt:Date.now()+900000};
   const db=new Storage(join(temp,'state.sqlite'),pem);db.save(issuer.records,new Map([[item.id,item]]),'seed');db.close();
   writeFileSync(join(temp,'ledger.json'),JSON.stringify({states:{[oldId]:1},submissions:[]}));
   const invoke=p=>spawnSync(process.execPath,[new URL(import.meta.url).pathname,'worker',temp,p],{encoding:'utf8',timeout:15000});
   const interrupted=invoke(fault);if(fault!=='rpc-unavailable')assert.equal(interrupted.signal,'SIGKILL',interrupted.stderr);else assert.equal(interrupted.status,0,interrupted.stderr);
   const interruptedLedger=JSON.parse(readFileSync(join(temp,'ledger.json')));
   assert.ok(Object.values(interruptedLedger.states).filter(x=>x===1).length<=1,'Dual active at interruption');
   const start=performance.now();const recovered=invoke('none');const restartMs=performance.now()-start;assert.equal(recovered.status,0,recovered.stderr);
   const result=JSON.parse(recovered.stdout);const repeated=invoke('none');assert.equal(repeated.status,0,repeated.stderr);const retry=JSON.parse(repeated.stdout);
   const blocked=fault.endsWith('before-broadcast');assert.equal(result.status,blocked?'needs-review':'approved');if(blocked)assert.equal(result.error,'BROADCAST_UNKNOWN');
   assert.equal(result.records,2);assert.equal(result.dualActive,false);assert.equal(retry.newId,result.newId);assert.equal(retry.submissions,result.submissions);
   if(!blocked){assert.equal(result.oldState,2);assert.equal(result.newState,1);assert.equal(result.submissions,2);}
   rows.push({run,fault,signal:interrupted.signal,restartMs,...result,retryStable:true,activeAtInterruption:Object.values(interruptedLedger.states).filter(x=>x===1).length});
  }finally{rmSync(temp,{recursive:true,force:true});}
 }
 writeFileSync(join(out,'results.json'),JSON.stringify({scope:'Real SIGKILL and SQLite; deterministic immediately-mined ledger model; software-key recovery; three repetitions per fault',rows},null,2));
 console.log(JSON.stringify({trials:rows.length,approved:rows.filter(x=>x.status==='approved').length,blocked:rows.filter(x=>x.status!=='approved').length,dualActive:rows.filter(x=>x.dualActive).length,output:out}));
}
