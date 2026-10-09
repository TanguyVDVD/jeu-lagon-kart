import test from 'node:test';
import assert from 'node:assert/strict';
import { getCpuInput } from '../shared/cpu.js';
import { createKart, createWorld, stepWorld, validateInput } from '../shared/game.js';
import { TRACKS, getTrack, nearestTrack, trackElevation, trackPoint } from '../shared/track.js';
import { getTrackEvent, nearestDriveableTrack, pointOnBranch, type TrackBranch } from '../shared/track-events.js';
import { trackBoundaryHeight, trackBoundaryShoulder } from '../shared/obstacle-heights.js';

/** A physically reachable mid-race fixture, with only earlier gates validated.
 * After setup, the CPU can only act through ordinary server input commands. */
function driveFrom(trackId: string, level: number, progress: number, options: {
  lateral?: number; branch?: TrackBranch; closeRoad?: boolean;
} = {}) {
  const track = getTrack(trackId), world = createWorld(true, trackId);
  Object.assign(world, { phase: 'racing', eventLevel: level, eventStage: options.branch ? 2 : 0, pickups: [] });
  const kart = createKart('cpu', 'CPU', '#fc735d', 0, trackId);
  const position = options.branch ? pointOnBranch(options.branch, progress) : trackPoint(progress, trackId);
  const nextCheckpoint = (Math.floor(progress / (track.length / track.checkpoints.length)) + 1) % track.checkpoints.length;
  const previous = track.checkpoints[(nextCheckpoint + track.checkpoints.length - 1) % track.checkpoints.length]!;
  const previousGate = options.branch && previous.progress > options.branch.start
    ? pointOnBranch(options.branch, previous.progress) : previous;
  const lateral = options.lateral ?? 0;
  Object.assign(kart, position, {
    x: position.x + Math.cos(position.angle) * lateral, z: position.z - Math.sin(position.angle) * lateral,
    cpu: true, speed: 22, elevation: trackElevation(progress, trackId), nextCheckpoint, progress,
    eventLevel: level, eventStage: world.eventStage,
    respawnX: previousGate.x + Math.sin(previousGate.angle) * 2,
    respawnZ: previousGate.z + Math.cos(previousGate.angle) * 2, respawnAngle: previousGate.angle,
  });
  world.players = [kart];
  // One normal movement precedes the leader-triggered closure. This catches
  // changes while a following driver has already passed the branch entrance.
  if (options.closeRoad) {
    stepWorld(world, new Map([[kart.id, getCpuInput(kart, 0, world, level / 3)]]), 1 / 30);
    world.eventStage = 1;
  }
  // For an engaged branch, include its merge and the first main-road gate after
  // the exit; stopping at two gates can leave half of a long branch untested.
  const gateSpacing = track.length / track.checkpoints.length;
  const requiredGates = options.branch
    ? Math.floor(options.branch.end / gateSpacing) + 1 - Math.floor(progress / gateSpacing) : 2;
  let advanced = 0, resets = 0, stationaryTicks = 0, maximumStationaryTicks = 0;
  const gates: number[] = [];
  for (let tick = 1; tick <= 30 * (options.branch ? 25 : 20) && advanced < requiredGates; tick++) {
    const before = { x: kart.x, z: kart.z, checkpoint: kart.nextCheckpoint, lap: kart.lap };
    const input = getCpuInput(kart, tick, world, level / 3);
    assert.ok(validateInput(input), 'the CPU must use the normal input contract');
    resets += Number(input.reset);
    stepWorld(world, new Map([[kart.id, input]]), 1 / 30);
    if (input.reset) {
      assert.equal(kart.nextCheckpoint, before.checkpoint, 'recovery cannot grant a checkpoint');
      assert.equal(kart.lap, before.lap, 'recovery cannot grant a lap');
    }
    if (kart.nextCheckpoint !== before.checkpoint) {
      assert.equal(kart.nextCheckpoint, (before.checkpoint + 1) % track.checkpoints.length);
      gates.push(before.checkpoint); advanced++;
    }
    stationaryTicks = Math.hypot(kart.x - before.x, kart.z - before.z) < .02 ? stationaryTicks + 1 : 0;
    maximumStationaryTicks = Math.max(maximumStationaryTicks, stationaryTicks);
  }
  return { advanced, requiredGates, resets, maximumStationarySeconds: maximumStationaryTicks / 30, gates,
    final: { x: kart.x, z: kart.z, speed: kart.speed, checkpoint: kart.nextCheckpoint } };
}

