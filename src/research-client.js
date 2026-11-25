const enc=new TextEncoder();
export const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export const payload=credential=>JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(credential.body.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))));
export async function makeKeys(){return crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);}
export async function pem(key){const data=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('spki',key))));return '-----BEGIN PUBLIC KEY-----\n'+data.match(/.{1,64}/g).join('\n')+'\n-----END PUBLIC KEY-----\n';}
function der(raw){
 const bytes=new Uint8Array(raw);
 const integer=part=>{let i=0;while(i<part.length-1&&part[i]===0)i++;let v=[...part.slice(i)];if(v[0]&128)v.unshift(0);return [2,v.length,...v];};
 const r=integer(bytes.slice(0,32)),s=integer(bytes.slice(32));return Uint8Array.from([48,r.length+s.length,...r,...s]);
}
export async function sealBrowser(value,key){
 const body=b64(enc.encode(JSON.stringify(value)));
 const signature=der(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,enc.encode(body)));
 return {body,signature:b64(signature)};
}
export async function presentBrowser(credential,request,key){
 const credentialHash=b64(await crypto.subtle.digest('SHA-256',enc.encode(JSON.stringify(credential))));
 return {credential,proof:await sealBrowser({type:'TrustChainResearchPresentation',credentialHash,audience:request.audience,nonce:request.nonce,requestId:request.id},key)};
}
export async function api(base,path,body,token){
 const url=new URL(base);if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('Use local research services');
 const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 const result=await r.json();if(!r.ok)throw Error(result.error || 'Request failed');return result;
}
async function db(){return new Promise((resolve,reject)=>{const r=indexedDB.open('trustchain-research',1);r.onupgradeneeded=()=>r.result.createObjectStore('wallet');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
export async function wallet(value){
 const d=await db();try{return await new Promise((resolve,reject)=>{const t=d.transaction('wallet',value===undefined?'readonly':'readwrite');const r=value===undefined?t.objectStore('wallet').get('current'):t.objectStore('wallet').put(value,'current');t.oncomplete=()=>resolve(r.result);t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error);});}finally{d.close();}
}
