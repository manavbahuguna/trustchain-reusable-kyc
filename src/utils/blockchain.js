// utils/blockchain.js
// Smart contract interaction layer using ethers.js v6

// ─── ABI (minimal, generated from SSIRegistry.sol) ────────────────────────────

export const SSI_REGISTRY_ABI = [
  "function registerDID(string did, bytes publicKey) external",
  "function updatePublicKey(string did, bytes newPublicKey) external",
  "function revokeDID(string did) external",
  "function recordVerification(string did, bytes32 challenge, uint8 newKycLevel) external",
  "function issueCredential(string did, string credentialType, uint256 expiresAt, bytes32 credentialHash) external returns (bytes32)",
  "function revokeCredential(bytes32 credentialId) external",
  "function authorizeInstitution(address institution, string name) external",
  "function getDIDDocument(string did) external view returns (tuple(string did, bytes publicKey, bytes32 publicKeyHash, uint256 registeredAt, uint256 lastVerifiedAt, bool isActive, uint8 kycLevel, address controller))",
  "function getPublicKey(string did) external view returns (bytes)",
  "function getPublicKeyHash(string did) external view returns (bytes32)",
  "function getKYCLevel(string did) external view returns (uint8)",
  "function isKYCValid(string did, uint8 requiredLevel) external view returns (bool)",
  "function getDIDCredentials(string did) external view returns (bytes32[])",
  "function getCredential(bytes32 credentialId) external view returns (tuple(bytes32 credentialId, address issuer, address holder, string credentialType, uint256 issuedAt, uint256 expiresAt, bool isRevoked, bytes32 credentialHash))",
  "function isCredentialValid(bytes32 credentialId) external view returns (bool)",
  "function getDIDByAddress(address controller) external view returns (string)",
  "function totalDIDs() external view returns (uint256)",
  "function totalVerifications() external view returns (uint256)",
  "event DIDRegistered(string indexed did, address indexed controller, uint256 timestamp)",
  "event VerificationCompleted(string indexed did, address indexed institution, bool success)",
  "event CredentialIssued(bytes32 indexed credentialId, string indexed did, address indexed issuer)",
];

export const CONTRACT_ADDRESSES = {
  'polygon-amoy': '0xd8b47aE8d0341D7dC3AA3e2Ed8cFC8553dDdC3cc',
  'sepolia':      '0x0000000000000000000000000000000000000000',
  'localhost':    '0xd8b47aE8d0341D7dC3AA3e2Ed8cFC8553dDdC3cc',
};

export const NETWORK_NAMES = {
  80002: 'polygon-amoy',
  11155111: 'sepolia',
  31337: 'localhost',
  1337: 'localhost',
};

export const NETWORK_INFO = {
  'polygon-amoy': {
    name: 'Polygon Amoy Testnet',
    chainId: 80002,
    rpc: 'https://rpc-amoy.polygon.technology',
    explorer: 'https://amoy.polygonscan.com',
    currency: 'MATIC',
    faucet: 'https://faucet.polygon.technology/',
  },
  'sepolia': {
    name: 'Ethereum Sepolia',
    chainId: 11155111,
    rpc: 'https://rpc.sepolia.org',
    explorer: 'https://sepolia.etherscan.io',
    currency: 'ETH',
    faucet: 'https://sepoliafaucet.com/',
  },
  'localhost': {
    name: 'Local Hardhat',
    chainId: 31337,
    rpc: 'http://127.0.0.1:8545',
    explorer: '',
    currency: 'ETH',
    faucet: null,
  },
};

/**
 * Get ethers contract instance.
 * Lazy-imports ethers to keep bundle size manageable.
 */
export async function getContract(signerOrProvider, networkKey = 'polygon-amoy') {
  const { ethers } = await import('ethers');
  const address = CONTRACT_ADDRESSES[networkKey];
  if (!address || address === '0x0000000000000000000000000000000000000000') {
    throw new Error(`Contract not deployed on ${networkKey}. Run: npm run deploy:${networkKey}`);
  }
  return new ethers.Contract(address, SSI_REGISTRY_ABI, signerOrProvider);
}

/**
 * Connect MetaMask and return signer + network info.
 */
export async function connectWallet() {
  if (!window.ethereum) {
    throw new Error('MetaMask not found. Please install MetaMask to use blockchain features.');
  }

  const { ethers } = await import('ethers');
  const provider = new ethers.BrowserProvider(window.ethereum);

  await provider.send('eth_requestAccounts', []);
  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const networkKey = NETWORK_NAMES[chainId] || 'unknown';

  return { provider, signer, address, chainId, networkKey };
}

/**
 * Register a DID on-chain.
 * @param {object} wallet - { signer, networkKey }
 * @param {string} did - DID string
 * @param {Uint8Array} publicKeyBytes - WebAuthn public key bytes
 */
export async function registerDIDOnChain(wallet, did, publicKeyBytes) {
  const { ethers } = await import('ethers');
  const contract = await getContract(wallet.signer, wallet.networkKey);

  const tx = await contract.registerDID(did, publicKeyBytes, {
  gasLimit: 500000
});
  const receipt = await tx.wait();

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    explorerUrl: NETWORK_INFO[wallet.networkKey]?.explorer
      ? `${NETWORK_INFO[wallet.networkKey].explorer}/tx/${receipt.hash}`
      : null,
  };
}

/**
 * Fetch a DID document from the blockchain.
 */
export async function getDIDDocument(provider, networkKey, did) {
  const contract = await getContract(provider, networkKey);
  try {
    const doc = await contract.getDIDDocument(did);
    return {
      did: doc.did,
      publicKey: doc.publicKey,
      publicKeyHash: doc.publicKeyHash,
      registeredAt: Number(doc.registeredAt) * 1000,
      lastVerifiedAt: Number(doc.lastVerifiedAt) * 1000,
      isActive: doc.isActive,
      kycLevel: Number(doc.kycLevel),
      controller: doc.controller,
    };
  } catch {
    return null;
  }
}

/**
 * Record a KYC verification on-chain (called by institution).
 */
export async function recordVerification(wallet, did, challengeBytes, kycLevel = 1) {
  const { ethers } = await import('ethers');
  const contract = await getContract(wallet.signer, wallet.networkKey);

  // Pad challenge to 32 bytes for bytes32 parameter
  const paddedChallenge = new Uint8Array(32);
  paddedChallenge.set(challengeBytes.slice(0, 32));

  const tx = await contract.recordVerification(
    did,
    ethers.hexlify(paddedChallenge),
    kycLevel
  );
  const receipt = await tx.wait();
  return receipt;
}

/**
 * Get KYC level for a DID.
 */
export async function getKYCLevel(provider, networkKey, did) {
  try {
    const contract = await getContract(provider, networkKey);
    return Number(await contract.getKYCLevel(did));
  } catch {
    return 0;
  }
}

export const KYC_LEVELS = {
  0: { label: 'Unverified',      color: '#888',   bg: '#f5f5f5' },
  1: { label: 'Basic KYC',       color: '#2196F3', bg: '#E3F2FD' },
  2: { label: 'Enhanced KYC',    color: '#4CAF50', bg: '#E8F5E9' },
  3: { label: 'Full Compliance', color: '#9C27B0', bg: '#F3E5F5' },
};
