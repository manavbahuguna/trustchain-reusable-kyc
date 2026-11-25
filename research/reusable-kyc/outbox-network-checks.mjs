// Local integration fixture: forwards real RPC calls; faults never enter production code.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {Storage} from './storage.mjs';
import {chainAdapter} from './chain.mjs';
export async function checkOutboxNetwork({config,provider,contract,ethers,dir}){
 let outage=false,dropResponse=false,dropped=0;const broadcasts=[];
 const proxy=createServer(async(req,res)=>{
  try{
   let body='';for await(const chunk of req)body+=chunk;
   if(outage){res.writeHead(503);res.end('Injected outage');return;}
   const rpc=JSON.parse(body),calls=Array.isArray(rpc)?rpc:[rpc];
   const sends=calls.filter(x=>x.method==='eth_sendRawTransaction');
   broadcasts.push(...sends.map(x=>x.params[0]));
   const upstream=await fetch(config.chain.rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body,signal:AbortSignal.timeout(5000)});
   const text=await upstream.text();
   if(dropResponse&&sends.length){
    const replies=JSON.parse(text);assert.ok(!(Array.isArray(replies)?replies:[replies]).some(x=>x.error),'Broadcast must reach the node successfully');
    dropResponse=false;outage=true;dropped++;res.destroy();return;
   }
   res.writeHead(upstream.status,{'content-type':'application/json'});res.end(text);
  }catch(error){res.writeHead(500);res.end(String(error));}
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const chain={...config.chain,rpcUrl:`http://127.0.0.1:${proxy.address().port}`,rpcNoCache:true};
 const key=readFileSync(config.privateKeyFile);
 try{
  for(const fault of ['lost-response','evicted'])for(const target of [1,2]){
   const id=`network-${fault}`;const file=join(dir,`${fault}-${target}.sqlite`);
   let db=new Storage(file,key),state={records:new Map(),applications:new Map([['op',{secretHash:Buffer.alloc(32),step:{}}]])};
   db.save(state.records,state.applications,'seed');let step=state.applications.get('op').step;
   let adapter=await chainAdapter(chain,true);const before=broadcasts.length;
   try{
    await provider.send('evm_setAutomine',[false]);
    dropResponse=fault==='lost-response';
    await assert.rejects(adapter.ensure(id,target,step,()=>db.save(state.records,state.applications,'prepared')),
     error=>fault==='lost-response'||error.code==='TRANSACTION_PENDING');
    assert.ok(step.rawTransaction);assert.equal(step.state,'prepared');
    const hash=step.hash,raw=step.rawTransaction,nonce=step.nonce;
    assert.ok(await provider.send('eth_getTransactionByHash',[hash]),'Original transaction must be pending');
    if(fault==='evicted'){
     assert.equal(await provider.send('hardhat_dropTransaction',[hash]),true);
     assert.equal(await provider.send('eth_getTransactionByHash',[hash]),null);
    }
    adapter.close();db.close();outage=false;
    // Reopen the actual encrypted journal and construct a fresh RPC adapter.
    db=new Storage(file,key);state=db.load();step=state.applications.get('op').step;
    adapter=await chainAdapter(chain,true);
    await assert.rejects(adapter.ensure(id,target,step,()=>db.save(state.records,state.applications,'retry')),e=>e.code==='TRANSACTION_PENDING');
    assert.ok(await provider.send('eth_getTransactionByHash',[hash]));
    await provider.send('evm_mine',[]);
    await adapter.ensure(id,target,step,()=>db.save(state.records,state.applications,'confirmed'));
    assert.equal(step.state,'confirmed');assert.equal(step.hash,hash);assert.equal(step.rawTransaction,raw);assert.equal(step.nonce,nonce);
    assert.equal(Number(await contract.status(ethers.id(id))),target);
    const sent=broadcasts.slice(before);assert.ok(sent.length>=2);assert.ok(sent.every(bytes=>bytes===raw),'All attempts must resend identical signed bytes');
    const count=broadcasts.length;await adapter.ensure(id,target,step,()=>{});assert.equal(broadcasts.length,count,'Confirmed retry must not broadcast');
   }finally{outage=false;dropResponse=false;adapter.close();db.close();await provider.send('evm_setAutomine',[true]);}
  }
  assert.equal(dropped,2);
  console.log('NETWORK OUTBOX PASS: four SQLite-backed registration/revocation cases recover after lost broadcast responses with RPC outage, or pending-transaction eviction; retries use identical signed bytes.');
 }finally{proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
}
