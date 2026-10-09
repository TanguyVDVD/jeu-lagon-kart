import test from 'node:test';
import assert from 'node:assert/strict';
import { COLORS, TOTAL_LAPS, TRACKS, createKart, createWorld, getTrack, neutralInput,
  resetKart, stepWorld, type World } from '../shared/game.js';
import { eventCheckpointGates, getTrackEvent, nearestDriveableTrack } from '../shared/track-events.js';
import { trackElevation } from '../shared/track.js';

function race(trackId = 'lagon', eventLevel = 0): World {
  const world = createWorld(true, trackId); world.phase = 'racing'; world.pickups = []; world.eventLevel = eventLevel;
  world.players = [createKart('driver', 'Pilote', COLORS[0]!, 0, trackId)];
  world.players[0]!.eventLevel = eventLevel; return world;
}
type Gate = { x: number; z: number; angle: number; width?: number; branchId?: string };
function cross(world: World, gate: Gate, offset = 0, reverse = false, dt = 1 / 30, distance = 0.15) {
  const kart = world.players[0]!, sign = reverse ? -1 : 1;
  kart.x = gate.x + Math.cos(gate.angle) * offset - Math.sin(gate.angle) * distance * sign;
  kart.z = gate.z - Math.sin(gate.angle) * offset - Math.cos(gate.angle) * distance * sign;
  kart.angle = gate.angle + (reverse ? Math.PI : 0); kart.speed = 18;
  kart.turnVelocity = 0; kart.lateralVelocity = 0; kart.resetLatch = false;
  stepWorld(world, new Map([[kart.id, { ...neutralInput(), throttle: 1 }]]), dt);
}

for (const track of TRACKS) test(`${track.id}: a legal shoulder trajectory counts three full laps without missing a gate`, () => {
  const world = race(track.id), kart = world.players[0]!;
  for (let lap = 0; lap < TOTAL_LAPS; lap++) {
    for (let gate = 1; gate < track.checkpoints.length; gate++) {
      cross(world, track.checkpoints[gate]!, track.width / 2 + 3);
      assert.equal(kart.nextCheckpoint, (gate + 1) % track.checkpoints.length, `lap ${lap}, gate ${gate}: the physical shoulder remains driveable`);
    }
    cross(world, track.checkpoints[0]!, -(track.width / 2 + 3));
    assert.equal(kart.lap, lap + 1, 'finish line also covers the physical shoulder');
  }
  assert.equal(kart.finished, true); assert.equal(world.phase, 'finished');
});

test('starting exactly on an uncredited checkpoint plane then moving forward credits it once', () => {
  const world = race(), kart = world.players[0]!, gate = getTrack('lagon').checkpoints[1]!;
  cross(world, gate, 0, false, 1 / 30, 0);
  assert.equal(kart.nextCheckpoint, 2);
  cross(world, gate, 0, false, 1 / 30, 0);
  assert.equal(kart.nextCheckpoint, 2);
});

test('stationary, reverse, out-of-order and far outside crossings never manufacture a checkpoint or lap', () => {
  const world = race(), kart = world.players[0]!, track = getTrack('lagon');
  Object.assign(kart, track.checkpoints[1]!, { speed: 0 });
  stepWorld(world, new Map(), 1 / 30); assert.equal(kart.nextCheckpoint, 1);
  cross(world, track.checkpoints[1]!, 0, true); assert.equal(kart.nextCheckpoint, 1);
  cross(world, track.checkpoints[4]!); assert.equal(kart.nextCheckpoint, 1);
  cross(world, track.checkpoints[1]!, track.width / 2 + 50); assert.equal(kart.nextCheckpoint, 1);
  cross(world, track.checkpoints[0]!); assert.equal(kart.lap, 0);
});

test('reset returns to the last validated checkpoint without treating its teleport as a crossing', () => {
  const world = race(), kart = world.players[0]!, track = getTrack('lagon');
  cross(world, track.checkpoints[1]!); assert.equal(kart.nextCheckpoint, 2);
  const respawn = { x: kart.respawnX, z: kart.respawnZ };
  Object.assign(kart, track.checkpoints[4]!, { speed: 0 });
  stepWorld(world, new Map([[kart.id, { ...neutralInput(), reset: true }]]), 1 / 30);
  assert.equal(kart.nextCheckpoint, 2); assert.equal(kart.lap, 0);
  assert.equal(kart.x, respawn.x); assert.equal(kart.z, respawn.z);
});

