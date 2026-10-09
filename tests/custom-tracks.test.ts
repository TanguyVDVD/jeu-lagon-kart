import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CUSTOM_TRACK_LIMITS, CUSTOM_TRACK_TEMPLATES, compileCustomTrack, customTrackRuntimeId, isCustomTrackRuntimeId,
  registerCustomTrack, sampleCustomTrackAnchors, validateCustomTrackDraft, type StoredCustomTrack } from '../shared/custom-tracks.js';
import { TRACKS, getAvailableTracks, getTrack, isTrackId, nearestTrack, spawnPoint, trackPoint, trackSurface } from '../shared/track.js';
import { COLORS, TOTAL_LAPS, createKart, createWorld, startRace, stepWorld } from '../shared/game.js';
import { getTrackEvent } from '../shared/track-events.js';
import { applyConfiguration, createTournament } from '../shared/tournament.js';
import { autopilot } from '../shared/autopilot.js';

function record(id: string, template = 0, revision = 1): StoredCustomTrack {
  return { id: `custom-${id}`, revision, draft: structuredClone(CUSTOM_TRACK_TEMPLATES[template]!.draft),
    createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' };
}
test('templates compile deterministically into smooth complete routes with a safe eight-player grid', () => {
  for (let index = 0; index < CUSTOM_TRACK_TEMPLATES.length; index++) {
    const source = record(`geometry-${index}`, index), input = structuredClone(source);
    const validation = validateCustomTrackDraft(source.draft);
    assert.deepEqual(validation.errors, []); assert.equal(validation.ok, true);
    assert.deepEqual(compileCustomTrack(source), compileCustomTrack(source));
    assert.deepEqual(source, input, 'validation and compilation do not mutate editor state');
    const track = registerCustomTrack(source);
    assert.equal(track.checkpoints.length, 12); assert.deepEqual(track.elevations, []); assert.equal(track.relief, undefined);
    assert.deepEqual(track.points, sampleCustomTrackAnchors(source.draft.anchors));
    for (let grid = 0; grid < 8; grid++) {
      const start = spawnPoint(grid, track.id), near = nearestTrack(start.x, start.z, track.id);
      assert.ok(near.distance + 1 < track.width / 2); assert.ok(near.progress > track.length - 25);
    }
    for (const checkpoint of track.checkpoints) {
      const near = nearestTrack(checkpoint.x, checkpoint.z, track.id);
      assert.ok(near.distance < 1e-6); assert.ok(Math.abs(near.progress - checkpoint.progress) < 1e-6);
    }
    assert.equal(trackSurface(spawnPoint(0,track.id).x,spawnPoint(0,track.id).z,track.id).surface, 'road');
    for (const zone of track.zones) {
      const point = trackPoint((zone.start+zone.end)/2,track.id);
      assert.equal(trackSurface(point.x + Math.cos(point.angle)*zone.offset,point.z-Math.sin(point.angle)*zone.offset,track.id).surface, zone.kind);
    }
  }
});

test('untrusted drafts reject broken structures but impose no driving-style restriction', () => {
  for (const input of [null, [], {}, { ...record('bad').draft, name: '' }, { ...record('bad').draft, width: 0 },
    { ...record('bad').draft, theme: '__proto__' }, { ...record('bad').draft, anchors: [{x:NaN,z:Infinity}] },
    { ...record('bad').draft, anchors: Array.from({length:CUSTOM_TRACK_LIMITS.maxAnchors+1},()=>({x:0,z:0})) },
    { ...record('bad').draft, anchors: [{x:0,z:0},{x:10,z:0},{x:Infinity,z:10}] },
    { ...record('bad').draft, anchors: [{x:0,z:0},{x:10,z:0},{x:2001,z:10}] },
    { ...record('bad').draft, anchors: Array.from({length:8},()=>({x:1,z:2})) },
    { ...record('bad').draft, zones: [{kind:'boost',start:-.1,end:.1,offset:0,width:8}] },
    { ...record('bad').draft, zones: [{kind:'boost',start:.1,end:1.1,offset:0,width:8}] },
    { ...record('bad').draft, zones: [{kind:'boost',start:.1,end:.1,offset:0,width:8}] },
    { ...record('bad').draft, zones: [{kind:'boost',start:.1,end:.12,offset:20,width:8}] },
    { ...record('bad').draft, zones: [{kind:'boost',start:.1,end:.12,offset:0,width:0}] },
  ]) {
    const result = validateCustomTrackDraft(input);
    assert.equal(result.ok, false); assert.ok(result.errors.length > 0);
  }
  assert.deepEqual(sampleCustomTrackAnchors([]), []);
});

function creativeSources(): StoredCustomTrack[] {
  const cross = record('creative-cross');
  [cross.draft.anchors[2], cross.draft.anchors[6]] = [cross.draft.anchors[6]!, cross.draft.anchors[2]!];
  const narrow = record('creative-narrow'); narrow.draft.anchors.forEach(point => { point.z *= .08; });
  const hairpin = record('creative-hairpin'); hairpin.draft.anchors[1] = {x:-15,z:-180};
  const duplicate = record('creative-duplicate'); duplicate.draft.anchors[1] = {...duplicate.draft.anchors[0]!};
  const repeated = record('creative-repeated'); repeated.draft.anchors.splice(1,0,...Array.from({length:5},()=>({...repeated.draft.anchors[0]!})));
  const short = record('creative-short'); short.draft.anchors.forEach(point => { point.x *= .06; point.z *= .06; }); short.draft.width = 4; short.draft.zones = [];
  const long = record('creative-long'); long.draft.anchors.forEach(point => { point.x *= 10; point.z *= 10; }); long.draft.width = 80;
  const triangle = record('creative-three'); triangle.draft.anchors = [{x:0,z:0},{x:80,z:0},{x:0,z:80}];
  const many = record('creative-many'); many.draft.anchors = Array.from({length:128},(_,index)=>({x:Math.sin(index*Math.PI/64)*200,z:Math.cos(index*Math.PI/64)*200}));
  const zones = record('creative-zones'); zones.draft.zones = Array.from({length:64},(_,index)=>({kind:index%2?'ice':'boost',start:0,end:1,offset:0,width:1}));
  return [cross,narrow,hairpin,duplicate,repeated,short,long,triangle,many,zones];
}

test('creative layouts with tight, coincident or crossing points compile and simulate without NaN', () => {
  for (const source of creativeSources()) {
    const validation = validateCustomTrackDraft(source.draft);
    assert.deepEqual(validation.errors, [], source.id); assert.equal(validation.ok, true, source.id);
    const track = registerCustomTrack(source);
    assert.ok(track.length > 0 && Number.isFinite(track.length), source.id);
    for (let sample = 0; sample <= 120; sample++) {
      const point = trackPoint((sample/120 - .1)*track.length, track.id);
      const near = nearestTrack(point.x,point.z,track.id);
      assert.ok(Object.values(point).every(Number.isFinite), source.id);
      assert.ok(Object.values(near).every(Number.isFinite), source.id);
    }
    const world = createWorld(false,track.id);
    world.players = Array.from({length:8},(_,index)=>createKart(String(index),`CPU ${index}`,COLORS[index]!,index,track.id));
    startRace(world);
    // Creative layouts can deliberately be hard or impossible; they still have
    // to accept input and simulate collisions/checkpoints without corrupt state.
    for(let tick=0;tick<390;tick++) stepWorld(world,new Map(world.players.map(kart=>[kart.id,autopilot(kart,tick,true)])),1/30);
    assert.ok(world.raceTime > 3, `${source.id}: validation includes actual driving after the countdown`);
    assert.ok(!JSON.stringify(world).includes('null'), `${source.id}: no NaN/Infinity in serialized race state`);
    assert.ok(world.players.every(kart=>Object.values(kart).filter(value=>typeof value==='number').every(Number.isFinite)),source.id);
  }
});

test('previously published geometry remains byte-for-byte compatible', () => {
  const hashes = ['83de90b781e940cdc7f2c5f4ac5d0fc85028ea0c3a919131c316fe244721e712','c3c149a0ac7054df8abb4bcbf72f8541422542e03365f6089682404855c1e86b'];
  for (let index=0;index<hashes.length;index++) {
    const track = compileCustomTrack(record(`historical-${index}`,index));
    // These fingerprints predate the retirement of loopings, when every circuit
    // carried an empty list between its checkpoints and its elevations.
    const published: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(track)) { published[key] = value; if (key === 'checkpoints') published.loops = []; }
    assert.equal(createHash('sha256').update(JSON.stringify(published)).digest('hex'),hashes[index]);
  }
});

