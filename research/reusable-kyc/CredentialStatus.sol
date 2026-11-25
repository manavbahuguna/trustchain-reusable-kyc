// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;
// One pinned issuer per deployment. No identity attributes are stored.
contract CredentialStatus {
    address public immutable issuer;
    mapping(bytes32 => uint8) public status; // 0 unknown, 1 active, 2 revoked
    constructor() { issuer = msg.sender; }
    modifier onlyIssuer() { require(msg.sender == issuer, "issuer only"); _; }
    function register(bytes32 id) external onlyIssuer {
        require(status[id] == 0, "already registered"); status[id] = 1;
    }
    function revoke(bytes32 id) external onlyIssuer {
        require(status[id] == 1, "not active"); status[id] = 2;
    }
}
