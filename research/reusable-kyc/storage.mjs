import {DatabaseSync} from 'node:sqlite';
import {readFileSync,existsSync,openSync,closeSync,chmodSync} from 'node:fs';
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
export class Storage {
 constructor(file,key,legacyFile){
  this.key=createHash('sha256').update('TrustChain application storage v1\0').update(key).digest();
  if(!existsSync(file)){const fd=openSync(file,'wx',0o600);closeSync(fd);}chmodSync(file,0o600);
  this.db=new DatabaseSync(file);
  try{
   // This implementation caches records in memory: enforce one owning process.
   this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
   this.db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS credentials(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS applications(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY,at INTEGER NOT NULL,event TEXT NOT NULL);');
   const version=this.db.prepare("SELECT value FROM meta WHERE key='version'").get();
   if(version && version.value!=='1')throw Error('Unsupported database version');
   if(!version){let records=new Map();if(legacyFile&&existsSync(legacyFile)){const data=JSON.parse(readFileSync(legacyFile,'utf8'));if(!Array.isArray(data))throw Error('Invalid legacy records');records=new Map(data);}this.save(records,new Map(),'initialize');this.db.prepare("INSERT INTO meta VALUES('version','1')").run();}
   // Authenticate the configured storage key even for an empty approval queue.
   const check=this.db.prepare("SELECT value FROM meta WHERE key='key-check'").get();
   if(check)this.decrypt(check.value,'key-check');else this.db.prepare("INSERT INTO meta VALUES('key-check',?)").run(this.encrypt({ok:true},'key-check'));
  }catch(e){this.db.close();throw e;}
 }
 encrypt(value,id){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);c.setAAD(Buffer.from(id));const body=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return JSON.stringify({iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),body:body.toString('base64')});}
 decrypt(text,id){const x=JSON.parse(text),c=createDecipheriv('aes-256-gcm',this.key,Buffer.from(x.iv,'base64'));c.setAAD(Buffer.from(id));c.setAuthTag(Buffer.from(x.tag,'base64'));return JSON.parse(Buffer.concat([c.update(Buffer.from(x.body,'base64')),c.final()]).toString());}
 load(){const records=new Map(this.db.prepare('SELECT * FROM credentials').all().map(r=>[r.id,JSON.parse(r.data)]));const applications=new Map(this.db.prepare('SELECT * FROM applications').all().map(r=>{const x=this.decrypt(r.data,r.id);x.secretHash=Buffer.from(x.secretHash,'base64');return[r.id,x];}));return{records,applications};}
 save(records,applications,event){this.db.exec('BEGIN IMMEDIATE');try{
  this.db.exec('DELETE FROM credentials; DELETE FROM applications;');
  const record=this.db.prepare('INSERT INTO credentials VALUES(?,?)'),application=this.db.prepare('INSERT INTO applications VALUES(?,?)');
  for(const[id,r]of records)record.run(id,JSON.stringify(r));
  for(const[id,a]of applications)application.run(id,this.encrypt({...a,secretHash:a.secretHash.toString('base64')},id));
  this.db.prepare('INSERT INTO audit(at,event) VALUES(?,?)').run(Date.now(),event);
  this.db.exec('COMMIT');
 }catch(e){this.db.exec('ROLLBACK');throw e;}}
 close(){this.db.close();}
}
