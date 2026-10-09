import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS, TRACK_IDS, TRACK, TRACK_LENGTH, ROAD_WIDTH, CHECKPOINTS, COLORS, TOTAL_LAPS,
  getTrack, isTrackId, nearestTrack, trackPoint, trackSurface, spawnPoint,
  createKart, createWorld, startRace, stepKart, stepWorld, resetKart, neutralInput,
  type Kart, type TrackDefinition, type TrackZone, type Vec2, type World } from '../shared/game.js';
import { reliefElevation, trackElevation, trackSlope, trackJumpAt } from '../shared/track.js';
import { autopilot } from '../shared/autopilot.js';

const dt = 1 / 30;
function racing(trackId: string, count = 1): World {
  const world = createWorld(count === 1, trackId);
  world.players = Array.from({ length: count }, (_, i) => createKart(String(i), 'Pilote ' + i, COLORS[i]!, i, trackId));
  startRace(world);
  for (let tick = 0; tick < 90; tick++) stepWorld(world, new Map(), dt);
  assert.equal(world.phase, 'racing');
  return world;
}
function zonePoint(track: TrackDefinition, zone: TrackZone) {
  const point = trackPoint((zone.start + zone.end) / 2, track.id);
  return { ...point, x: point.x + Math.cos(point.angle) * zone.offset,
    z: point.z - Math.sin(point.angle) * zone.offset };
}
function orient(a: Vec2, b: Vec2, c: Vec2) { return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x); }

test('twelve circuits expose bounded zones, closed nonintersecting routes and consistent arc coordinates', () => {
  assert.deepEqual(TRACKS.map(track => track.id), ['lagon', 'canyon', 'glacier', 'neon', 'mangrove', 'dunes', 'volcan', 'forest', 'harbor', 'sky', 'foundry', 'castle']);
  assert.deepEqual(TRACKS.map(track => track.id), TRACK_IDS);
  assert.equal(TRACK, getTrack('lagon').points);
  assert.equal(TRACK_LENGTH, getTrack('lagon').length);
  assert.equal(ROAD_WIDTH, getTrack('lagon').width);
  assert.equal(CHECKPOINTS, getTrack('lagon').checkpoints);
  assert.equal(isTrackId('lagon'), true); assert.equal(isTrackId('__proto__'), false);
  assert.equal(getTrack('missing').id, 'lagon');
  for (const track of TRACKS) {
    assert.equal(isTrackId(track.id), true);
    const extended = track.elevations.length > 0;
    assert.ok(extended ? track.length > 1200 && track.length < 1600 : track.length > 800 && track.length < 1300, track.id);
    assert.ok(extended ? track.width >= 22 && track.width <= 24 : track.width >= 15 && track.width <= 18);
    assert.equal(track.checkpoints.length, 12);
    assert.ok(Math.hypot(trackPoint(0, track.id).x - trackPoint(track.length, track.id).x,
      trackPoint(0, track.id).z - trackPoint(track.length, track.id).z) < 1e-6);
    for (let i = 0; i < track.points.length; i++) for (let j = i + 2; j < track.points.length; j++) {
      if (i === 0 && j === track.points.length - 1) continue;
      const a = track.points[i]!; const b = track.points[(i + 1) % track.points.length]!;
      const c = track.points[j]!; const d = track.points[(j + 1) % track.points.length]!;
      assert.ok(!(orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0), track.id + ' self-intersection');
    }
    for (let sample = 1; sample < 50; sample++) {
      const progress = track.length * sample / 50;
      const point = trackPoint(progress, track.id);
      const near = nearestTrack(point.x, point.z, track.id);
      assert.ok(near.distance < 1e-6); assert.ok(Math.abs(near.progress - progress) < 1e-6);
    }
    for (const zone of track.zones) {
      assert.ok(zone.start >= 0 && zone.end > zone.start && zone.end < track.length);
      assert.ok(Math.abs(zone.offset) + zone.width / 2 <= track.width / 2 + 1e-6);
      const point = zonePoint(track, zone);
      assert.equal(trackSurface(point.x, point.z, track.id).zone?.id, zone.id);
    }
    for (let i = 0; i < 8; i++) {
      const point = spawnPoint(i, track.id);
      assert.ok(nearestTrack(point.x, point.z, track.id).distance < track.width / 2);
    }
  }
});

