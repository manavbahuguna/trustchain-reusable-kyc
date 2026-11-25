const crypto = require('node:crypto');
function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 20000) throw Error('Invalid encoding');
  const result = Buffer.from(value, 'base64url');
  if (result.toString('base64url') !== value) throw Error('Noncanonical encoding');
  return result;
}
// Narrow ES256 assertion verifier; registration/attestation are outside this helper.
function verifyAssertion(input, { challenge, origin, rpId, publicKey }) {
  const clientBytes = decode(input.clientDataJSON), auth = decode(input.authenticatorData);
  const client = JSON.parse(clientBytes.toString('utf8'));
  if (client.type !== 'webauthn.get' || client.challenge !== challenge.toString('base64url') ||
      client.origin !== origin || (client.crossOrigin !== undefined && client.crossOrigin !== false) || client.topOrigin !== undefined) throw Error('Invalid client context');
  if (auth.length !== 37) throw Error('Unsupported authenticator data');
  if (!crypto.timingSafeEqual(auth.subarray(0, 32), crypto.createHash('sha256').update(rpId).digest())) throw Error('Wrong RP ID');
  const flags = auth[32];
  if ((flags & 5) !== 5 || (flags & 0xc2) !== 0 || ((flags & 16) && !(flags & 8))) throw Error('Invalid authenticator flags');
  if (!Buffer.isBuffer(publicKey) || publicKey.length !== 65 || publicKey[0] !== 4) throw Error('Unsupported public key');
  const der = Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), publicKey]);
  const signed = Buffer.concat([auth, crypto.createHash('sha256').update(clientBytes).digest()]);
  if (!crypto.verify('sha256', signed, { key: der, format: 'der', type: 'spki' }, decode(input.signature))) throw Error('Invalid signature');
  return { signCount: auth.readUInt32BE(33), backupEligible: !!(flags & 8), backedUp: !!(flags & 16) };
}
module.exports = { verifyAssertion };
