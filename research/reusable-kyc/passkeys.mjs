import {randomBytes, createHash} from 'node:crypto';
import {generateRegistrationOptions,verifyRegistrationResponse,generateAuthenticationOptions,verifyAuthenticationResponse} from '@simplewebauthn/server';
import {open,seal} from './protocol.mjs';
export const hashAction=value=>createHash('sha256').update(JSON.stringify(value)).digest('base64url');
export class Passkeys {
 constructor(issuer,origin,persist,now=Date.now){this.issuer=issuer;this.origin=origin;this.rpID=new URL(origin).hostname;this.persist=persist;this.now=now;this.pending=new Map();}
 put(value){for(const[k,v]of this.pending)if(v.expiresAt<=this.now())this.pending.delete(k);if(this.pending.size>=1000)throw Error('Passkey capacity reached');const id=randomBytes(32).toString('base64url');this.pending.set(id,{...value,expiresAt:this.now()+120000});return id;}
 take(id,kind){const x=this.pending.get(id);this.pending.delete(id);if(!x||x.kind!==kind||x.expiresAt<=this.now())throw Error('Invalid or expired passkey request');return x;}
 active(id){const r=this.issuer.records.get(id);if(!r||r.revoked||r.expiresAt<=this.now()||!r.passkey)throw Error('No active passkey');return r;}
 async registration(holderPublicKey){
  const options=await generateRegistrationOptions({rpName:'TrustChain',rpID:this.rpID,userName:randomBytes(16).toString('hex'),attestationType:'none',authenticatorSelection:{residentKey:'required',userVerification:'required'}});
  return {id:this.put({kind:'registration',holderPublicKey,challenge:options.challenge}),options};
 }
 async register({id,response,proof}){const x=this.take(id,'registration');const p=open(proof,x.holderPublicKey);if(p.id!==id||p.challenge!==x.challenge)throw Error('Holder binding mismatch');
  const v=await verifyRegistrationResponse({response,expectedChallenge:x.challenge,expectedOrigin:this.origin,expectedRPID:this.rpID,requireUserVerification:true});if(!v.verified)throw Error('Registration failed');
  const c=v.registrationInfo.credential;
  return {ticket:this.put({kind:'enrollment',holderPublicKey:x.holderPublicKey,passkey:{...c,publicKey:Buffer.from(c.publicKey).toString('base64url')}})};
 }
 enrollment(ticket,key){const x=this.take(ticket,'enrollment');if(x.holderPublicKey!==key)throw Error('Enrollment key mismatch');return x.passkey;}
 async authentication(id,action){const r=this.active(id);if(!action||!['presentation','rotate'].includes(action.type))throw Error('Invalid action');const options=await generateAuthenticationOptions({rpID:this.rpID,allowCredentials:[{id:r.passkey.id}],userVerification:'required'});return {id:this.put({kind:'authentication',credentialId:id,action,challenge:options.challenge}),options};}
 async authenticate({id,response}){const x=this.take(id,'authentication'),r=this.active(x.credentialId);if(response.id!==r.passkey.id)throw Error('Unregistered authenticator');
 const v=await verifyAuthenticationResponse({response,expectedChallenge:x.challenge,expectedOrigin:this.origin,expectedRPID:this.rpID,credential:{...r.passkey,publicKey:new Uint8Array(Buffer.from(r.passkey.publicKey,'base64url'))},requireUserVerification:true});if(!v.verified)throw Error('Authentication failed');
 r.passkey.counter=v.authenticationInfo.newCounter;this.persist();
 return {authorization:seal({type:'TrustChainPasskeyAuthorization',credentialId:x.credentialId,actionHash:hashAction(x.action),issuedAt:this.now(),expiresAt:this.now()+60000},this.issuer.keys.privateKey)};
 }
 authorize(id,action,envelope){const p=open(envelope,this.issuer.keys.publicKey);if(p.type!=='TrustChainPasskeyAuthorization'||p.credentialId!==id||p.actionHash!==hashAction(action)||!Number.isFinite(p.expiresAt)||p.expiresAt<=this.now())throw Error('Passkey authorization required');}
}
