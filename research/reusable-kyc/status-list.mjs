import {gzipSync,gunzipSync} from 'node:zlib';
import {seal,open} from './protocol.mjs';
// Research envelope, not a W3C-conformant BitstringStatusListCredential.
export function statusList(issuer,now=Date.now()){
 const bits=Buffer.alloc(16384),count=issuer.records.size;
 if(count>131072)throw Error('List capacity exceeded');
 for(const r of issuer.records.values()){const i=r.payload.statusIndex;if(!Number.isInteger(i)||i<0||i>=count)throw Error('Legacy credential needs reissuance');if(r.revoked)bits[i>>3]|=1<<(i%8);}
 return seal({type:'TrustChainResearchStatusList',issuer:issuer.id,issuedAt:now,expiresAt:now+60000,count,bits:gzipSync(bits).toString('base64url')},issuer.keys.privateKey);
}
export function listReader({issuer,publicKey,url,cacheMs=0,now=Date.now,fetchList}){
 if(!Number.isInteger(cacheMs)||cacheMs<0||cacheMs>60000)throw Error('Invalid list cache policy');
 let cached,inflight;
 async function refresh(){const start=now();const envelope=await fetchList();const p=open(envelope,publicKey);
 if(p.type!=='TrustChainResearchStatusList'||p.issuer!==issuer||!Number.isFinite(p.issuedAt)||p.issuedAt>now()||!Number.isFinite(p.expiresAt)||p.expiresAt<=now()||p.expiresAt-p.issuedAt>60000||now()-p.issuedAt>(cacheMs||60000)||!Number.isInteger(p.count)||p.count<0||p.count>131072)throw Error('Invalid list');
 const bits=gunzipSync(Buffer.from(p.bits,'base64url'),{maxOutputLength:16384});if(bits.length!==16384)throw Error('Invalid list size');
 cached={...p,bits,until:Math.min(start+cacheMs,p.issuedAt+cacheMs,p.expiresAt)};return cached;
 }
 return async(id,credential)=>{if(credential.issuer!==issuer||!Number.isInteger(credential.statusIndex)||credential.statusIndex<0)throw Error('Invalid status index');
 const list=cached&&cached.until>now()?cached:await(inflight||=(refresh().finally(()=>{inflight=null;})));
 const i=credential.statusIndex;if(i>=list.count||(list.bits[i>>3]&(1<<(i%8))))throw Error('Unknown or revoked list credential');
 };
}
