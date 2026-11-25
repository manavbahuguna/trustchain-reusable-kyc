import {publicKey} from './lifecycle.mjs';
// Only invoked for an application whose administrator approval was recorded.
export async function reconcile(item,{issuer,lifecycle,adapter,save,now=Date.now}){
 if(item.status==='approved')return {id:item.id,status:item.status};
 if(!item.chainPlan){
  if(item.status!=='processing'||!item.operation)throw Error('No durable approval intent');
  const op=item.operation,old=op.request&&issuer.records.get(op.request.credentialId);
  if(op.request&&(!old||old.revoked||old.expiresAt<=now()))throw Error('Previous credential unavailable');
  if(old?.replacementOperation&&old.replacementOperation!==item.id)throw Error('Replacement already in progress');
  if(old)old.replacementOperation=item.id;
  const credential=issuer.issue(publicKey(op.holderPublicKey||op.request.newPublicKey),{simulatedIdentityApproved:true,level:old?.payload.level||1,ttlMs:old?old.expiresAt-now():86400000,passkeyRequired:!!op.passkey});
  const id=JSON.parse(Buffer.from(credential.body,'base64url')).id;
  if(op.passkey)issuer.records.get(id).passkey=op.passkey;
  // Prepared credentials are not usable until chain registration succeeds.
  issuer.records.get(id).revoked=true;
  item.chainPlan={id,oldId:op.request?.credentialId,result:{credential,recoveryToken:lifecycle.token(id)},revoke:{},register:{}};
  save('chain-intent');
 }
 const plan=item.chainPlan;
 try{
  const chain=await adapter();
  if(plan.oldId){await chain.ensure(plan.oldId,2,plan.revoke,()=>save('chain-revoke-progress'));issuer.revoke(plan.oldId);save('chain-old-revoked');}
  if(issuer.records.get(plan.id).expiresAt<=now())throw Error('Replacement expired; requires manual review');
  await chain.ensure(plan.id,1,plan.register,()=>save('chain-register-progress'));
  issuer.records.get(plan.id).revoked=false;
  item.result=plan.result;item.status='approved';item.operation=null;item.expiresAt=now()+900000;item.recoveryMessage=null;
  save('chain-approved');return{id:item.id,status:item.status};
 }catch(e){item.status='needs-review';item.recoveryMessage=e.code||'CHAIN_REVIEW_REQUIRED';save('chain-needs-review');throw e;}
}
export async function ensureChainState({id,target,step,save,status,receipt,submit,prepare,broadcast,validate}){
 if(step.rawTransaction)await validate(step,id,target);
 const current=await status(id);
 if(current===target){step.state='confirmed';save();return;}
 if((target===1&&current!==0)||(target===2&&current!==1))throw Object.assign(Error('Unexpected contract state'),{code:'CHAIN_STATE_CONFLICT'});
 if(step.rawTransaction){
  await validate(step,id,target);
  const r=await receipt(step.hash);
  if(r){if(Number(r.status)===0)throw Object.assign(Error('Transaction reverted'),{code:'TRANSACTION_REVERTED'});throw Object.assign(Error('Receipt/state mismatch'),{code:'CHAIN_STATE_CONFLICT'});}
  await broadcast(step);
  if(await status(id)===target){step.state='confirmed';save();return;}
  throw Object.assign(Error('Transaction pending'),{code:'TRANSACTION_PENDING'});
 }
 if(step.hash){const r=await receipt(step.hash);if(!r)throw Object.assign(Error('Transaction pending'),{code:'TRANSACTION_PENDING'});if(Number(r.status)===0){step.state='reverted';save();throw Object.assign(Error('Transaction reverted'),{code:'TRANSACTION_REVERTED'});}throw Object.assign(Error('Receipt/state mismatch'),{code:'CHAIN_STATE_CONFLICT'});}
 if(step.state==='submitting')throw Object.assign(Error('Broadcast outcome unknown'),{code:'BROADCAST_UNKNOWN'});
 if(prepare){
  const prepared=await prepare(id,target);
  Object.assign(step,prepared,{state:'prepared'});save();
  await validate(step,id,target);
  await broadcast(step);
  if(await status(id)===target){step.state='confirmed';save();return;}
  throw Object.assign(Error('Transaction pending'),{code:'TRANSACTION_PENDING'});
 }
 step.state='submitting';save();
 const tx=await submit(id,target);step.hash=tx.hash;step.state='submitted';save();
 // A bounded RPC check; pending transactions are resumed on the next reconciliation.
 const r=await receipt(step.hash);
 if(!r)throw Object.assign(Error('Transaction pending'),{code:'TRANSACTION_PENDING'});
 if(Number(r.status)!==1)throw Object.assign(Error('Transaction reverted'),{code:'TRANSACTION_REVERTED'});
 if(await status(id)!==target)throw Object.assign(Error('State mismatch'),{code:'CHAIN_STATE_CONFLICT'});
 step.state='confirmed';save();
}
