'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {FrameoGallery}=require('../lib/frameo-gallery');
const {FrameoWidget}=require('../lib/frameo-widget');
const {DevicePreview,PreviewCache}=require('../lib/device-preview');
const PEER='ab'.repeat(32),JPEG=Buffer.from([255,216,255,224,0,4,0,0,255,217]);
const preview={mime:'image/jpeg',data:JPEG.toString('base64'),bytes:JPEG.length,width:1,height:1};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
function fixture(t){
 const calls=[],events=[],state={mode:'manage',mayManage:true,pixels:null,index:null,visibilityError:null};
 const items=[
  {mediaId:'1',type:'photo',visible:true,captureDate:'2025-01-01T00:00:00Z',receiveDate:'2025-02-01T00:00:00Z'},
  {mediaId:'2',type:'photo',visible:true,captureDate:null,receiveDate:'2025-03-01T00:00:00Z'},
  {mediaId:'3',type:'greeting',visible:false,captureDate:'2024-01-01T00:00:00Z',receiveDate:null},
  {mediaId:'4',type:'video',visible:false,captureDate:null,receiveDate:null}];
 const device={stopped:false,operation:null,lastInfo:{mayView:true,mayManage:true},
  peer:()=>PEER,getData:()=>({id:PEER}),getName:()=> 'Frame',getSetting:()=> 'Sender',accessMode:()=>state.mode,
  publicStatus(){return{info:this.lastInfo}},
  async refreshInfo(){this.lastInfo={mayView:true,mayManage:state.mayManage};return this.lastInfo}};
 const app={stopping:false,activeTransfer:false,transferQueue:[],permissionTask:null,
  homey:{__:key=>key,api:{realtime(event,value){events.push({event,value})}}},
  previewCache:new PreviewCache(),async waitUntilReady(){},getDevices:()=>[device],
  getDevice(id){assert.equal(id,PEER);return device},
  engine:{async listMedia(){calls.push('list');return state.index?state.index.promise:structuredClone(items)},
   async previewMedia(peer,id){calls.push(['preview',id]);return state.pixels?state.pixels.promise:preview},
   async deleteMedia(peer,id){calls.push(['delete',id]);items.splice(items.findIndex(item=>item.mediaId===id),1);return{mediaId:id,deleted:true}},
   async setMediaVisible(peer,id,visible){calls.push(['visibility',id,visible]);if(state.visibilityError)throw Object.assign(Error('PRIVATE'),{code:state.visibilityError});items.find(item=>item.mediaId===id).visible=visible;return{mediaId:id,visible,acknowledged:true,verified:true}}}};
 device.homey={...app.homey,app};device.preview=new DevicePreview(device,{cache:app.previewCache,randomInt:()=>0});
 const gallery=new FrameoGallery(app);app.gallery=gallery;const widget=new FrameoWidget(app);
 t.after(async()=>{await device.preview.close();gallery.close()});
 async function authorize(id){const page=await gallery.list({id:PEER});await gallery.preview({id:PEER,mediaId:id,revision:page.revision});return page.revision}
 return{app,device,gallery,widget,calls,events,state,items,authorize};
}
test('delete clears only the matching selected widget preview and emits a public targeted event',async t=>{
 const f=fixture(t);const selected=await f.widget.state({deviceId:PEER});assert.equal(selected.mediaId,'1');
 const before=f.app.previewCache.get(PEER);let revision=await f.authorize('2');
 await f.gallery.delete({id:PEER,mediaId:'2',revision,confirmation:'delete'});
 assert.equal(f.app.previewCache.get(PEER),before,'Deleting another ID must preserve selected pixels');
 revision=await f.authorize('1');await f.gallery.delete({id:PEER,mediaId:'1',revision,confirmation:'delete'});
 assert.equal(f.app.previewCache.get(PEER),null);
 assert.deepEqual(f.events.at(-1),{event:'gallery.changed',value:{id:PEER,mediaId:'1',change:'delete'}});
});
test('mutation aborts a matching in-flight preview and late pixels cannot refill the widget cache',async t=>{
 const f=fixture(t),revision=await f.authorize('1');f.state.pixels=deferred();
 const pending=f.widget.state({deviceId:PEER});await tick();
 const rejection=assert.rejects(pending,{code:'ABORTED'});
 await f.gallery.delete({id:PEER,mediaId:'1',revision,confirmation:'delete'});
 await rejection;f.state.pixels.resolve(preview);await tick();
 assert.equal(f.app.previewCache.bytes,0);assert.equal(f.widget.pending.size,0);
});
test('targeted invalidation leaves a different already-selected in-flight preview intact',async t=>{
 const f=fixture(t);await f.widget.state({deviceId:PEER});f.state.pixels=deferred();
 const pending=f.widget.next({deviceId:PEER});await tick();assert.equal(f.device.preview.loadingMediaId,'2');
 f.device.preview.invalidateMedia('1');f.state.pixels.resolve(preview);
 const result=await pending;assert.equal(result.mediaId,'2');assert.equal(f.app.previewCache.get(PEER).mediaId,'2');
});
test('visibility requires preview, current rights, exact bool, revision and explicit confirmation',async t=>{
 const f=fixture(t),page=await f.gallery.list({id:PEER});
 const body={id:PEER,mediaId:'1',revision:page.revision,visible:false,confirmation:'visibility'};
 await assert.rejects(f.gallery.visibility(body),{code:'PREVIEW_REQUIRED'});
 await f.gallery.preview({id:PEER,mediaId:'1'});
 await assert.rejects(f.gallery.visibility({...body,visible:'false'}),{code:'GALLERY_INVALID_REQUEST'});
 await assert.rejects(f.gallery.visibility({...body,confirmation:'delete'}),{code:'GALLERY_INVALID_REQUEST'});
 f.state.mayManage=false;await assert.rejects(f.gallery.visibility(body),{code:'PERMISSION_REQUIRED'});
 assert(!f.calls.some(value=>Array.isArray(value)&&value[0]==='visibility'));assert.equal(f.gallery.deleting.size,0);
 f.state.mayManage=true;const result=await f.gallery.visibility(body);
 assert.deepEqual(result,{mediaId:'1',visible:false,acknowledged:true,verified:true});
 assert.equal(f.items.find(item=>item.mediaId==='1').visible,false);
 assert.deepEqual(await f.gallery.visibility(body),result,'A duplicate confirmed HTTP request must be idempotent');
 assert.equal(f.calls.filter(value=>Array.isArray(value)&&value[0]==='visibility').length,1);
});
test('uncertain visibility cannot repeat or authorize a different mutation before a fresh index',async t=>{
 const f=fixture(t),revision=await f.authorize('1');f.state.visibilityError='VISIBILITY_UNVERIFIED';
 const body={id:PEER,mediaId:'1',revision,visible:false,confirmation:'visibility'};
 await assert.rejects(f.gallery.visibility(body),e=>e.code==='VISIBILITY_UNVERIFIED'&&!e.message.includes('PRIVATE'));
 await assert.rejects(f.gallery.visibility(body),{code:'VISIBILITY_UNVERIFIED'});
 await assert.rejects(f.gallery.delete({...body,confirmation:'delete'}),{code:'GALLERY_STALE'});
 assert.equal(f.calls.filter(value=>Array.isArray(value)&&value[0]==='visibility').length,1);
 assert.equal(f.gallery.snapshots.size,0);assert.equal(f.gallery.deleting.size,0);
});
test('a visual selection or Flow shortcut targets one stored photo without fetching its bytes', async t => {
  const f = fixture(t), page = await f.gallery.list({ id: PEER });
  const body = { id: PEER, mediaId: '2', revision: page.revision };
  f.app.engine.displayMedia = async (peer, mediaId, { name }) => {
    f.calls.push(['display', peer, mediaId, name]);
    return { mediaId, requested: true };
  };
  assert.deepEqual(await f.gallery.selectDisplayPhoto(body), { mediaId: '2' });
  assert.deepEqual(f.calls, ['list']);
  await assert.rejects(f.gallery.display({ ...body, mediaId: '4' }), { code: 'MEDIA_TYPE_UNSUPPORTED' });
  await assert.rejects(f.gallery.selectDisplayPhoto({ ...body, revision: 'stale' }), { code: 'GALLERY_STALE' });
  await assert.rejects(f.gallery.display({ ...body, mediaId: '999' }), { code: 'MEDIA_NOT_FOUND' });
  f.device.lastInfo.mayManage = false;
  await assert.rejects(f.gallery.selectDisplayPhoto(body), { code: 'PERMISSION_REQUIRED' });
  await assert.rejects(f.gallery.display(body), { code: 'PERMISSION_REQUIRED' });
  f.device.lastInfo.mayManage = true;
  assert.deepEqual(await f.gallery.display(body), { mediaId: '2', requested: true });
  f.gallery.changed(PEER);
  assert.deepEqual(await f.gallery.displayPhoto(PEER, '2'), { mediaId: '2', requested: true });
  assert.deepEqual(f.calls, ['list', ['display', PEER, '2', 'Sender'], ['display', PEER, '2', 'Sender']]);
  assert.deepEqual(f.events, []);
});
test('gallery filters and date sorts are deterministic, missing dates last, and cursor options cannot change',async t=>{
 const f=fixture(t);let page=await f.gallery.list({id:PEER,type:'photo',visibility:'visible',sort:'received_desc',limit:1});
 assert.equal(page.total,2);assert.equal(page.items[0].id,'2');
 const next=await f.gallery.list({id:PEER,type:'photo',visibility:'visible',sort:'received_desc',limit:1,cursor:page.nextCursor});
 assert.equal(next.items[0].id,'1');
 await assert.rejects(f.gallery.list({id:PEER,sort:'captured_asc',cursor:page.nextCursor}),{code:'GALLERY_STALE'});
 page=await f.gallery.list({id:PEER,sort:'captured_asc'});
 assert.deepEqual(page.items.map(item=>item.id),['3','1','2','4']);
 page=await f.gallery.list({id:PEER,visibility:'hidden'});
 assert.deepEqual(page.items.map(item=>item.id),['3','4']);
 const before=f.calls.length;
 for(const bad of [{type:'image'},{visibility:false},{sort:'arbitrary'}])await assert.rejects(f.gallery.list({id:PEER,...bad}),{code:'GALLERY_INVALID_REQUEST'});
 assert.equal(f.calls.length,before);
});
test('an index started before a mutation cannot replace the invalidated snapshot afterwards',async t=>{
 const f=fixture(t),revision=await f.authorize('1');f.state.index=deferred();
 const listing=f.gallery.list({id:PEER});await tick();
 const rejection=assert.rejects(listing,{code:'GALLERY_STALE'});
 await f.gallery.visibility({id:PEER,mediaId:'1',revision,visible:false,confirmation:'visibility'});
 f.state.index.resolve(structuredClone(f.items));await rejection;assert.equal(f.gallery.snapshots.size,0);
});

test('empty or stale revisions never authorize a visibility or deletion command',async t=>{
 const f=fixture(t);await f.authorize('1');
 for(const revision of ['', 'wrong-snapshot']){
  await assert.rejects(f.gallery.visibility({id:PEER,mediaId:'1',revision,visible:false,confirmation:'visibility'}),{code:'GALLERY_STALE'});
  await assert.rejects(f.gallery.delete({id:PEER,mediaId:'1',revision,confirmation:'delete'}),{code:'GALLERY_STALE'});
 }
 assert(!f.calls.some(value=>Array.isArray(value)&&['visibility','delete'].includes(value[0])));
});
test('closing the gallery rejects a late uncancellable index instead of repopulating snapshots',async t=>{
 const f=fixture(t);f.state.index=deferred();const pending=f.gallery.list({id:PEER});await tick();
 const rejected=assert.rejects(pending,{code:'ABORTED'});f.gallery.close();f.state.index.resolve(structuredClone(f.items));
 await rejected;assert.equal(f.gallery.snapshots.size,0);assert.deepEqual(f.events,[]);
});
