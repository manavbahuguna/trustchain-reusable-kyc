// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title SSIRegistry
 * @dev Self-Sovereign Identity Registry for Financial KYC
 * Maps Decentralized Identifiers (DIDs) to public keys and verification status.
 * Financial institutions can verify identities without accessing biometric data.
 */
contract SSIRegistry {

    // ─── Structs ─────────────────────────────────────────────────────────────

    struct DIDDocument {
        string did;                    // e.g. "did:ethr:0x1234..."
        bytes publicKey;               // WebAuthn COSE public key (compressed)
        bytes32 publicKeyHash;         // keccak256 of public key for fast lookup
        uint256 registeredAt;          // UNIX timestamp
        uint256 lastVerifiedAt;        // UNIX timestamp of last successful verification
        bool isActive;                 // DID revocation status
        uint8 kycLevel;                // 0=none, 1=basic, 2=enhanced, 3=full
        address controller;            // Ethereum address that controls this DID
    }

    struct VerifiableCredential {
        bytes32 credentialId;
        address issuer;               // Financial institution address
        address holder;               // DID controller address
        string credentialType;        // e.g. "KYCCredential", "AMLCheck"
        uint256 issuedAt;
        uint256 expiresAt;
        bool isRevoked;
        bytes32 credentialHash;       // IPFS hash or commitment
    }

    struct FinancialInstitution {
        string name;
        bool isAuthorized;
        uint256 authorizedAt;
        uint256 verificationsCount;
    }

    // ─── Storage ──────────────────────────────────────────────────────────────

    address public owner;
    uint256 public totalDIDs;
    uint256 public totalVerifications;

    // DID string → DIDDocument
    mapping(string => DIDDocument) public didDocuments;

    // Address → DID string (for reverse lookup)
    mapping(address => string) public addressToDID;

    // Credential ID → VerifiableCredential
    mapping(bytes32 => VerifiableCredential) public credentials;

    // DID string → array of credential IDs
    mapping(string => bytes32[]) public didCredentials;

    // Financial institution address → info
    mapping(address => FinancialInstitution) public institutions;

    // Challenge nonces used (anti-replay)
    mapping(bytes32 => bool) public usedChallenges;

    // ─── Events ───────────────────────────────────────────────────────────────

    event DIDRegistered(string indexed did, address indexed controller, uint256 timestamp);
    event DIDUpdated(string indexed did, uint256 timestamp);
    event DIDRevoked(string indexed did, uint256 timestamp);
    event KYCLevelUpdated(string indexed did, uint8 newLevel, address indexed institution);
    event CredentialIssued(bytes32 indexed credentialId, string indexed did, address indexed issuer);
    event CredentialRevoked(bytes32 indexed credentialId);
    event VerificationCompleted(string indexed did, address indexed institution, bool success);
    event InstitutionAuthorized(address indexed institution, string name);

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "SSI: not owner");
        _;
    }

    modifier onlyAuthorizedInstitution() {
        require(institutions[msg.sender].isAuthorized, "SSI: not authorized institution");
        _;
    }

    modifier onlyDIDController(string memory did) {
        require(
            didDocuments[did].controller == msg.sender,
            "SSI: not DID controller"
        );
        _;
    }

    modifier didExists(string memory did) {
        require(bytes(didDocuments[did].did).length > 0, "SSI: DID not found");
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
    }

    // ─── DID Management ───────────────────────────────────────────────────────

    /**
     * @dev Register a new DID with a WebAuthn public key.
     * The public key is the credential public key from WebAuthn registration,
     * encoded in COSE format. No biometric data is stored.
     */
    function registerDID(
        string calldata did,
        bytes calldata publicKey
    ) external {
        require(bytes(did).length > 0, "SSI: empty DID");
        require(publicKey.length > 0, "SSI: empty public key");
        require(bytes(didDocuments[did].did).length == 0, "SSI: DID already registered");
        require(bytes(addressToDID[msg.sender]).length == 0, "SSI: address already has DID");

        bytes32 pkHash = keccak256(publicKey);

        didDocuments[did] = DIDDocument({
            did: did,
            publicKey: publicKey,
            publicKeyHash: pkHash,
            registeredAt: block.timestamp,
            lastVerifiedAt: 0,
            isActive: true,
            kycLevel: 0,
            controller: msg.sender
        });

        addressToDID[msg.sender] = did;
        totalDIDs++;

        emit DIDRegistered(did, msg.sender, block.timestamp);
    }

    /**
     * @dev Update the public key for an existing DID (key rotation).
     */
    function updatePublicKey(
        string calldata did,
        bytes calldata newPublicKey
    ) external onlyDIDController(did) didExists(did) {
        require(didDocuments[did].isActive, "SSI: DID is revoked");
        didDocuments[did].publicKey = newPublicKey;
        didDocuments[did].publicKeyHash = keccak256(newPublicKey);
        emit DIDUpdated(did, block.timestamp);
    }

    /**
     * @dev Revoke a DID (e.g. device lost/stolen). Controller only.
     */
    function revokeDID(string calldata did)
        external onlyDIDController(did) didExists(did) {
        didDocuments[did].isActive = false;
        emit DIDRevoked(did, block.timestamp);
    }

    // ─── Verification ─────────────────────────────────────────────────────────

    /**
     * @dev Record a successful verification event.
     * Called by authorized financial institutions after completing a 
     * challenge-response authentication against the stored public key.
     * The actual cryptographic verification happens off-chain; this records
     * the attestation on-chain for auditability.
     */
    function recordVerification(
        string calldata did,
        bytes32 challenge,
        uint8 newKycLevel
    ) external onlyAuthorizedInstitution didExists(did) {
        require(!usedChallenges[challenge], "SSI: challenge already used");
        require(didDocuments[did].isActive, "SSI: DID is revoked");
        require(newKycLevel <= 3, "SSI: invalid KYC level");

        usedChallenges[challenge] = true;
        didDocuments[did].lastVerifiedAt = block.timestamp;

        if (newKycLevel > didDocuments[did].kycLevel) {
            didDocuments[did].kycLevel = newKycLevel;
            emit KYCLevelUpdated(did, newKycLevel, msg.sender);
        }

        institutions[msg.sender].verificationsCount++;
        totalVerifications++;

        emit VerificationCompleted(did, msg.sender, true);
    }

    /**
     * @dev Issue a Verifiable Credential to a DID holder.
     */
    function issueCredential(
        string calldata did,
        string calldata credentialType,
        uint256 expiresAt,
        bytes32 credentialHash
    ) external onlyAuthorizedInstitution didExists(did) returns (bytes32) {
        bytes32 credentialId = keccak256(
            abi.encodePacked(did, credentialType, block.timestamp, msg.sender)
        );

        credentials[credentialId] = VerifiableCredential({
            credentialId: credentialId,
            issuer: msg.sender,
            holder: didDocuments[did].controller,
            credentialType: credentialType,
            issuedAt: block.timestamp,
            expiresAt: expiresAt,
            isRevoked: false,
            credentialHash: credentialHash
        });

        didCredentials[did].push(credentialId);

        emit CredentialIssued(credentialId, did, msg.sender);
        return credentialId;
    }

    /**
     * @dev Revoke a previously issued credential.
     */
    function revokeCredential(bytes32 credentialId) external {
        VerifiableCredential storage vc = credentials[credentialId];
        require(vc.issuer == msg.sender || msg.sender == owner, "SSI: not issuer");
        vc.isRevoked = true;
        emit CredentialRevoked(credentialId);
    }

    // ─── Institution Management ───────────────────────────────────────────────

    function authorizeInstitution(address institution, string calldata name)
        external onlyOwner {
        institutions[institution] = FinancialInstitution({
            name: name,
            isAuthorized: true,
            authorizedAt: block.timestamp,
            verificationsCount: 0
        });
        emit InstitutionAuthorized(institution, name);
    }

    function revokeInstitution(address institution) external onlyOwner {
        institutions[institution].isAuthorized = false;
    }

    // ─── View Functions ───────────────────────────────────────────────────────

    function getDIDDocument(string calldata did)
        external view returns (DIDDocument memory) {
        return didDocuments[did];
    }

    function getPublicKey(string calldata did)
        external view didExists(did) returns (bytes memory) {
        return didDocuments[did].publicKey;
    }

    function getPublicKeyHash(string calldata did)
        external view didExists(did) returns (bytes32) {
        return didDocuments[did].publicKeyHash;
    }

    function getKYCLevel(string calldata did)
        external view didExists(did) returns (uint8) {
        return didDocuments[did].kycLevel;
    }

    function isKYCValid(string calldata did, uint8 requiredLevel)
        external view returns (bool) {
        DIDDocument memory doc = didDocuments[did];
        return doc.isActive && doc.kycLevel >= requiredLevel;
    }

    function getDIDCredentials(string calldata did)
        external view returns (bytes32[] memory) {
        return didCredentials[did];
    }

    function getCredential(bytes32 credentialId)
        external view returns (VerifiableCredential memory) {
        return credentials[credentialId];
    }

    function isCredentialValid(bytes32 credentialId)
        external view returns (bool) {
        VerifiableCredential memory vc = credentials[credentialId];
        return !vc.isRevoked &&
               vc.expiresAt > block.timestamp &&
               vc.issuer != address(0);
    }

    function getDIDByAddress(address controller)
        external view returns (string memory) {
        return addressToDID[controller];
    }
}
