import test from 'node:test';
import assert from 'node:assert/strict';
import { autopilot } from '../shared/autopilot.js';
import { CHECKPOINTS, COLORS, FINISH_GRACE_SECONDS, ITEMS, MAX_RACE_SECONDS, PICKUP_RESPAWN_SECONDS, ROAD_WIDTH, TOTAL_LAPS,
  TRACK_LENGTH, createKart, createWorld, nearestTrack, neutralInput, resetKart, spawnPoint,
  standings, startRace, stepKart, stepWorld, trackPoint, validateInput, type Input, type World } from '../shared/game.js';

const dt = 1 / 30;
function race(count = 1): World {
  const world = createWorld(count === 1);
  world.players = Array.from({ length: count }, (_, index) => createKart(`p${index}`, `Pilote ${index}`, COLORS[index]!, index));
  world.hostId = world.players[0]!.id;
  startRace(world);
  for (let i = 0; i < 90; i++) stepWorld(world, new Map(), dt);
  assert.equal(world.phase, 'racing');
  return world;
}
function cross(world: World, checkpointIndex: number, playerIndex = 0, reverse = false): void {
  const kart = world.players[playerIndex]!;
  const cp = CHECKPOINTS[checkpointIndex]!;
  const direction = reverse ? -1 : 1;
  kart.x = cp.x - Math.sin(cp.angle) * 0.3 * direction;
  kart.z = cp.z - Math.cos(cp.angle) * 0.3 * direction;
  kart.angle = cp.angle + (reverse ? Math.PI : 0);
  kart.speed = 20;
  stepWorld(world, new Map([[kart.id, { ...neutralInput(), throttle: 1 }]]), dt);
}

test('strict input validation rejects forged state, malformed values and unknown fields', () => {
  assert.deepEqual(validateInput(neutralInput(4, 2)), neutralInput(4, 2));
  for (const input of [null, [], {}, { ...neutralInput(), x: 9 }, { ...neutralInput(), lap: 3 },
    { ...neutralInput(), seq: -1 }, { ...neutralInput(), seq: 1.5 }, { ...neutralInput(), seq: Number.MAX_SAFE_INTEGER + 1 },
    { ...neutralInput(), epoch: -1 }, { ...neutralInput(), steer: NaN }, { ...neutralInput(), throttle: Infinity },
    { ...neutralInput(), steer: 2 }, { ...neutralInput(), reset: 'yes' }]) assert.equal(validateInput(input), null);
});

test('three second countdown prevents movement and cleanly starts the race', () => {
  const world = createWorld();
  world.players.push(createKart('p0', 'Pilote', COLORS[0]!, 0));
  world.players[0]!.epoch = 7;
  world.players[0]!.lastSeq = 140;
  startRace(world);
  const x = world.players[0]!.x;
  for (let i = 0; i < 89; i++) stepWorld(world, new Map([['p0', { ...neutralInput(), throttle: 1 }]]), dt);
  assert.equal(world.phase, 'countdown'); assert.equal(world.players[0]!.x, x);
  stepWorld(world, new Map(), dt);
  assert.equal(world.phase, 'racing'); assert.equal(world.raceTime, 0);
  assert.equal(world.players[0]!.epoch, 7); assert.equal(world.players[0]!.lastSeq, 140);
});

test('only all ordered checkpoints in the forward direction award laps and a shared result', () => {
  const world = race(2);
  cross(world, 0); assert.equal(world.players[0]!.lap, 0);
  cross(world, 4); assert.equal(world.players[0]!.nextCheckpoint, 1);
  cross(world, 1, 0, true); assert.equal(world.players[0]!.nextCheckpoint, 1);
  for (let lap = 0; lap < TOTAL_LAPS; lap++) {
    for (let index = 1; index < CHECKPOINTS.length; index++) cross(world, index);
    assert.equal(world.players[0]!.lap, lap);
    cross(world, 0);
    assert.equal(world.players[0]!.lap, lap + 1);
  }
  assert.equal(world.players[0]!.finished, true);
  assert.equal(world.players[0]!.progress, TOTAL_LAPS * TRACK_LENGTH);
  assert.equal(world.phase, 'racing');
  for (let lap = 0; lap < TOTAL_LAPS; lap++) {
    for (let index = 1; index < CHECKPOINTS.length; index++) cross(world, index, 1);
    cross(world, 0, 1);
  }
  assert.equal(world.phase, 'finished');
  assert.deepEqual(standings(world).map(kart => kart.id), ['p0', 'p1']);
});

