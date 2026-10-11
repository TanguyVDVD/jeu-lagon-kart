import test from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOM_TRACK_TEMPLATES, registerCustomTrack, type CustomTrackDraft } from '../shared/custom-tracks.js';
import { PICKUP_RESPAWN_SECONDS, createKart, createWorld, neutralInput, resetKart, startRace, stepKart, stepWorld, type Kart } from '../shared/game.js';
import { nearestTrack, trackElevation, trackPoint, type TrackDefinition } from '../shared/track.js';
import { autopilot } from '../shared/autopilot.js';
import { nearestDriveableTrack } from '../shared/track-events.js';

function track(name: string, triple = false): TrackDefinition {
  const draft: CustomTrackDraft = structuredClone(CUSTOM_TRACK_TEMPLATES.find(t => t.id === 'figure-eight')!.draft);
  draft.zones = [];
  if (triple) {
    draft.width = 12;
    draft.anchors = [[-130,0],[-65,0],[0,0],[65,0],[130,0],[130,100],[0,130],[0,65],[0,0],[0,-65],[0,-130],[-130,-130],[-100,-100],[-50,-50],[0,0],[50,50],[100,100],[150,150],[170,-160],[-160,-160]].map(([x,z]) => ({ x:x!, z:z! }));
  }
  return registerCustomTrack({ id: `custom-physics-${name}`, revision: 1, draft,
    createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z' });
}
function driver(track: TrackDefinition, id: string, progress: number, lateral = 0): Kart {
  const kart = createKart(id, id, '#fc735d', 0, track.id), point = trackPoint(progress, track.id);
  Object.assign(kart, point, { x: point.x + Math.cos(point.angle) * lateral, z: point.z - Math.sin(point.angle) * lateral,
    progress, routeProgress: progress, elevation: trackElevation(progress, track.id), speed: 20 });
  return kart;
}

for (const triple of [false, true]) test(`${triple ? 'three' : 'two'} floors keep their own motion and deterministic prediction through the crossing`, () => {
  const road = track(`motion-${triple}`, triple);
  const crossings = triple ? road.crossings!.filter(c => Math.hypot(c.x, c.z) < .001) : road.crossings!;
  const passes = [...new Set(crossings.flatMap(c => [c.lowerProgress, c.upperProgress]))];
  assert.equal(passes.length, triple ? 3 : 2);
  for (const progress of passes) for (const lateral of [0, road.width * .32]) {
    const kart = driver(road, `floor-${progress}`, progress - 8, lateral), predicted = structuredClone(kart);
    const height = trackElevation(progress, road.id);
    for (let tick = 0; tick < 32; tick++) {
      const input = { ...neutralInput(tick), throttle: 1 };
      stepKart(kart, input, 1 / 30); stepKart(predicted, input, 1 / 30);
      assert.deepEqual(predicted, kart, 'prediction uses the same surface coordinate');
      assert.ok(Math.abs(kart.elevation - height) < 1.1, `stays near its ${height} m deck, got ${kart.elevation}`);
      assert.ok(Math.abs(kart.routeProgress! - progress) < 35, 'does not teleport to the other route');
      assert.equal(kart.airborne, false);
    }
    assert.ok(kart.routeProgress! > progress + 5, 'really drove through the crossing');
  }
});

test('karts, traps and mystery boxes cannot interact through an overpass', () => {
  const road = track('contacts'), crossing = road.crossings![0]!;
  const world = createWorld(false, road.id), low = driver(road, 'low', crossing.lowerProgress), high = driver(road, 'high', crossing.upperProgress);
  world.phase = 'racing'; world.players = [low, high]; world.pickups = [];
  low.speed = high.speed = 0;
  const before = [low, high].map(kart => ({ x: kart.x, z: kart.z }));
  world.objects = [{ id: 'low-trap', kind: 'trap', owner: low.id, x: low.x, z: low.z, angle: 0, ttl: 10,
    progress: crossing.lowerProgress, elevation: low.elevation }];
  stepWorld(world, new Map(), 1 / 30);
  assert.equal(high.stun, 0); assert.equal(world.objects.length, 1);
  for (const [i, kart] of [low, high].entries()) assert.ok(Math.hypot(kart.x - before[i]!.x, kart.z - before[i]!.z) < 1e-8, 'different floors do not shove each other');
  world.objects = []; world.players = [low];
  world.pickups = [{ id: 'upper-box', x: high.x, z: high.z, progress: crossing.upperProgress, elevation: high.elevation, cooldown: 0 }];
  stepWorld(world, new Map(), 1 / 30);
  assert.equal(low.item, ''); assert.equal(world.pickups[0]!.cooldown, 0);
  world.players = [high]; stepWorld(world, new Map(), 1 / 30);
  assert.notEqual(high.item, ''); assert.equal(world.pickups[0]!.cooldown, PICKUP_RESPAWN_SECONDS);
  const victim = driver(road, 'same-floor', crossing.lowerProgress); victim.speed = 0;
  world.players = [low, victim]; world.pickups = [];
  low.spectator = true;
  world.objects = [{ id: 'same-floor-trap', kind: 'trap', owner: low.id, x: victim.x, z: victim.z, angle: 0, ttl: 10,
    progress: crossing.lowerProgress, elevation: victim.elevation }];
  stepWorld(world, new Map(), 1 / 30);
  assert.ok(victim.stun > 0, 'same-floor attacks retain their collision');
});

test('an upper checkpoint ignores the lower road and its reset preserves the upper floor', () => {
  const road = track('checkpoint'), crossing = road.crossings![0]!, gate = trackPoint(crossing.upperProgress, road.id);
  road.checkpoints[1] = { ...gate, progress: crossing.upperProgress };
  const world = createWorld(false, road.id); world.phase = 'racing'; world.pickups = [];
  for (const [progress, valid] of [[crossing.lowerProgress, false], [crossing.upperProgress, true]] as const) {
    const kart = driver(road, valid ? 'upper' : 'lower', progress);
    Object.assign(kart, { x: gate.x - Math.sin(gate.angle) * .1, z: gate.z - Math.cos(gate.angle) * .1, angle: gate.angle, speed: 15 });
    world.players = [kart]; stepWorld(world, new Map([[kart.id, { ...neutralInput(), throttle: 1 }]]), 1 / 30);
    assert.equal(kart.nextCheckpoint, valid ? 2 : 1, 'only crossing the gate on its route validates it');
    if (valid) {
      kart.x += 20; kart.z += 20; kart.elevation = 0; kart.routeProgress = crossing.lowerProgress;
      resetKart(kart);
      assert.ok(Math.abs(kart.elevation - trackElevation(crossing.upperProgress, road.id)) < .01);
      const near = nearestDriveableTrack(kart.x, kart.z, road.id, 0, 0, { progress: kart.routeProgress, elevation: kart.elevation });
      assert.ok(Math.abs(near.progress - crossing.upperProgress) < 3);
    }
  }
});

test('stationary and moving jumps below two or three floors hit a ceiling and land on their own road', () => {
  for (const triple of [false, true]) {
    const road = track(`ceiling-${triple}`, triple);
    const centres = triple ? road.crossings!.filter(c => Math.hypot(c.x, c.z) < .001 && c.height - c.lowerHeight < 6) : road.crossings!;
    for (const crossing of centres) for (const speed of [0, 6]) {
      const kart = driver(road, 'jump', crossing.lowerProgress);
      Object.assign(kart, { speed, airborne: true, verticalVelocity: 15 });
      const maximumFoot = trackElevation(crossing.upperProgress, road.id) - crossing.deckThickness - 1.8;
      let touched = false;
      for (let tick = 0; tick < 65; tick++) {
        stepKart(kart, neutralInput(tick), 1 / 30);
        assert.ok(kart.elevation <= maximumFoot + 1e-6, 'the kart cannot pass through the concrete deck');
        touched ||= Math.abs(kart.elevation - maximumFoot) < .001;
        assert.ok(Math.abs(kart.routeProgress! - crossing.lowerProgress) < 6, 'a head impact never selects the upper route');
      }
      assert.ok(touched); assert.ok(Math.abs(kart.elevation - crossing.lowerHeight) < .001); assert.equal(kart.airborne, false);
    }
  }
});

test('a swept projectile and slipstream remain on their own floor', () => {
  const road = track('projectile-draft'), crossing = road.crossings![0]!;
  const world = createWorld(false, road.id), low = driver(road, 'low', crossing.lowerProgress), high = driver(road, 'high', crossing.upperProgress);
  world.phase = 'racing'; world.players = [low, high]; world.pickups = [];
  low.speed = high.speed = 20; high.angle = low.angle;
  high.x = low.x + Math.sin(low.angle) * 6; high.z = low.z + Math.cos(low.angle) * 6;
  stepWorld(world, new Map(), .1);
  assert.equal(low.draftCharge, 0, 'traffic above the kart cannot create an aerodynamic draft');
  const target = driver(road, 'target', crossing.upperProgress); target.speed = 0;
  world.players = [target];
  const point = trackPoint(crossing.lowerProgress, road.id);
  world.objects = [{ id: 'under-shot', kind: 'projectile', owner: low.id, x: point.x - Math.sin(point.angle) * 3,
    z: point.z - Math.cos(point.angle) * 3, angle: point.angle, ttl: 4, progress: crossing.lowerProgress - 3, elevation: 0 }];
  stepWorld(world, new Map(), .1);
  assert.equal(target.stun, 0); assert.equal(world.objects.length, 1);
  assert.ok(Math.abs(world.objects[0]!.progress! - crossing.lowerProgress) < 5);
  assert.equal(world.objects[0]!.elevation, 0);
});

test('a normal two-player figure-eight race completes all ordered laps with ordinary inputs', t => {
  const road = track('complete-race'), world = createWorld(false, road.id);
  world.players = [createKart('one', 'One', '#fc735d', 0, road.id), createKart('two', 'Two', '#76eeeb', 1, road.id)];
  startRace(world);
  const floors = new Set<number>();
  for (let tick = 0; tick < 30 * 220 && world.phase !== 'finished'; tick++) {
    stepWorld(world, new Map(world.players.map(kart => [kart.id, autopilot(kart, tick, true)])), 1 / 30);
    for (const kart of world.players) {
      const near = nearestTrack(kart.x, kart.z, road.id, { progress: kart.routeProgress, elevation: kart.elevation });
      if (Math.abs(near.progress - road.crossings![0]!.upperProgress) < 4) floors.add(1);
      if (Math.abs(near.progress - road.crossings![0]!.lowerProgress) < 4) floors.add(0);
      assert.ok(Number.isFinite(kart.elevation));
    }
  }
  assert.equal(world.phase, 'finished');
  assert.equal(world.players.filter(kart => kart.finished && kart.lap === 3).length, 2);
  assert.deepEqual([...floors].sort(), [0, 1]);
  t.diagnostic(`2/2 completed three laps in ${world.raceTime.toFixed(2)} simulated seconds`);
});
