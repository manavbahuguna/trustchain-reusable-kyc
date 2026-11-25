const { test } = require('node:test');
const assert = require('node:assert/strict');
const c = require('node:crypto');
const { verifyAssertion } = require('./assertion.cjs');
function fixture(change = {}) {
 const keys = c.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
 const challenge = c.randomBytes(32);
 const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: challenge.toString('base64url'), origin: 'http://localhost:5173', ...change.client }));
 const auth = Buffer.alloc(37); c.createHash('sha256').update(change.rp || 'localhost').digest().copy(auth); auth[32] = change.flags ?? 5;
 const signature = c.sign('sha256', Buffer.concat([auth, c.createHash('sha256').update(client).digest()]), keys.privateKey);
 const input = { clientDataJSON: client.toString('base64url'), authenticatorData: auth.toString('base64url'), signature: signature.toString('base64url') };
 const options = { challenge, origin: 'http://localhost:5173', rpId: 'localhost', publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-65) };
 return { input, options };
}
test('valid signed assertion', () => { const f = fixture(); assert.equal(verifyAssertion(f.input, f.options).signCount, 0); });
for (const [name, change] of Object.entries({ challenge: {client:{challenge:'replay'}}, origin:{client:{origin:'https://attacker.example'}}, type:{client:{type:'webauthn.create'}}, crossOrigin:{client:{crossOrigin:true}}, rp:{rp:'other'}, missingUV:{flags:1}, missingUP:{flags:4}, invalidBackup:{flags:21} })) {
 test('reject signed wrong ' + name, () => { const f = fixture(change); assert.throws(() => verifyAssertion(f.input, f.options)); });
}
test('reject invalid signature', () => { const f = fixture(); f.input.signature = c.randomBytes(70).toString('base64url'); assert.throws(() => verifyAssertion(f.input, f.options)); });
