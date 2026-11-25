// server/index.js
// Research backend with in-memory single-use authentication challenges.
// Does not change KYC status after authentication.

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { ethers } = require('ethers');
const { verifyAssertion } = require('./assertion.cjs');
const EXPECTED_ORIGIN = process.env.WEBAUTHN_ORIGIN || 'http://localhost:5173';
const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';

const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }));

// ─── In-memory challenge store (replace with Redis in production) ──────────
// Challenges expire after 2 minutes
const challenges = new Map(); // challengeId → { challenge, did, expiresAt }

function cleanExpired() {
  const now = Date.now();
  for (const [id, v] of challenges) {
    if (v.expiresAt < now) challenges.delete(id);
  }
}
setInterval(cleanExpired, 30000);

// ─── Smart contract client ─────────────────────────────────────────────────
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '';
const RPC_URL = process.env.RPC_URL || 'https://rpc-amoy.polygon.technology';
const SSI_ABI = [
  'function getPublicKey(string did) external view returns (bytes)',
  'function getDIDDocument(string did) external view returns (tuple(string did, bytes publicKey, bytes32 publicKeyHash, uint256 registeredAt, uint256 lastVerifiedAt, bool isActive, uint8 kycLevel, address controller))',
  'function isKYCValid(string did, uint8 requiredLevel) external view returns (bool)',
];

function getContract() {
  return new ethers.Contract(CONTRACT_ADDRESS, SSI_ABI, new ethers.JsonRpcProvider(RPC_URL));
}

// ─── Routes ────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/challenge
 * Generate a challenge for WebAuthn authentication.
 * Body: { did: string }
 */
app.post('/api/auth/challenge', (req, res) => {
  const { did } = req.body;
  if (typeof did !== 'string' || !did || did.length > 1024) return res.status(400).json({ error: 'did is required' });

  cleanExpired();
  if (challenges.size >= 10000) return res.status(503).json({ error: 'Challenge capacity reached' });
  const challengeBytes = crypto.randomBytes(32);
  const challengeId = crypto.randomUUID();
  const expiresAt = Date.now() + 2 * 60 * 1000; // 2 minutes

  challenges.set(challengeId, {
    challenge: challengeBytes,
    did,
    expiresAt,
  });

  res.json({
    challengeId,
    challenge: challengeBytes.toString('base64url'),
    expiresAt,
  });
});

/**
 * POST /api/auth/verify
 * Verify a WebAuthn authentication response.
 * Body: { challengeId, did, authenticatorData, clientDataJSON, signature }
 *
 * Verification steps:
 * 1. Look up challenge by ID (replay protection)
 * 2. Fetch public key from blockchain
 * 3. Reconstruct signed data: authData || SHA256(clientDataJSON)
 * 4. Verify ECDSA P-256 signature
 * 5. Return authentication without changing KYC state
 */
app.post('/api/auth/verify', async (req, res) => {
  const { challengeId, did, authenticatorData, clientDataJSON, signature } = req.body;

  // 1. Challenge lookup
  const stored = challenges.get(challengeId);
  if (!stored) return res.status(400).json({ error: 'Challenge not found or expired' });
  if (stored.did !== did) return res.status(400).json({ error: 'DID mismatch' });
  if (stored.expiresAt <= Date.now()) {
    challenges.delete(challengeId);
    return res.status(400).json({ error: 'Challenge expired' });
  }
  challenges.delete(challengeId); // consume challenge (one-time use)

  try {
    const contract = getContract();
    const doc = await contract.getDIDDocument(did);
    if (!doc.isActive) return res.status(401).json({ error: 'Inactive identity' });
    const result = verifyAssertion(req.body, {
      challenge: stored.challenge, origin: EXPECTED_ORIGIN, rpId: RP_ID,
      publicKey: Buffer.from(doc.publicKey.slice(2), 'hex'),
    });
    // Authentication proves key control, never identity approval or a KYC upgrade.
    res.json({ authenticated: true, verified: true, did, kycLevel: Number(doc.kycLevel),
      kycUpdated: false, signCount: result.signCount, timestamp: Date.now() });
  } catch (err) {
    res.status(401).json({ authenticated: false, error: 'Authentication failed' });
  }
});

/**
 * GET /api/did/:did
 * Fetch a DID document from the blockchain.
 */
app.get('/api/did/:did', async (req, res) => {
  try {
    const contract = getContract();
    const doc = await contract.getDIDDocument(req.params.did);
    res.json({
      did: doc.did,
      publicKeyHash: doc.publicKeyHash,
      registeredAt: Number(doc.registeredAt) * 1000,
      lastVerifiedAt: Number(doc.lastVerifiedAt) * 1000,
      isActive: doc.isActive,
      kycLevel: Number(doc.kycLevel),
      controller: doc.controller,
    });
  } catch (e) {
    res.status(404).json({ error: 'DID not found' });
  }
});

/**
 * GET /api/kyc/:did/:level
 * Check if a DID meets a minimum KYC level.
 */
app.get('/api/kyc/:did/:level', async (req, res) => {
  try {
    const contract = getContract();
    const valid = await contract.isKYCValid(req.params.did, Number(req.params.level));
    res.json({ valid, did: req.params.did, requiredLevel: Number(req.params.level) });
  } catch (e) {
    res.json({ valid: false, error: e.message });
  }
});

/**
 * GET /api/health
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SSI KYC Verification Server',
    contract: CONTRACT_ADDRESS || 'not configured',
    network: RPC_URL,
    timestamp: new Date().toISOString(),
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`SSI KYC Server running on http://localhost:${PORT}`);
  console.log(`Contract: ${CONTRACT_ADDRESS || '⚠ Not configured (set CONTRACT_ADDRESS env)'}`);
  console.log(`Network:  ${RPC_URL}`);
});
