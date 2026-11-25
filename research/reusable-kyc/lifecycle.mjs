import { randomBytes, randomUUID, createHash, createPublicKey, timingSafeEqual } from 'node:crypto';
import { open } from './protocol.mjs';
export const hash = text => createHash('sha256').update(text).digest('base64url');
export function publicKey(pem) {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1') throw Error('P-256 key required');
  return key;
}
export class Lifecycle {
  constructor(issuer) { this.issuer = issuer; this.requests = new Map(); }
  token(id) {
    const secret = randomBytes(32).toString('base64url');
    this.issuer.records.get(id).recoveryHash = hash(secret); return secret;
  }
  challenge(id, newPublicKey, mode) {
    if (!['rotate','recover'].includes(mode)) throw Error('Invalid mode');
    const record = this.issuer.records.get(id);
    if (!record?.payload || record.replacementOperation || record.revoked || record.expiresAt <= Date.now()) throw Error('Credential not active');
    publicKey(newPublicKey);
    for (const [key, r] of this.requests) if (r.expiresAt <= Date.now()) this.requests.delete(key);
    if (this.requests.size >= 1000) throw Error('Capacity reached');
    const request = { type:'TrustChainKeyChange', id:randomUUID(), credentialId:id, mode, issuer:this.issuer.id,
      newPublicKey, nonce:randomBytes(32).toString('base64url'), expiresAt:Date.now()+120000 };
    this.requests.set(request.id, request); return request;
  }
  authorize(body) {
    const request = this.requests.get(body.requestId); this.requests.delete(body.requestId);
    if (!request || request.expiresAt <= Date.now()) throw Error('Expired request');
    const record = this.issuer.records.get(request.credentialId);
    if (!record?.payload || record.replacementOperation || record.revoked || record.expiresAt <= Date.now()) throw Error('Credential not active');
    const check = (proof, key) => {
      if (JSON.stringify(open(proof,key)) !== JSON.stringify(request)) throw Error('Wrong key-change binding');
    };
    check(body.newProof, publicKey(request.newPublicKey));
    if (request.mode === 'rotate') check(body.oldProof, record.payload.holderKey);
    else {
      const supplied = Buffer.from(hash(typeof body.recoveryToken === 'string' ? body.recoveryToken : ''));
      const expected = Buffer.from(record.recoveryHash || '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied,expected) || body.simulatedRecoveryApproved !== true) throw Error('Recovery approval and token required');
    }
    return { request, record };
  }
}