test('new circuits leave space between separate bends and a dry route beside each mud patch', () => {
  for (const id of ['mangrove', 'dunes', 'volcan', 'forest', 'harbor', 'sky', 'foundry', 'castle']) {
    const track = getTrack(id);
    const samples = Array.from({ length: 240 }, (_, i) => trackPoint(i * track.length / 240, id));
    for (let i = 0; i < samples.length; i++) for (let j = i + 1; j < samples.length; j++) {
      const arcDistance = Math.min(j - i, samples.length - j + i) * track.length / samples.length;
      if (arcDistance < track.width * 3) continue;
      const a = samples[i]!; const b = samples[j]!;
      assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > track.width * 1.5, id + ': separate bends overlap');
    }
    for (const zone of track.zones.filter(zone => zone.kind === 'mud')) {
      const dryLine = trackPoint((zone.start + zone.end) / 2, id);
      assert.equal(trackSurface(dryLine.x, dryLine.z, id).surface, 'road', id + ': mud must remain avoidable');
    }
  }
});

for (const track of TRACKS) {
  test(track.id + ': eight ordinary input drivers finish three laps with items, zones and collisions', t => {
    const world = racing(track.id, 8);
    for (let tick = 0; tick < 30 * 220 && world.phase === 'racing'; tick++)
      stepWorld(world, new Map(world.players.map(kart => [kart.id, autopilot(kart, tick, true)])), dt);
    assert.equal(world.phase, 'finished');
    assert.equal(world.players.filter(kart => kart.finished && kart.lap === TOTAL_LAPS).length, 8);
    assert.ok(world.raceTime < TOTAL_LAPS * track.length / 25, track.id + ': ' + world.raceTime);
    assert.equal(new Set(world.players.map(kart => kart.rank)).size, 8);
    assert.ok(world.players.every(kart => kart.trackId === track.id));
    t.diagnostic(track.id + ': 8/8 finished in ' + world.raceTime.toFixed(2) + ' simulation seconds');
  });

  test(track.id + ': checkpoints use this circuit and reject skipped gates or reverse crossings', () => {
    const world = racing(track.id); const kart = world.players[0]!;
    const cross = (index: number, reverse = false) => {
      const cp = track.checkpoints[index]!;
      const direction = reverse ? -1 : 1;
      Object.assign(kart, { x: cp.x - Math.sin(cp.angle) * .3 * direction,
        z: cp.z - Math.cos(cp.angle) * .3 * direction, angle: cp.angle + (reverse ? Math.PI : 0), speed: 20, turnVelocity: 0 });
      stepWorld(world, new Map([[kart.id, { ...neutralInput(), throttle: 1 }]]), dt);
    };
    cross(0); assert.equal(kart.lap, 0);
    cross(4); assert.equal(kart.nextCheckpoint, 1);
    cross(1, true); assert.equal(kart.nextCheckpoint, 1);
    for (let lap = 0; lap < 3; lap++) {
      for (let cp = 1; cp < track.checkpoints.length; cp++) cross(cp);
      cross(0); assert.equal(kart.lap, lap + 1);
    }
    assert.equal(kart.progress, track.length * 3);
    assert.equal(world.phase, 'finished');
  });

  test(track.id + ': prediction matches server movement on surfaces and drift still releases a mini-turbo', () => {
    const world = racing(track.id); world.pickups = [];
    const kart = world.players[0]!;
    const predicted = structuredClone(kart);
    for (let tick = 0; tick < 180; tick++) {
      const input = autopilot(kart, tick);
      stepKart(predicted, input, dt);
      stepWorld(world, new Map([[kart.id, input]]), dt);
      assert.equal(predicted.x, kart.x); assert.equal(predicted.z, kart.z);
      assert.equal(predicted.surface, kart.surface); assert.equal(predicted.boost, kart.boost);
    }
    Object.assign(kart, trackPoint(5, track.id), { speed: 25, boost: 0 });
    for (let tick = 0; tick < 24; tick++) {
      Object.assign(kart, trackPoint(5, track.id));
      stepKart(kart, { ...neutralInput(), throttle: 1, steer: .4, drift: true }, dt);
    }
    assert.ok(kart.driftCharge >= .65);
    stepKart(kart, neutralInput(), dt); assert.ok(kart.boost > 0);
  });
}