for (const track of TRACKS) test(`${track.id}: CPUs already on the main road survive event changes at levels 1, 2 and 3`, () => {
  const event = getTrackEvent(track.id, 1, 3), route = event.branches.find(branch => branch.kind === 'detour')!;
  const blocker = event.blockers[0]!, wall = nearestTrack(blocker.x, blocker.z, track.id).progress;
  const positions = [
    ['past the entrance', (route.start + wall) / 2],
    ['before the barrier', wall - blocker.halfLength - 1.3],
    ['inside appearing debris', wall],
    ['past the barrier', wall + blocker.halfLength + 2],
  ] as const;
  for (const level of [1, 2, 3]) for (const [name, progress] of positions) {
    const result = driveFrom(track.id, level, progress, { closeRoad: true });
    const message = `${track.id}, level ${level}, ${name}: ${JSON.stringify(result)}`;
    assert.equal(result.advanced, 2, message);
    assert.ok(result.maximumStationarySeconds < 3, message);
    assert.ok(result.resets <= 1, `a recovery must not loop: ${message}`);
  }
});

for (const [trackId, location] of [['mangrove', 'after'], ['castle', 'before'], ['foundry', 'after']] as const)
  test(`${trackId}: a late closure does not strand CPU drivers in either outside lane`, () => {
    const track = getTrack(trackId), blocker = getTrackEvent(trackId, 1, 3).blockers[0]!;
    const wall = nearestTrack(blocker.x, blocker.z, trackId).progress;
    const progress = location === 'after' ? wall + blocker.halfLength + 2 : wall - blocker.halfLength - 1.3;
    for (const lateral of [-track.width * .35, track.width * .35]) {
      const result = driveFrom(trackId, 3, progress, { lateral, closeRoad: true });
      const message = `${trackId}, lateral ${lateral}: ${JSON.stringify(result)}`;
      assert.equal(result.advanced, 2, message);
      assert.ok(result.maximumStationarySeconds < 3, message);
      assert.ok(result.resets <= 1, message);
    }
  });

for (const track of TRACKS) test(`${track.id}: a CPU already on an open branch follows it to actual checkpoints`, () => {
  for (const level of [1, 3]) for (const branch of getTrackEvent(track.id, 2, level).branches) {
    const result = driveFrom(track.id, level, (branch.start + branch.end) / 2, { branch });
    const message = `${track.id}, level ${level}, ${branch.kind}: ${JSON.stringify(result)}`;
    assert.equal(result.advanced, result.requiredGates, message);
    assert.ok(result.maximumStationarySeconds < 3, message);
    assert.equal(result.resets, 0, `an open branch must be drivable without recovery: ${message}`);
  }
});

test('a CPU pressing a real rail requests only a valid grounded recovery', () => {
  const track = getTrack('lagon');
  // A kart stopped against a closed rail whose guided route lies beyond it: the
  // inside of a bend. The circuit decides where; the driver must ask to recover there.
  const stopped = (progress: number, side: number) => {
    const position = trackPoint(progress, track.id), offset = side * (track.width / 2 + trackBoundaryShoulder(progress, track.id) - .001);
    const kart = createKart('rail', 'Rail', '#fc735d', 0, track.id);
    Object.assign(kart, position, { x: position.x - Math.cos(position.angle) * offset,
      z: position.z + Math.sin(position.angle) * offset, speed: 1, progress,
      nextCheckpoint: Math.floor(progress / (track.length / track.checkpoints.length)) + 1,
      eventStage: 1, eventLevel: 3, elevation: trackElevation(progress, track.id) });
    return kart;
  };
  const kart = Array.from({ length: Math.floor(track.length / 5) }, (_, index) => index * 5 + 20).flatMap(progress => [1, -1].map(side => stopped(progress, side)))
    .find(candidate => getCpuInput(candidate, 37).reset)!;
  assert.ok(kart, 'some closed rail of the circuit stands between a stopped kart and its route');
  const before = structuredClone(kart), near = nearestDriveableTrack(kart.x, kart.z, track.id, 1, 3);
  assert.ok(Math.abs(near.distance - near.width / 2 - trackBoundaryShoulder(near.progress, track.id, near.branchId)) < .01);
  const recovery = getCpuInput(kart, 37);
  assert.equal(recovery.reset, true);
  assert.deepEqual(validateInput(recovery), recovery);
  assert.equal(recovery.seq, 37); assert.equal(recovery.epoch, kart.epoch);
  assert.deepEqual(kart, before, 'requesting recovery cannot mutate simulation state');
  const aboveRail = trackElevation(near.progress, track.id) + trackBoundaryHeight(near.progress, track.id, near.branchId) + 1;
  for (const change of [{ airborne: true }, { elevation: aboveRail, airborne: false }, { speed: 18 },
    { resetCooldown: .1 }, { resetLatch: true }]) {
    assert.equal(getCpuInput({ ...kart, ...change }, 38).reset, false, JSON.stringify(change));
  }
});

test('open junctions let CPUs enter detours through ordinary controls without recovery', () => {
  for (const track of TRACKS) {
    const branch = getTrackEvent(track.id, 1, 3).branches.find(route => route.kind === 'detour')!;
    const result = driveFrom(track.id, 3, branch.start - 20, { closeRoad: true });
    const message = `${track.id}: ${JSON.stringify(result)}`;
    assert.equal(result.advanced, 2, message);
    assert.equal(result.resets, 0, `an open junction must not be mistaken for a wall: ${message}`);
  }
});