test('editing previews cannot overwrite an existing race or immutable published revision', () => {
  const first = record('versions'), track = registerCustomTrack(first), start = trackPoint(120, track.id);
  const newer = record('versions', 1, 2); newer.draft.name = 'Nouvelle version';
  const next = registerCustomTrack(newer);
  const newestOnly = getAvailableTracks().filter(candidate => candidate.id.startsWith('custom-versions-'));
  assert.deepEqual(newestOnly, [next]); assert.equal(getTrack(track.id), track); assert.equal(getTrack(next.id), next);
  assert.equal(isTrackId(track.id), true); assert.equal(isTrackId(next.id), true);
  assert.equal(TRACKS.length, 12, 'the builtin catalogue and career stay fixed');
  for (const template of CUSTOM_TRACK_TEMPLATES) validateCustomTrackDraft(template.draft);
  assert.deepEqual(trackPoint(120, track.id), start, 'a preview never modifies a cached arc table');
  assert.equal(registerCustomTrack(first), track, 'receiving the same immutable snapshot is idempotent');
  const collision = {...first,draft:{...first.draft,name:'Changed without increment'}};
  assert.throws(()=>registerCustomTrack(collision),/déjà publiée/);
  assert.equal(registerCustomTrack(first), track); assert.deepEqual(getAvailableTracks().filter(t=>t.id.startsWith('custom-versions-')), [next]);
  assert.equal(isTrackId('custom-not-saved-v1'), false);
  assert.equal(isCustomTrackRuntimeId('custom-not-saved-v1'), true);
  for (const invalid of ['lagon','../custom-test-v1','custom-x-v0','custom-x-v10001','custom-x-v1-suffix','custom-x-vNaN']) assert.equal(isCustomTrackRuntimeId(invalid),false);
  assert.throws(()=>customTrackRuntimeId({...first,id:'../escape'}));
});

