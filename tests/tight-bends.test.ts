import test from 'node:test';
import assert from 'node:assert/strict';
import { COLORS, createKart, createWorld, neutralInput, startRace, stepKart, stepWorld } from '../shared/game.js';
import { getCpuInput } from '../shared/cpu.js';
import { getTrack, trackElevation, trackPoint } from '../shared/track.js';
import { registerCustomTrack, type StoredCustomTrack } from '../shared/custom-tracks.js';

// A player-made circuit with hairpins tighter than the road is wide, and two
// boost strips a second apart: the layout on which laps and boosts went missing.
const hairpins = { id: 'custom-tight-bends', revision: 1, createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z',
  draft: { name: 'Épingles', theme: 'forest', width: 20,
    anchors: [[-30.5, -88.5], [122.5, -116], [164.5, -79.5], [200.5, -81], [230, -8.5], [141.5, -44], [78, -17.5], [110, 23.5], [106.5, 40],
      [132.5, 88.5], [56.5, 94.5], [-18.5, 4.5], [-85, 16.5], [-101.5, -12.5], [-252, 9.5], [-117, -74.5]].map(([x, z]) => ({ x, z })),
    zones: [{ kind: 'boost', start: .08, end: .12, offset: 6, width: 8 }, { kind: 'boost', start: .14, end: .18, offset: 6, width: 8 }],
    elevations: [], events: [] } } as unknown as StoredCustomTrack;
const track = registerCustomTrack(hairpins);

function follow(lateral: number) {
  const world = createWorld(true, track.id); world.phase = 'racing'; world.pickups = []; world.eventLevel = 0;
  const kart = createKart('driver', 'Pilote', COLORS[0]!, 0, track.id); world.players = [kart];
  const coast = new Map([[kart.id, neutralInput()]]);
  const at = (progress: number) => { const point = trackPoint(progress, track.id); return { x: point.x + Math.cos(point.angle) * lateral, z: point.z - Math.sin(point.angle) * lateral }; };
  // Hold a constant distance from the centre line in one continuous movement,
  // never teleporting: on the inside of a hairpin this legal line folds back on
  // itself and never meets the flat gate.
  Object.assign(kart, at(1), { routeProgress: 1, elevation: trackElevation(1, track.id) });
  for (let progress = 1.3; progress <= track.length + 3 && !kart.lap; progress += .3) {
    const target = at(progress);
    for (let step = 0; step < 40 && !kart.lap; step++) {
      const distance = Math.hypot(target.x - kart.x, target.z - kart.z);
      if (distance < .05) break;
      Object.assign(kart, { angle: Math.atan2(target.x - kart.x, target.z - kart.z), speed: Math.min(40, distance * 30 * 1.04),
        turnVelocity: 0, lateralVelocity: 0, stun: 0, boost: 0, airborne: false, verticalVelocity: 0 });
      stepWorld(world, coast, 1 / 30);
    }
  }
  return kart;
}

for (const lateral of [-13, -9, 0, 9, 13]) test(`tight bends: a lap ${lateral} m from the centre line validates every gate`, () => {
  const kart = follow(lateral);
  assert.equal(kart.lap, 1, `stopped waiting for gate ${kart.nextCheckpoint} of ${getTrack(track.id).checkpoints.length}`);
  assert.equal(kart.nextCheckpoint, 1);
});

test('tight bends: a kart beyond the shoulder or driving backwards never validates a gate', () => {
  const outside = follow(track.width / 2 + 9);
  assert.equal(outside.lap, 0); assert.equal(outside.nextCheckpoint, 1);
  const world = createWorld(true, track.id); world.phase = 'racing'; world.pickups = []; world.eventLevel = 0;
  const kart = createKart('driver', 'Pilote', COLORS[0]!, 0, track.id); world.players = [kart];
  for (let progress = track.length - 1; progress > track.length * .5; progress -= .5) {
    const point = trackPoint(progress, track.id);
    Object.assign(kart, { x: point.x, z: point.z, angle: point.angle + Math.PI, speed: 45, routeProgress: progress, elevation: trackElevation(progress, track.id) });
    stepWorld(world, new Map([[kart.id, { ...neutralInput(), throttle: 1 }]]), 1 / 30);
  }
  assert.equal(kart.lap, 0); assert.equal(kart.nextCheckpoint, 1);
});

test('two boost strips a second apart both fire, each once per lap', () => {
  const kart = createKart('driver', 'Pilote', COLORS[0]!, 0, track.id);
  const enter = (fraction: number) => {
    const point = trackPoint(track.length * fraction, track.id);
    Object.assign(kart, { x: point.x + Math.cos(point.angle) * 6, z: point.z - Math.sin(point.angle) * 6, angle: point.angle, speed: 30,
      boost: 0, padZone: '', routeProgress: track.length * fraction, elevation: trackElevation(track.length * fraction, track.id) });
    stepKart(kart, { ...neutralInput(), throttle: 1 }, 1 / 30);
    return kart.boost;
  };
  assert.ok(enter(.1) > 1, 'first strip');
  assert.ok(enter(.16) > 1, 'second strip, half a second later');
  assert.equal(enter(.1), 0, 'the same strip never pays twice in a lap');
  kart.lap = 1;
  assert.ok(enter(.1) > 1, 'and pays again on the next lap');
});

test('tight bends: weaving drivers who cut a hairpin on the road keep validating gates', () => {
  const world = createWorld(false, track.id); world.eventLevel = 0;
  world.players = Array.from({ length: 4 }, (_, index) => Object.assign(createKart(`k${index}`, `K${index}`, COLORS[index]!, index, track.id), { cpu: true }));
  startRace(world);
  const length = track.length, late = new Set<string>();
  for (let tick = 0; tick < 30 * 75; tick++) {
    const controls = new Map(world.players.map((kart, index) => {
      const input = getCpuInput(kart, tick, world, 1);
      // A human line: full throttle, wide swings, and no automatic replacement.
      return [kart.id, world.phase === 'countdown' ? neutralInput(tick) : { ...input, reset: false, brake: false, throttle: 1,
        steer: Math.max(-1, Math.min(1, input.steer + Math.sin(tick * (.03 + index * .011) + index) * (.5 + index * .12))) }];
    }));
    stepWorld(world, controls, 1 / 30);
    for (const kart of world.players) {
      if (kart.nextCheckpoint === 0 || kart.surface === 'offroad') continue;
      const gate = track.checkpoints[kart.nextCheckpoint]!.progress, beyond = (((kart.routeProgress ?? 0) - gate) % length + length) % length;
      // Well past a gate, on the road, yet still waiting for it: a lost lap.
      if (beyond > 25 && beyond < 70) late.add(`${kart.id} gate ${kart.nextCheckpoint}`);
    }
  }
  assert.deepEqual([...late], []);
});
