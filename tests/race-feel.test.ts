import test from 'node:test';
import assert from 'node:assert/strict';
import { COLORS, PICKUP_RESPAWN_SECONDS, START_GRACE_SECONDS, TRACKS, createKart, createWorld, getTrack, neutralInput,
  startRace, stepKart, stepWorld, cloneKartForPrediction, type World } from '../shared/game.js';
import { getTrackEvent, nearestDriveableTrack } from '../shared/track-events.js';

const dt = 1 / 30;
function grid(trackId = 'lagon', count = 2, eventLevel = 3): World {
  const world = createWorld(false, trackId); world.eventLevel = eventLevel;
  world.players = Array.from({ length: count }, (_, index) => createKart(`p${index}`, `Pilote ${index}`, COLORS[index]!, index, trackId));
  startRace(world); world.phase = 'racing'; world.countdown = 0;
  return world;
}

test('the bunched grid only draws a turbo or a shield from the first cubes', () => {
  const world = grid('lagon', 3), kart = world.players[2]!;
  for (let draw = 0; draw < 120; draw++) {
    kart.item = ''; kart.itemCharges = 0;
    world.pickups = [{ id: 'box', x: kart.x, z: kart.z, cooldown: 0 }];
    stepWorld(world, new Map(), dt);
    assert.equal(world.pickups[0]!.cooldown, PICKUP_RESPAWN_SECONDS);
    const drawn: string = kart.item;
    if (world.raceTime < START_GRACE_SECONDS) assert.ok(drawn === 'turbo' || drawn === 'shield', `${drawn} at ${world.raceTime.toFixed(2)} s`);
  }
  assert.ok(world.raceTime < START_GRACE_SECONDS);
});

for (const track of TRACKS) test(`${track.id}: cubes leave a barred road for the detour and never sit in the debris`, () => {
  const world = grid(track.id, 1), kart = world.players[0]!;
  const initial = world.pickups.map(pickup => ({ ...pickup }));
  world.pickups[0]!.cooldown = 2;
  for (const stage of [1, 2]) {
    kart.lap = stage; stepWorld(world, new Map(), dt);
    assert.equal(world.eventStage, stage);
    const event = getTrackEvent(track.id, stage, 3), detour = event.branches.find(route => route.kind === 'detour')!;
    assert.equal(event.blockers.length, 1);
    assert.equal(new Set(world.pickups.map(pickup => pickup.id)).size, initial.length);
    for (const pickup of world.pickups) {
      const road = nearestDriveableTrack(pickup.x, pickup.z, track.id, stage, 3, pickup);
      assert.ok(road.distance < road.width / 2, `${pickup.id} stays on a driveable surface`);
      for (const blocker of event.blockers) {
        const along = (pickup.x - blocker.x) * Math.sin(blocker.angle) + (pickup.z - blocker.z) * Math.cos(blocker.angle);
        const across = (pickup.x - blocker.x) * Math.cos(blocker.angle) - (pickup.z - blocker.z) * Math.sin(blocker.angle);
        assert.ok(Math.abs(along) > blocker.halfLength + 3 || Math.abs(across) > blocker.halfWidth + 3, `${pickup.id} is clear of the debris`);
      }
      const before = initial.find(candidate => candidate.id === pickup.id)!;
      const barred = before.progress! > detour.start && before.progress! < detour.end && /^pickup-/.test(pickup.id);
      if (barred) assert.ok(Math.hypot(pickup.x - before.x, pickup.z - before.z) > 0 || road.branchId === detour.id, `${pickup.id} moved`);
      else assert.deepEqual([pickup.x, pickup.z], [before.x, before.z], `${pickup.id} keeps its place on an open road`);
    }
  }
  assert.ok(world.pickups[0]!.cooldown > 1.8, 'a relocated cube keeps its cooldown');
});

test('cubes are placed beyond the flight path of a jump', () => {
  for (const track of TRACKS) {
    const world = grid(track.id, 1, 0);
    for (const pickup of world.pickups) for (const jump of getTrack(track.id).elevations.filter(feature => feature.kind === 'jump'))
      assert.ok(pickup.progress! < jump.start - 2 || pickup.progress! >= jump.end + 45 - 1e-6, `${track.id} ${pickup.id}`);
  }
});

test('a finisher rolls to a stop past the line; prediction and server agree and the result is final', () => {
  const world = grid('lagon', 2, 0), kart = world.players[0]!, track = getTrack('lagon'), line = track.checkpoints[0]!;
  world.pickups = [];
  kart.lap = 2; kart.nextCheckpoint = 0;
  kart.x = line.x - Math.sin(line.angle) * .4; kart.z = line.z - Math.cos(line.angle) * .4; kart.angle = line.angle; kart.speed = 36;
  kart.routeProgress = track.length - .4;
  const throttle = { ...neutralInput(), throttle: 1 };
  stepWorld(world, new Map([[kart.id, throttle]]), dt);
  assert.equal(kart.finished, true);
  assert.ok(kart.speed > 20, 'no frozen kart on the line');
  const finishTime = kart.finishTime, progress = kart.progress, predicted = cloneKartForPrediction(kart);
  let travelled = 0;
  for (let tick = 0; tick < 90; tick++) {
    const before = { x: kart.x, z: kart.z };
    stepWorld(world, new Map([[kart.id, throttle]]), dt); stepKart(predicted, throttle, dt);
    travelled += Math.hypot(kart.x - before.x, kart.z - before.z);
    assert.ok(Math.hypot(predicted.x - kart.x, predicted.z - kart.z) < 1e-6);
  }
  assert.equal(kart.speed, 0); assert.ok(travelled > 5 && travelled < 40, `stopped after ${travelled.toFixed(1)} m`);
  assert.equal(kart.finishTime, finishTime); assert.equal(kart.progress, progress); assert.equal(kart.lap, 3);
  const stopped = { x: kart.x, z: kart.z };
  stepWorld(world, new Map([[kart.id, throttle]]), dt);
  assert.deepEqual({ x: kart.x, z: kart.z }, stopped);
});
