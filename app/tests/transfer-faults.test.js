'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const http=require('node:http'),net=require('node:net');
const {FrameoEngine,SETTINGS_KEY}=require('../lib/frameo-engine');
const {FrameoTransfers}=require('../lib/frameo-transfers');
const {FrameoUploads}=require('../lib/frameo-uploads');
const {FrameoGroups}=require('../lib/frameo-groups');
const {JOURNAL_KEY}=require('../lib/transfer-journal');
const A='ab'.repeat(32),B='bc'.repeat(32),C='cd'.repeat(32);
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nvAAAAAASUVORK5CYII=','base64');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
async function fixture(t,{runner,engineOptions={},onSave,saved:previous}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'frameo-fault-test-'));
 const saved=previous||new Map([[SETTINGS_KEY,{private_key:'17'.repeat(32),frames:{a:{peer_id:A},b:{peer_id:B},c:{peer_id:C}}}]]);
 const sends=[],events=[],created=[],logs=[];
 const originalMkdtemp=fs.mkdtemp;
 t.mock.method(fs,'mkdtemp',async(...args)=>{
  const value=await originalMkdtemp(...args);
  if(String(args[0]).includes('com.roue.frameo'))created.push(value);
  return value;
 });
 const app={stopping:false,log:value=>logs.push(value),homey:{
  settings:{get:key=>saved.get(key),async set(key,value){if(onSave)await onSave(key,value);saved.set(key,structuredClone(value))}},
  __:key=>key}};
 app.engine=new FrameoEngine({homey:app.homey,downloadTimeoutMs:2000,...engineOptions,
  runner:async details=>{
   sends.push(details.request.peer);
   assert.deepEqual(await fs.readFile(details.request.path),PNG);
   return runner?runner(details):{ok:true,result:{peer:details.request.peer,confirmed:true,mediaId:'123',bytes:PNG.length}};
  }});
 const devices=[A,B,C].map((id,index)=>({stopped:false,operation:null,getData:()=>({id}),getName:()=> 'Fixture '+index,
  sendPrepared:(handle,options)=>app.engine.sendPrepared(id,handle,options)}));
 app.getDevices=()=>devices;
 app.photoReceived={trigger:async(device,tokens)=>events.push(['received',device.getData().id,tokens])};
 app.photoFailed={trigger:async(device,tokens)=>events.push(['failed',device.getData().id,tokens])};
 app.groups=new FrameoGroups(app);app.transfers=new FrameoTransfers(app,{flowTimeoutMs:2000});
 app.uploads=new FrameoUploads(app,{tmpdir:directory,sweepMs:0});
 await app.uploads.ready;
 t.after(async()=>{
  app.stopping=true;const engineClosed=app.engine.close();
  await app.transfers.close();await app.uploads.close();await engineClosed;
  await fs.rm(directory,{recursive:true,force:true});
 });
 async function noSources(){for(const p of created)await assert.rejects(fs.lstat(p),{code:'ENOENT'})}
 return{app,directory,saved,sends,events,created,logs,noSources};
}
async function localHttp(t,handler){
 const sockets=new Set(),server=http.createServer(handler);
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket))});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve))});
 return 'http://127.0.0.1:'+server.address().port;
}
async function upload(f){
 const batch=await f.app.transfers.start({frameId:A});
 const started=await f.app.uploads.start({batchId:batch.batchId,mime:'image/png',bytes:PNG.length});
 await f.app.uploads.chunk({uploadId:started.uploadId,offset:0,data:PNG.toString('base64')});
 return started.uploadId;
}
test('an actual HTTP connection cut during source download creates no frame send and removes partial files',async t=>{
 let requests=0;
 const f=await fixture(t);
 const url=await localHttp(t,(request,response)=>{
  requests++;response.writeHead(200,{'Content-Type':'image/png','Content-Length':PNG.length+4096});
  response.write(PNG.subarray(0,16));setTimeout(()=>request.socket.destroy(),15);
 });
 const {jobId}=await f.app.transfers.enqueueManual({frameId:A,url});
 await assert.rejects(f.app.transfers.waitFor(jobId),{code:'TRANSFER_INCOMPLETE'});
 const job=(await f.app.transfers.get(jobId)).job;
 assert.equal(job.results[0].status,'failed');assert.equal(requests,1);assert.deepEqual(f.sends,[]);
 await f.noSources();
 assert(!JSON.stringify(f.saved.get(JOURNAL_KEY)).includes(url));
});
test('shutdown interrupts a real stalled HTTP source and queued uploads without leaving originals or auto sends',async t=>{
 const started=deferred(),connectionClosed=deferred(),f=await fixture(t);
 const url=await localHttp(t,(request,response)=>{
  response.writeHead(200,{'Content-Type':'image/png'});response.write(PNG.subarray(0,8));started.resolve();
  response.once('close',()=>connectionClosed.resolve());
 });
 const first=await f.app.transfers.enqueueManual({frameId:A,url});await started.promise;
 const uploadId=await upload(f),second=await f.app.uploads.finish({uploadId});
 f.app.stopping=true;const engineClosed=f.app.engine.close();
 await f.app.transfers.close();await f.app.uploads.close();await engineClosed;await connectionClosed.promise;
 for(const id of [first.jobId,second.jobId])assert.equal((await f.app.transfers.get(id)).job.results[0].status,'failed');
 assert.equal(f.app.uploads.stats().bytes,0);await f.noSources();assert.deepEqual(f.sends,[]);assert.deepEqual(f.events,[]);
});
test('an actual TCP loss after acceptance is uncertain for that receiver; the group continues once for each other receiver',async t=>{
 const accepted=[],sockets=new Set();
 const server=net.createServer(socket=>{
  sockets.add(socket);socket.once('close',()=>sockets.delete(socket));let input='';
  socket.on('data',chunk=>{
   input+=chunk;if(!input.includes('\n'))return;
   const peer=JSON.parse(input.trim()).peer;accepted.push(peer);
   if(peer===B){socket.destroy();return}
   socket.end(JSON.stringify({peer,confirmed:true,mediaId:peer===A?'1':'3',bytes:PNG.length}));
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve))});
 const f=await fixture(t,{runner:({request,signal})=>new Promise((resolve,reject)=>{
  let output='',settled=false;
  const socket=net.createConnection({host:'127.0.0.1',port:server.address().port,signal});
  function fail(){if(!settled){settled=true;reject(Object.assign(Error('Synthetic lost bridge'),{code:'ENGINE_NOT_READY',details:{started:true}}))}}
  socket.once('connect',()=>socket.write(JSON.stringify({peer:request.peer})+'\n'));
  socket.on('data',chunk=>output+=chunk);
  socket.once('end',()=>{if(!output)return fail();settled=true;resolve({ok:true,result:JSON.parse(output)})});
  socket.once('error',fail);socket.once('close',()=>{if(!settled)fail()});
 })});
 const group=(await f.app.groups.save({name:'Fixture group',frameIds:[A,B,C]})).group;
 const {jobId}=await f.app.transfers.enqueueFlow({groupId:group.id},'image',{async getStream(){return require('node:stream').Readable.from([PNG])}});
 await assert.rejects(f.app.transfers.waitFor(jobId),{code:'TRANSFER_INCOMPLETE'});
 const job=(await f.app.transfers.get(jobId)).job;
 assert.deepEqual(job.results.map(x=>x.status),['succeeded','uncertain','succeeded']);
 assert.equal(job.results[1].code,'SEND_UNVERIFIED');assert.deepEqual(accepted,[A,B,C]);assert.deepEqual(f.sends,[A,B,C]);
 assert.equal(f.events.filter(x=>x[0]==='received').length,2);assert.equal(f.events.filter(x=>x[0]==='failed').length,1);
 await f.noSources();
});
test('a partial append failure abandons the entire upload and frees quota without creating a send job',async t=>{
 const f=await fixture(t),batch=await f.app.transfers.start({frameId:A});
 const {uploadId}=await f.app.uploads.start({batchId:batch.batchId,mime:'image/png',bytes:PNG.length});
 const append=fs.appendFile;
 t.mock.method(fs,'appendFile',async(filename,bytes)=>{
  if(String(filename).includes('homey-frameo-upload-')){await append(filename,bytes.subarray(0,4));throw Object.assign(Error('PRIVATE FILE PATH'),{code:'EIO'})}
  return append(filename,bytes);
 });
 await assert.rejects(f.app.uploads.chunk({uploadId,offset:0,data:PNG.toString('base64')}),error=>error.code==='UPLOAD_FAILED'&&!error.message.includes('PRIVATE'));
 assert.equal(f.app.uploads.stats().bytes,0);assert.equal(f.app.uploads.stats().sessions,0);
 await assert.rejects(f.app.uploads.finish({uploadId}),{code:'UPLOAD_NOT_FOUND'});assert.deepEqual(f.sends,[]);await f.noSources();
});
test('shutdown waits for an in-flight append before unlinking the source and cannot finish it afterwards',async t=>{
 const f=await fixture(t),batch=await f.app.transfers.start({frameId:A});
 const {uploadId}=await f.app.uploads.start({batchId:batch.batchId,mime:'image/png',bytes:PNG.length});
 const entered=deferred(),gate=deferred(),append=fs.appendFile;
 t.mock.method(fs,'appendFile',async(...args)=>{entered.resolve();await gate.promise;return append(...args)});
 const writing=f.app.uploads.chunk({uploadId,offset:0,data:PNG.toString('base64')});await entered.promise;
 f.app.stopping=true;let closed=false;const closing=f.app.uploads.close().then(()=>{closed=true});
 await tick();assert.equal(closed,false);gate.resolve();await writing;await closing;
 assert.equal(f.app.uploads.stats().bytes,0);await f.noSources();assert.deepEqual(f.sends,[]);
 await assert.rejects(f.app.uploads.finish({uploadId}),{code:'TRANSFER_CANCELLED'});
});
test('a failed unlink retains its reservation and a later sweep releases it without leaking the path',async t=>{
 const f=await fixture(t),uploadId=await upload(f),remove=fs.rm;
 const replacement=t.mock.method(fs,'rm',async(folder,options)=>{
  if(String(folder).includes('homey-frameo-upload-'))throw Object.assign(Error('PRIVATE FILE PATH'),{code:'EBUSY'});
  return remove(folder,options);
 });
 await assert.rejects(f.app.uploads.abort({uploadId}),error=>error.code==='UPLOAD_FAILED'&&!error.message.includes('PRIVATE'));
 assert.equal(f.app.uploads.stats().bytes,PNG.length);
 replacement.mock.restore();await f.app.uploads.sweep();
 assert.equal(f.app.uploads.stats().bytes,0);await f.noSources();assert.deepEqual(f.sends,[]);
});
test('loss of the HTTP finish response cannot create a second send when the same finish is requested again',async t=>{
 const f=await fixture(t),uploadId=await upload(f);let calls=0;
 const url=await localHttp(t,async(request,response)=>{
  let input='';for await(const chunk of request)input+=chunk;
  const result=await f.app.uploads.finish(JSON.parse(input));
  if(++calls===1){request.socket.destroy();return}
  response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(result));
 });
 await assert.rejects(fetch(url,{method:'POST',body:JSON.stringify({uploadId})}));
 const accepted=await(await fetch(url,{method:'POST',body:JSON.stringify({uploadId})})).json();
 assert.equal((await f.app.transfers.waitFor(accepted.jobId)).status,'succeeded');
 assert.equal(calls,2);assert.deepEqual(f.sends,[A]);await f.noSources();
});
test('shutdown fences a late ACK, preserves an earlier receipt and restart recovery never replays pending members',async t=>{
 const entered=deferred(),late=deferred();
 const f=await fixture(t,{runner:async({request})=>{
  if(request.peer===B){entered.resolve();await late.promise}
  return{ok:true,result:{peer:request.peer,confirmed:true,mediaId:request.peer===A?'1':'2',bytes:PNG.length}};
 }});
 const group=(await f.app.groups.save({name:'Fixture group',frameIds:[A,B,C]})).group;
 const {jobId}=await f.app.transfers.enqueueManual({groupId:group.id,data:PNG.toString('base64'),mime:'image/png'});
 await entered.promise;
 const crashSnapshot=structuredClone(f.saved.get(JOURNAL_KEY));
 assert.deepEqual(crashSnapshot.jobs[0].results.map(x=>x.status),['succeeded','running','queued']);
 f.app.stopping=true;const engineClosed=f.app.engine.close();await f.app.transfers.close();await engineClosed;
 const frozen=structuredClone((await f.app.transfers.get(jobId)).job);
 assert.deepEqual(frozen.results.map(x=>x.status),['succeeded','uncertain','failed']);
 late.resolve();await tick();assert.deepEqual((await f.app.transfers.get(jobId)).job,frozen);
 assert.deepEqual(f.sends,[A,B]);assert.equal(f.events.filter(x=>x[0]==='received').length,1);
 assert.equal(f.events.filter(x=>x[0]==='failed').length,0,'Shutdown must not start consumer Flows');
 const store=new Map([[JOURNAL_KEY,crashSnapshot]]),restarted={stopping:false,homey:{settings:{get:key=>store.get(key),set:(key,value)=>store.set(key,structuredClone(value))},__:key=>key},getDevices:()=>[],log(){}};
 restarted.transfers=new FrameoTransfers(restarted);await restarted.transfers.ready;t.after(()=>restarted.transfers.close());
 const recovered=(await restarted.transfers.history()).jobs[0];
 assert.deepEqual(recovered.results.map(x=>x.status),['succeeded','uncertain','failed']);
 assert.equal(recovered.results[0].mediaId,'1');assert.equal(restarted.transfers.runtime.size,0);assert.equal(restarted.transfers.queue.length,0);
 await f.noSources();
});
test('journal storage failure after a receipt preserves success and prevents an unsafely untracked next send',async t=>{
 let failed=false;
 const f=await fixture(t,{onSave:(key,value)=>{
  if(key===JOURNAL_KEY&&!failed&&value.jobs[0]?.results[0]?.status==='succeeded'){
   failed=true;throw Error('Synthetic storage failure');
  }
 }});
 const group=(await f.app.groups.save({name:'Fixture group',frameIds:[A,B]})).group;
 const {jobId}=await f.app.transfers.enqueueManual({groupId:group.id,data:PNG.toString('base64'),mime:'image/png'});
 await assert.rejects(f.app.transfers.waitFor(jobId),{code:'TRANSFER_INCOMPLETE'});
 const job=(await f.app.transfers.get(jobId)).job;
 assert.equal(job.results[0].status,'succeeded');assert.equal(job.results[0].mediaId,'123');
 assert.equal(job.results[1].status,'failed');assert.equal(job.results[1].code,'TRANSFER_JOURNAL_FAILED');
 assert.deepEqual(f.sends,[A]);await f.noSources();
});

