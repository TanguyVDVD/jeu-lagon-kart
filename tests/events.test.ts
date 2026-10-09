import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS, getTrack, nearestTrack, trackPoint, trackSurface } from '../shared/track.js';
import { COLORS, TOTAL_LAPS, createKart, createWorld, neutralInput, startRace, stepKart, stepWorld } from '../shared/game.js';
import { autopilot } from '../shared/autopilot.js';
import { constrainTrackEvent, dynamicSurface, eventRoutePoint, getTrackEvent,
  nearestDriveableTrack, pointOnBranch, trackEventPickups, eventCheckpointGates, type TrackBranch } from '../shared/track-events.js';
import { DEFAULT_BUILD, type KartBuild } from '../shared/garage.js';

function driveSector(trackId: string, route: TrackBranch, useBranch: boolean, build: KartBuild = { ...DEFAULT_BUILD }) {
  const track = getTrack(trackId), world = createWorld(false, trackId); world.eventLevel = useBranch ? 1 : 0;
  const kart = createKart('sector', 'Essai à allure normale', COLORS[0]!, 0, trackId, 'zsky', build); world.players = [kart];
  startRace(world);
  for (let tick = 0; tick < 90; tick++) stepWorld(world, new Map(), 1 / 30);
  world.eventStage = 2;
  const finalGate = (Math.floor(route.end / (track.length / 12)) + 2) % 12;
  Object.assign(kart, trackPoint(route.start - 15, trackId), { speed: 28,
    nextCheckpoint: Math.floor(route.start / (track.length / 12)) + 1, eventStage: 2, eventLevel: world.eventLevel,
    padLaps: Object.fromEntries(track.zones.map(zone => [zone.id, 0])) });
  const point = (progress: number) => useBranch && progress >= route.start && progress <= route.end ? pointOnBranch(route, progress) : trackPoint(progress, trackId);
  let ticks = 0, visited = false, offroadTicks = 0, steer = 0;
  for (; ticks < 30 * 60 && kart.nextCheckpoint !== finalGate; ticks++) {
    const near = nearestDriveableTrack(kart.x, kart.z, trackId, 2, world.eventLevel);
    visited ||= near.branchId === route.id && nearestTrack(kart.x, kart.z, trackId).distance > track.width / 2 + 5;
    const target = point(near.progress + Math.max(8, kart.speed * .45));
    const next = point(near.progress + 10), after = point(near.progress + 22);
    const curvature = Math.abs(Math.atan2(Math.sin(after.angle - next.angle), Math.cos(after.angle - next.angle))) / Math.max(1, Math.hypot(after.x - next.x, after.z - next.z));
    const cruiseSpeed = Math.max(15, Math.min(28, .95 / Math.max(.001, curvature)));
    const desired = Math.atan2(target.x - kart.x, target.z - kart.z), difference = Math.atan2(Math.sin(desired - kart.angle), Math.cos(desired - kart.angle));
    const requestedSteer = Math.max(-.85, Math.min(.85, difference * 2.1));
    // Limited steering strength and gradual changes; no drift, reset, item or
    // injected position while traversing the sector. Both paths use this driver.
    steer += Math.max(-.12, Math.min(.12, requestedSteer - steer));
    stepWorld(world, new Map([[kart.id, { ...neutralInput(ticks), throttle: kart.speed > cruiseSpeed ? 0 : 1,
      brake: kart.speed > cruiseSpeed + 4, steer }]]), 1 / 30);
    offroadTicks += Number(kart.surface === 'offroad');
  }
  return { seconds: ticks / 30, complete: kart.nextCheckpoint === finalGate, visited, offroadTicks };
}

test('level zero preserves the original circuit and every original surface at every lap', () => {
  for (const track of TRACKS) for (const stage of [0, 1, 2]) {
    const event = getTrackEvent(track.id, stage, 0);
    assert.deepEqual(event.branches, []); assert.deepEqual(event.blockers, []); assert.equal(event.weather, 'clear');
    assert.deepEqual(trackEventPickups(track.id, stage, 0), []);
    for (let sample = 0; sample < 60; sample++) {
      const point = trackPoint(track.length * sample / 60, track.id);
      const original = nearestTrack(point.x, point.z, track.id);
      const active = nearestDriveableTrack(point.x, point.z, track.id, stage, 0);
      const { width, branchId, surface, ...coordinates } = active;
      assert.deepEqual(coordinates, original); assert.equal(width, track.width); assert.equal(branchId, '');
      assert.deepEqual(dynamicSurface(point.x, point.z, track.id, stage, 0), trackSurface(point.x, point.z, track.id));
      assert.deepEqual(eventRoutePoint(track.length * sample / 60, track.id, stage, 0), point);
      assert.equal(constrainTrackEvent(point.x, point.z, point.x - 2, point.z - 2, 46, track.id, stage, 0).blocked, false);
    }
  }
});