test('boost pads require forward entry and cannot recharge while parked, re-entering or resetting within the same lap', () => {
  const track = getTrack('neon'); const zone = track.zones.find(zone => zone.kind === 'boost')!;
  const kart = createKart('pad', 'Pad', COLORS[0]!, 0, track.id);
  const point = zonePoint(track, zone);
  Object.assign(kart, point, { speed: 15 });
  stepKart(kart, neutralInput(), dt);
  assert.equal(kart.surface, 'boost'); assert.ok(kart.boost > 1); assert.equal(kart.padLaps[zone.id], 0);
  for (let tick = 0; tick < 100; tick++) {
    Object.assign(kart, point, { speed: 15 }); stepKart(kart, neutralInput(), dt);
  }
  assert.equal(kart.boost, 0);
  Object.assign(kart, trackPoint(zone.end + 8, track.id)); stepKart(kart, neutralInput(), dt);
  Object.assign(kart, point, { speed: 15 }); stepKart(kart, neutralInput(), dt);
  assert.equal(kart.boost, 0);
  resetKart(kart);
  Object.assign(kart, point, { speed: 15 }); stepKart(kart, neutralInput(), dt);
  assert.equal(kart.boost, 0); assert.equal(kart.padLaps[zone.id], 0);
  Object.assign(kart, trackPoint(zone.end + 8, track.id)); stepKart(kart, neutralInput(), dt);
  Object.assign(kart, point, { speed: 15, lap: 1 }); stepKart(kart, neutralInput(), dt);
  assert.ok(kart.boost > 0); assert.equal(kart.padLaps[zone.id], 1);
  const reverse = createKart('reverse', 'Reverse', COLORS[1]!, 1, track.id);
  Object.assign(reverse, point, { angle: point.angle + Math.PI, speed: 15 });
  stepKart(reverse, neutralInput(), dt); assert.equal(reverse.boost, 0);
});

test('mud slows a kart while ice preserves momentum and reduces grip', () => {
  const canyon = getTrack('canyon'); const mud = canyon.zones.find(zone => zone.kind === 'mud')!;
  const muddy = createKart('mud', 'Mud', COLORS[0]!, 0, canyon.id);
  const dry = createKart('dry', 'Dry', COLORS[1]!, 1, canyon.id);
  Object.assign(muddy, zonePoint(canyon, mud), { speed: 32 });
  Object.assign(dry, trackPoint(5, canyon.id), { speed: 32 });
  stepKart(muddy, { ...neutralInput(), throttle: 1 }, dt); stepKart(dry, { ...neutralInput(), throttle: 1 }, dt);
  assert.equal(muddy.surface, 'mud'); assert.ok(muddy.speed < dry.speed);
  const glacier = getTrack('glacier'); const zone = glacier.zones.find(zone => zone.kind === 'ice')!;
  const icy = createKart('ice', 'Ice', COLORS[0]!, 0, glacier.id);
  const road = createKart('road', 'Road', COLORS[1]!, 1, glacier.id);
  Object.assign(icy, zonePoint(glacier, zone), { speed: 25, lateralVelocity: 5, turnVelocity: 1 });
  Object.assign(road, trackPoint(5, glacier.id), { speed: 25, lateralVelocity: 5, turnVelocity: 1 });
  stepKart(icy, neutralInput(), dt); stepKart(road, neutralInput(), dt);
  assert.equal(icy.surface, 'ice');
  assert.ok(icy.speed > road.speed); assert.ok(icy.lateralVelocity > road.lateralVelocity);
  assert.ok(icy.turnVelocity > road.turnVelocity);
});

test('launch boost rewards a fresh press in the final second, never holding throttle from countdown start', () => {
  const world = createWorld(false, 'canyon');
  world.players = Array.from({ length: 3 }, (_, i) => createKart(String(i), 'Launch ' + i, COLORS[i]!, i, 'canyon'));
  startRace(world);
  for (let tick = 0; tick < 90; tick++) {
    const inputs = new Map(world.players.map((kart, index) => [kart.id,
      { ...neutralInput(tick), throttle: index === 0 ? 1 : index === 1 && tick >= 66 ? 1 : 0 }]));
    stepWorld(world, inputs, dt);
  }
  assert.equal(world.phase, 'racing');
  assert.equal(world.players[0]!.boost, 0); assert.equal(world.players[0]!.launchFault, true);
  assert.ok(world.players[1]!.boost > 1); assert.equal(world.players[1]!.launchFault, false);
  assert.equal(world.players[2]!.boost, 0);
  assert.ok(world.players.every(kart => kart.speed === 0));
});

test('draft requires a connected moving opponent ahead and rewards one second with a cooldown', () => {
  const world = racing('lagon', 2); world.pickups = [];
  const follower = world.players[0]!; const leader = world.players[1]!;
  const align = () => {
    const point = trackPoint(12, world.trackId);
    Object.assign(follower, point, { speed: 24, turnVelocity: 0 });
    Object.assign(leader, point, { x: point.x + Math.sin(point.angle) * 10,
      z: point.z + Math.cos(point.angle) * 10, speed: 24, turnVelocity: 0 });
  };
  for (let tick = 0; tick < 30; tick++) { align(); stepWorld(world, new Map(), dt); }
  assert.ok(follower.boost > 1); assert.ok(follower.draftCooldown > 2.9); assert.equal(follower.draftCharge, 0);
  for (let tick = 0; tick < 15; tick++) { align(); stepWorld(world, new Map(), dt); }
  assert.equal(follower.draftCharge, 0); assert.ok(follower.draftCooldown < 2.6);
  follower.draftCooldown = 0; follower.boost = 0; leader.connected = false;
  for (let tick = 0; tick < 35; tick++) { align(); stepWorld(world, new Map(), dt); }
  assert.equal(follower.draftCharge, 0); assert.equal(follower.boost, 0);
  leader.connected = true;
  for (let tick = 0; tick < 35; tick++) { align(); leader.angle += Math.PI; stepWorld(world, new Map(), dt); }
  assert.equal(follower.boost, 0);
});

