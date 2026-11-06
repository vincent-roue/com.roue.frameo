'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {FrameoEngine}=require('../lib/frameo-engine');
const PEER='ab'.repeat(32),ID='9223372036854775807';
const CONFIG={private_key:'17'.repeat(32),client_name:'Test',default_frame:PEER,frames:{fixture:{peer_id:PEER,name:'Test'}}};
function fixture(t,runner){const calls=[];const engine=new FrameoEngine({homey:{settings:{get:()=>structuredClone(CONFIG),set(){assert.fail('Visibility must not replace identity')}}},runner:async value=>{calls.push(value.request);return runner(value.request)}});t.after(()=>engine.close());return{engine,calls}}
const reply=(visible,overrides={})=>({ok:true,result:{peer:PEER,mediaId:ID,visible,acknowledged:true,verified:true,...overrides},config:{private_key:'do-not-store'}});
test('visibility bridge sends one exact boolean and ID and returns only confirmed public metadata',async t=>{
 for(const visible of [false,true]){const f=fixture(t,req=>reply(visible,{secret:'PRIVATE'}));assert.deepEqual(await f.engine.setMediaVisible(PEER,ID,visible,{name:'My sender',path:'/unsafe',mediaIds:['1','2']}),{mediaId:ID,visible,acknowledged:true,verified:true});assert.equal(f.calls.length,1);const r=f.calls[0];assert.equal(r.operation,'setMediaVisible');assert.equal(r.visible,visible);assert.equal(r.mediaId,ID);assert.equal(r.peer,PEER);assert.equal(r.name,'My sender');assert(!('path'in r));assert(!('mediaIds'in r));}
});
test('invalid IDs or nonboolean visibility fail before starting a native operation',async t=>{
 const f=fixture(t,()=>assert.fail('No native mutation allowed'));
 for(const id of ['01','9223372036854775808','1;delete','',1])await assert.rejects(f.engine.setMediaVisible(PEER,id,false),{code:'INVALID_MEDIA_ID'});
 for(const visible of [undefined,null,0,1,'false',{},[]])await assert.rejects(f.engine.setMediaVisible(PEER,ID,visible),{code:'INVALID_VISIBILITY'});
 assert.equal(f.calls.length,0);
});
test('visibility success requires matching peer, exact ID, bool, ACK and verified flags',async t=>{
 for(const bad of [{peer:'cd'.repeat(32)},{mediaId:'1'},{visible:true},{visible:undefined},{acknowledged:false},{acknowledged:'true'},{verified:false},{verified:'true'}]){
  const f=fixture(t,()=>reply(false,bad));await assert.rejects(f.engine.setMediaVisible(PEER,ID,false),{code:'VISIBILITY_UNVERIFIED'});assert.equal(f.calls.length,1);
 }
});
test('ambiguous process errors are never retried and remain unverified',async t=>{
 for(const code of ['TIMEOUT','ABORTED','ENGINE_NOT_READY','VISIBILITY_UNVERIFIED']){
  const f=fixture(t,()=>({ok:false,error:{code,message:'PRIVATE TRACE'}}));
  await assert.rejects(f.engine.setMediaVisible(PEER,ID,false),e=>e.code==='VISIBILITY_UNVERIFIED'&&!e.message.includes('PRIVATE'));assert.equal(f.calls.length,1);
 }
 for(const code of ['PERMISSION_REQUIRED','MEDIA_NOT_FOUND']){
  const f=fixture(t,()=>({ok:false,error:{code,message:'PRIVATE TRACE'}}));await assert.rejects(f.engine.setMediaVisible(PEER,ID,false),{code});assert.equal(f.calls.length,1);
 }
});