test('progressive levels introduce routes before common road closures and the final shortcut', () => {
  for (const track of TRACKS) {
    const beginner = getTrackEvent(track.id, 1, 1);
    assert.equal(beginner.branches.filter(route => route.open).length, 2);
    assert.equal(beginner.blockers.length, 0); assert.equal(beginner.weather, 'clear');
    for (const level of [2, 3]) {
      assert.equal(getTrackEvent(track.id, 0, level).blockers.length, 0);
      const middle = getTrackEvent(track.id, 1, level), final = getTrackEvent(track.id, 2, level);
      assert.equal(middle.blockers.length, 1); assert.notEqual(middle.weather, 'clear');
      assert.equal(middle.branches.find(route => route.kind === 'shortcut')!.open, false);
      assert.equal(final.branches.filter(route => route.open).length, 3);
      assert.deepEqual(final.blockers, middle.blockers);
      if (level === 3) assert.equal(final.weather, 'storm');
      // Calls from separate clients depend only on the shared state, not on time,
      // random draws, local driver position or the client's current lap.
      assert.deepEqual(structuredClone(middle), getTrackEvent(track.id, 1, level));
    }
  }
});

test('branch joins preserve the full width of the original driveable road', () => {
  for (const track of TRACKS) for (let sample = 0; sample < 180; sample++) {
    const point = trackPoint(track.length * sample / 180, track.id);
    for (const side of [-1, 1]) {
      const x = point.x + Math.cos(point.angle) * side * (track.width / 2 - .3);
      const z = point.z - Math.sin(point.angle) * side * (track.width / 2 - .3);
      if (trackSurface(x, z, track.id).surface !== 'offroad')
        assert.notEqual(dynamicSurface(x, z, track.id, 2, 3).surface, 'offroad', track.id + ': a narrow branch stole a road lane');
    }
  }
});

for (const track of TRACKS) test(track.id + ': broad tangent branches keep ordered gates and the shortcut beats the normal road length', () => {
  const event = getTrackEvent(track.id, 2, 3), gateDistance = track.length / 12;
  const detour = event.branches.find(route => route.kind === 'detour')!;
  const shortcut = event.branches.find(route => route.kind === 'shortcut')!;
  assert.ok(shortcut.length < (shortcut.end - shortcut.start) * .95, 'a shortcut must shorten the normal road itself');
  for (const route of event.branches) {
    assert.ok(route.width >= 12, 'two drivers need room to steer and pass');
    assert.ok(route.minTurnRadius >= (route.kind === 'shortcut' ? 25 : 20), 'tight artificial hairpins are not acceptable');
    assert.ok(route.end - route.start > gateDistance * 2, 'transitions must extend over a useful approach distance');
    for (const [point, progress] of [[route.points[0]!, route.start], [route.points.at(-1)!, route.end]] as const) {
      const main = trackPoint(progress, track.id);
      assert.ok(Math.hypot(point.x - main.x, point.z - main.z) < 1e-6, 'route must reconnect to the real road');
    }
    let previousProgress = -Infinity, separated = 0;
    for (let index = 0; index < route.points.length; index++) {
      const point = route.points[index]!;
      assert.ok(point.progress > previousProgress); previousProgress = point.progress;
      const near = nearestDriveableTrack(point.x, point.z, track.id, 2, 3);
      assert.ok(near.distance < 1e-6); assert.notEqual(dynamicSurface(point.x, point.z, track.id, 2, 3).surface, 'offroad');
      if (nearestTrack(point.x, point.z, track.id).distance > track.width / 2 + 5) {
        separated++; assert.equal(near.branchId, route.id);
        assert.ok(Math.abs(near.progress - point.progress) < 1e-5, 'branch progress must map into the original checkpoint interval');
      }
      if (index > 0) {
        const before = route.points[index - 1]!;
        assert.equal(constrainTrackEvent(point.x, point.z, before.x, before.z, 46, track.id, 2, 3).blocked, false, 'alternative route must avoid the closure');
      }
    }
    assert.ok(separated >= 8, 'this must be a separate road, not a different lane of the existing road');
    const intermediate = track.checkpoints.map((checkpoint, index) => ({ checkpoint, index })).filter(({ checkpoint }) => checkpoint.progress > route.start && checkpoint.progress < route.end);
    assert.ok(intermediate.length >= 2);
    for (const { checkpoint, index } of intermediate) {
      const gate = eventCheckpointGates(track.id, index, 2, 3).find(gate => gate.branchId === route.id)!;
      assert.ok(gate); assert.equal(gate.progress, checkpoint.progress);
      assert.ok(nearestDriveableTrack(gate.x, gate.z, track.id, 2, 3).distance < 1e-6);
    }
    assert.equal(eventCheckpointGates(track.id, 0, 2, 3).length, 1, 'no alternate finish-line gate');
  }
  const technical = event.branches.find(route => route.kind === 'technical')!;
  const surfaces = [.27, .65, .9].map(t => {
    const point = pointOnBranch(technical, technical.start + (technical.end - technical.start) * t);
    return dynamicSurface(point.x, point.z, track.id, 2, 3).surface;
  });
  assert.ok(surfaces.includes('boost')); assert.ok(surfaces.includes('ice')); assert.ok(surfaces.includes('road'));
  const pickups = trackEventPickups(track.id, 0, 1);
  assert.equal(pickups.length, 2); assert.equal(new Set(pickups.map(pickup => pickup.id)).size, 2);
  for (const pickup of pickups) assert.equal(nearestDriveableTrack(pickup.x, pickup.z, track.id, 0, 1).branchId, detour.id);
});

