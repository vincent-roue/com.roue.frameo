'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {createPrivateDirectory,recoverPrivateDirectories}=require('../lib/frameo-temp');
const {FrameoUploads}=require('../lib/frameo-uploads');
const MARKER='.frameo-owner.json';
async function root(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'frameo-recovery-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir}
async function makeDead(directory){const name=path.join(directory,MARKER),owner=JSON.parse(await fs.readFile(name,'utf8'));owner.pid=process.pid;owner.processToken=randomUUID();await fs.writeFile(name,JSON.stringify(owner))}
test('an abruptly killed local process leaves marked sources which startup recovers without sending',async t=>{
 const directory=await root(t),modulePath=path.resolve(__dirname,'../lib/frameo-uploads'),tempPath=path.resolve(__dirname,'../lib/frameo-temp');
 const source="const fs=require('node:fs/promises'),path=require('node:path');const {FrameoUploads}=require("+JSON.stringify(modulePath)+");const{createPrivateDirectory}=require("+JSON.stringify(tempPath)+");const app={stopping:false,log(){},transfers:{ready:Promise.resolve(),requireBatch(){return{targets:[{}]}}}};(async()=>{const u=new FrameoUploads(app,{tmpdir:"+JSON.stringify(directory)+",sweepMs:0});await u.ready;const x=await u.start({batchId:'fixture',mime:'image/png',bytes:3});await u.chunk({uploadId:x.uploadId,offset:0,data:'YWJj'});for(const kind of ['source','preview']){const d=await createPrivateDirectory(kind,{tmpdir:"+JSON.stringify(directory)+"});await fs.writeFile(path.join(d,'synthetic-image'),'not a user photo')}process.stdout.write('ready\\n');setInterval(()=>{},1000)})().catch(()=>process.exit(1));";
 const child=spawn(process.execPath,['-e',source],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 t.after(()=>{try{child.kill('SIGKILL')}catch{}});
 await new Promise((resolve,reject)=>{let value='';const timer=setTimeout(()=>reject(Error('Synthetic child timed out')),5000);child.stdout.on('data',chunk=>{value+=chunk;if(value.includes('ready')){clearTimeout(timer);resolve()}});child.once('error',reject);child.once('exit',code=>{if(code!==null&&code!==0)reject(Error('Synthetic child failed'))})});
 assert.equal((await fs.readdir(directory)).length,3);
 const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
 const app={stopping:false,log(){},transfers:{ready:Promise.resolve(),requireBatch(){assert.fail('Recovery must not send or reopen a batch')}}};
 const uploads=new FrameoUploads(app,{tmpdir:directory,sweepMs:0});t.after(()=>uploads.close());
 const stats=await uploads.ready;
 assert.equal(stats.removed,3);assert.equal(stats.failed,0);assert.equal(stats.remainingUnknown,false);
 assert.deepEqual(await fs.readdir(directory),[]);assert.equal(uploads.stats().bytes,0);
});
test('concurrent live owners, legacy folders, user files and malformed markers are preserved',async t=>{
 const directory=await root(t),live=await createPrivateDirectory('upload',{tmpdir:directory});
 await fs.writeFile(path.join(live,'source'),'live upload');
 const legacy=await fs.mkdtemp(path.join(directory,'homey-frameo-upload-'));
 await fs.writeFile(path.join(legacy,'source'),'legacy must stay');
 const unknown=await createPrivateDirectory('source',{tmpdir:directory});
 await fs.writeFile(path.join(unknown,MARKER),'not JSON');
 await fs.writeFile(path.join(directory,'user.txt'),'user data');
 const stats=await recoverPrivateDirectories({tmpdir:directory});
 assert.equal(stats.live,1);assert.equal(stats.unknown,1);assert.equal(stats.removed,0);
 assert.equal(await fs.readFile(path.join(live,'source'),'utf8'),'live upload');
 assert.equal(await fs.readFile(path.join(legacy,'source'),'utf8'),'legacy must stay');
 assert.equal(await fs.readFile(path.join(directory,'user.txt'),'utf8'),'user data');
});
test('a namespaced symlink cannot lead recovery into another directory',async t=>{
 const directory=await root(t),outside=await root(t);
 const target=await createPrivateDirectory('source',{tmpdir:outside});await makeDead(target);
 await fs.writeFile(path.join(target,'keep'),'outside fixture');
 const link=await createPrivateDirectory('source',{tmpdir:directory});await fs.rm(link,{recursive:true,force:true});
 await fs.symlink(target,link,process.platform==='win32'?'junction':'dir');
 const stats=await recoverPrivateDirectories({tmpdir:directory});
 assert.equal(stats.removed,0);assert.equal(await fs.readFile(path.join(target,'keep'),'utf8'),'outside fixture');
});
test('recovery reports an exhausted budget instead of claiming all stale sources are gone',async t=>{
 const directory=await root(t);
 for(let i=0;i<9;i++){const folder=await createPrivateDirectory('preview',{tmpdir:directory});await makeDead(folder);await fs.writeFile(path.join(folder,'preview'),'fixture')}
 const first=await recoverPrivateDirectories({tmpdir:directory});
 assert.equal(first.removed,8);assert.equal(first.budgetExhausted,true);assert.equal(first.remainingUnknown,true);
 const second=await recoverPrivateDirectories({tmpdir:directory});
 assert.equal(second.removed,1);assert.equal(second.remainingUnknown,false);assert.deepEqual(await fs.readdir(directory),[]);
 const serialized=JSON.stringify(first);assert(!serialized.includes(directory));assert(!serialized.includes(process.pid.toString()));
});
test('two upload service instances never remove each other’s active source files',async t=>{
 const directory=await root(t),app={stopping:false,log(){},transfers:{ready:Promise.resolve(),requireBatch(){return{targets:[{}]}}}};
 const first=new FrameoUploads(app,{tmpdir:directory,sweepMs:0});t.after(()=>first.close());
 const one=await first.start({batchId:'fixture',mime:'image/png',bytes:3});await first.chunk({uploadId:one.uploadId,offset:0,data:'YWJj'});
 const second=new FrameoUploads(app,{tmpdir:directory,sweepMs:0});t.after(()=>second.close());const stats=await second.ready;
 assert.equal(stats.live,1);assert.equal(stats.removed,0);assert.equal(first.stats().bytes,3);
 assert.deepEqual(await first.abort({uploadId:one.uploadId}),{aborted:true});assert.deepEqual(await fs.readdir(directory),[]);
});
