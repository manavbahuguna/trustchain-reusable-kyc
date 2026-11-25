// scripts/deploy.js
const { ethers } = require("hardhat");

async function main() {
  console.log("Deploying SSIRegistry to Polygon Amoy testnet...\n");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer address:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "MATIC\n");

  const SSIRegistry = await ethers.getContractFactory("SSIRegistry");
  const registry = await SSIRegistry.deploy();
  await registry.waitForDeployment();

  const address = await registry.getAddress();
  console.log("SSIRegistry deployed to:", address);

  // Authorize a demo institution
  const demoBank = "0x742d35Cc6634C0532925a3b8D4C9C2C3d6cd1aBC"; // Demo address
  try {
    const tx = await registry.authorizeInstitution(demoBank, "DemoBank FSB");
    await tx.wait();
    console.log("Demo institution authorized:", demoBank);
  } catch (e) {
    console.log("Skipping demo institution (address may not exist on testnet)");
  }

  console.log("\n=== Deployment Summary ===");
  console.log("Contract: SSIRegistry");
  console.log("Address:", address);
  console.log("Network: Polygon Amoy");
  console.log(`Polygonscan: https://amoy.polygonscan.com/address/${address}`);
  console.log("\nUpdate frontend/.env: VITE_CONTRACT_ADDRESS=" + address);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
