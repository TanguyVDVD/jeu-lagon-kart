import test from 'node:test';
import assert from 'node:assert/strict';
import { createKart, createWorld, neutralInput, stepKart, stepWorld, type Kart } from '../shared/game.js';
import { getTrack, reliefElevation, trackElevation, trackPoint, nearestTrack } from '../shared/track.js';
import { constrainTrackEvent, getTrackEvent, nearestDriveableTrack, trackBoundaryGap } from '../shared/track-events.js';
import { BRIDGE_RAIL_TOP, ROAD_RAIL_TOP, trackBoundaryShoulder, driveableGroundHeight } from '../shared/obstacle-heights.js';

function railFixture(bridge = false) {
  const trackId = bridge ? 'sky' : 'lagon', track = getTrack(trackId);
  const feature = track.elevations.find(feature => feature.kind === 'bridge');
  for (const fraction of [.5, .25, .75, .1, .9]) for (const side of [1, -1]) {
    const progress = feature ? feature.start + (feature.end - feature.start) * fraction : 5;
    const point = trackPoint(progress, trackId), limit = track.width / 2 + trackBoundaryShoulder(progress, trackId);
    const wall = { x: point.x + Math.cos(point.angle) * side * limit, z: point.z - Math.sin(point.angle) * side * limit };
    if (getTrackEvent(trackId, 2, 3).branches.some(branch => branch.points.some(p => Math.hypot(p.x - wall.x, p.z - wall.z) < branch.width / 2 + 2))) continue;
    const kart = createKart('jump', 'Saut', '#ff6b6b', 0, trackId);
    Object.assign(kart, { x: point.x + Math.cos(point.angle) * side * (limit - .2),
      z: point.z - Math.sin(point.angle) * side * (limit - .2), angle: point.angle + Math.PI / 2 * side,
      speed: 10, elevation: trackElevation(progress, trackId), turnVelocity: 0 });
    return { kart, point, limit, side, base: trackElevation(progress, trackId), track };
  }
  throw new Error('No unobstructed rail fixture');
}
/** Natural ground under the kart: hills, without any bridge deck. */
function terrain(kart: Kart) {
  return reliefElevation(nearestDriveableTrack(kart.x, kart.z, kart.trackId, kart.eventStage, kart.eventLevel).progress, getTrack(kart.trackId));
}
function clearance(kart: Kart) {
  const near = nearestDriveableTrack(kart.x, kart.z, kart.trackId, kart.eventStage, kart.eventLevel);
  return near.distance - near.width / 2 - trackBoundaryShoulder(near.progress, kart.trackId, near.branchId);
}

test('classic races keep their rails closed, and a shortcut opens its passage only in its actual phase', () => {
  const track = getTrack('neon');
  const candidates = Array.from({ length: 360 }, (_, index) => trackPoint(index * track.length / 360, track.id))
    .flatMap(point => [1, -1].map(side => {
      const limit = track.width / 2 + 5;
      return { point, side, limit, x: point.x + Math.cos(point.angle) * side * limit, z: point.z - Math.sin(point.angle) * side * limit };
    }));
  const gate = candidates.find(gate => trackBoundaryGap(gate.x, gate.z, track.id, 2, 3) &&
    !trackBoundaryGap(gate.x, gate.z, track.id, 0, 3) && Math.abs(nearestTrack(gate.x, gate.z, track.id).distance - gate.limit) < .01)!;
  assert.ok(gate, 'the final shortcut has a distinct rail opening');
  assert.equal(trackBoundaryGap(gate.x, gate.z, track.id, 2, 0), false);
  for (const [stage, level, open] of [[2, 0, false], [0, 3, false], [2, 3, true]] as const) {
    const kart = createKart('gap', 'Ouverture', '#ff6b6b', 0, track.id);
    Object.assign(kart, { x: gate.point.x + Math.cos(gate.point.angle) * gate.side * (gate.limit - .2),
      z: gate.point.z - Math.sin(gate.point.angle) * gate.side * (gate.limit - .2), angle: gate.point.angle + Math.PI / 2 * gate.side,
      speed: 10, eventStage: stage, eventLevel: level });
    kart.elevation = trackElevation(nearestTrack(kart.x, kart.z, track.id).progress, track.id);
    stepKart(kart, neutralInput(), .1);
    const distance = nearestTrack(kart.x, kart.z, track.id).distance;
    if (open) assert.ok(distance > gate.limit + .2, 'an open branch can actually be entered through its visible passage');
    else assert.ok(distance <= gate.limit + .01, `closed passage stays solid in phase ${stage}, level ${level}`);
  }
});

for (const bridge of [false, true]) test(`${bridge ? 'bridge' : 'road'} rail blocks ground and low jumps but allows sufficient clearance`, () => {
  const expectedTop = bridge ? BRIDGE_RAIL_TOP : ROAD_RAIL_TOP;
  for (const height of [0, .2, expectedTop + .6]) {
    const { kart, base } = railFixture(bridge);
    kart.elevation = base + height; kart.airborne = height > 0;
    stepKart(kart, neutralInput(), .1);
    if (height > expectedTop) assert.ok(clearance(kart) > .2, `above the ${expectedTop} m rail`);
    else assert.ok(clearance(kart) <= .01, `height ${height} must still meet the rail`);
  }
});

