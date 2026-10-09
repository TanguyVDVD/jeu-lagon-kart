import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Client,type Room} from 'colyseus.js';
import {CUSTOM_TRACK_TEMPLATES,registerCustomTrackPreview,releaseCustomTrackPreview,validateCustomTrackDraft,type CustomTrackPreview} from '../shared/custom-tracks.js';
import {customTrackModule,moveCustomTrackModule,projectCustomTrackPoint,type TrackModuleSelection} from '../shared/custom-track-editing.js';
import {getAvailableTracks,getTrack,isPreviewTrackId,isTrackId} from '../shared/track.js';
import {getTrackEvent} from '../shared/track-events.js';
import {neutralInput,type World} from '../shared/game.js';

const draft=()=>structuredClone(CUSTOM_TRACK_TEMPLATES[0]!.draft);
test('private previews never become selectable circuits and release their definition',()=>{
  const before=getAvailableTracks().map(track=>track.id),source:CustomTrackPreview={id:`custom-private-${randomUUID()}-v1`,draft:draft()};
  const original=structuredClone(source),compiled=registerCustomTrackPreview(source);
  assert.equal(isPreviewTrackId(compiled.id),true);assert.equal(isTrackId(compiled.id),false);assert.equal(getTrack(compiled.id),compiled);
  assert.deepEqual(getAvailableTracks().map(track=>track.id),before);assert.deepEqual(source,original);
  assert.equal(registerCustomTrackPreview(source),compiled,'same snapshot is idempotent');
  assert.throws(()=>registerCustomTrackPreview({...source,draft:{...source.draft,width:30}}),/autre version/);
  getTrackEvent(compiled.id,0,3);releaseCustomTrackPreview(compiled.id);
  assert.equal(isPreviewTrackId(compiled.id),false);assert.notEqual(getTrack(compiled.id).id,compiled.id);assert.equal(isTrackId(compiled.id),false);
});

test('direct module placement preserves complete intervals, independent trigger and finite lane bounds',()=>{
  const source=draft();source.elevations=[{kind:'bridge',start:.2,end:.3,height:3,approach:10}];
  source.events=[{lap:2,kind:'rain',start:.6,end:.7}];source.interactions=[{kind:'boost',trigger:.1,start:.25,end:.29,width:8,offset:0,duration:10}];
  for(const group of ['zones','elevations','events','interactions'] as const){
    const selection={group,index:0},feature=customTrackModule(source,selection)!,length=feature.end-feature.start;
    for(const requested of [.48,2,-1]){assert.equal(moveCustomTrackModule(source,selection,requested),true);assert.ok(Math.abs(feature.end-feature.start-length)<1e-12);assert.ok(feature.start>=0&&feature.end<=1+1e-12);}
  }
  const targetStart=source.interactions[0]!.start,targetEnd=source.interactions[0]!.end;
  moveCustomTrackModule(source,{group:'interactions',index:0,handle:'trigger'},.8,1000);
  assert.equal(source.interactions[0]!.trigger,.8);assert.equal(source.interactions[0]!.start,targetStart);assert.equal(source.interactions[0]!.end,targetEnd);
  assert.equal(source.interactions[0]!.offset,(source.width-8)/2);assert.equal(validateCustomTrackDraft(source).ok,true);
  assert.equal(moveCustomTrackModule(source,{group:'track',index:0},.5),false);
  assert.equal(moveCustomTrackModule(source,{group:'zones',index:99},.5),false);
  assert.equal(moveCustomTrackModule(source,{group:'zones',index:0},NaN),false);
});

test('pointer projection stays finite with close anchors, crossings and coincident local points',()=>{
  const source=draft();source.anchors[1]={...source.anchors[0]!};source.anchors[3]={...source.anchors[6]!};
  for(const point of source.anchors){const projected=projectCustomTrackPoint(source,point,.4);assert.ok(projected&&Number.isFinite(projected.fraction+projected.offset));assert.ok(projected.fraction>=0&&projected.fraction<=1);}
  assert.equal(projectCustomTrackPoint(source,{x:Infinity,z:0}),undefined);
  source.anchors=source.anchors.map(()=>({x:0,z:0}));assert.equal(projectCustomTrackPoint(source,{x:1,z:1}),undefined);
});

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate:()=>boolean,label:string,timeout=7000){const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw Error(label);await pause(20);}}
type Peer={room:Room;world?:World;preview?:CustomTrackPreview;lastPreview?:CustomTrackPreview;notices:string[]};
function observe(room:Room):Peer{const peer:Peer={room,notices:[]};room.onMessage('snapshot',(value:{world:World;previewTrack?:CustomTrackPreview})=>{peer.world=value.world;peer.preview=value.previewTrack;if(value.previewTrack)peer.lastPreview=value.previewTrack;});room.onMessage('notice',(value:{message:string})=>peer.notices.push(value.message));room.onError(()=>{});return peer;}

