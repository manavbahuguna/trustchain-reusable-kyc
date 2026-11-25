import http from 'node:http';
import { once } from 'node:events';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Application-level HTTP delay, not a packet-level WAN emulator.
export async function delayProxy(target,delayMs=0){
 const destination=new URL(target);
 if(!['127.0.0.1','localhost'].includes(destination.hostname))throw Error('Local targets only');
 const stats={requests:0,failures:0,methods:{}};
 const server=http.createServer(async(req,res)=>{
  try{
   const parts=[];let length=0;for await(const p of req){length+=p.length;if(length>1048576)throw Error('Too large');parts.push(p);}
   const body=Buffer.concat(parts);stats.requests++;
   try{for(const item of [JSON.parse(body)].flat())if(item?.method)stats.methods[item.method]=(stats.methods[item.method]||0)+1;}catch{}
   await sleep(delayMs);
   const headers={...req.headers,host:destination.host};delete headers.connection;delete headers['content-length'];
   const upstream=await fetch(new URL(req.url,destination),{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:body,signal:AbortSignal.timeout(10000),redirect:'error'});
   const payload=Buffer.from(await upstream.arrayBuffer());await sleep(delayMs);
   res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')||'application/json'});res.end(payload);
  }catch{stats.failures++;res.writeHead(502);res.end('{"error":"Upstream failed"}');}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 return {url:'http://127.0.0.1:'+server.address().port,stats,setDelay(ms){if(!Number.isFinite(ms)||ms<0||ms>1000)throw Error('Invalid delay');delayMs=ms;},async close(){server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