test('swept barriers stop fast crossings in both directions and safely release a kart caught by a phase change', () => {
  for (const track of TRACKS) {
    const blocker = getTrackEvent(track.id, 1, 2).blockers[0]!;
    const along = (distance: number) => ({ x: blocker.x + Math.sin(blocker.angle) * distance,
      z: blocker.z + Math.cos(blocker.angle) * distance });
    for (const direction of [-1, 1]) {
      const before = along(-direction * 35), after = along(direction * 35);
      const stopped = constrainTrackEvent(after.x, after.z, before.x, before.z, 46, track.id, 1, 2);
      assert.equal(stopped.blocked, true); assert.equal(stopped.speed, 0);
      const signed = (stopped.x - blocker.x) * Math.sin(blocker.angle) + (stopped.z - blocker.z) * Math.cos(blocker.angle);
      assert.ok(signed * direction < -blocker.halfLength);
      assert.equal(constrainTrackEvent(after.x, after.z, before.x, before.z, 46, track.id, 0, 2).blocked, false);
    }
    const released = constrainTrackEvent(blocker.x, blocker.z, blocker.x, blocker.z, 30, track.id, 1, 2);
    assert.equal(released.blocked, true);
    assert.ok(Math.hypot(released.x - blocker.x, released.z - blocker.z) > blocker.halfLength);
    assert.equal(constrainTrackEvent(released.x, released.z, released.x, released.z, 0, track.id, 1, 2).blocked, false);
  }
});

test('CPU route guidance passes around closures and weather changes actual road surfaces', () => {
  for (const track of TRACKS) {
    const event = getTrackEvent(track.id, 1, 2), detour = event.branches.find(route => route.kind === 'detour')!;
    const progress = (detour.start + detour.end) / 2;
    const guided = eventRoutePoint(progress, track.id, 1, 2);
    assert.ok(nearestTrack(guided.x, guided.z, track.id).distance > 20);
    assert.equal(nearestDriveableTrack(guided.x, guided.z, track.id, 1, 2).branchId, detour.id);
    let weatherChanges = 0;
    for (let index = 0; index < 100; index++) {
      const point = trackPoint(track.length * index / 100, track.id), before = dynamicSurface(point.x, point.z, track.id, 0, 2);
      const after = dynamicSurface(point.x, point.z, track.id, 1, 2);
      if (before.surface === 'road' && after.surface === (track.theme === 'ice' ? 'ice' : 'mud')) weatherChanges++;
    }
    assert.ok(weatherChanges >= 2, track.id + ': weather must affect handling, not just the picture');
  }
  assert.equal(getTrackEvent('invalid', NaN, Infinity).trackId, getTrack().id);
  assert.equal(getTrackEvent('lagon', 999, 999).stage, 2); assert.equal(getTrackEvent('lagon', 999, 999).level, 3);
});

for (const track of TRACKS) test(track.id + ': eight ordinary drivers finish with common phases, closures and actual detour visits without resetting', t => {
  const world = createWorld(false, track.id); world.eventLevel = 3;
  world.players = Array.from({ length: 8 }, (_, index) => createKart('dynamic-' + index, 'Pilote ' + index, COLORS[index]!, index, track.id));
  startRace(world);
  const phases = new Set<number>(), detourDrivers = new Set<string>(); let resets = 0;
  for (let tick = 0; tick < 30 * 240 && world.phase !== 'finished'; tick++) {
    stepWorld(world, new Map(world.players.map(kart => { const input = autopilot(kart, tick, true); resets += Number(input.reset); return [kart.id, input]; })), 1 / 30);
    phases.add(world.eventStage);
    if (tick % 6 !== 0 || world.eventStage === 0) continue;
    for (const kart of world.players) {
      assert.equal(kart.eventStage, world.eventStage); assert.equal(kart.eventLevel, world.eventLevel);
      const near = nearestDriveableTrack(kart.x, kart.z, track.id, world.eventStage, world.eventLevel);
      if (near.branchId === track.id + '-detour' && nearestTrack(kart.x, kart.z, track.id).distance > track.width / 2 + 5) detourDrivers.add(kart.id);
    }
  }
  assert.equal(world.phase, 'finished'); assert.equal(world.players.filter(kart => kart.finished && kart.lap === TOTAL_LAPS).length, 8);
  assert.equal(detourDrivers.size, 8, 'every driver must physically use the separate road, not skip the closed area');
  assert.deepEqual([...phases].sort(), [0, 1, 2]);
  assert.equal(new Set(world.players.map(kart => kart.rank)).size, 8);
  assert.equal(resets, 0, 'normal branches must not rely on the reset button to finish a race');
  t.diagnostic(track.id + ': 8/8 finished with events in ' + world.raceTime.toFixed(2) + ' simulation seconds');
});

