import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';import {performance} from 'node:perf_hooks';import {delayProxy} from './delay-proxy.mjs';
test('proxy preserves JSON and status, counts requests, adds delay in both directions',async()=>{
 const s=http.createServer(async(req,res)=>{const parts=[];for await(const p of req)parts.push(p);res.writeHead(201,{'content-type':'application/json'});res.end(Buffer.concat(parts));});s.listen(0,'127.0.0.1');await once(s,'listening');
 const p=await delayProxy('http://127.0.0.1:'+s.address().port,25);
 try{const start=performance.now();const r=await fetch(p.url,{method:'POST',body:JSON.stringify({method:'test'})});assert.equal(r.status,201);assert.deepEqual(await r.json(),{method:'test'});assert.ok(performance.now()-start>=45);assert.equal(p.stats.requests,1);assert.equal(p.stats.methods.test,1);
 s.closeAllConnections();await new Promise(r=>s.close(r));assert.equal((await fetch(p.url)).status,502);assert.equal(p.stats.failures,1);
 }finally{await p.close();if(s.listening)await new Promise(r=>s.close(r));}
});
