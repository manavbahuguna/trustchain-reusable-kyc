// Set PLAYWRIGHT_MODULE to an installed Playwright package, or install playwright locally.
import { createRequire } from 'node:module';
import { mkdtempSync,rmSync,readFileSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 const backend=process.env.BACKEND||'signed-status';let chain;
 if(backend==='local-chain'){
  const hh=createRequire(new URL('../../hardhat/package.json',import.meta.url)),solc=hh('solc'),{ethers}=require('ethers'),rpcPort=await freePort(),rpcUrl='http://127.0.0.1:'+rpcPort;
  const child=spawn(process.execPath,[hh.resolve('hardhat/internal/cli/cli.js'),'--config',new URL('./local-chain.cjs',import.meta.url).pathname,'node','--hostname','127.0.0.1','--port',String(rpcPort)],{cwd:new URL('../../hardhat/',import.meta.url).pathname,stdio:'ignore'});children.push({child});
  for(let i=0;i<300;i++){try{if((await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})})).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const provider=new ethers.JsonRpcProvider(rpcUrl);provider.pollingInterval=50;
  try{const compiled=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'CredentialStatus.sol':{content:readFileSync(new URL('./CredentialStatus.sol',import.meta.url),'utf8')}},settings:{outputSelection:{'*':{'*':['abi','evm.bytecode']}}}})));const artifact=compiled.contracts['CredentialStatus.sol'].CredentialStatus;const c=await new ethers.ContractFactory(artifact.abi,artifact.evm.bytecode.object,await provider.getSigner()).deploy();await c.waitForDeployment();chain={rpcUrl,contractAddress:await c.getAddress(),rpcNoCache:true};}finally{provider.destroy();}
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
 const measurement=await holder.evaluate(async({issuer,verifier})=>{
 const request=async(base,path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(path+':'+r.status);return v;};
 const local=await new Promise((resolve,reject)=>{const r=indexedDB.open('trustchain-research',1);r.onsuccess=()=>{const d=r.result,t=d.transaction('wallet'),q=t.objectStore('wallet').get('current');q.onsuccess=()=>{resolve(q.result);d.close();};q.onerror=()=>reject(q.error);};r.onerror=()=>reject(r.error);});
 const enc=new TextEncoder(),b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 const payload=JSON.parse(atob(local.credential.body.replace(/-/g,'+').replace(/_/g,'/')));
 const seal=async value=>{const body=b64(enc.encode(JSON.stringify(value))),raw=new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},local.keys.privateKey,enc.encode(body)));const integer=p=>{let i=0;while(i<p.length-1&&p[i]===0)i++;const a=[...p.slice(i)];if(a[0]&128)a.unshift(0);return[2,a.length,...a];};const r=integer(raw.slice(0,32)),s=integer(raw.slice(32));return{body,signature:b64(Uint8Array.from([48,r.length+s.length,...r,...s]))};};
 const samples=[];
 for(let i=-4;i<40;i++){const start=performance.now();try{const c=await request(verifier,'/challenge',{}),challengeDone=performance.now();const presentation={credential:local.credential,proof:await seal({type:'TrustChainResearchPresentation',credentialHash:b64(await crypto.subtle.digest('SHA-256',enc.encode(JSON.stringify(local.credential)))),audience:c.audience,nonce:c.nonce,requestId:c.id})};const signingDone=performance.now();const options=await request(issuer,'/passkeys/authenticate/options',{credentialId:payload.id,action:{type:'presentation',presentation}}),optionsDone=performance.now();const response=(await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON(options.options)})).toJSON(),deviceDone=performance.now();presentation.passkeyAuthorization=(await request(issuer,'/passkeys/authenticate/verify',{id:options.id,response})).authorization;const authDone=performance.now();const result=await request(verifier,'/present',{requestId:c.id,presentation});if(i>=0)samples.push({trial:i,accepted:result.accepted,totalMs:performance.now()-start,challengeMs:challengeDone-start,signingMs:signingDone-challengeDone,authenticationOptionsMs:optionsDone-signingDone,virtualAuthenticatorMs:deviceDone-optionsDone,authenticationVerificationMs:authDone-deviceDone,presentationVerificationMs:performance.now()-authDone});}catch(e){if(i>=0)samples.push({trial:i,accepted:false,error:e.message,totalMs:performance.now()-start});}}
 return {samples,userAgent:navigator.userAgent};
 },{issuer:a.url,verifier:b.url});
 if(process.env.RESULT_PATH)writeFileSync(process.env.RESULT_PATH,JSON.stringify({backend,authentication:'virtual-CTAP2 passkey; issuer-mediated authorization',statusCacheMs:0,network:'loopback; no injected delay',...measurement},null,2));
 assert.equal(measurement.samples.filter(s=>!s.accepted).length,0);
 await negativeChecks();
 await holder.getByRole('button',{name:'Request key rotation'}).click();await holder.getByRole('button',{name:'Check approval'}).waitFor();await approvePending();await checkPresentation();
 const code=await holder.getByLabel('Offline recovery code',{exact:true}).inputValue();assert.ok(code.length>30);
 await holder.getByRole('button',{name:'Simulate lost key'}).click();await holder.getByText('Signing key lost',{exact:true}).waitFor();await holder.reload();await holder.getByText('Signing key lost',{exact:true}).waitFor();
 await holder.getByLabel('Offline recovery code',{exact:true}).fill(code);await holder.getByRole('button',{name:'Request recovery'}).click();await holder.getByRole('button',{name:'Check approval'}).waitFor();await approvePending();await checkPresentation();
 // Recreate the issuer process on the same address; stored passkey and counter must still work.
 await stop(a);
 await verifier.getByRole('button',{name:'Create verification request'}).click();await verifier.waitForFunction(()=>document.querySelector('[role=log] p')?.textContent.startsWith('Fresh request'));
 await holder.getByLabel('Presentation request',{exact:true}).fill(await verifier.getByLabel('Request to share',{exact:true}).inputValue());await holder.getByRole('button',{name:'Create presentation',exact:true}).click();await holder.waitForFunction(()=>document.querySelector('[role=log] p')?.textContent.startsWith('Failed:'));
 if(process.env.RESULT_PATH){const saved=JSON.parse(readFileSync(process.env.RESULT_PATH,'utf8'));saved.freshPresentationDuringIssuerOutage='failed as expected';writeFileSync(process.env.RESULT_PATH,JSON.stringify(saved,null,2));}
 const restartedConfig=JSON.parse(readFileSync(join(dir,'a.json'),'utf8'));restartedConfig.port=Number(new URL(a.url).port);const restarted=await startService(restartedConfig,join(dir,'restart.json'));children.push(restarted);await checkPresentation();
 await admin.reload();await admin.getByLabel('Issuer service',{exact:true}).fill(a.url);await admin.getByLabel('Administrator sign-in key').fill(token);await admin.getByRole('button',{name:'Sign in',exact:true}).click();await admin.getByRole('button',{name:'Refresh requests'}).waitFor();
 await admin.getByRole('button',{name:'Refresh requests'}).click();const active=admin.locator('article').filter({hasText:'Active · Level'});await active.getByRole('button',{name:'Revoke credential'}).click();await active.waitFor({state:'detached'});await holder.getByRole('button',{name:'Create presentation',exact:true}).click();await holder.waitForFunction(()=>document.querySelector('[role=log] p')?.textContent.startsWith('Failed:'));
 await admin.getByRole('button',{name:'Sign out',exact:true}).click();await admin.getByRole('button',{name:'Sign in',exact:true}).waitFor();
 await holder.getByLabel('Offline recovery code',{exact:true}).fill('');
 if(process.env.SCREENSHOT_PATH)await holder.screenshot({path:process.env.SCREENSHOT_PATH,fullPage:true});
 await holder.setViewportSize({width:390,height:844});assert.equal(await holder.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);console.log('Browser PASS: virtual passkey registration and authentication; wrong origin, wrong challenge, unregistered credential and replay rejected; three isolated browser contexts; holder request, admin approval, verifier exchange, rotation, recovery after reload, revocation rejection, sign-out; no admin controls in holder/verifier.');

}finally{await browser?.close();for(const c of children.reverse())await stop(c);rmSync(dir,{recursive:true,force:true});}
