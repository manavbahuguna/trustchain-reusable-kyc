import test from 'node:test';
import assert from 'node:assert/strict';
import { Issuer, Verifier, keyPair, present, seal } from './protocol.mjs';
function setup() {
  let time = 1000000;
  const now = () => time;
  const issuer = new Issuer('a', keyPair(), now), holder = keyPair();
  const trust = { publicKey: issuer.keys.publicKey, status: (id, nonce) => issuer.status(id, nonce) };
  const verifier = new Verifier('b', new Map([['a', trust]]), now);
  const credential = issuer.issue(holder.publicKey, { simulatedIdentityApproved: true });
  return { issuer, holder, trust, verifier, credential, advance: ms => { time += ms; } };
}
for (const scenario of ['valid', 'replay', 'wrong holder', 'wrong audience', 'wrong nonce', 'tampered credential', 'expired credential', 'expired challenge', 'revoked', 'untrusted issuer', 'status outage', 'forged status', 'stale status replay', 'insufficient level', 'issuer removed']) {
 test(scenario, async () => {
  const s = setup(), r = s.verifier.challenge(scenario === 'insufficient level' ? 2 : 1);
  let p = present(s.credential, r, s.holder.privateKey);
  const id = JSON.parse(Buffer.from(s.credential.body, 'base64url')).id;
  if (scenario === 'wrong holder') p = present(s.credential, r, keyPair().privateKey);
  if (scenario === 'wrong audience') p = present(s.credential, { ...r, audience: 'c' }, s.holder.privateKey);
  if (scenario === 'wrong nonce') p = present(s.credential, { ...r, nonce: 'other' }, s.holder.privateKey);
  if (scenario === 'tampered credential') p.credential = { ...s.credential, body: Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(s.credential.body, 'base64url')), level: 3 })).toString('base64url') };
  if (scenario === 'expired credential') s.advance(60001);
  if (scenario === 'expired challenge') s.advance(120001);
  if (scenario === 'revoked') s.issuer.revoke(id);
  if (scenario === 'untrusted issuer') { const rogue = new Issuer('rogue'); p = present(rogue.issue(s.holder.publicKey, { simulatedIdentityApproved: true }), r, s.holder.privateKey); }
  if (scenario === 'issuer removed') s.verifier.trustedIssuers.delete('a');
  if (scenario === 'status outage') s.trust.status = () => { throw Error('Unavailable'); };
  if (scenario === 'forged status') s.trust.status = (_, nonce) => seal({ id, nonce, revoked: false }, keyPair().privateKey);
  if (scenario === 'stale status replay') { const old = s.issuer.status(id, 'old-nonce'); s.trust.status = () => old; }
  if (scenario === 'valid' || scenario === 'replay') {
    assert.equal((await s.verifier.accept(r.id, p)).accepted, true);
    if (scenario === 'replay') await assert.rejects(s.verifier.accept(r.id, p));
  } else await assert.rejects(s.verifier.accept(r.id, p));
 });
}
test('authentication does not substitute for explicit issuance approval', () => {
 const s = setup(); assert.throws(() => s.issuer.issue(s.holder.publicKey));
});
test('concurrent presentation allows at most one acceptance', async () => {
 const s = setup(), r = s.verifier.challenge(), p = present(s.credential, r, s.holder.privateKey);
 const results = await Promise.allSettled([s.verifier.accept(r.id, p), s.verifier.accept(r.id, p)]);
 assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
});