test('rail collision checks height at the crossing, including a fast downward segment', () => {
  const { kart, point, side, limit } = railFixture();
  kart.x = point.x + Math.cos(point.angle) * side * (limit - .8);
  kart.z = point.z - Math.sin(point.angle) * side * (limit - .8);
  Object.assign(kart, { elevation: kart.elevation + 1, verticalVelocity: -12, airborne: true });
  stepKart(kart, neutralInput(), .1);
  assert.ok(clearance(kart) <= .01, 'being high at frame start does not grant passage after descending into the rail');
});

test('ground contact blocks the outward component while retaining tangential sliding along the rail', () => {
  const { kart, point, side, limit } = railFixture();
  Object.assign(kart, { x: point.x + Math.cos(point.angle) * side * (limit - .02),
    z: point.z - Math.sin(point.angle) * side * (limit - .02), angle: point.angle + .18 * side, speed: 25 });
  const before = { x: kart.x, z: kart.z };
  stepKart(kart, neutralInput(), 1 / 30);
  assert.ok(clearance(kart) <= .01);
  const forward = (kart.x - before.x) * Math.sin(point.angle) + (kart.z - before.z) * Math.cos(point.angle);
  assert.ok(forward > .5, `retained forward movement: ${forward}`);
});

test('clearing a rail allows an exterior landing without teleportation; low return is blocked and jumping back succeeds', () => {
  const { kart, point, side, base } = railFixture();
  Object.assign(kart, { elevation: base + 2.5, verticalVelocity: 0, airborne: true });
  stepKart(kart, neutralInput(), .1); assert.ok(clearance(kart) > .2);
  for (let tick = 0; tick < 25; tick++) stepKart(kart, neutralInput(), 1 / 30);
  assert.equal(kart.airborne, false); assert.equal(kart.elevation, terrain(kart));
  assert.ok(clearance(kart) > 2, 'landing outside must not snap horizontally through the wall');
  kart.angle = point.angle - Math.PI / 2 * side; kart.speed = 10;
  for (let tick = 0; tick < 60; tick++) stepKart(kart, { ...neutralInput(), throttle: 1 }, 1 / 30);
  assert.ok(clearance(kart) >= -.01, 'ground return cannot cross the closed rail');
  Object.assign(kart, { elevation: kart.elevation + 2.5, verticalVelocity: 0, airborne: true, speed: 10 });
  for (let tick = 0; tick < 10; tick++) stepKart(kart, { ...neutralInput(), throttle: 1 }, 1 / 30);
  assert.ok(clearance(kart) < -.2, 'a second real jump can re-enter');
});

test('leaving a bridge above its rail falls to exterior terrain rather than hovering on invisible deck', () => {
  const { kart, base } = railFixture(true);
  Object.assign(kart, { elevation: base + BRIDGE_RAIL_TOP + .6, verticalVelocity: 0, airborne: true });
  stepKart(kart, neutralInput(), .1); assert.ok(clearance(kart) > .2);
  for (let tick = 0; tick < 75; tick++) stepKart(kart, { ...neutralInput(), throttle: 1 }, 1 / 30);
  assert.equal(kart.airborne, false); assert.equal(kart.elevation, terrain(kart));
  assert.ok(clearance(kart) > 1);
  const near = nearestDriveableTrack(kart.x, kart.z, kart.trackId);
  assert.equal(driveableGroundHeight(near, kart.trackId), terrain(kart));
});