test('a collision from behind cannot push a waiting kart inside the event barricade', () => {
  const world = createWorld(false, 'lagon'); world.eventLevel = 3;
  world.players = [createKart('front', 'Avant', COLORS[0]!, 0), createKart('back', 'Arrière', COLORS[1]!, 1)];
  startRace(world);
  for (let tick = 0; tick < 90; tick++) stepWorld(world, new Map(), 1 / 30);
  const blocker = getTrackEvent('lagon', 1, 3).blockers[0]!;
  world.players.forEach((kart, index) => {
    const distance = -(blocker.halfLength + .95 + .08 + index * 1.8);
    Object.assign(kart, { x: blocker.x + Math.sin(blocker.angle) * distance,
      z: blocker.z + Math.cos(blocker.angle) * distance, angle: blocker.angle, speed: 0, lap: 1 });
  });
  stepWorld(world, new Map(world.players.map(kart => [kart.id, neutralInput()])), 1 / 30);
  for (const kart of world.players)
    assert.equal(constrainTrackEvent(kart.x, kart.z, kart.x, kart.z, kart.speed, 'lagon', 1, 3).blocked, false, kart.id + ' entered the barrier after collision resolution');
});

test('reset returns to a validated gate without sweeping the teleport through an event barrier', () => {
  const track = getTrack('lagon'), event = getTrackEvent(track.id, 1, 3);
  const detour = event.branches.find(route => route.kind === 'detour')!;
  const gate = Math.floor(detour.start / (track.length / 12));
  const respawn = trackPoint(gate * track.length / 12 + 2, track.id);
  const afterBarrier = trackPoint((detour.start + detour.end) / 2 + 12, track.id);
  const kart = createKart('reset-event', 'Retour piste', COLORS[0]!, 0, track.id);
  Object.assign(kart, afterBarrier, { eventStage: 1, eventLevel: 3, respawnX: respawn.x, respawnZ: respawn.z, respawnAngle: respawn.angle });
  stepKart(kart, { ...neutralInput(), reset: true }, 1 / 30);
  assert.ok(Math.hypot(kart.x - respawn.x, kart.z - respawn.z) < 1e-6, 'teleport was stopped by a barrier crossed only by its imaginary segment');
});

test('every branch supports normal cruising with limited gradual steering, without drift or reset', () => {
  for (const track of TRACKS) for (const route of getTrackEvent(track.id, 2, 3).branches) {
    const result = driveSector(track.id, route, true);
    assert.equal(result.complete, true, route.id + ': the final gate must be crossed after rejoining');
    assert.equal(result.visited, true, route.id + ': driver must actually leave the original road');
    assert.equal(result.offroadTicks, 0, route.id + ': friendly geometry should not require cutting over the shoulder');
  }
});

test('shortcuts save real sector time against the normal road with the same accessible driver and no added turbo', t => {
  for (const track of TRACKS) {
    const route = getTrackEvent(track.id, 2, 3).branches.find(route => route.kind === 'shortcut')!;
    for (const build of [{ ...DEFAULT_BUILD }, { ...DEFAULT_BUILD, chassis: 'heavy', engine: 'velocity', tires: 'allterrain', wing: 'streamlined', weight: 'ballast' }]) {
      const main = driveSector(track.id, route, false, build), shortcut = driveSector(track.id, route, true, build);
      assert.ok(main.complete && shortcut.complete, track.id + ': both paths must finish the comparison');
      assert.equal(shortcut.offroadTicks, 0); assert.equal(shortcut.visited, true);
      assert.ok(shortcut.seconds < main.seconds * .95, track.id + ': shortcut must save time on an ordinary build');
      t.diagnostic(track.id + '/' + build.chassis + ': normal ' + main.seconds.toFixed(2) + ' s, shortcut ' + shortcut.seconds.toFixed(2) + ' s');
    }
  }
});