test('published custom routes can join mixed tournaments and never receive unsafe generated closures', () => {
  const saved = record('tournament'), track = registerCustomTrack(saved);
  const result = applyConfiguration(createTournament(), {mode:'tournament',selection:'manual',raceCount:2,schedule:['lagon',track.id]}, 'lagon');
  assert.deepEqual(result.tournament.schedule, ['lagon',track.id]);
  const random = applyConfiguration(createTournament(), {mode:'tournament',selection:'random',raceCount:2,trackPool:['lagon',track.id]}, 'lagon', ()=>.1);
  assert.deepEqual(new Set(random.tournament.schedule), new Set(['lagon',track.id]));
  for (const level of [0,1,2,3]) for (const stage of [0,1,2]) {
    const event = getTrackEvent(track.id,stage,level); assert.deepEqual(event.branches,[]); assert.deepEqual(event.blockers,[]);
    assert.equal(event.level,0); assert.equal(event.weather,'clear');
  }
});

for (const [label, template] of [['oval',0],['kidney',1],['ice',0],['reverse',1]] as const) test(`custom ${label}: eight CPU drivers finish three laps with normal items, collisions and checkpoints`, t => {
  const source = record(`cpu-${label}`,template);
  if (label === 'ice') {
    source.draft.theme = 'ice'; source.draft.width = 24;
    source.draft.zones.push({ kind:'ice',start:.3,end:.4,width:24,offset:0 },{ kind:'mud',start:.65,end:.7,width:8,offset:7 });
  }
  if (label === 'reverse') source.draft.anchors = [source.draft.anchors[0]!, ...source.draft.anchors.slice(1).reverse()];
  const track = registerCustomTrack(source);
  const world = createWorld(false, track.id);
  world.eventLevel = 3;
  world.players = Array.from({length:8},(_,index)=>createKart(String(index),`CPU ${index}`,COLORS[index]!,index,track.id));
  startRace(world);
  for(let tick=0;tick<30*200 && world.phase !== 'finished';tick++) {
    stepWorld(world,new Map(world.players.map(kart=>[kart.id,autopilot(kart,tick,true)])),1/30);
  }
  assert.equal(world.phase,'finished');
  assert.equal(world.players.filter(kart=>kart.finished && kart.lap===TOTAL_LAPS).length,8);
  assert.equal(new Set(world.players.map(kart=>kart.rank)).size,8);
  t.diagnostic(`${track.name}: 8/8 finish in ${world.raceTime.toFixed(2)} simulated seconds`);
});