test('starting a new circuit resets positions, pickups, surfaces and boosts but retains tournament identity', () => {
  const world = racing('lagon'); const originalTournament = world.tournament;
  world.players[0]!.boost = 2; world.players[0]!.padLaps = { old: 0 };
  world.trackId = 'neon'; startRace(world);
  assert.equal(world.tournament, originalTournament);
  const kart = world.players[0]!;
  assert.equal(kart.trackId, 'neon'); assert.equal(kart.boost, 0); assert.deepEqual(kart.padLaps, {});
  assert.deepEqual({ x: kart.x, z: kart.z, angle: kart.angle }, spawnPoint(0, 'neon'));
  assert.ok(world.pickups.every(pickup => nearestTrack(pickup.x, pickup.z, 'neon').distance < 4));
});


test('six additional themes contain gentle bridges, genuine ramp profiles and clear landing corridors', () => {
  const additions = TRACKS.slice(6);
  assert.deepEqual(additions.map(track => track.theme), ['volcano', 'forest', 'harbor', 'sky', 'foundry', 'castle']);
  assert.ok(TRACKS.slice(0, 6).every(track => track.elevations.length === 0));
  for (const track of additions) {
    assert.ok(track.elevations.some(feature => feature.kind === 'bridge'));
    assert.equal(track.elevations.filter(feature => feature.kind === 'jump').length, 1);
    // Structures stand on the hills: every height below is measured above the natural ground.
    const above = (progress: number) => trackElevation(progress, track.id) - reliefElevation(progress, track);
    assert.equal(above(0), 0); assert.equal(above(track.length), 0); assert.equal(above(-1), 0);
    assert.ok(Math.abs(trackSlope(0, track.id)) < 1e-9, track.id + ': the starting grid is level');
    const ordered = [...track.elevations].sort((a, b) => a.start - b.start);
    for (let i = 0; i < ordered.length; i++) {
      const feature = ordered[i]!;
      assert.ok(feature.start > 50 && feature.end < track.length - 55);
      if (i) assert.ok(feature.start > ordered[i - 1]!.end + 8, track.id + ': structures overlap');
      assert.ok(feature.height > 0 && feature.end > feature.start);
      assert.ok(Math.abs(above(feature.start)) < 1e-8);
      if (feature.kind === 'bridge') {
        assert.ok(Math.abs(above(feature.end)) < 1e-8);
        assert.ok(Math.abs(above((feature.start + feature.end) / 2) - feature.height) < 1e-6);
        for (let progress = feature.start; progress <= feature.end; progress += .4) {
          assert.ok(Math.abs(trackSlope(progress, track.id)) <= .151, track.id + ': bridge steeper than 15 percent');
          assert.ok(Math.abs(trackElevation(progress + .01, track.id) - trackElevation(progress, track.id)) < .0016);
        }
      } else {
        assert.ok(Math.abs(above(feature.end) - feature.height) < 1e-7);
        assert.equal(above(feature.end + .05), 0);
        assert.ok(trackSlope(feature.start + 1, track.id) < .15);
        assert.ok(feature.launchSpeed! >= 6 && feature.launchSpeed! <= 9);
        assert.equal(trackJumpAt(feature.end - 1, track.id)?.id, feature.id);
        assert.equal(trackJumpAt(feature.end + 1, track.id), undefined);
        const launch = trackPoint(feature.end, track.id);
        for (let distance = 1; distance <= 55; distance++) {
          const point = trackPoint(feature.end + distance, track.id);
          const sideways = Math.abs((point.x - launch.x) * Math.cos(launch.angle) - (point.z - launch.z) * Math.sin(launch.angle));
          assert.ok(sideways < track.width / 2 - 4, track.id + ': landing corridor requires a sharper turn');
          assert.equal(above(feature.end + distance), 0);
        }
      }
    }
    // The added circuits are intentionally broad and avoid the tight bends of the old lot.
    for (let progress = 0; progress < track.length; progress += 2) {
      const before = trackPoint(progress - 4, track.id), after = trackPoint(progress + 4, track.id);
      const turn = Math.abs(Math.atan2(Math.sin(after.angle - before.angle), Math.cos(after.angle - before.angle)));
      assert.ok(turn < .45, track.id + ': unexpectedly tight corner');
    }
  }
});
