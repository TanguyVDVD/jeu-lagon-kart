import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CUSTOM_TRACK_TEMPLATES, compileCustomTrack, registerCustomTrack, validateCustomTrackDraft, type StoredCustomTrack } from '../shared/custom-tracks.js';
import { getTrackLapCount, getTrackRaceTimeLimit, getTrackReplayTimeLimit, trackElevation, trackPoint } from '../shared/track.js';
import { dynamicSurface, getTrackEvent } from '../shared/track-events.js';
import { COLORS, createKart, createWorld, neutralInput, startRace, stepKart, stepWorld } from '../shared/game.js';
import { autopilot } from '../shared/autopilot.js';
import { CustomTrackStore } from '../server/custom-track-store.js';
import { ReplayRecorder } from '../server/competitive.js';
import { PlayerStore, validateReplay } from '../server/player-store.js';

function source(name: string): StoredCustomTrack {
  const draft = structuredClone(CUSTOM_TRACK_TEMPLATES[0]!.draft);
  draft.lapCount = 6;
  draft.elevations = [
    {kind:'bridge',start:.1,end:.24,height:5,approach:25},
    {kind:'jump',start:.4,end:.42,height:2,approach:0,launchSpeed:7},
  ];
  draft.events = [
    {lap:2,kind:'rain',start:.3,end:.36},
    {lap:4,kind:'ice',start:.72,end:.75},
    {lap:5,kind:'boost',start:.26,end:.28},
  ];
  return {id:`custom-modules-${name}`,revision:1,draft,createdAt:'2026-10-07T00:00:00.000Z',updatedAt:'2026-10-07T00:00:00.000Z'};
}

test('custom modules compile into real bridge and jump geometry without mutating the draft',()=>{
  const saved=source('geometry'), before=structuredClone(saved), track=registerCustomTrack(saved);
  assert.equal(getTrackLapCount(track.id),6); assert.equal(getTrackLapCount('lagon'),3);
  assert.equal(getTrackRaceTimeLimit(track.id),600); assert.equal(getTrackRaceTimeLimit('lagon'),300);
  assert.deepEqual(saved,before); assert.equal(track.elevations.length,2);
  assert.equal(trackElevation(track.length*.17,track.id),5);
  assert.ok(Math.abs(trackElevation(track.length*.41,track.id)-1)<1e-8);
  assert.equal(track.elevations[1]!.launchSpeed,7);
});

test('new authored options reject malformed values while preserving optional historical draft fields',()=>{
  const plain=structuredClone(CUSTOM_TRACK_TEMPLATES[0]!.draft);
  assert.deepEqual(validateCustomTrackDraft(plain).draft,plain);
  for(const patch of [
    {lapCount:0},{lapCount:21},{lapCount:3.5},
    {elevations:[{kind:'bridge',start:.2,end:.4,height:5,approach:0}]},
    {elevations:[{kind:'jump',start:.2,end:.3,height:5,approach:0,launchSpeed:26}]},
    {events:[{lap:4,kind:'rain',start:.2,end:.3}]},
    {events:[{lap:2,kind:'unknown',start:.2,end:.3}]},
    {events:[{lap:2,kind:'rain',start:.4,end:.3}]},
  ]) assert.equal(validateCustomTrackDraft({...plain,...patch}).ok,false,JSON.stringify(patch));
  // Drafts saved while loopings existed still load; the retired module is dropped.
  const retired=validateCustomTrackDraft({...plain,loops:[{start:.2,end:.3,height:20,lateralSpread:10}]});
  assert.equal(retired.ok,true); assert.deepEqual(retired.draft,plain);
});

test('scheduled effects activate only on their leader lap, including laps beyond three, and change real driving',()=>{
  const saved=source('events'), track=registerCustomTrack(saved);
  const at=(fraction:number)=>trackPoint(track.length*fraction,track.id);
  for(const [stage,weather] of [[0,'clear'],[1,'rain'],[2,'clear'],[3,'clear'],[4,'clear'],[5,'clear']] as const)
    assert.equal(getTrackEvent(track.id,stage,0).weather,weather);
  const wet=at(.33), ice=at(.735), turbo=at(.27);
  assert.equal(dynamicSurface(wet.x,wet.z,track.id,0).surface,'road');
  assert.equal(dynamicSurface(wet.x,wet.z,track.id,1).surface,'mud');
  assert.equal(dynamicSurface(wet.x,wet.z,track.id,2).surface,'road');
  assert.equal(dynamicSurface(ice.x,ice.z,track.id,3).surface,'ice');
  assert.equal(dynamicSurface(ice.x,ice.z,track.id,4).surface,'road');
  assert.equal(dynamicSurface(turbo.x,turbo.z,track.id,4).surface,'boost');
  const first=createKart('first','Leader',COLORS[0]!,0,track.id), second=createKart('second','Autre',COLORS[1]!,1,track.id);
  const world=createWorld(false,track.id);world.players=[first,second];startRace(world);world.phase='racing';first.lap=4;
  stepWorld(world,new Map(),1/30);
  assert.equal(world.eventStage,4);assert.equal(second.eventStage,4,'all players receive the leader phase, not their own lap');
  Object.assign(second,turbo,{eventStage:4,speed:12,lap:1,stun:0,elevation:0,airborne:false});
  stepKart(second,{...neutralInput(),throttle:1},1/30);assert.ok(second.boost>0,'temporary turbo applies real acceleration');
  const normal=createKart('normal','Normal',COLORS[0]!,0,track.id), muddy=createKart('muddy','Boue',COLORS[1]!,1,track.id);
  Object.assign(normal,wet,{speed:30,eventStage:0});Object.assign(muddy,wet,{speed:30,eventStage:1});
  stepKart(normal,neutralInput(),.1);stepKart(muddy,neutralInput(),.1);
  assert.ok(muddy.speed<normal.speed,'scheduled rain slows the kart on its marked road zone');
});