test('reset returns to a validated checkpoint without awarding progression', () => {
  const world = race(); const kart = world.players[0]!;
  cross(world, 1);
  const checkpoint = { x: kart.respawnX, z: kart.respawnZ };
  kart.x += 30; kart.z += 40;
  resetKart(kart);
  assert.equal(kart.x, checkpoint.x); assert.equal(kart.z, checkpoint.z);
  assert.equal(kart.nextCheckpoint, 2); assert.equal(kart.lap, 0);
  assert.equal(kart.speed, 0);
});

test('deterministic client movement and server movement agree without external effects', () => {
  const world = race(); world.pickups = [];
  const predicted = structuredClone(world.players[0]!);
  for (let seq = 0; seq < 80; seq++) {
    const input = { ...neutralInput(seq), throttle: 1, steer: 0.06 };
    stepKart(predicted, input, dt);
    stepWorld(world, new Map([[predicted.id, input]]), dt);
  }
  assert.equal(predicted.x, world.players[0]!.x); assert.equal(predicted.z, world.players[0]!.z);
  assert.equal(predicted.speed, world.players[0]!.speed);
});

test('drift release awards mini turbo; offroad slows and a grounded crossing meets the rail', () => {
  const kart = createKart('p', 'Pilote', COLORS[0]!, 0);
  kart.speed = 25;
  // Follow the centerline while holding drift to isolate charge/release physics.
  for (let i = 0; i < 24; i++) {
    Object.assign(kart, trackPoint(20 + i));
    stepKart(kart, { ...neutralInput(), throttle: 1, steer: 0.4, drift: true }, dt);
  }
  assert.ok(kart.driftCharge > 0.65);
  stepKart(kart, neutralInput(), dt);
  assert.ok(kart.boost > 0);
  const point = trackPoint(20);
  Object.assign(kart, point, { x: point.x + Math.cos(point.angle) * 11,
    z: point.z - Math.sin(point.angle) * 11, speed: 30, boost: 0 });
  stepKart(kart, { ...neutralInput(), throttle: 1 }, dt);
  assert.ok(kart.speed < 30);
  Object.assign(kart, { x: point.x + Math.cos(point.angle) * (ROAD_WIDTH / 2 + 4.8),
    z: point.z - Math.sin(point.angle) * (ROAD_WIDTH / 2 + 4.8), angle: point.angle + Math.PI / 2,
    speed: 10, turnVelocity: 0, lateralVelocity: 0 });
  stepKart(kart, neutralInput(), .1);
  assert.ok(nearestTrack(kart.x, kart.z).distance <= ROAD_WIDTH / 2 + 5.01);
});

test('server assigns pickups and a held item button cannot consume newly collected items', () => {
  const world = race(); const kart = world.players[0]!;
  world.pickups = [{ id: 'box', x: kart.x, z: kart.z, cooldown: 0 }];
  stepWorld(world, new Map(), dt);
  assert.ok(ITEMS.includes(kart.item as typeof ITEMS[number]));
  assert.equal(world.pickups[0]!.cooldown, PICKUP_RESPAWN_SECONDS);
  kart.item = 'turbo';
  const held = { ...neutralInput(), use: true };
  stepWorld(world, new Map([[kart.id, held]]), dt);
  assert.equal(kart.item, ''); assert.ok(kart.boost > 2);
  kart.item = 'trap';
  stepWorld(world, new Map([[kart.id, held]]), dt);
  assert.equal(kart.item, 'trap');
  stepWorld(world, new Map(), dt);
  stepWorld(world, new Map([[kart.id, held]]), dt);
  assert.equal(kart.item, ''); assert.equal(world.objects[0]!.kind, 'trap');
});