function realDevice(app, onStore) {
 const Module=require('node:module'),filename=path.resolve(__dirname,'../drivers/frameo/device.js');
 const compiled=new Module(filename,module),realRequire=Module.createRequire(filename);
 compiled.filename=filename;compiled.paths=Module._nodeModulePaths(path.dirname(filename));
 compiled.require=name=>name==='homey'?{Device:class{}}:realRequire(name);
 compiled._compile(require('node:fs').readFileSync(filename,'utf8'),filename);
 const device=new compiled.exports();
 Object.assign(device,{homey:{...app.homey,app,clock:{getTimezone:()=> 'UTC'},i18n:{getLanguage:()=> 'en'}},
  stopped:false,operation:null,lastResult:null,lastSent:null,lastError:null,preview:null,
  getData:()=>({id:A}),getName:()=> 'SDK fixture',getStoreValue:()=>null,getSetting:()=> 'Homey',
  hasCapability:()=>false,setAvailable:async()=>{},setUnavailable:async()=>{},error(){},
  setStoreValue:async(key,value)=>{if(onStore)await onStore(key,value)}});
 return device;
}
test('an exact receipt known before slow SDK persistence survives shutdown without consulting old device history',async t=>{
 const persisted=deferred(),gate=deferred(),f=await fixture(t);
 const device=realDevice(f.app,async(key,value)=>{
  if(key==='last_result'){persisted.resolve(structuredClone(value));await gate.promise}
 });
 f.app.getDevices=()=>[device];
 const {jobId}=await f.app.transfers.enqueueManual({frameId:A,data:PNG.toString('base64'),mime:'image/png'});
 const receipt=await persisted.promise;assert.equal(receipt.mediaId,'123');assert.equal(receipt.confirmed,true);
 assert.equal((await f.app.transfers.get(jobId)).job.results[0].status,'running','SDK persistence is still pending');
 f.app.stopping=true;const engineClosed=f.app.engine.close();await f.app.transfers.close();await engineClosed;
 const known=(await f.app.transfers.get(jobId)).job;
 assert.equal(known.results[0].status,'succeeded');assert.equal(known.results[0].mediaId,'123');
 assert.deepEqual(f.events,[],'No consumer Flow starts during shutdown');
 device.stopped=true;gate.resolve();await tick();
 assert.deepEqual((await f.app.transfers.get(jobId)).job,known);await f.noSources();
});
test('an SDK failure after the correlated receipt cannot downgrade that successful send',async t=>{
 const f=await fixture(t),device=f.app.getDevices()[0];
 Object.defineProperty(device,'lastResult',{get(){assert.fail('An unrelated historical receipt must never be consulted')}});
 device.sendPrepared=async(handle,options)=>{
  options.onConfirmedReceipt({confirmed:true,mediaId:'456',at:new Date().toISOString()});
  throw Error('Synthetic SDK storage failure after ACK');
 };
 const {jobId}=await f.app.transfers.enqueueManual({frameId:A,data:PNG.toString('base64'),mime:'image/png'});
 assert.equal((await f.app.transfers.waitFor(jobId)).results[0].mediaId,'456');
 assert.equal(f.events.filter(value=>value[0]==='received').length,1);assert.equal(f.events.filter(value=>value[0]==='failed').length,0);
 await f.noSources();
});
test('a callback arriving only after an uncertain terminal decision cannot rewrite it with a late ACK',async t=>{
 const f=await fixture(t),device=f.app.getDevices()[0],entered=deferred(),late=deferred();let callback;
 Object.defineProperty(device,'lastResult',{get(){assert.fail('Old receipt must not be used to infer this job')}});
 device.sendPrepared=async(handle,options)=>{callback=options.onConfirmedReceipt;entered.resolve();return late.promise};
 const {jobId}=await f.app.transfers.enqueueManual({frameId:A,data:PNG.toString('base64'),mime:'image/png'});await entered.promise;
 f.app.stopping=true;const engineClosed=f.app.engine.close();await f.app.transfers.close();await engineClosed;
 const terminal=(await f.app.transfers.get(jobId)).job;assert.equal(terminal.results[0].status,'uncertain');
 callback({confirmed:true,mediaId:'789',at:new Date().toISOString()});late.resolve({confirmed:true,mediaId:'789'});await tick();
 assert.deepEqual((await f.app.transfers.get(jobId)).job,terminal);assert.deepEqual(f.events,[]);await f.noSources();
});