test('a real ramp launches a grounded kart over its side rail and lands it outside without injected flight state', () => {
  const track = getTrack('sky'), ramp = track.elevations.find(feature => feature.kind === 'jump')!;
  const point = trackPoint(ramp.end - 2, track.id), offset = track.width / 2 - 1;
  const kart = createKart('ramp-rail', 'Saut réel', '#ff6b6b', 0, track.id);
  // The fixture starts on the actual ramp surface. Every subsequent position,
  // elevation and flight flag comes only from ordinary deterministic movement.
  Object.assign(kart, { x: point.x + Math.cos(point.angle) * offset, z: point.z - Math.sin(point.angle) * offset,
    angle: point.angle + .65, speed: 32 });
  const start = nearestDriveableTrack(kart.x, kart.z, track.id);
  assert.ok(start.progress >= ramp.start && start.progress < ramp.end);
  kart.elevation = trackElevation(start.progress, track.id);
  assert.equal(kart.airborne, false); assert.equal(kart.verticalVelocity, 0);
  assert.ok(clearance(kart) < 0);
  let launched = false, crossedRail = false, landedOutside = false, peak = kart.elevation;
  for (let tick = 0; tick < 180; tick++) {
    const previousClearance = clearance(kart);
    stepKart(kart, { ...neutralInput(tick), throttle: 1 }, 1 / 30);
    const next = nearestDriveableTrack(kart.x, kart.z, track.id);
    launched ||= kart.airborne && kart.verticalVelocity > 0;
    peak = Math.max(peak, kart.elevation);
    if (previousClearance <= 0 && clearance(kart) > .01) {
      assert.ok(launched && kart.airborne, 'the real ramp must launch before the rail crossing');
      assert.ok(kart.elevation > trackElevation(next.progress, track.id) + ROAD_RAIL_TOP);
      assert.equal(trackBoundaryGap(kart.x, kart.z, track.id, kart.eventStage, kart.eventLevel), false,
        'the kart crosses a solid rail, not a branch opening');
      crossedRail = true;
    }
    if (launched && !kart.airborne) {
      landedOutside = clearance(kart) > 1;
      assert.equal(kart.elevation, terrain(kart)); assert.equal(kart.verticalVelocity, 0);
      break;
    }
  }
  assert.ok(launched, 'stepKart detects the actual ramp lip');
  assert.ok(peak > ramp.height + reliefElevation(ramp.end, track) + .5);
  assert.ok(crossedRail, 'flight clears the lateral rail');
  assert.ok(landedOutside, 'the kart lands on the exterior terrain without horizontal teleportation');
});

test('a ground-level kart entering below a raised bridge stays below the deck', () => {
  const { kart, point, side, limit, base } = railFixture(true);
  Object.assign(kart, { x: point.x + Math.cos(point.angle) * side * (limit + .2),
    z: point.z - Math.sin(point.angle) * side * (limit + .2), angle: point.angle - Math.PI / 2 * side, speed: 10, airborne: false });
  kart.elevation = terrain(kart);
  assert.ok(base > kart.elevation + 3);
  for (let tick = 0; tick < 12; tick++) {
    stepKart(kart, { ...neutralInput(), throttle: 1 }, 1 / 30);
    assert.equal(kart.elevation, terrain(kart), 'entering below the bridge cannot act as an elevator');
  }
  assert.ok(clearance(kart) < 0); assert.equal(kart.airborne, false);
});

for (const trackId of ['lagon', 'neon', 'sky']) test(`${trackId}: debris has finite height, swept vertical contact and safe phase changes`, () => {
  const blocker = getTrackEvent(trackId, 1, 3).blockers[0]!;
  const offset = (along: number) => ({ x: blocker.x + Math.sin(blocker.angle) * along, z: blocker.z + Math.cos(blocker.angle) * along });
  const before = offset(-8), after = offset(8), top = blocker.elevation + blocker.height;
  const sweep = (previous: number, current: number) => constrainTrackEvent(after.x, after.z, before.x, before.z, 46, trackId, 1, 3, { previous, current });
  assert.equal(sweep(top + .5, top + .2).blocked, false, 'passes above actual debris');
  assert.equal(sweep(blocker.elevation + .1, blocker.elevation + .1).blocked, true, 'low flight still collides');
  assert.equal(sweep(top + 1, blocker.elevation).blocked, true, 'a descending segment entering the finite box is swept');
  assert.equal(sweep(blocker.elevation, top + 1).blocked, true, 'ending above the box does not erase an earlier impact');
  assert.equal(constrainTrackEvent(blocker.x, blocker.z, blocker.x, blocker.z, 20, trackId, 1, 3,
    { previous: top + .5, current: top + .5 }).blocked, false, 'new debris cannot eject a kart above it');
  const low = constrainTrackEvent(blocker.x, blocker.z, blocker.x, blocker.z, 20, trackId, 1, 3,
    { previous: blocker.elevation, current: blocker.elevation });
  assert.equal(low.blocked, true); assert.ok(Math.hypot(low.x - blocker.x, low.z - blocker.z) > blocker.halfLength);
});

test('airborne shortcuts still require all ordered checkpoint gates and reset restores a valid road position', () => {
  const world = createWorld(true), kart = createKart('air', 'Air', '#ff6b6b', 0);
  world.phase = 'racing'; world.players = [kart]; world.pickups = [];
  const skipped = getTrack('lagon').checkpoints[4]!;
  Object.assign(kart, skipped, { x: skipped.x - Math.sin(skipped.angle) * .2, z: skipped.z - Math.cos(skipped.angle) * .2,
    elevation: 3, verticalVelocity: 0, airborne: true, speed: 20 });
  stepWorld(world, new Map([[kart.id, neutralInput()]]), 1 / 30);
  assert.equal(kart.nextCheckpoint, 1); assert.equal(kart.lap, 0);
  stepWorld(world, new Map([[kart.id, { ...neutralInput(), reset: true }]]), 1 / 30);
  assert.equal(kart.elevation, trackElevation(kart.routeProgress!, kart.trackId)); assert.equal(kart.airborne, false);
  assert.equal(kart.nextCheckpoint, 1); assert.equal(kart.lap, 0); assert.ok(clearance(kart) <= 0);
});
