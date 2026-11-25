import {readFileSync} from 'node:fs';
import {ensureChainState} from './reconcile.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ethers } = require('ethers');
export const abi = ['function status(bytes32) view returns(uint8)', 'function issuer() view returns(address)', 'function register(bytes32)', 'function revoke(bytes32)'];
export async function chainAdapter(config, write = false) {
  const url = new URL(config.rpcUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('Research adapter permits local RPC only');
  const request = new ethers.FetchRequest(config.rpcUrl); request.timeout = 3000;
  const provider = new ethers.JsonRpcProvider(request, undefined, config.rpcNoCache ? { cacheTimeout: -1, batchMaxCount: 1 } : {});
  provider.pollingInterval = 50;
  if ((await provider.getNetwork()).chainId !== 31337n) throw Error('Local research chain required');
  const runner = write ? await provider.getSigner(config.account || 0) : provider;
  const contract = new ethers.Contract(config.contractAddress, abi, runner);
  if (await provider.getCode(config.contractAddress) === '0x') throw Error('Missing status contract');
  if (write && (await contract.issuer()).toLowerCase() !== (await runner.getAddress()).toLowerCase()) throw Error('Wrong chain issuer');
  const lag = config.statusLagBlocks ?? 0;
  if (!Number.isInteger(lag) || lag < 0 || lag > 100) throw Error('Invalid block lag');
  // Optional local signing key enables exact-transaction crash recovery. Never expose it via HTTP.
  const wallet=write&&config.transactionKeyFile?new ethers.Wallet(readFileSync(config.transactionKeyFile,'utf8').trim(),provider):null;
  if(wallet&&(await wallet.getAddress()).toLowerCase()!==(await runner.getAddress()).toLowerCase())throw Error('Wrong transaction signing key');
  const idHash = id => ethers.keccak256(ethers.toUtf8Bytes(id));
  return {
    async ensure(id,target,step,save){return ensureChainState({id,target,step,save,
      status:async value=>Number(BigInt(await provider.send('eth_call',[{to:config.contractAddress,data:contract.interface.encodeFunctionData('status',[idHash(value)])},'latest']))),
      receipt:hash=>provider.send('eth_getTransactionReceipt',[hash]),
      ...(wallet?{
        prepare:async(value,target)=>{
          const tx=await wallet.populateTransaction({to:config.contractAddress,data:contract.interface.encodeFunctionData(target===1?'register':'revoke',[idHash(value)])});
          const rawTransaction=await wallet.signTransaction(tx);
          return{rawTransaction,hash:ethers.keccak256(rawTransaction),nonce:tx.nonce,chainId:String(tx.chainId)};
        },
        validate:async(step,value,target)=>{
          const tx=ethers.Transaction.from(step.rawTransaction);
          if(tx.hash!==step.hash||tx.chainId!==31337n||String(tx.chainId)!==step.chainId||tx.nonce!==step.nonce||tx.from?.toLowerCase()!==wallet.address.toLowerCase()||tx.to?.toLowerCase()!==config.contractAddress.toLowerCase()||tx.value!==0n||tx.data!==contract.interface.encodeFunctionData(target===1?'register':'revoke',[idHash(value)]))throw Object.assign(Error('Outbox transaction binding mismatch'),{code:'OUTBOX_BINDING_MISMATCH'});
        },
        broadcast:async step=>{
          // Never allocate a replacement nonce or change fees on recovery.
          try{await provider.broadcastTransaction(step.rawTransaction);}catch(error){
            const known=await provider.send('eth_getTransactionByHash',[step.hash]);
            const mined=await provider.send('eth_getTransactionReceipt',[step.hash]);
            if(!known&&!mined){
              const nonce=Number(BigInt(await provider.send('eth_getTransactionCount',[wallet.address,'latest'])));
              if(nonce>step.nonce)throw Object.assign(Error('Signing nonce consumed by another transaction; manual review required'),{code:'OUTBOX_NONCE_CONFLICT'});
              throw error;
            }
          }
        }
      }:{}),
      submit:(value,target)=>target===1?contract.register(idHash(value)):contract.revoke(idHash(value))});},
    async checkStatus(id) {
      if (lag === 0) {
        if (Number(await contract.status(idHash(id))) !== 1) throw Error('Unknown or revoked chain credential');
        return;
      }
      const head = Number(BigInt(await provider.send('eth_blockNumber', [])));
      if (head < lag) throw Error('Insufficient chain history');
      if (Number(await contract.status(idHash(id), {blockTag: head - lag})) !== 1) throw Error('Unknown or revoked chain credential');
    },
    async register(id) { const r = await (await contract.register(idHash(id))).wait(); return r.gasUsed.toString(); },
    async revoke(id) { const r = await (await contract.revoke(idHash(id))).wait(); return r.gasUsed.toString(); },
    close() { provider.destroy(); },
  };
}
