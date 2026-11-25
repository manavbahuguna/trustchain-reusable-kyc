import test from 'node:test';import assert from 'node:assert/strict';import{Issuer,keyPair,seal}from'./protocol.mjs';import{statusList,listReader}from'./status-list.mjs';
function fixture(ttl=500){let time=1000,calls=0,offline=false;const a=new Issuer('a',keyPair(),()=>time),c=JSON.parse(Buffer.from(a.issue(keyPair().publicKey,{simulatedIdentityApproved:true}).body,'base64url'));const read=listReader({issuer:'a',publicKey:a.keys.publicKey,cacheMs:ttl,now:()=>time,fetchList:async()=>{calls++;if(offline)throw Error('offline');return statusList(a,time);}});return{a,c,read,setTime:n=>time=n,offline:()=>offline=true,calls:()=>calls};}
test('aggregate cache expires without renewal and then observes revocation',async()=>{const f=fixture();await f.read(f.c.id,f.c);f.a.revoke(f.c.id);f.setTime(1499);await f.read(f.c.id,f.c);assert.equal(f.calls(),1);f.setTime(1500);await assert.rejects(f.read(f.c.id,f.c));});
test('expired list fails closed during outage',async()=>{const f=fixture();await f.read(f.c.id,f.c);f.offline();f.setTime(1500);await assert.rejects(f.read(f.c.id,f.c));});
test('zero-cache list refetches and rejects unknown index',async()=>{const f=fixture(0);await f.read(f.c.id,f.c);await f.read(f.c.id,f.c);assert.equal(f.calls(),2);await assert.rejects(f.read('x',{...f.c,statusIndex:2}));});
test('wrong issuer and malformed compressed list rejected',async()=>{const f=fixture();await assert.rejects(f.read(f.c.id,{...f.c,issuer:'other'}));const read=listReader({issuer:'a',publicKey:f.a.keys.publicKey,now:()=>1000,fetchList:async()=>seal({type:'TrustChainResearchStatusList',issuer:'a',issuedAt:1000,expiresAt:2000,count:1,bits:'invalid'},f.a.keys.privateKey)});await assert.rejects(read(f.c.id,f.c));});

// Replay a genuine pre-revocation response: valid signature, stale contents.
function replayFixture(cacheMs=0){
 let time=1000,calls=0;
 const issuer=new Issuer('replay',keyPair(),()=>time);
 const credential=JSON.parse(Buffer.from(issuer.issue(keyPair().publicKey,{simulatedIdentityApproved:true,ttlMs:120000}).body,'base64url'));
 let response=statusList(issuer,time);
 const read=listReader({issuer:issuer.id,publicKey:issuer.keys.publicKey,cacheMs,now:()=>time,fetchList:async()=>{calls++;return response;}});
 issuer.revoke(credential.id);
 return{check:()=>read(credential.id,credential),at:value=>time=value,calls:()=>calls,fresh:()=>response=statusList(issuer,time)};
}
test('zero local cache refetches but accepts a replayed list until signed expiry',async()=>{
 const f=replayFixture();
 for(const time of [1001,31000,60999]){f.at(time);await f.check();}
 assert.equal(f.calls(),3,'each acceptance fetched the same stale signed response');
 f.at(61000);await assert.rejects(f.check(),/Invalid list/);
 f.at(61001);await assert.rejects(f.check(),/Invalid list/);
 assert.equal(f.calls(),5);
});
test('positive cache bounds replay age without extending the original deadline',async()=>{
 const f=replayFixture(500);
 f.at(1499);await f.check();assert.equal(f.calls(),1);
 // Current policy accepts age == cacheMs, but cannot retain it as a cache hit.
 f.at(1500);await f.check();await f.check();assert.equal(f.calls(),3);
 f.at(1501);await assert.rejects(f.check(),/Invalid list/);assert.equal(f.calls(),4);
});
test('fresh revoked list immediately rejects with zero local cache',async()=>{
 const f=replayFixture();f.at(1001);await f.check();
 f.fresh();await assert.rejects(f.check(),/Unknown or revoked/);assert.equal(f.calls(),2);
});
test('maximum cache still rejects replay at signed expiry',async()=>{
 const f=replayFixture(60000);f.at(1001);await f.check();
 f.at(60999);await f.check();assert.equal(f.calls(),1);
 f.at(61000);await assert.rejects(f.check(),/Invalid list/);assert.equal(f.calls(),2);
});
