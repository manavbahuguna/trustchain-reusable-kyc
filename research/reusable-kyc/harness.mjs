import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import net from 'node:net';
export async function freePort(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
export async function startService(config,file){
 writeFileSync(file,JSON.stringify(config),{mode:0o600});
 const child=spawn(process.execPath,[new URL('./service.mjs',import.meta.url).pathname,file],{stdio:['ignore','pipe','pipe']});
 let errors='';child.stderr.on('data',d=>{errors+=d;});
 const info=await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{child.kill();reject(Error('Service startup timeout'));},10000);
  child.once('error',e=>{clearTimeout(timeout);reject(e);});
  child.once('exit',code=>{clearTimeout(timeout);reject(Error('Service exited '+code+': '+errors));});
  child.stdout.once('data',d=>{clearTimeout(timeout);resolve(JSON.parse(d));});
 });
 return {child,url:'http://127.0.0.1:'+info.port};
}
export async function stop(s){if(s.child.exitCode!==null || s.child.signalCode!==null)return;const done=once(s.child,'exit');s.child.kill();await done;}
export async function post(url,body,token){
 const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 return {code:r.status,body:await r.json()};
}
