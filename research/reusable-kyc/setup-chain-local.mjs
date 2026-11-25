// Disposable Hardhat demo only. The well-known fixture key is NOT a deployment secret.
import {createRequire} from 'node:module';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url),{ethers}=require('ethers');
const hh=createRequire(new URL('../../hardhat/package.json',import.meta.url)),solc=hh('solc');
const dir=resolve(process.argv[2]||'.trustchain-chain-local'),rpcUrl=process.argv[3]||'http://127.0.0.1:8545';
if(existsSync(dir))throw Error('Refusing to overwrite existing configuration');
if(!['localhost','127.0.0.1'].includes(new URL(rpcUrl).hostname))throw Error('Loopback RPC required');
const provider=new ethers.JsonRpcProvider(rpcUrl);provider.pollingInterval=50;
try{
 if((await provider.getNetwork()).chainId!==31337n)throw Error('Local chain 31337 required');
 const wallet=ethers.HDNodeWallet.fromPhrase('test test test test test test test test test test test junk');
 if((await(await provider.getSigner(0)).getAddress()).toLowerCase()!==wallet.address.toLowerCase())throw Error('Expected disposable default Hardhat account');
 const compiled=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'CredentialStatus.sol':{content:readFileSync(new URL('./CredentialStatus.sol',import.meta.url),'utf8')}},settings:{outputSelection:{'*':{'*':['abi','evm.bytecode']}}}})));
 if(compiled.errors?.some(e=>e.severity==='error'))throw Error('Contract compilation failed');
 const artifact=compiled.contracts['CredentialStatus.sol'].CredentialStatus;
 const contract=await new ethers.ContractFactory(artifact.abi,artifact.evm.bytecode.object,wallet.connect(provider)).deploy();await contract.waitForDeployment();
 execFileSync(process.execPath,[new URL('./setup-local.mjs',import.meta.url).pathname,dir],{stdio:'ignore'});
 const transactionKeyFile=join(dir,'transaction.key');writeFileSync(transactionKeyFile,wallet.privateKey,{mode:0o600,flag:'wx'});
 const chain={rpcUrl,contractAddress:await contract.getAddress(),account:0,rpcNoCache:true};
 const issuer=JSON.parse(readFileSync(join(dir,'issuer.json'))),verifier=JSON.parse(readFileSync(join(dir,'verifier.json')));
 issuer.chain={...chain,transactionKeyFile};delete verifier.trustedIssuers[0].statusUrl;verifier.trustedIssuers[0].chain=chain;
 for(const[name,value]of [['issuer.json',issuer],['verifier.json',verifier]])writeFileSync(join(dir,name),JSON.stringify(value,null,2),{mode:0o600});
 console.log('Disposable chain demo configured with durable signing in '+dir+'. Keep the node running; never use this public fixture key for real assets.');
}finally{provider.destroy();}