test('trap and projectile hit opponents, never their owner, then disappear', () => {
  for (const kind of ['trap', 'projectile'] as const) {
    const world = race(2); const [owner, victim] = world.players;
    const point = trackPoint(40);
    Object.assign(owner!, point);
    const forward = kind === 'projectile' ? 5 : -3;
    Object.assign(victim!, point, { x: point.x + Math.sin(point.angle) * forward,
      z: point.z + Math.cos(point.angle) * forward });
    owner!.item = kind;
    stepWorld(world, new Map([[owner!.id, { ...neutralInput(), use: true }]]), dt);
    assert.equal(owner!.stun, 0); assert.ok(victim!.stun > 0, kind);
    assert.equal(world.objects.length, 0);
  }
});

test('items expire, collisions separate karts, and disconnected inputs are neutralized', () => {
  const world = race(2); const [a, b] = world.players;
  Object.assign(b!, { x: a!.x + 0.5, z: a!.z });
  world.objects.push({ id: 'expired', kind: 'trap', x: 0, z: 0, angle: 0, owner: a!.id, ttl: dt / 2 });
  a!.connected = false;
  stepWorld(world, new Map([[a!.id, { ...neutralInput(), throttle: 1 }]]), dt);
  assert.equal(a!.speed, 0); assert.equal(world.objects.length, 0);
  assert.ok(Math.hypot(a!.x - b!.x, a!.z - b!.z) >= 2.49);
});

test('inactive racers cannot block results and rematch clears all prior race state', () => {
  const world = race(2);
  world.players[0]!.finished = true; world.players[0]!.finishTime = 10;
  world.finishTimeout = FINISH_GRACE_SECONDS;
  for (let i = 0; i < (FINISH_GRACE_SECONDS + 1) * 30; i++) stepWorld(world, new Map(), dt);
  assert.equal(world.phase, 'finished'); assert.equal(world.players[1]!.finished, false);
  world.players[1]!.item = 'trap';
  startRace(world);
  assert.equal(world.phase, 'countdown'); assert.equal(world.round, 2);
  for (const kart of world.players) {
    assert.equal(kart.finished, false); assert.equal(kart.lap, 0); assert.equal(kart.item, '');
  }
  world.phase = 'racing'; world.raceTime = MAX_RACE_SECONDS;
  stepWorld(world, new Map(), dt); assert.equal(world.phase, 'finished');
});

test('spectators never move, receive items or enter the standings', () => {
  const world = race(); const spectator = createKart('watch', 'Spectateur', COLORS[1]!, 1);
  spectator.spectator = true; world.players.push(spectator);
  const before = spawnPoint(1);
  stepWorld(world, new Map([[spectator.id, { ...neutralInput(), throttle: 1 }]]), dt);
  assert.equal(spectator.x, before.x); assert.equal(spectator.z, before.z);
  assert.equal(standings(world).length, 1);
});

test('eight ordinary input drivers finish three full laps including objects and kart collisions', () => {
  const world = race(8);
  for (let tick = 0; tick < 30 * 150 && world.phase === 'racing'; tick++) {
    stepWorld(world, new Map(world.players.map(kart => [kart.id, autopilot(kart, tick, true)])), dt);
  }
  assert.equal(world.phase, 'finished');
  assert.equal(world.players.filter(kart => kart.finished).length, 8);
  assert.ok(world.raceTime < 100, `Duration ${world.raceTime}s`);
  assert.equal(new Set(world.players.map(kart => kart.rank)).size, 8);
});

test('abandoned karts remain classified without blocking a finished race', () => {
  const world = race(2);
  world.players[0]!.finished = true;
  world.players[1]!.abandoned = true;
  const x = world.players[1]!.x;
  stepWorld(world, new Map([[world.players[1]!.id, { ...neutralInput(), throttle: 1 }]]), dt);
  assert.equal(world.phase, 'finished');
  assert.equal(world.players[1]!.x, x);
  assert.equal(standings(world).length, 2);
});
