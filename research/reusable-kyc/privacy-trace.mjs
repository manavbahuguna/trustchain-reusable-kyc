// Set PLAYWRIGHT_MODULE to an installed Playwright package, or install playwright locally.
import { createRequire } from 'node:module';
import { mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { keyPair } from './protocol.mjs';
import { freePort,startService,stop } from './harness.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir=mkdtempSync(join(tmpdir(),'trustchain-browser-'));const children=[];let browser;
try {
 const keys=keyPair(),token='local-browser-test-token-'+ 'x'.repeat(32),port=await freePort(),origin='http://localhost:'+port;
 const privateKeyFile=join(dir,'key.pem'),publicKeyFile=join(dir,'key.pub');
 writeFileSync(privateKeyFile,keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});writeFileSync(publicKeyFile,keys.publicKey.export({type:'spki',format:'pem'}));
 const a=await startService({role:'issuer',id:'institution-a',port:0,privateKeyFile,publicKeyFile,adminToken:token,stateFile:join(dir,'state'),browserOrigin:origin},join(dir,'a.json'));children.push(a);
 const b=await startService({role:'verifier',id:'institution-b',port:0,browserOrigin:origin,trustedIssuers:[{id:'institution-a',publicKeyFile,statusUrl:a.url+'/status'}]},join(dir,'b.json'));children.push(b);
 const c=await startService({role:'verifier',id:'institution-c',port:0,browserOrigin:origin,trustedIssuers:[{id:'institution-a',publicKeyFile,statusUrl:a.url+'/status'}]},join(dir,'c.json'));children.push(c);
 const vite=spawn(process.execPath,[new URL('../../node_modules/vite/bin/vite.js',import.meta.url).pathname,'preview','--host','localhost','--port',String(port),'--strictPort'],{cwd:new URL('../../',import.meta.url).pathname,stdio:'ignore'});children.push({child:vite});
 for(let i=0;i<100;i++){try{if((await fetch(origin,{signal:AbortSignal.timeout(1000)})).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {})});
 const holder=await browser.newPage({viewport:{width:1280,height:1000}}),admin=await browser.newPage(),verifier=await browser.newPage();const errors=[];
 for(const p of [holder,admin,verifier])p.on('pageerror',e=>errors.push(e.message));
 const cdp=await holder.context().newCDPSession(holder);await cdp.send('WebAuthn.enable');const authenticator=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
 await holder.goto(origin+'?role=holder');await admin.goto(origin+'?role=issuer');await verifier.goto(origin+'?role=verifier');
 assert.equal(await holder.getByLabel('Administrator sign-in key').count(),0);assert.equal(await verifier.getByLabel('Administrator sign-in key').count(),0);
 await holder.getByLabel('Issuer service',{exact:true}).fill(a.url);await admin.getByLabel('Issuer service',{exact:true}).fill(a.url);await verifier.getByLabel('Verifier service',{exact:true}).fill(b.url);
 await admin.getByLabel('Administrator sign-in key').fill(token);await admin.getByRole('button',{name:'Sign in',exact:true}).click();await admin.getByRole('button',{name:'Refresh requests'}).waitFor();
 async function negativeChecks(){
 // Read the already-shared envelope, not the private holder key.
 const envelope=JSON.parse(await holder.getByLabel('Presentation to share',{exact:true}).inputValue());
 const credential=JSON.parse(Buffer.from(envelope.presentation.credential.body,'base64url'));
 assert.equal(credential.passkeyRequired,true);
 async function post(path,body){return fetch(a.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}
 assert.equal((await post('/applications/issue',{holderPublicKey:credential.holderKey})).status,400);
 for(const mutation of ['origin','challenge','credential','replay']){
  const r=await (await post('/passkeys/authenticate/options',{credentialId:credential.id,action:{type:'presentation',presentation:envelope.presentation}})).json();
  const response=await holder.evaluate(async options=>(await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON(options)})).toJSON(),r.options);
  if(mutation==='origin'||mutation==='challenge'){const data=JSON.parse(Buffer.from(response.response.clientDataJSON,'base64url'));data[mutation]=mutation==='origin'?'https://wrong.example':'wrong-challenge';response.response.clientDataJSON=Buffer.from(JSON.stringify(data)).toString('base64url');}
  if(mutation==='credential')response.id='unregistered';
  const checked=await post('/passkeys/authenticate/verify',{id:r.id,response});assert.equal(checked.status,mutation==='replay'?200:400);
  assert.equal((await post('/passkeys/authenticate/verify',{id:r.id,response})).status,400);
 }
 // Removing a required authorization must fail at the verifier, even with a valid holder signature.
 const altered=structuredClone(envelope);delete altered.presentation.passkeyAuthorization;
 const rejected=await fetch(b.url+'/present',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(altered)});assert.equal(rejected.status,400);
 }
 async function approvePending(){await admin.getByRole('button',{name:'Refresh requests'}).click();await admin.getByRole('checkbox').check();const card=admin.locator('article').filter({hasText:'pending'});await card.getByRole('button',{name:'Approve request'}).click();await card.waitFor({state:'detached'});await holder.getByRole('button',{name:'Check approval'}).click();await holder.getByRole('button',{name:'Check approval'}).waitFor({state:'detached'});}
 async function checkPresentation(accepted=true){
  const previous=await verifier.getByLabel('Request to share',{exact:true}).inputValue();await verifier.getByRole('button',{name:'Create verification request'}).click();await verifier.waitForFunction(old=>{const v=document.querySelector('textarea[readonly]').value;return v.length>0&&v!==old;},previous);
  const request=await verifier.getByLabel('Request to share',{exact:true}).inputValue();await holder.getByLabel('Presentation request',{exact:true}).fill(request);await holder.getByRole('button',{name:'Create presentation',exact:true}).click();
  await holder.waitForFunction(id=>{try{return JSON.parse(document.querySelector('textarea[readonly]').value).requestId===id;}catch{return false;}},JSON.parse(request).id);
  await verifier.getByLabel('Holder presentation',{exact:true}).fill(await holder.getByLabel('Presentation to share',{exact:true}).inputValue());
  await verifier.getByRole('button',{name:'Verify presentation',exact:true}).click();await verifier.waitForFunction(ok=>document.querySelector('[role=log] p')?.textContent.startsWith(ok?'Accepted:':'Failed:'),accepted);
 }

 const trace=[];
 const decode=envelope=>JSON.parse(Buffer.from(envelope.body,'base64url'));
 // Retain selected public fields only, never sessions, recovery/pickup secrets,
 // private keys, authenticator responses, or reusable signed envelopes.
 function capture(response){
  const request=response.request(),url=new URL(request.url());
  if(!['/passkeys/authenticate/options','/present'].includes(url.pathname))return;
  const body=request.postDataJSON(),presentation=url.pathname==='/present'?body.presentation:body.action?.presentation;
  if(!presentation)return;
  const credential=decode(presentation.credential),proof=decode(presentation.proof);
  trace.push({observer:url.pathname==='/present'?'verifier':'issuer',endpoint:url.pathname,httpStatus:response.status(),
   recipient:url.origin===b.url?'institution-b':url.origin===c.url?'institution-c':'institution-a',
   credential:{id:credential.id,issuer:credential.issuer,holderKey:credential.holderKey,statusIndex:credential.statusIndex,level:credential.level,passkeyRequired:credential.passkeyRequired},
   proof:{audience:proof.audience,requestId:proof.requestId,nonce:proof.nonce},
   receivedFullCredential:true,receivedHolderProof:true});
 }
 holder.on('response',capture);verifier.on('response',capture);
 await holder.getByRole('button',{name:'Request credential',exact:true}).click();await holder.getByRole('button',{name:'Check approval'}).waitFor();await approvePending();
 for(const base of [b.url,c.url,b.url]){await verifier.getByLabel('Verifier service',{exact:true}).fill(base);await checkPresentation();}
 const issuerRows=trace.filter(x=>x.observer==='issuer'),verifierRows=trace.filter(x=>x.observer==='verifier');
 assert.equal(issuerRows.length,3);assert.equal(verifierRows.length,3);
 assert.deepEqual(issuerRows.map(x=>x.proof.audience),['institution-b','institution-c','institution-b']);
 for(const row of trace){assert.equal(row.httpStatus,200);assert.equal(row.credential.passkeyRequired,true);}
 assert.equal(new Set(verifierRows.map(x=>x.credential.id)).size,1);
 assert.equal(new Set(verifierRows.map(x=>x.credential.holderKey)).size,1);
 assert.equal(new Set(verifierRows.map(x=>x.proof.nonce)).size,3);
 for(const row of verifierRows){const observed=issuerRows.find(x=>x.proof.requestId===row.proof.requestId);assert.deepEqual(observed.credential,row.credential);assert.deepEqual(observed.proof,row.proof);}
 // A fresh request cannot obtain authorization while the issuer is stopped.
 await stop(a);
 const challenge=await(await fetch(b.url+'/challenge',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json();
 await holder.getByLabel('Presentation request',{exact:true}).fill(JSON.stringify(challenge));
 await holder.getByRole('button',{name:'Create presentation',exact:true}).click();
 await holder.waitForFunction(()=>document.querySelector('[role=log] p')?.textContent.startsWith('Failed:'));
 const out=resolve(process.env.OUT||'privacy-trace-results');mkdirSync(out,{recursive:true});
 writeFileSync(join(out,'trace.json'),JSON.stringify({schema:1,authentication:'Chrome virtual CTAP2 with user verification; real application passkey flow',statusBackend:'nonce-bound signed status',scope:'Synthetic disposable identity; browser-observed successful request/response pairs, not server log persistence',trace,checks:{acceptedPresentations:3,independentVerifiers:2,issuerSeesAudience:true,crossVerifierCredentialLinkable:true,distinctChallenges:true,freshPresentationBlockedByIssuerOutage:true}},null,2));
 assert.deepEqual(errors,[]);
 console.log('PRIVACY TRACE PASS: three protected presentations across two verifiers; issuer sees matching credential and audience, stable identifiers link uses, distinct nonces, fresh authorization fails during issuer outage. Output: '+out);
}finally{await browser?.close();for(const child of children.reverse())await stop(child);rmSync(dir,{recursive:true,force:true});}
