import { Issuer, Verifier, keyPair, present } from './protocol.mjs';
const institutionA = new Issuer('institution-a');
const holder = keyPair();
const institutionB = new Verifier('institution-b', new Map([['institution-a', {
  publicKey: institutionA.keys.publicKey,
  status: (id, nonce) => institutionA.status(id, nonce),
}]]));
const credential = institutionA.issue(holder.publicKey, { simulatedIdentityApproved: true });
let request = institutionB.challenge();
console.log('Before revocation:', await institutionB.accept(request.id, present(credential, request, holder.privateKey)));
institutionA.revoke(JSON.parse(Buffer.from(credential.body, 'base64url')).id);
request = institutionB.challenge();
try { await institutionB.accept(request.id, present(credential, request, holder.privateKey)); }
catch (error) { console.log('After revocation: REJECTED —', error.message); }
