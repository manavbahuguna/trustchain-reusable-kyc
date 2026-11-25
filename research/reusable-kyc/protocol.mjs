import { generateKeyPairSync, sign, verify, randomBytes, randomUUID, createHash } from 'node:crypto';
export const keyPair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('base64url');
export function seal(payload, key) {
  const body = encode(payload);
  return { body, signature: sign('sha256', Buffer.from(body), key).toString('base64url') };
}
export function open(envelope, key) {
  if (!envelope || typeof envelope.body !== 'string' || typeof envelope.signature !== 'string' ||
      !verify('sha256', Buffer.from(envelope.body), key, Buffer.from(envelope.signature, 'base64url'))) throw Error('Invalid signature');
  return JSON.parse(Buffer.from(envelope.body, 'base64url').toString());
}
export class Issuer {
  constructor(id, keys = keyPair(), now = Date.now) {
    this.id = id; this.keys = keys; this.now = now; this.records = new Map();
  }
  issue(holderPublicKey, { simulatedIdentityApproved = false, ttlMs = 60000, level = 1, passkeyRequired = false } = {}) {
    if (!simulatedIdentityApproved) throw Error('Explicit simulated identity approval required');
    if (!Number.isInteger(level) || level < 1 || level > 3 || !Number.isFinite(ttlMs) || ttlMs <= 0) throw Error('Invalid issuance policy');
    const payload = { type: 'TrustChainResearchCredential', version: 1, id: randomUUID(), issuer: this.id,
      holderKey: holderPublicKey.export({ type: 'spki', format: 'pem' }).toString(),
      statusIndex:this.records.size, level, issuedAt: this.now(), expiresAt: this.now() + ttlMs, evidence: 'SIMULATED_IDENTITY_CHECK', ...(passkeyRequired?{passkeyRequired:true}:{}) };
    this.records.set(payload.id, { revoked: false, expiresAt: payload.expiresAt, payload });
    return seal(payload, this.keys.privateKey);
  }
  status(id, nonce) {
    const record = this.records.get(id);
    if (!record) throw Error('Unknown credential');
    return seal({ type: 'TrustChainResearchStatus', issuer: this.id, id, nonce, revoked: record.revoked, checkedAt: this.now() }, this.keys.privateKey);
  }
  revoke(id) {
    const record = this.records.get(id);
    if (!record) throw Error('Unknown credential');
    record.revoked = true;
  }
}
export function present(credential, request, holderPrivateKey) {
  return { credential, proof: seal({ type: 'TrustChainResearchPresentation', credentialHash: digest(JSON.stringify(credential)),
    audience: request.audience, nonce: request.nonce, requestId: request.id }, holderPrivateKey) };
}
export class Verifier {
  constructor(id, trustedIssuers, now = Date.now) {
    this.id = id; this.trustedIssuers = trustedIssuers; this.now = now; this.requests = new Map(); this.statusCache = new Map();
  }
  challenge(requiredLevel = 1) {
    if (!Number.isInteger(requiredLevel) || requiredLevel < 1 || requiredLevel > 3) throw Error('Invalid required level');
    const request = { id: randomUUID(), audience: this.id, nonce: randomBytes(32).toString('base64url'), expiresAt: this.now() + 120000, requiredLevel };
    for (const [id, r] of this.requests) if (r.expiresAt <= this.now()) this.requests.delete(id);
    this.requests.set(request.id, request); return { ...request };
  }
  async accept(requestId, presentation) {
    const request = this.requests.get(requestId);
    if (!request || request.expiresAt <= this.now()) throw Error('Missing, consumed or expired challenge');
    this.requests.delete(requestId); // Atomic consumption before asynchronous status lookup.
    const untrusted = JSON.parse(Buffer.from(presentation.credential.body, 'base64url').toString());
    const trusted = this.trustedIssuers.get(untrusted.issuer);
    if (!trusted) throw Error('Untrusted issuer');
    const credential = open(presentation.credential, trusted.publicKey);
    if (credential.type !== 'TrustChainResearchCredential' || credential.version !== 1 ||
        !Number.isFinite(credential.issuedAt) || credential.issuedAt > this.now() ||
        !Number.isFinite(credential.expiresAt) || credential.expiresAt <= this.now() ||
        !Number.isInteger(credential.level) || credential.level < request.requiredLevel || credential.level > 3) throw Error('Invalid or expired credential');
    const proof = open(presentation.proof, credential.holderKey);
    if (proof.type !== 'TrustChainResearchPresentation' || proof.audience !== this.id || proof.nonce !== request.nonce ||
        proof.requestId !== request.id || proof.credentialHash !== digest(JSON.stringify(presentation.credential))) throw Error('Presentation binding mismatch');
    if(credential.passkeyRequired){
      const a=open(presentation.passkeyAuthorization,trusted.publicKey);
      const actionHash=digest(JSON.stringify({type:'presentation',presentation:{credential:presentation.credential,proof:presentation.proof}}));
      if(a.type!=='TrustChainPasskeyAuthorization'||a.credentialId!==credential.id||a.actionHash!==actionHash||!Number.isFinite(a.issuedAt)||a.issuedAt>this.now()||!Number.isFinite(a.expiresAt)||a.expiresAt<=this.now()||a.expiresAt-a.issuedAt>60000)throw Error('Passkey authorization required');
    }
    const ttl = trusted.statusCacheMs ?? 0;
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > 60000) throw Error('Invalid status cache policy');
    const cacheKey = JSON.stringify([credential.issuer, credential.id]);
    const cached = this.statusCache.get(cacheKey);
    const hit = cached && cached.trust === trusted && cached.key === trusted.publicKey && cached.until > this.now();
    const checkedFrom = this.now();
    if (!hit) {
    this.statusCache.delete(cacheKey);
    if (trusted.checkStatus) {
      // A separately configured chain adapter checks authoritative contract state.
      await trusted.checkStatus(credential.id,credential);
    } else {
      const statusNonce = randomBytes(32).toString('base64url');
      const status = open(await trusted.status(credential.id, statusNonce), trusted.publicKey);
      if (status.type !== 'TrustChainResearchStatus' || status.issuer !== credential.issuer || status.id !== credential.id ||
          status.nonce !== statusNonce || !Number.isFinite(status.checkedAt) || status.checkedAt > this.now() ||
          this.now() - status.checkedAt > 30000 || status.revoked !== false) throw Error('Revoked or invalid status');
    }
    if (ttl > 0) {
      for (const [key, value] of this.statusCache) if (value.until <= this.now()) this.statusCache.delete(key);
      if (this.statusCache.size >= 10000) this.statusCache.delete(this.statusCache.keys().next().value);
      this.statusCache.set(cacheKey, {trust: trusted, key: trusted.publicKey, until: Math.min(checkedFrom + ttl, credential.expiresAt)});
    }
    }
    if (request.expiresAt <= this.now() || credential.expiresAt <= this.now()) throw Error('Expired during verification');
    return { accepted: true, issuer: credential.issuer, level: credential.level, evidence: credential.evidence };
  }
}