test('100 ms movement sweeps through the expected gate and finish-line jitter cannot replay a lap', () => {
  const world = race(), kart = world.players[0]!, track = getTrack('lagon');
  for (let gate = 1; gate < track.checkpoints.length; gate++) cross(world, track.checkpoints[gate]!, 0, false, 0.1);
  cross(world, track.checkpoints[0]!, 0, false, 0.1); assert.equal(kart.lap, 1);
  for (let i = 0; i < 5; i++) { cross(world, track.checkpoints[0]!, 0, true); cross(world, track.checkpoints[0]!); }
  assert.equal(kart.lap, 1); assert.equal(kart.nextCheckpoint, 1);
});

for (const track of TRACKS) test(`${track.id}: every real branch credits its own ordered gates for three laps`, () => {
  const routes = getTrackEvent(track.id, 2, 1).branches;
  for (const route of routes) {
    const world = race(track.id, 1), kart = world.players[0]!; world.eventStage = 2;
    let branchGates = 0;
    for (let lap = 0; lap < TOTAL_LAPS; lap++) {
      for (let index = 1; index < track.checkpoints.length; index++) {
        const gates = eventCheckpointGates(track.id, index, 2, 1);
        const gate = gates.find(candidate => candidate.branchId === route.id) ?? gates[0]!;
        if (gate.branchId) branchGates++;
        cross(world, gate);
        assert.equal(kart.nextCheckpoint, (index + 1) % track.checkpoints.length, `${route.kind}, lap ${lap}, gate ${index}`);
      }
      cross(world, track.checkpoints[0]!); assert.equal(kart.lap, lap + 1);
    }
    assert.ok(branchGates >= 6, 'a branch crosses several genuine intermediate checkpoints');
    assert.equal(kart.finished, true);
  }
});

test('branch respawn stays on the actual validated route and skipping an intermediate branch gate is rejected', () => {
  const track = getTrack('lagon'), routes = getTrackEvent(track.id, 2, 1).branches;
  const route = routes.find(candidate => candidate.kind === 'shortcut')!;
  const gates = track.checkpoints.flatMap((checkpoint, index) => eventCheckpointGates(track.id, index, 2, 1)
    .filter(gate => gate.branchId === route.id).map(gate => ({ gate, index, distance: Math.hypot(gate.x - checkpoint.x, gate.z - checkpoint.z) })));
  assert.ok(gates.length >= 2);
  const farthest = [...gates].sort((a, b) => b.distance - a.distance)[0]!;
  const world = race(track.id, 1), kart = world.players[0]!; world.eventStage = 2;
  kart.nextCheckpoint = farthest.index;
  cross(world, farthest.gate);
  assert.equal(kart.nextCheckpoint, farthest.index + 1);
  assert.ok(Math.hypot(kart.respawnX - farthest.gate.x - Math.sin(farthest.gate.angle) * 2,
    kart.respawnZ - farthest.gate.z - Math.cos(farthest.gate.angle) * 2) < 1e-6);
  Object.assign(kart, track.checkpoints[10]!, { speed: 0 });
  stepWorld(world, new Map([[kart.id, { ...neutralInput(), reset: true }]]), 1 / 30);
  assert.equal(nearestDriveableTrack(kart.x, kart.z, track.id, 2, 1).branchId, route.id);
  assert.equal(kart.nextCheckpoint, farthest.index + 1);
  const skipped = race(track.id, 1); skipped.eventStage = 2; skipped.players[0]!.nextCheckpoint = gates[0]!.index;
  cross(skipped, gates[1]!.gate);
  assert.equal(skipped.players[0]!.nextCheckpoint, gates[0]!.index);
  assert.equal(skipped.players[0]!.lap, 0);
});

test('a kart crossing a checkpoint in flight still validates that checkpoint', () => {
  const world = race(), kart = world.players[0]!, gate = getTrack('lagon').checkpoints[1]!;
  Object.assign(kart, { elevation: 4, verticalVelocity: 2, airborne: true });
  cross(world, gate);
  assert.equal(kart.nextCheckpoint, 2);
  assert.equal(kart.airborne, true); assert.ok(kart.elevation > 3);
  assert.equal(kart.lap, 0);
});

test('reset lands on the actual elevated branch and clears flight without altering checkpoint credit', () => {
  const candidate = TRACKS.flatMap(track => track.checkpoints.flatMap((_, index) =>
    eventCheckpointGates(track.id, index, 2, 1).filter(gate => gate.branchId && trackElevation(gate.progress, track.id) > 1)
      .map(gate => ({ track, gate, index }))))[0]!;
  assert.ok(candidate, 'an elevated branch checkpoint exists');
  const { track, gate, index } = candidate;
  const world = race(track.id, 1), kart = world.players[0]!;
  kart.eventStage = world.eventStage = 2;
  Object.assign(kart, { respawnX: gate.x, respawnZ: gate.z, respawnAngle: gate.angle,
    nextCheckpoint: index + 1, lap: 1, elevation: 40, verticalVelocity: 10, airborne: true });
  resetKart(kart);
  const ground = nearestDriveableTrack(kart.x, kart.z, track.id, 2, 1);
  assert.equal(ground.branchId, gate.branchId);
  assert.ok(trackElevation(ground.progress, track.id) > 1);
  assert.equal(kart.elevation, trackElevation(ground.progress, track.id));
  assert.equal(kart.airborne, false); assert.equal(kart.verticalVelocity, 0);
  assert.equal(kart.nextCheckpoint, index + 1); assert.equal(kart.lap, 1);
});

