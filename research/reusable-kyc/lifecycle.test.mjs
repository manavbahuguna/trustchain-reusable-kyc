import test from 'node:test';
import assert from 'node:assert/strict';
import { Issuer,keyPair,seal } from './protocol.mjs';
import { Lifecycle } from './lifecycle.mjs';
function setup(mode){
 const issuer=new Issuer('a'),old=keyPair(),next=keyPair();
 const credential=issuer.issue(old.publicKey,{simulatedIdentityApproved:true});
 const id=JSON.parse(Buffer.from(credential.body,'base64url')).id;
 const lifecycle=new Lifecycle(issuer),token=lifecycle.token(id);
 const r=lifecycle.challenge(id,next.publicKey.export({type:'spki',format:'pem'}).toString(),mode);
 return {issuer,lifecycle,r,token,body:{requestId:r.id,newProof:seal(r,next.privateKey),oldProof:seal(r,old.privateKey),recoveryToken:token,simulatedRecoveryApproved:true}};
}
for(const mode of ['rotate','recover']){
 test(mode+' valid and single use',()=>{const s=setup(mode);assert.equal(s.lifecycle.authorize(s.body).request.mode,mode);assert.throws(()=>s.lifecycle.authorize(s.body));});
 test(mode+' rejects wrong new-key proof',()=>{const s=setup(mode);s.body.newProof=seal(s.r,keyPair().privateKey);assert.throws(()=>s.lifecycle.authorize(s.body));});
 test(mode+' rejects revoked credential',()=>{const s=setup(mode);s.issuer.revoke(s.r.credentialId);assert.throws(()=>s.lifecycle.authorize(s.body));});
}
test('rotation requires old key',()=>{const s=setup('rotate');delete s.body.oldProof;assert.throws(()=>s.lifecycle.authorize(s.body));});
test('recovery requires code',()=>{const s=setup('recover');s.body.recoveryToken='wrong';assert.throws(()=>s.lifecycle.authorize(s.body));});
test('recovery requires explicit approval',()=>{const s=setup('recover');s.body.simulatedRecoveryApproved=false;assert.throws(()=>s.lifecycle.authorize(s.body));});
test('key substitution fails',()=>{const s=setup('rotate');s.body.newProof=seal({...s.r,newPublicKey:'other'},keyPair().privateKey);assert.throws(()=>s.lifecycle.authorize(s.body));});
test('expired change request fails',()=>{const s=setup('rotate');s.lifecycle.requests.get(s.r.id).expiresAt=0;assert.throws(()=>s.lifecycle.authorize(s.body));});
test('expired credential cannot be recovered',()=>{const s=setup('recover');s.issuer.records.get(s.r.credentialId).expiresAt=0;assert.throws(()=>s.lifecycle.authorize(s.body));});
test('rotation preserves the bound issuer',()=>{const s=setup('rotate');s.body.oldProof=seal({...s.r,issuer:'other'},keyPair().privateKey);assert.throws(()=>s.lifecycle.authorize(s.body));});
