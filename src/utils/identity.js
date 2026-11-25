// utils/identity.js
// Local identity management — stores credential metadata in localStorage.
// NO biometric data, NO private keys ever stored. Only public key + DID metadata.

const STORAGE_KEY = 'ssi_kyc_identity';
const CREDENTIAL_KEY = 'ssi_kyc_credentials';

/**
 * Save identity metadata to localStorage (public data only).
 * @param {Object} identity - { did, credentialId, publicKeyBase64, username, displayName, ... }
 */
export function saveIdentity(identity) {
  const safe = {
    did: identity.did,
    credentialId: identity.credentialIdBase64,
    publicKeyHash: identity.publicKeyHash || null,
    username: identity.username,
    displayName: identity.displayName || identity.username,
    createdAt: identity.timestamp || Date.now(),
    onChain: identity.onChain || false,
    txHash: identity.txHash || null,
    kycLevel: identity.kycLevel || 0,
    // NEVER store: private keys, biometric data, raw authenticator data
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
  return safe;
}

/**
 * Load stored identity.
 */
export function loadIdentity() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Update identity fields (e.g. after on-chain registration).
 */
export function updateIdentity(updates) {
  const identity = loadIdentity() || {};
  const updated = { ...identity, ...updates };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  return updated;
}

/**
 * Clear local identity (deregister from device).
 */
export function clearIdentity() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(CREDENTIAL_KEY);
}

/**
 * Save a verifiable credential.
 */
export function saveCredential(credential) {
  const existing = loadCredentials();
  existing.push({
    ...credential,
    savedAt: Date.now(),
  });
  localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(existing));
}

/**
 * Load all saved credentials.
 */
export function loadCredentials() {
  try {
    return JSON.parse(localStorage.getItem(CREDENTIAL_KEY) || '[]');
  } catch {
    return [];
  }
}

/**
 * Format DID for display (truncate middle).
 */
export function formatDID(did, length = 24) {
  if (!did || did.length <= length) return did;
  const prefix = did.slice(0, 14);
  const suffix = did.slice(-8);
  return `${prefix}...${suffix}`;
}

/**
 * Format a hex address for display.
 */
export function formatAddress(addr) {
  if (!addr) return '';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/**
 * Build a DID document for display.
 */
export function buildDIDDocument(identity) {
  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/jws-2020/v1',
    ],
    id: identity.did,
    controller: identity.did,
    verificationMethod: [{
      id: `${identity.did}#key-1`,
      type: 'JsonWebKey2020',
      controller: identity.did,
      publicKeyJwk: {
        kty: 'EC',
        crv: 'P-256',
        use: 'sig',
        note: 'Public key hash: ' + (identity.publicKeyHash || 'pending'),
      },
    }],
    authentication: [`${identity.did}#key-1`],
    assertionMethod: [`${identity.did}#key-1`],
    created: new Date(identity.createdAt).toISOString(),
    updated: new Date().toISOString(),
  };
}

/**
 * Privacy audit log — what data is stored vs not stored.
 */
export const PRIVACY_GUARANTEES = [
  { item: 'Biometric data (fingerprint, face, iris)', stored: false, location: 'Never leaves your device secure enclave' },
  { item: 'Private key', stored: false, location: 'Stored in device hardware (TPM/Secure Enclave), never exported' },
  { item: 'Public key', stored: true, location: 'On blockchain (hash) + locally (bytes)' },
  { item: 'Decentralized Identifier (DID)', stored: true, location: 'On blockchain (mapping) + locally' },
  { item: 'KYC level', stored: true, location: 'On blockchain (immutable audit trail)' },
  { item: 'Credential metadata', stored: true, location: 'On blockchain + locally (no biometric link)' },
  { item: 'Challenge nonces (used)', stored: true, location: 'On blockchain (replay prevention)' },
  { item: 'IP address / device fingerprint', stored: false, location: 'Not collected' },
  { item: 'Raw attestation object', stored: false, location: 'Discarded after key extraction' },
];
