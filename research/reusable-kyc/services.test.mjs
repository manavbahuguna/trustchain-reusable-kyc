import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { keyPair, present } from './protocol.mjs';
const service = new URL('./service.mjs', import.meta.url);
async function start(config, file) {
 writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
 const child = spawn(process.execPath, [service.pathname, file], { stdio: ['ignore','pipe','pipe'] });
 const info = await new Promise((resolve,reject) => {
  const timeout = setTimeout(() => { child.kill(); reject(Error('Startup timeout')); }, 5000);
  child.once('exit', code => { clearTimeout(timeout); reject(Error('Service exited ' + code)); });
  child.stdout.once('data', data => { clearTimeout(timeout); resolve(JSON.parse(data)); });
 });
 return { child, url: 'http://127.0.0.1:' + info.port };
}
async function stop(s) { const done = once(s.child,'exit'); s.child.kill(); await done; }
async function post(url, body, token) {
 const r = await fetch(url, { method:'POST', headers:{'content-type':'application/json', ...(token ? {authorization:'Bearer '+token}: {})}, body:JSON.stringify(body) });
 return { code:r.status, body:await r.json() };
}
test('separate institution processes: approval, binding, replay, persistence, revocation and outage', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'trustchain-test-')); const children=[];
 try {
  const keys=keyPair(), holder=keyPair(), token='test-only-'+ 'x'.repeat(40);
  const privateKeyFile=join(dir,'issuer.pem'), publicKeyFile=join(dir,'issuer.pub');
  writeFileSync(privateKeyFile,keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  writeFileSync(publicKeyFile,keys.publicKey.export({type:'spki',format:'pem'}));
  const config={role:'issuer', id:'a',port:0,privateKeyFile,publicKeyFile,adminToken:token,stateFile:join(dir,'state.json')};
  let a=await start(config,join(dir,'a.json')); children.push(a);
  const b=await start({role:'verifier',id:'b',port:0,trustedIssuers:[{id:'a',publicKeyFile,statusUrl:a.url+'/status'}]},join(dir,'b.json')); children.push(b);
  const issue={holderPublicKey:holder.publicKey.export({type:'spki',format:'pem'}),simulatedIdentityApproved:true};
  assert.equal((await post(a.url+'/issue',issue)).code,401);
  assert.equal((await post(a.url+'/issue',{...issue,simulatedIdentityApproved:false},token)).code,400);
  const issued=await post(a.url+'/issue',issue,token); assert.equal(issued.code,201);
  const credential=issued.body.credential, id=JSON.parse(Buffer.from(credential.body,'base64url')).id;
  async function presentation(key=holder.privateKey) { const r=(await post(b.url+'/challenge',{})).body; return {requestId:r.id,presentation:present(credential,r,key)}; }
  assert.equal((await post(b.url+'/present',await presentation(keyPair().privateKey))).code,400);
  const p=await presentation(); assert.equal((await post(b.url+'/present',p)).body.accepted,true);
  assert.equal((await post(b.url+'/present',p)).code,400);
  assert.equal((await post(a.url+'/revoke',{id})).code,401);
  const port=Number(new URL(a.url).port); await stop(a); children.splice(children.indexOf(a),1);
  assert.equal((await post(b.url+'/present',await presentation())).code,400);
  a=await start({...config,port},join(dir,'a.json')); children.push(a);
  assert.equal((await post(b.url+'/present',await presentation())).body.accepted,true);
  assert.equal((await post(a.url+'/revoke',{id},token)).code,200);
  assert.equal((await post(b.url+'/present',await presentation())).code,400);
  await stop(a); children.splice(children.indexOf(a),1);
  a=await start({...config,port},join(dir,'a.json')); children.push(a);
  assert.equal((await post(b.url+'/present',await presentation())).code,400);
 } finally { for(const child of children) await stop(child); rmSync(dir,{recursive:true,force:true}); }
});