test('private draft rooms hydrate only their owner, never persist and cannot leak into another room', {timeout:35000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'lagon-preview-test-')),oldPlayers=process.env.PLAYER_DATA_DIR,oldTracks=process.env.CUSTOM_TRACK_DATA_DIR;
  process.env.PLAYER_DATA_DIR=join(directory,'players');process.env.CUSTOM_TRACK_DATA_DIR=join(directory,'tracks');
  const {createGameServer}=await import('../server/app.js'),{playerStore}=await import('../server/career.js');
  const {gameServer,httpServer,ready}=createGameServer(directory),store=await ready,peers:Peer[]=[];
  t.after(async()=>{await Promise.allSettled(peers.filter(peer=>peer.room.connection.isOpen).map(peer=>peer.room.leave()));await gameServer.gracefullyShutdown(false);
    if(oldPlayers===undefined)delete process.env.PLAYER_DATA_DIR;else process.env.PLAYER_DATA_DIR=oldPlayers;
    if(oldTracks===undefined)delete process.env.CUSTOM_TRACK_DATA_DIR;else process.env.CUSTOM_TRACK_DATA_DIR=oldTracks;
    await rm(directory,{recursive:true,force:true});});
  await gameServer.listen(0,'127.0.0.1');const address=httpServer.address();assert.ok(address&&typeof address!=='string');
  const origin=`http://127.0.0.1:${address.port}`,sdk=new Client(origin.replace('http:','ws:')),players=await playerStore(),author=await players.createPlayer('Atelier privé');
  const source=draft();source.elevations=[{kind:'bridge',start:.56,end:.65,height:6,approach:20}];
  const original=structuredClone(source),before=players.getProfile(author.profile.id);
  const peer=observe(await sdk.create('race',{practice:true,previewDraft:source,workshop:{group:'elevations',index:0},token:author.token}));peers.push(peer);
  await until(()=>!!peer.preview&&!!peer.world,'preview source arrives');const id=peer.world!.trackId;
  assert.match(id,/^custom-private-/);assert.deepEqual(peer.preview!.draft,original);assert.equal(isTrackId(id),false);assert.equal(isPreviewTrackId(id),true);
  assert.equal(store.list().length,0);assert.deepEqual(await readdir(join(directory,'tracks')),[]);
  await assert.rejects(sdk.create('race',{trackId:id}),/inconnu/);await assert.rejects(sdk.create('race',{practice:true,trackId:id}),/inconnu/);
  await assert.rejects(sdk.create('race',{practice:false,previewDraft:source}),/solo privé/);
  await assert.rejects(sdk.create('race',{practice:true,previewDraft:source,workshop:{group:'elevations',index:999}}),/module existant/);
  await assert.rejects(sdk.joinById(peer.room.roomId,{}));
  const missing=await fetch(`${origin}/api/tracks/${id}`);assert.equal(missing.status,404);
  peer.room.send('tracksReady',{ids:[id]});await until(()=>peer.preview===undefined,'preview acknowledgement');
  peer.room.send('ready',{ready:true});await until(()=>peer.world!.players[0]?.ready===true,'ready');peer.room.send('start');
  await until(()=>peer.world?.phase==='racing','private workshop starts');const initial={x:peer.world!.players[0]!.x,z:peer.world!.players[0]!.z};
  const kart=peer.world!.players[0]!;for(let seq=0;seq<12;seq++){peer.room.send('input',{...neutralInput(seq,kart.epoch),throttle:1});await pause(35);}
  await until(()=>Math.hypot(peer.world!.players[0]!.x-initial.x,peer.world!.players[0]!.z-initial.z)>1,'ordinary controls move the preview kart');
  peer.room.send('workshop-restart');await until(()=>Math.hypot(peer.world!.players[0]!.x-initial.x,peer.world!.players[0]!.z-initial.z)<.01,'restart same private approach');
  await peer.room.leave();await until(()=>!isPreviewTrackId(id),'preview definition released on dispose');
  assert.deepEqual(players.getProfile(author.profile.id),before);assert.deepEqual((await players.listReplays(author.profile.id)),[]);
  assert.equal(store.list().length,0);assert.deepEqual(await readdir(join(directory,'tracks')),[]);
  const all=observe(await sdk.create('race',{practice:true,previewDraft:{...source,name:'Essai complet'},token:author.token}));peers.push(all);
  await until(()=>!!all.world?.workshop,'full preview workshop');assert.equal(all.world!.workshop!.selection.group,'track');assert.notEqual(all.world!.trackId,id);
  const allId=all.world!.trackId;await all.room.leave();await until(()=>!isPreviewTrackId(allId),'full preview released');
  const published=await store.save({id:author.profile.id,name:author.profile.name},source);
  assert.equal(store.list().length,1);assert.equal(isTrackId(published.runtimeId),true);assert.equal(published.runtimeId.startsWith('custom-private-'),false);assert.deepEqual(published.draft,original);
});
