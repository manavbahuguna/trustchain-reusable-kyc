import test from 'node:test';import assert from 'node:assert/strict';
import {Issuer,Verifier,keyPair,present} from './protocol.mjs';
function setup(ttl=500){let time=1000,calls=0;const now=()=>time,issuer=new Issuer('a',keyPair(),now),holder=keyPair();const trust={publicKey:issuer.keys.publicKey,statusCacheMs:ttl,status:(id,n)=>{calls++;return issuer.status(id,n);}};const v=new Verifier('b',new Map([['a',trust]]),now);const c=issuer.issue(holder.publicKey,{simulatedIdentityApproved:true,ttlMs:10000});return {issuer,holder,trust,v,c,advance:n=>time+=n,calls:()=>calls,async accept(key=holder.privateKey){const r=v.challenge();return v.accept(r.id,present(c,r,key));},id:JSON.parse(Buffer.from(c.body,'base64url')).id};}
test('cache admits revoked credential only until original TTL; hits do not renew TTL',async()=>{const s=setup();await s.accept();s.issuer.revoke(s.id);s.advance(400);await s.accept();assert.equal(s.calls(),1);s.advance(100);await assert.rejects(s.accept());assert.equal(s.calls(),2);});
test('zero TTL checks every presentation',async()=>{const s=setup(0);await s.accept();s.issuer.revoke(s.id);await assert.rejects(s.accept());});
test('expired cache fails closed on status outage',async()=>{const s=setup();await s.accept();s.trust.status=()=>{throw Error('down');};s.advance(500);await assert.rejects(s.accept());});
test('cached status never bypasses holder proof',async()=>{const s=setup();await s.accept();await assert.rejects(s.accept(keyPair().privateKey));});
test('removed issuer is rejected despite cached status',async()=>{const s=setup();await s.accept();s.v.trustedIssuers.delete('a');await assert.rejects(s.accept());});
test('credential expiry overrides cache',async()=>{const s=setup(60000);await s.accept();s.advance(10000);await assert.rejects(s.accept());});
test('changed trusted key cannot reuse cached status',async()=>{const s=setup();await s.accept();s.trust.publicKey=keyPair().publicKey;await assert.rejects(s.accept());});