test('a newly closed road resets to the same validated gate on its open detour without granting progress', () => {
  for (const track of TRACKS) {
    const detour = getTrackEvent(track.id, 1, 3).branches.find(branch => branch.kind === 'detour')!;
    const index = track.checkpoints.findIndex((checkpoint, index) => index > 0 &&
      checkpoint.progress > detour.start && checkpoint.progress < detour.end &&
      // Past the junction: where both roads still overlap, the original gate already serves the detour.
      eventCheckpointGates(track.id, index, 1, 3).some(gate => gate.branchId === detour.id && Math.hypot(gate.x - checkpoint.x, gate.z - checkpoint.z) > 3) &&
      !nearestDriveableTrack(checkpoint.x + Math.sin(checkpoint.angle) * 2, checkpoint.z + Math.cos(checkpoint.angle) * 2, track.id, 1, 3).branchId);
    assert.ok(index > 0, track.id + ': a main-road gate lies inside the closure sector');
    const main = track.checkpoints[index]!, kart = createKart('late', 'Retardataire', COLORS[0]!, 0, track.id);
    const original = { x: main.x + Math.sin(main.angle) * 2, z: main.z + Math.cos(main.angle) * 2 };
    Object.assign(kart, { respawnX: original.x, respawnZ: original.z, respawnAngle: main.angle,
      nextCheckpoint: (index + 1) % track.checkpoints.length, lap: 1, progress: track.length + main.progress + 7,
      eventLevel: 3, eventStage: 0, padLaps: { previous: 1 } });
    resetKart(kart);
    assert.equal(kart.x, original.x); assert.equal(kart.z, original.z, 'before closure the original respawn is preserved');
    const progression = { next: kart.nextCheckpoint, lap: kart.lap, progress: kart.progress };
    kart.eventStage = 1; resetKart(kart);
    const gate = eventCheckpointGates(track.id, index, 1, 3).find(gate => gate.branchId === detour.id)!;
    assert.equal(kart.x, gate.x + Math.sin(gate.angle) * 2); assert.equal(kart.z, gate.z + Math.cos(gate.angle) * 2);
    assert.equal(kart.angle, gate.angle); assert.deepEqual({ next: kart.nextCheckpoint, lap: kart.lap, progress: kart.progress }, progression);
    assert.deepEqual(kart.padLaps, { previous: 1 }); assert.equal(kart.verticalVelocity, 0); assert.equal(kart.airborne, false);
    resetKart(kart); assert.equal(kart.x, gate.x + Math.sin(gate.angle) * 2, 'repeated reset keeps the chosen equivalent gate');
  }
});

test('active closures preserve respawns outside their sector and an already chosen open shortcut', () => {
  const track = getTrack('neon'), kart = createKart('safe', 'Sans détour', COLORS[0]!, 0, track.id);
  Object.assign(kart, { eventLevel: 3, eventStage: 2 });
  const start = { x: kart.respawnX, z: kart.respawnZ, angle: kart.respawnAngle };
  resetKart(kart); assert.deepEqual({ x: kart.x, z: kart.z, angle: kart.angle }, start);
  const shortcut = getTrackEvent(track.id, 2, 3).branches.find(branch => branch.kind === 'shortcut')!;
  const index = track.checkpoints.findIndex(checkpoint => checkpoint.progress > shortcut.start && checkpoint.progress < shortcut.end);
  const gate = eventCheckpointGates(track.id, index, 2, 3).find(gate => gate.branchId === shortcut.id)!;
  Object.assign(kart, { respawnX: gate.x + Math.sin(gate.angle) * 2, respawnZ: gate.z + Math.cos(gate.angle) * 2,
    respawnAngle: gate.angle, nextCheckpoint: index + 1 });
  resetKart(kart);
  assert.equal(kart.x, gate.x + Math.sin(gate.angle) * 2); assert.equal(kart.z, gate.z + Math.cos(gate.angle) * 2);
  assert.equal(kart.nextCheckpoint, index + 1); assert.equal(kart.lap, 0);
});