test('all modules and lap rules survive publication, immutable versions and reopening data',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'lagon-track-modules-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=await CustomTrackStore.open(directory), draft=source('storage').draft;
  const first=await store.save({id:'architect',name:'Architecte'},draft);
  const original=await readFile(join(directory,first.runtimeId+'.json'),'utf8');
  const next={...structuredClone(draft),lapCount:8};
  const second=await store.save({id:'architect',name:'Architecte'},next,first.id,first.revision);
  const reopened=await CustomTrackStore.open(directory);
  assert.deepEqual(reopened.get(first.runtimeId)!.draft,draft);assert.deepEqual(reopened.get(second.runtimeId)!.draft,next);
  assert.equal(await readFile(join(directory,first.runtimeId+'.json'),'utf8'),original);
  assert.equal(getTrackLapCount(first.runtimeId),6);assert.equal(getTrackLapCount(second.runtimeId),8);
  assert.deepEqual(compileCustomTrack(reopened.get(first.runtimeId)!),compileCustomTrack(first));
});

test('eight CPUs complete six laps through a bridge, a jump and lap-specific events',t=>{
  const track=registerCustomTrack(source('race')), world=createWorld(false,track.id);world.eventLevel=3;
  world.players=Array.from({length:8},(_,index)=>createKart(`cpu-${index}`,`CPU ${index}`,COLORS[index]!,index,track.id));
  startRace(world);let reachedFourth=false,jumpSeen=false;const stages=new Set<number>();
  for(let tick=0;tick<30*500 && world.phase!=='finished';tick++){
    stepWorld(world,new Map(world.players.map(kart=>[kart.id,autopilot(kart,tick,true)])),1/30);
    if(world.players.some(kart=>kart.lap===3 && !kart.finished))reachedFourth=true;
    jumpSeen ||= world.players.some(kart=>kart.airborne);
    stages.add(world.eventStage);
  }
  t.diagnostic(JSON.stringify({raceTime:world.raceTime,phase:world.phase,laps:world.players.map(k=>k.lap),jumpSeen}));
  assert.ok(reachedFourth);assert.ok(jumpSeen);
  assert.equal(world.phase,'finished');assert.equal(world.players.filter(kart=>kart.finished&&kart.lap===6).length,8);
  assert.ok(stages.has(4)&&stages.has(5));
});

test('twenty-lap replay recording and results exceed old six-minute limits while staying bounded and persistent',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'lagon-long-replay-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const saved=source('replay');saved.draft.lapCount=20;const track=registerCustomTrack(saved);
  const now=Date.now(),store=await PlayerStore.open(directory,{now:()=>now}),identity=await store.createPlayer('Endurance');
  const recorder=new ReplayRecorder({id:'twenty-lap-replay',trackId:track.id,createdAt:now});
  const kart={playerId:identity.profile.id,name:'Endurance',color:COLORS[0]!,x:0,z:0,angle:0,speed:20,lap:0,rank:1,finished:false,finishTime:0};
  for(let tick=0;tick<=30*2000;tick++)recorder.sample(tick/30,[{...kart,lap:Math.min(19,Math.floor(tick/3000))}]);
  const replay=recorder.finish(2000,[{...kart,lap:20,finished:true,finishTime:1999.5}]);
  assert.equal(replay.durationMs,2_000_000);assert.equal(replay.drivers[0]!.frames.at(-1)![5],20);
  assert.ok(replay.drivers[0]!.frames.length<=1802);assert.ok(Buffer.byteLength(JSON.stringify(replay))<2*1024*1024);
  assert.equal(getTrackReplayTimeLimit(track.id),2060);assert.deepEqual(validateReplay(replay),replay);
  await store.saveReplay(replay);
  await store.recordRace({id:replay.id,trackId:track.id,ranked:false,finishedAt:now,entries:[{playerId:kart.playerId,rank:1,finished:true,finishTime:1999.5}]});
  const reopened=await PlayerStore.open(directory,{now:()=>now});assert.deepEqual(await reopened.getReplay(replay.id),replay);
  assert.equal(reopened.getProfile(kart.playerId)!.stats.bestTimes[track.id],1999.5);
});
