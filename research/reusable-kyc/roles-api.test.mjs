import test from 'node:test';import assert from 'node:assert/strict';import{mkdtempSync,writeFileSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{once}from'node:events';
import{createService}from'./service.mjs';import{keyPair,present,seal}from'./protocol.mjs';import{post}from'./harness.mjs';
test('holder submission, issuer authorization, collection and separate verifier workflow',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'roles-test-')),keys=keyPair(),holder=keyPair(),token='admin-key-'+ 'x'.repeat(40);
 const privateKeyFile=join(dir,'key'),publicKeyFile=join(dir,'pub');writeFileSync(privateKeyFile,keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});writeFileSync(publicKeyFile,keys.publicKey.export({type:'spki',format:'pem'}));
 const a=createService({role:'issuer',allowLegacyApplications:true,id:'a',privateKeyFile,publicKeyFile,adminToken:token,stateFile:join(dir,'state')});a.listen(0,'127.0.0.1');await once(a,'listening');const url='http://127.0.0.1:'+a.address().port;
 const b=createService({role:'verifier',id:'b',trustedIssuers:[{id:'a',publicKeyFile,statusUrl:url+'/status'}]});b.listen(0,'127.0.0.1');await once(b,'listening');const verifier='http://127.0.0.1:'+b.address().port;
 try{
 const request=(await post(url+'/applications/issue',{holderPublicKey:holder.publicKey.export({type:'spki',format:'pem'}),simulatedIdentityApproved:true,level:3})).body;
 assert.equal((await post(url+'/admin/applications',{})).code,401);
 assert.equal((await post(url+'/admin/approve',{id:request.id,simulatedIdentityApproved:true},request.accessToken)).code,401);
 assert.equal((await post(url+'/admin/approve',{id:request.id,simulatedIdentityApproved:true},token)).code,401);
 assert.equal((await post(url+'/issue',{holderPublicKey:holder.publicKey.export({type:'spki',format:'pem'}),simulatedIdentityApproved:true},request.accessToken)).code,401);
 assert.equal((await post(url+'/applications/collect',{id:request.id,accessToken:'wrong'})).code,400);
 assert.equal((await post(url+'/admin/session',{token:'wrong'})).code,401);
 const session=(await post(url+'/admin/session',{token})).body.accessToken;
 const listing=(await post(url+'/admin/applications',{},session)).body;assert.equal(JSON.stringify(listing).includes(request.accessToken),false);
 assert.equal((await post(url+'/admin/approve',{id:request.id},session)).code,400);
 assert.equal((await post(url+'/admin/approve',{id:request.id,simulatedIdentityApproved:true},session)).code,200);
 assert.equal((await post(url+'/admin/approve',{id:request.id,simulatedIdentityApproved:true},session)).code,400);
 const issued=(await post(url+'/applications/collect',request)).body.result;const credential=issued.credential;
 assert.equal(JSON.parse(Buffer.from(credential.body,'base64url')).level,1);
 const challenge=(await post(verifier+'/challenge',{})).body;
 assert.equal((await post(verifier+'/present',{requestId:challenge.id,presentation:present(credential,challenge,holder.privateKey)})).body.accepted,true);
 assert.equal((await post(verifier+'/admin/approve',{id:request.id},session)).code,404);
 const next=keyPair(),id=JSON.parse(Buffer.from(credential.body,'base64url')).id;
 const cr=(await post(url+'/key-change/challenge',{id,mode:'recover',newPublicKey:next.publicKey.export({type:'spki',format:'pem'}).toString()})).body;
 const recovery=(await post(url+'/applications/key-change',{requestId:cr.id,newProof:seal(cr,next.privateKey),recoveryToken:issued.recoveryToken})).body;
 assert.equal((await post(url+'/applications/collect',recovery)).body.status,'pending');
 assert.equal((await post(url+'/admin/approve',{id:recovery.id,simulatedIdentityApproved:true},session)).code,200);
 const recovered=(await post(url+'/applications/collect',recovery)).body.result;
 let r=(await post(verifier+'/challenge',{})).body;assert.equal((await post(verifier+'/present',{requestId:r.id,presentation:present(credential,r,holder.privateKey)})).code,400);
 r=(await post(verifier+'/challenge',{})).body;assert.equal((await post(verifier+'/present',{requestId:r.id,presentation:present(recovered.credential,r,next.privateKey)})).body.accepted,true);
 assert.equal((await post(url+'/admin/logout',{},session)).code,200);assert.equal((await post(url+'/admin/applications',{},session)).code,401);
 }finally{a.closeAllConnections();b.closeAllConnections();await Promise.all([new Promise(r=>a.close(r)),new Promise(r=>b.close(r))]);rmSync(dir,{recursive:true,force:true});}
});
