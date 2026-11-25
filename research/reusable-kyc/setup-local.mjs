import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { keyPair } from './protocol.mjs';
const dir = resolve(process.argv[2] || '.trustchain-research-local');
mkdirSync(dir, { mode: 0o700 }); // Refuse to overwrite existing keys or state.
const keys = keyPair(), token = randomBytes(32).toString('base64url');
const write = (name, data) => writeFileSync(join(dir,name),data,{mode:0o600,flag:'wx'});
write('issuer.pem',keys.privateKey.export({type:'pkcs8',format:'pem'}));
write('issuer.pub',keys.publicKey.export({type:'spki',format:'pem'}));
write('issuer.json',JSON.stringify({role:'issuer',id:'institution-a',port:4101,privateKeyFile:join(dir,'issuer.pem'),publicKeyFile:join(dir,'issuer.pub'),adminToken:token,stateFile:join(dir,'state.json')},null,2));
write('verifier.json',JSON.stringify({role:'verifier',id:'institution-b',port:4102,trustedIssuers:[{id:'institution-a',publicKeyFile:join(dir,'issuer.pub'),statusUrl:'http://127.0.0.1:4101/status'}]},null,2));
write('.gitignore','*\n');
console.log('Local-only configuration created in ' + dir + '. Keep these files private.');
