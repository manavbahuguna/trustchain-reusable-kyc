import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest();
export class ApprovalQueue {
 constructor(now=Date.now){this.now=now;this.items=new Map();}
 prune(){for(const [id,x]of this.items)if(x.expiresAt<=this.now()&&(!x.chainPlan||x.status==='approved'))this.items.delete(id);}
 create(kind,operation,summary){this.prune();if(this.items.size>=1000)throw Error('Approval queue full');
  const accessToken=randomBytes(32).toString('base64url');const item={id:randomUUID(),kind,operation,summary,status:'pending',createdAt:this.now(),expiresAt:this.now()+15*60*1000,secretHash:hash(accessToken)};this.items.set(item.id,item);
  return {id:item.id,accessToken,expiresAt:item.expiresAt};
 }
 get(id){this.prune();const item=this.items.get(id);if(!item||(item.expiresAt<=this.now()&&item.status!=='needs-review'&&item.status!=='processing'))throw Error('Unknown or expired application');return item;}
 list(){this.prune();return [...this.items.values()].map(x=>({id:x.id,kind:x.kind,summary:x.summary,status:x.status,createdAt:x.createdAt,expiresAt:x.expiresAt,recoveryMessage:x.recoveryMessage,canReconcile:!!x.chainPlan&&x.status==='needs-review',transactions:x.chainPlan?{revoke:x.chainPlan.revoke.hash,register:x.chainPlan.register.hash}:undefined}));}
 collect(id,secret){const item=this.get(id);if(typeof secret!=='string'||!timingSafeEqual(hash(secret),item.secretHash))throw Error('Invalid request secret');return {id,status:item.status,expiresAt:item.expiresAt,...(item.status==='approved'?{result:item.result}:{})};}
 async approve(id,execute){const item=this.get(id);if(item.status!=='pending')throw Error('Application already decided');item.status='processing';
  try{item.result=await execute(item);item.status='approved';item.operation=null;return {id,status:item.status};}
  catch(e){if(item.chainPlan){item.status='needs-review';}else{item.status='failed';item.operation=null;}throw e;}
 }
 reject(id){const item=this.get(id);if(item.status!=='pending')throw Error('Application already decided');item.status='rejected';item.operation=null;return {id,status:'rejected'};}
}
export class AdminSessions {
 constructor(token,now=Date.now){this.hash=hash(token);this.now=now;this.sessions=new Map();}
 login(token){for(const[t,s]of this.sessions)if(s<=this.now())this.sessions.delete(t);if(typeof token!=='string'||!timingSafeEqual(hash(token),this.hash))throw Error('Unauthorized');if(this.sessions.size>=100)throw Error('Session limit');
  const accessToken=randomBytes(32).toString('base64url'),expiresAt=this.now()+15*60*1000;this.sessions.set(hash(accessToken).toString('hex'),expiresAt);return {accessToken,expiresAt};
 }
 authorized(token){if(typeof token!=='string')return false;return (this.sessions.get(hash(token).toString('hex'))||0)>this.now();}
 logout(token){if(typeof token==='string')this.sessions.delete(hash(token).toString('hex'));}
}
