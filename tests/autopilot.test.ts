import test from 'node:test';
import assert from 'node:assert/strict';
import { autopilot } from '../shared/autopilot.js';
import { createKart, createWorld, stepWorld, trackPoint, nearestTrack, getTrack } from '../shared/game.js';
import { trackElevation } from '../shared/track.js';
import { getTrackEvent } from '../shared/track-events.js';

function stoppedBeforeClosure() {
  const world = createWorld(true, 'neon');
  world.phase = 'racing'; world.eventLevel = 3; world.eventStage = 1; world.pickups = [];
  const kart = createKart('late', 'Retardataire', '#fc735d', 0, 'neon');
  const track = getTrack('neon'), blocker = getTrackEvent('neon', 1, 3).blockers[0]!;
  const progress = nearestTrack(blocker.x, blocker.z, track.id).progress - blocker.halfLength - .4;
  const nextCheckpoint = Math.floor(progress / (track.length / track.checkpoints.length)) + 1;
  const gate = track.checkpoints[nextCheckpoint - 1]!;
  Object.assign(kart, { ...trackPoint(progress, track.id), elevation: trackElevation(progress, track.id),
    nextCheckpoint, progress, eventLevel: 3, eventStage: 1,
    respawnX: gate.x + Math.sin(gate.angle) * 2, respawnZ: gate.z + Math.cos(gate.angle) * 2,
    respawnAngle: gate.angle });
  world.players = [kart]; return { world, kart };
}

test('a closure before the next gate requests ordinary recovery without changing the driver', () => {
  const { kart } = stoppedBeforeClosure(), before = structuredClone(kart);
  const input = autopilot(kart, 37);
  assert.equal(input.reset, true, 'a stationary kart before its next gate must not push the new barricade forever');
  assert.equal(input.seq, 37); assert.equal(input.epoch, kart.epoch);
  assert.deepEqual(kart, before, 'the driver emits commands and cannot grant position or progress');
  kart.resetCooldown = .1; assert.equal(autopilot(kart, 38).reset, false);
  kart.resetCooldown = 0; kart.resetLatch = true; assert.equal(autopilot(kart, 39).reset, false);
});

test('closure recovery does not reset a moving kart or one genuinely clearing the debris in flight', () => {
  const { kart } = stoppedBeforeClosure();
  kart.speed = 18; assert.equal(autopilot(kart, 1).reset, false);
  const debris = getTrackEvent('neon', 1, 3).blockers[0]!;
  kart.speed = 0; kart.elevation = debris.elevation + debris.height + 1;
  kart.airborne = true; assert.equal(autopilot(kart, 2).reset, false);
  kart.airborne = false; assert.equal(autopilot(kart, 3).reset, false, 'actual vertical clearance also prevents a false collision');
  Object.assign(kart, trackPoint(25, 'neon'), { nextCheckpoint: 1, elevation: trackElevation(25, 'neon') });
  assert.equal(autopilot(kart, 4).reset, false, 'a normal stopped kart must still launch normally');
});

test('a late closure can be recovered through ordinary inputs and the next gate is physically reached', () => {
  const { world, kart } = stoppedBeforeClosure();
  const previousCheckpoint = kart.nextCheckpoint;
  let resets = 0;
  for (let tick = 0; tick < 30 * 12 && kart.nextCheckpoint === previousCheckpoint; tick++) {
    const input = autopilot(kart, tick); resets += Number(input.reset);
    stepWorld(world, new Map([[kart.id, input]]), 1 / 30);
    assert.equal(kart.lap, 0, 'recovery cannot complete a lap');
  }
  assert.equal(resets, 1, 'a single valid recovery must not loop at the old closed route');
  assert.equal(kart.nextCheckpoint, (previousCheckpoint + 1) % getTrack(kart.trackId).checkpoints.length,
    'the next gate is reached by driving after recovery');
  assert.equal(kart.finished, false);
  assert.ok(kart.speed > 5);
});
