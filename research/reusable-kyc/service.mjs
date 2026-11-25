import http from 'node:http';
import {statusList,listReader} from './status-list.mjs';
import {reconcile} from './reconcile.mjs';
import {Storage} from './storage.mjs';
import {Passkeys} from './passkeys.mjs';
import { readFileSync } from 'node:fs';
import { createPublicKey, createPrivateKey, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Issuer, Verifier } from './protocol.mjs';
import { Lifecycle, publicKey } from './lifecycle.mjs';
import {ApprovalQueue, AdminSessions} from './approvals.mjs';

export function createService(config) {
  const issuer = config.role === 'issuer' ? new Issuer(config.id, {
    privateKey:createPrivateKey(readFileSync(config.privateKeyFile)), publicKey:createPublicKey(readFileSync(config.publicKeyFile)),
  }) : null;
  if (issuer && (!config.adminToken || config.adminToken.length < 32 || (!config.stateFile&&!config.databaseFile))) throw Error('Issuer needs credentials and storage');
  const approvals=issuer ? new ApprovalQueue() : null;
  const storage=issuer ? new Storage(config.databaseFile || config.stateFile+'.sqlite',issuer.keys.privateKey.export({type:'pkcs8',format:'der'}),config.stateFile) : null;
  function restore(){const data=storage.load();issuer.records=data.records;approvals.items=data.applications;}
  if(storage){restore();let interrupted=false;for(const item of approvals.items.values())if(item.status==='processing'){item.status='needs-review';interrupted=true;}if(interrupted)storage.save(issuer.records,approvals.items,'interrupted-chain-approval');}
  const sessions=issuer ? new AdminSessions(config.adminToken) : null;
  let unhealthy=false, mutating=false;
  function flush(event) {try{storage.save(issuer.records,approvals.items,event);}catch(e){unhealthy=true;throw e;}}
  function persist() {if(config.chain)flush('chain-checkpoint');}
  const passkeys=issuer ? new Passkeys(issuer,config.browserOrigin || 'http://localhost:5173',persist) : null;
  let adapterPromise;
  const adapter = () => adapterPromise ||= import('./chain.mjs').then(m => m.chainAdapter(config.chain,true)).catch(e=>{adapterPromise=null;throw e;});
  const lifecycle=issuer ? new Lifecycle(issuer) : null;
  const recover=item=>{const binding=JSON.stringify([config.chain.rpcUrl,config.chain.contractAddress.toLowerCase(),config.chain.account||0]);if(item.chainBinding&&item.chainBinding!==binding)throw Error('Chain configuration changed');item.chainBinding=binding;return reconcile(item,{issuer,lifecycle,adapter,save:flush});};
  const chainReaders=[];
  const trust=new Map((config.trustedIssuers || []).map(t => {
    let readPromise;
    const entry={ publicKey:createPublicKey(readFileSync(t.publicKeyFile)), statusCacheMs:t.statusCacheMs ?? 0 };
    if(t.statusListUrl) {entry.statusCacheMs=0;entry.checkStatus=listReader({issuer:t.id,publicKey:entry.publicKey,cacheMs:t.statusCacheMs??0,fetchList:async()=>{const r=await fetch(t.statusListUrl,{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(3000),redirect:'error'});if(!r.ok)throw Error('List unavailable');const text=await r.text();if(text.length>65536)throw Error('List too large');return JSON.parse(text);}});}
    else if(t.chain) entry.checkStatus=async id => {
      readPromise ||= import('./chain.mjs').then(m=>m.chainAdapter(t.chain));
      const reader=await readPromise; if(!chainReaders.includes(reader)) chainReaders.push(reader);
      await reader.checkStatus(id);
    };
    else entry.status=async (id,nonce) => {
      const r=await fetch(t.statusUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,nonce}),signal:AbortSignal.timeout(3000),redirect:'error'});
      if(!r.ok) throw Error('Status unavailable');
      const text=await r.text(); if(text.length>65536) throw Error('Status too large'); return JSON.parse(text);
    };
    return [t.id,entry];
  }));
  const verifier=config.role==='verifier' ? new Verifier(config.id,trust) : null;
  if(!issuer && !verifier) throw Error('Unknown role');
  async function issue(key, options, passkey) {
    const credential=issuer.issue(key,{...options,passkeyRequired:!!passkey});
    const id=JSON.parse(Buffer.from(credential.body,'base64url')).id;
    if(passkey)issuer.records.get(id).passkey=passkey;
    let gasUsed;
    try { if(config.chain) gasUsed=await (await adapter()).register(id); }
    catch(e) { issuer.records.delete(id); throw e; }
    const recoveryToken=lifecycle.token(id); persist();
    return {credential,recoveryToken,gasUsed};
  }
  async function revoke(id) {
    const gasUsed=config.chain ? await (await adapter()).revoke(id) : undefined;
    issuer.revoke(id); persist(); return gasUsed;
  }
  const server=http.createServer(async(req,res)=>{
    const origin=req.headers.origin, allowed=config.browserOrigin || 'http://localhost:5173';
    if(origin && origin!==allowed) { res.writeHead(403); return res.end(); }
    if(origin) { res.setHeader('Access-Control-Allow-Origin',allowed); res.setHeader('Vary','Origin'); }
    if(req.method==='OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers','content-type,authorization'); res.setHeader('Access-Control-Allow-Methods','POST,GET,OPTIONS'); res.writeHead(204); return res.end();
    }
    let ownsLock=false;
    const send=(code,body)=>{if(ownsLock && code<400 && ['/issue','/revoke','/key-change','/applications/issue','/applications/key-change','/admin/approve','/admin/reject','/passkeys/authenticate/verify'].includes(req.url))flush(req.url);res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
    if(req.method==='GET' && req.url==='/health') return send(unhealthy?503:200,{role:config.role,id:config.id,researchOnly:true,statusBackend:config.chain || config.trustedIssuers?.some(t=>t.chain)?'local-chain':'signed-status'});
    if(req.method!=='POST') return send(404,{error:'Not found'});
    if(unhealthy) return send(503,{error:'Storage failure; repair storage before restarting'});
    try {
      const adminRoute=issuer && req.url.startsWith('/admin/') && req.url!=='/admin/session';
      const privileged=issuer && (['/issue','/revoke','/key-change'].includes(req.url) || adminRoute);
      if(privileged) {
        const actual=Buffer.from(req.headers.authorization || ''), expected=Buffer.from('Bearer '+config.adminToken);
        const bearer=(req.headers.authorization||'').replace(/^Bearer /,'');
        const authorized=adminRoute ? sessions.authorized(bearer) : (sessions.authorized(bearer) || (actual.length===expected.length && timingSafeEqual(actual,expected)));
        if(!authorized) return send(401,{error:'Unauthorized'});
        if(mutating) return send(409,{error:'Another issuer operation is in progress'});
        mutating=true; ownsLock=true;
      }
      if(issuer && !ownsLock) {if(mutating)return send(409,{error:'Issuer busy'});mutating=true;ownsLock=true;}
      let size=0;const parts=[];
      for await(const part of req) { size+=part.length;if(size>65536) return send(413,{error:'Request too large'});parts.push(part); }
      const body=JSON.parse(Buffer.concat(parts).toString());
      if(!body || typeof body!=='object' || Array.isArray(body)) throw Error('Invalid request');
      if(issuer && req.url==='/passkeys/register/options') return send(200,await passkeys.registration(publicKey(body.holderPublicKey).export({type:'spki',format:'pem'}).toString()));
      if(issuer && req.url==='/passkeys/register/verify') return send(200,await passkeys.register(body));
      if(issuer && req.url==='/passkeys/authenticate/options') return send(200,await passkeys.authentication(body.credentialId,body.action));
      if(issuer && req.url==='/passkeys/authenticate/verify') return send(200,await passkeys.authenticate(body));
      if(issuer && req.url==='/admin/session') {
        try{return send(200,sessions.login(body.token));}catch{return send(401,{error:'Invalid administrator credentials'});}
      }
      if(issuer && req.url==='/admin/logout') {sessions.logout((req.headers.authorization||'').replace(/^Bearer /,''));return send(200,{signedOut:true});}
      if(issuer && req.url==='/admin/applications') return send(200,{applications:approvals.list()});
      if(issuer && req.url==='/admin/credentials') return send(200,{credentials:[...issuer.records.entries()].map(([id,r])=>({id,revoked:r.revoked,expiresAt:r.expiresAt,level:r.payload?.level}))});
      if(issuer && req.url==='/applications/issue') {
        if(!body.enrollmentTicket && config.allowLegacyApplications!==true)throw Error('Passkey enrollment required');
        const key=publicKey(body.holderPublicKey);
        const normalized=key.export({type:'spki',format:'pem'}).toString();
        return send(201,approvals.create('issue',{holderPublicKey:normalized,passkey:body.enrollmentTicket?passkeys.enrollment(body.enrollmentTicket,normalized):undefined},{holderPublicKey:normalized}));
      }
      if(issuer && req.url==='/applications/key-change') {
        // Verify key possession/recovery secret now; final approval comes ONLY from admin route.
        const {request,record}=lifecycle.authorize({...body,simulatedRecoveryApproved:true});
        if(record.passkey && request.mode==='rotate')passkeys.authorize(request.credentialId,{type:'rotate',request},body.passkeyAuthorization);
        const replacementPasskey=body.enrollmentTicket?passkeys.enrollment(body.enrollmentTicket,request.newPublicKey):undefined;
        if(record.passkey&&!replacementPasskey)throw Error('Replacement passkey required');
        return send(201,approvals.create(request.mode,{request,passkey:replacementPasskey},{credentialId:request.credentialId,newPublicKey:request.newPublicKey,level:record.payload.level}));
      }
      if(issuer && req.url==='/applications/collect') return send(200,approvals.collect(body.id,body.accessToken));
      if(issuer && req.url==='/admin/reconcile'){const item=approvals.get(body.id);if(!config.chain||!item.chainPlan||item.status!=='needs-review')throw Error('No recoverable operation');return send(200,await recover(item));}
      if(issuer && req.url==='/admin/reject') return send(200,approvals.reject(body.id));
      if(issuer && req.url==='/admin/approve') {
        if(body.simulatedIdentityApproved!==true) throw Error('Explicit approval required');
        const result=await approvals.approve(body.id,async item=>{
          if(config.chain){await recover(item);return item.result;}
          if(item.kind==='issue') return issue(publicKey(item.operation.holderPublicKey),{simulatedIdentityApproved:true,level:1,ttlMs:86400000},item.operation.passkey);
          const request=item.operation.request,record=issuer.records.get(request.credentialId);
          if(!record?.payload || record.revoked || record.expiresAt<=Date.now())throw Error('Credential no longer active');
          await revoke(request.credentialId);
          return issue(publicKey(request.newPublicKey),{simulatedIdentityApproved:true,level:record.payload.level,ttlMs:record.expiresAt-Date.now()},item.operation.passkey);
        });
        return send(200,result);
      }
      if(issuer && req.url==='/issue') return send(201,await issue(publicKey(body.holderPublicKey),body));
      if(issuer && req.url==='/revoke') {const gasUsed=await revoke(body.id);return send(200,{revoked:true,gasUsed});}
      if(issuer && req.url==='/key-change/challenge') return send(200,lifecycle.challenge(body.id,body.newPublicKey,body.mode));
      if(issuer && req.url==='/key-change') {
        const {request,record}=lifecycle.authorize(body);
        if(record.passkey)throw Error('Passkey credentials require the approval workflow');
        // Invalidate first: an interrupted replacement never leaves two active credentials.
        await revoke(request.credentialId);
        const replacement=await issue(publicKey(request.newPublicKey),{simulatedIdentityApproved:true,level:record.payload.level,ttlMs:record.expiresAt-Date.now()});
        return send(201,{...replacement,replaces:request.credentialId,mode:request.mode});
      }
      if(issuer && req.url==='/status-list')return send(200,statusList(issuer));
      if(issuer && req.url==='/status') {
        if(config.chain) return send(404,{error:'Use the configured contract status provider'});
        if(typeof body.nonce!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(body.nonce)) throw Error('Invalid nonce');
        return send(200,issuer.status(body.id,body.nonce));
      }
      if(verifier && req.url==='/challenge') {
        for(const [id,r] of verifier.requests) if(r.expiresAt<=Date.now()) verifier.requests.delete(id);
        if(verifier.requests.size>=10000) return send(503,{error:'Capacity reached'});
        return send(200,verifier.challenge(body.requiredLevel));
      }
      if(verifier && req.url==='/present') return send(200,await verifier.accept(body.requestId,body.presentation));
      return send(404,{error:'Not found'});
    } catch {if(ownsLock){try{if(config.chain)flush('chain-operation-failed');else restore();}catch{unhealthy=true;}}return send(unhealthy?503:400,{accepted:false,error:req.url==='/key-change'?'Request rejected; an interrupted replacement may require issuer review':'Request rejected'});}
    finally {if(ownsLock) mutating=false;}
  });
  server.recoveryReady=(async()=>{if(!config.chain)return;mutating=true;try{for(const item of approvals.items.values())if(item.chainPlan&&item.status==='needs-review'){try{await recover(item);}catch{if(unhealthy)break;}}}finally{mutating=false;}})();
  server.requestTimeout=10000;server.headersTimeout=10000;
  server.on('close',()=>{storage?.close();for(const reader of chainReaders)reader.close();if(adapterPromise)adapterPromise.then(a=>a.close()).catch(()=>{});});
  return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
  const server=createService(config);
  await server.recoveryReady;
  server.listen(config.port,'127.0.0.1',()=>console.log(JSON.stringify({ready:true,role:config.role,port:server.address().port})));
  process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
}
