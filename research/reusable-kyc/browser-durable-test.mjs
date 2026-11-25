// Set PLAYWRIGHT_MODULE to an installed Playwright package, or install playwright locally.
import { createRequire } from 'node:module';
import { mkdtempSync,rmSync,readFileSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn,execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { keyPair } from './protocol.mjs';
import { freePort,startService,stop } from './harness.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir=mkdtempSync(join(tmpdir(),'trustchain-browser-'));const children=[];let browser;
try {
 const keys=keyPair(),token='local-browser-test-token-'+ 'x'.repeat(32),port=await freePort(),origin='http://localhost:'+port;
 const privateKeyFile=join(dir,'key.pem'),publicKeyFile=join(dir,'key.pub');
 writeFileSync(privateKeyFile,keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});writeFileSync(publicKeyFile,keys.publicKey.export({type:'spki',format:'pem'}));
 const backend='local-chain';let chain;
 if(backend==='local-chain'){
  const hh=createRequire(new URL('../../hardhat/package.json',import.meta.url)),solc=hh('solc'),{ethers}=require('ethers'),rpcPort=await freePort(),rpcUrl='http://127.0.0.1:'+rpcPort;
  const child=spawn(process.execPath,[hh.resolve('hardhat/internal/cli/cli.js'),'--config',new URL('./local-chain.cjs',import.meta.url).pathname,'node','--hostname','127.0.0.1','--port',String(rpcPort)],{cwd:new URL('../../hardhat/',import.meta.url).pathname,stdio:'ignore'});children.push({child});
  for(let i=0;i<300;i++){try{if((await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})})).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const setupDir=join(dir,'durable-demo');
  execFileSync(process.execPath,[new URL('./setup-chain-local.mjs',import.meta.url).pathname,setupDir,rpcUrl]);
  chain=JSON.parse(readFileSync(join(setupDir,'issuer.json'))).chain;

 }
 const a=await startService({role:'issuer',id:'institution-a',port:0,privateKeyFile,publicKeyFile,adminToken:token,stateFile:join(dir,'state'),chain,browserOrigin:origin},join(dir,'a.json'));children.push(a);
 const b=await startService({role:'verifier',id:'institution-b',port:0,browserOrigin:origin,trustedIssuers:[{id:'institution-a',publicKeyFile,...(chain?{chain}:backend==='signed-list'?{statusListUrl:a.url+'/status-list'}:{statusUrl:a.url+'/status'})}]},join(dir,'b.json'));children.push(b);
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
 await holder.getByRole('button',{name:'Request credential',exact:true}).click();await holder.getByRole('button',{name:'Check approval'}).waitFor();await approvePending();await checkPresentation();
 await negativeChecks();
 await holder.getByRole('button',{name:'Request key rotation'}).click();await holder.getByRole('button',{name:'Check approval'}).waitFor();await approvePending();await checkPresentation();
 const code=await holder.getByLabel('Offline recovery code',{exact:true}).inputValue();assert.ok(code.length>30);
 await holder.getByRole('button',{name:'Simulate lost key'}).click();await holder.getByText('Signing key lost',{exact:true}).waitFor();await holder.reload();await holder.getByText('Signing key lost',{exact:true}).waitFor();
 await holder.getByLabel('Offline recovery code',{exact:true}).fill(code);await holder.getByRole('button',{name:'Request recovery'}).click();await holder.getByRole('button',{name:'Check approval'}).waitFor();await approvePending();await checkPresentation();
 // Recreate the issuer process on the same address; stored passkey and counter must still work.
 await stop(a);
 await verifier.getByRole('button',{name:'Create verification request'}).click();await verifier.waitForFunction(()=>document.querySelector('[role=log] p')?.textContent.startsWith('Fresh request'));
 await holder.getByLabel('Presentation request',{exact:true}).fill(await verifier.getByLabel('Request to share',{exact:true}).inputValue());await holder.getByRole('button',{name:'Create presentation',exact:true}).click();await holder.waitForFunction(()=>document.querySelector('[role=log] p')?.textContent.startsWith('Failed:'));

 const restartedConfig=JSON.parse(readFileSync(join(dir,'a.json'),'utf8'));restartedConfig.port=Number(new URL(a.url).port);const restarted=await startService(restartedConfig,join(dir,'restart.json'));children.push(restarted);await checkPresentation();
 await admin.reload();await admin.getByLabel('Issuer service',{exact:true}).fill(a.url);await admin.getByLabel('Administrator sign-in key').fill(token);await admin.getByRole('button',{name:'Sign in',exact:true}).click();await admin.getByRole('button',{name:'Refresh requests'}).waitFor();
 await admin.getByRole('button',{name:'Refresh requests'}).click();const active=admin.locator('article').filter({hasText:'Active · Level'});await active.getByRole('button',{name:'Revoke credential'}).click();await active.waitFor({state:'detached'});await holder.getByRole('button',{name:'Create presentation',exact:true}).click();await holder.waitForFunction(()=>document.querySelector('[role=log] p')?.textContent.startsWith('Failed:'));
 await admin.getByRole('button',{name:'Sign out',exact:true}).click();await admin.getByRole('button',{name:'Sign in',exact:true}).waitFor();
 await holder.getByLabel('Offline recovery code',{exact:true}).fill('');
 if(process.env.SCREENSHOT_PATH)await holder.screenshot({path:process.env.SCREENSHOT_PATH,fullPage:true});
 await holder.setViewportSize({width:390,height:844});assert.equal(await holder.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await stop(restarted);
 const {Storage}=await import('./storage.mjs');
 const db=new Storage(join(dir,'state.sqlite'),keys.privateKey.export({type:'pkcs8',format:'der'}));
 let plans;try{plans=[...db.load().applications.values()].filter(x=>x.chainPlan);assert.equal(plans.length,3);
 for(const item of plans){assert.equal(item.status,'approved');assert.ok(item.chainPlan.register.rawTransaction);assert.equal(item.chainPlan.register.state,'confirmed');if(item.chainPlan.oldId){assert.ok(item.chainPlan.revoke.rawTransaction);assert.equal(item.chainPlan.revoke.state,'confirmed');}}}finally{db.close();}
 if(process.env.RESULT_PATH)writeFileSync(process.env.RESULT_PATH,JSON.stringify({passed:true,durableSigning:true,approvedApplications:plans.length,checks:['issuance','rotation','recovery after reload','issuer restart','issuer outage','revocation rejection','encrypted outbox for all three approvals'],authentication:'virtual CTAP2; simulated identity approval'},null,2));
 assert.deepEqual(errors,[]);console.log('Browser PASS: virtual passkey registration and authentication; wrong origin, wrong challenge, unregistered credential and replay rejected; three isolated browser contexts; holder request, admin approval, verifier exchange, rotation, recovery after reload, revocation rejection, sign-out; no admin controls in holder/verifier.');

}finally{await browser?.close();for(const c of children.reverse())await stop(c);rmSync(dir,{recursive:true,force:true});}
