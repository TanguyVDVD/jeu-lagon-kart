import test from 'node:test';
import assert from 'node:assert/strict';
import { createKart, createWorld, cloneKartForPrediction, neutralInput, resetKart, startRace, stepKart, stepWorld,
  validateInput, type Kart, type World } from '../shared/game.js';
import { getTrack, trackPoint, trackElevation, makeTrack, registerTrackDefinition } from '../shared/track.js';
import { nearestDriveableTrack } from '../shared/track-events.js';
import { trackBoundaryShoulder } from '../shared/obstacle-heights.js';
import { getCpuInput } from '../shared/cpu.js';
import { getKartStats } from '../shared/garage.js';
import { armTeamRelay, resolveTeamRelays, recoveryItemWeights, noteItemDraw, RELAY_BONUS, COMBO_LAP_BUDGET, railResponse } from '../shared/race-fun.js';

const dt = 1 / 30;
function place(kart: Kart, progress: number, speed = 28, offset = 0) {
  const track = getTrack(kart.trackId), local = ((progress % track.length) + track.length) % track.length;
  const point = trackPoint(local, kart.trackId);
  Object.assign(kart, point, { x: point.x + Math.cos(point.angle) * offset, z: point.z - Math.sin(point.angle) * offset,
    speed, progress, lap: Math.floor(progress / track.length), elevation: trackElevation(local, kart.trackId),
    nextCheckpoint: (Math.floor(local / (track.length / track.checkpoints.length)) + 1) % track.checkpoints.length,
    respawnX: point.x, respawnZ: point.z, respawnAngle: point.angle, airborne: false, verticalVelocity: 0 });
}
function race(trackId = 'lagon', count = 1) {
  const world = createWorld(count === 1, trackId); world.phase = 'racing'; world.pickups = [];
  world.players = Array.from({ length: count }, (_, index) => createKart('driver' + index, 'Pilote ' + index, '#ff6b6b', index, trackId));
  return world;
}
function laneInput(kart: Kart, offset = 0) {
  const near = nearestDriveableTrack(kart.x, kart.z, kart.trackId, 0, 0);
  const aim = trackPoint(near.progress + 10, kart.trackId);
  const angle = Math.atan2(aim.x + Math.cos(aim.angle) * offset - kart.x, aim.z - Math.sin(aim.angle) * offset - kart.z);
  const delta = Math.atan2(Math.sin(angle - kart.angle), Math.cos(angle - kart.angle));
  return { ...neutralInput(), throttle: 1, steer: Math.max(-1, Math.min(1, delta * 2.5)) };
}
function comboCircuit() {
  return registerTrackDefinition(makeTrack({ ...getTrack(), id: 'custom-combo-budget-v1', width: 28, zones: [], relief: undefined,
    anchors: Array.from({ length: 8 }, (_, index) => [Math.sin(index * Math.PI / 4) * 500, Math.cos(index * Math.PI / 4) * 500]),
    elevations: Array.from({ length: 6 }, (_, index) => ({ kind: 'jump', start: .108 + index * .16,
      end: .12 + index * .16, height: 1.6, approach: 0, launchSpeed: 6.3 })) }), 'custom-combo-budget', 1);
}

test('rails: real shallow contact keeps momentum while a frontal contact remains penalising', () => {
  const shallow = createKart('graze', 'Frôlement', '#ff6b6b', 0), frontal = createKart('head', 'Frontal', '#ff6b6b', 0);
  const p = 42, track = getTrack(shallow.trackId), offset = track.width / 2 + trackBoundaryShoulder(p, track.id) - .025;
  place(shallow, p, 30, offset); place(frontal, p, 30, offset);
  shallow.angle += .12; frontal.angle += Math.PI / 2;
  stepKart(shallow, { ...neutralInput(), throttle: 1 }, dt);
  stepKart(frontal, { ...neutralInput(), throttle: 1 }, dt);
  assert.ok(shallow.fun!.wallSeconds > 0 && frontal.fun!.wallSeconds > 0);
  assert.ok(shallow.speed > frontal.speed * 2.5, `${shallow.speed} vs ${frontal.speed}`);
  assert.ok(shallow.speed > 20 && frontal.speed < 10);
});

test('rails: holding against the rail is slower than driving the same section cleanly', () => {
  const clean = createKart('clean', 'Propre', '#ff6b6b', 0), wall = createKart('wall', 'Rail', '#ff6b6b', 0);
  const track = getTrack(), offset = track.width / 2 + trackBoundaryShoulder(42, track.id);
  place(clean, 42, 30); place(wall, 42, 30, offset - .03);
  let contacts = 0;
  for (let tick = 0; tick < 120; tick++) {
    stepKart(clean, laneInput(clean), dt); stepKart(wall, laneInput(wall, offset + 2), dt);
    if (wall.fun!.wallSeconds > .22) contacts++;
  }
  const cleanProgress = nearestDriveableTrack(clean.x, clean.z, track.id).progress;
  const wallProgress = nearestDriveableTrack(wall.x, wall.z, track.id).progress;
  assert.ok(contacts > 15, `${contacts} sustained contacts expected`);
  assert.ok(cleanProgress > wallProgress + 15, `${cleanProgress} clean vs ${wallProgress} rubbing`);
  assert.ok(Math.abs(railResponse(46, .1, .3, getKartStats(wall.build).speed)) <= getKartStats(wall.build).speed * .72);
});

test('rails: a real shoulder brush announces once without granting a combo or boost', () => {
  const world = race(), kart = world.players[0]!, p = 42, track = getTrack();
  place(kart, p, 30, track.width / 2 + trackBoundaryShoulder(p, track.id) - .025); kart.angle += .12;
  stepWorld(world, new Map([[kart.id, { ...neutralInput(), throttle: 1 }]]), dt);
  assert.equal(kart.fun!.feedbackKind, 'graze'); assert.equal(kart.fun!.feedbackSeq, 1);
  assert.equal(kart.fun!.chain, 0); assert.equal(kart.boost, 0);
  for (let tick = 0; tick < 10; tick++) stepWorld(world, new Map([[kart.id, { ...neutralInput(), throttle: 1 }]]), dt);
  assert.equal(kart.fun!.feedbackSeq, 1, 'holding the rail does not repeat the announcement');
});

test('prediction clones keep nested feedback, pickups and interactions independent of snapshots', () => {
  const server = createKart('source', 'Source', '#ff6b6b', 0); server.padLaps.pad = 1;
  const predicted = cloneKartForPrediction(server);
  predicted.padLaps.pad = 9; predicted.fun!.chain = 4; predicted.build.engine = 'velocity';
  assert.equal(server.padLaps.pad, 1); assert.equal(server.fun!.chain, 0); assert.notEqual(server.build.engine, predicted.build.engine);
  stepKart(predicted, { ...neutralInput(), throttle: 1 }, dt); assert.equal(server.speed, 0);
});

test('combos: a real ramp jump followed by an aligned landing earns a small two-action chain', () => {
  const world = race('forest'), kart = world.players[0]!, ramp = getTrack('forest').elevations.find(feature => feature.kind === 'jump')!;
  place(kart, ramp.end - 12, 30);
  let launched = false, landed = false, maximumChain = 0, comboReward = 0;
  for (let tick = 0; tick < 240 && !landed; tick++) {
    const airborne = kart.airborne, oldBoost = kart.boost;
    stepWorld(world, new Map([[kart.id, getCpuInput(kart, tick, world)]]), dt);
    launched ||= kart.airborne;
    landed ||= airborne && !kart.airborne;
    maximumChain = Math.max(maximumChain, kart.fun?.chain ?? 0);
    if (kart.fun?.feedbackKind === 'combo') comboReward = Math.max(comboReward, kart.boost - Math.max(0, oldBoost - dt));
  }
  assert.ok(launched && landed, 'ordinary controls must actually launch and land');
  assert.equal(maximumChain, 2); assert.equal(kart.fun!.feedbackKind, 'combo');
  assert.ok(comboReward > 0 && comboReward <= .181, `bounded bonus: ${comboReward}`);
  const sequence = kart.fun!.feedbackSeq;
  resetKart(kart); place(kart, ramp.end - 12, 30);
  for (let tick = 0; tick < 160; tick++) stepWorld(world, new Map([[kart.id, getCpuInput(kart, tick, world)]]), dt);
  assert.equal(kart.fun!.feedbackSeq, sequence, 'resetting and replaying the same ramp cannot farm another chain');
});

test('combos: a real charged drift is one action; repeating it cannot stack the chain', () => {
  const world = race(comboCircuit().id), kart = world.players[0]!; place(kart, 40, 28);
  for (let repeat = 0; repeat < 2; repeat++) {
    for (let tick = 0; tick < 23; tick++) stepWorld(world, new Map([[kart.id,
      { ...neutralInput(), throttle: 1, drift: true, steer: tick % 2 ? .16 : -.16 }]]), dt);
    assert.ok(kart.driftCharge >= .65, 'ordinary steering must really charge drift');
    stepWorld(world, new Map([[kart.id, { ...laneInput(kart), drift: false }]]), dt);
    assert.ok(kart.boost > 0); assert.equal(kart.fun!.chain, 1); assert.equal(kart.fun!.feedbackSeq, 0);
  }
  for (let tick = 0; tick < 250; tick++) stepWorld(world, new Map([[kart.id, { ...neutralInput(), brake: true }]]), dt);
  assert.equal(kart.fun!.chain, 0, 'the chain expires rather than surviving until the next lap');
});

test('combos: six real jump/landing chains on one authored lap never exceed the extra turbo budget', () => {
  const track = comboCircuit();
  const world = race(track.id), kart = world.players[0]!; place(kart, 10, 28);
  let landings = 0, totalReward = 0;
  for (let tick = 0; tick < 4000 && landings < 6; tick++) {
    const airborne = kart.airborne, previousBoost = kart.boost, sequence = kart.fun!.feedbackSeq;
    stepWorld(world, new Map([[kart.id, { ...getCpuInput(kart, tick, world), drift: false }]]), dt);
    if (airborne && !kart.airborne) landings++;
    if (kart.fun!.feedbackSeq !== sequence && kart.fun!.feedbackKind === 'combo')
      totalReward += kart.boost - Math.max(0, previousBoost - dt);
  }
  assert.equal(landings, 6, 'all rewards follow real driven launches and landings');
  assert.equal(kart.lap, 0); assert.ok(totalReward > .89 && totalReward <= COMBO_LAP_BUDGET + 1e-9, `earned ${totalReward}s`);
});

test('combos and relay feedback cannot be supplied by a client and reset at a new race', () => {
  for (const forged of [{ fun: { chain: 4, feedbackKind: 'combo' } }, { boost: 50 }, { relayTarget: 'other' }])
    assert.equal(validateInput({ ...neutralInput(), ...forged }), null);
  const world = race(), kart = world.players[0]!;
  kart.fun!.chain = 4; kart.fun!.feedbackKind = 'combo'; startRace(world);
  assert.equal(kart.fun!.chain, 0); assert.equal(kart.fun!.feedbackSeq, 0); assert.equal(kart.boost, 0);
});

const base = [12, 25, 5, 8, 18, 12, 14, 6];
function rollingRace(gap: number) {
  const world = race('lagon', 2); world.raceTime = 10;
  place(world.players[0]!, 30, 30); place(world.players[1]!, 30 + gap, 30);
  for (let tick = 0; tick < 105; tick++) stepWorld(world, new Map(world.players.map(kart => [kart.id, getCpuInput(kart, tick, world)])), dt);
  return world;
}
test('recovery: equal ranks with different real gaps yield different recovery odds, capped to one draw per lap', () => {
  const near = rollingRace(20), far = rollingRace(190);
  const nearDraw = recoveryItemWeights(near, near.players[0]!, base), farDraw = recoveryItemWeights(far, far.players[0]!, base);
  assert.equal(nearDraw.seconds, 0); assert.deepEqual(nearDraw.weights, base);
  assert.ok(farDraw.seconds > 2.5); assert.ok(farDraw.weights[1]! > base[1]!);
  assert.ok(farDraw.weights[5]! < base[5]!, 'return tools replace leader attacks');
  assert.ok(Math.abs(farDraw.weights.reduce((a, b) => a + b, 0) - 100) < .0001);
  far.players[0]!.rank = 1;
  assert.deepEqual(recoveryItemWeights(far, far.players[0]!, base), farDraw, 'a forged/stale displayed rank has no effect');
  noteItemDraw(far, far.players[0]!, farDraw.seconds);
  assert.equal(recoveryItemWeights(far, far.players[0]!, base).seconds, 0);
});

test('recovery: waiting, reversing, resets and the initial grid cannot manufacture extra assistance', () => {
  const world = rollingRace(190), kart = world.players[0]!;
  assert.ok(recoveryItemWeights(world, kart, base).seconds > 0);
  for (let tick = 0; tick < 150; tick++) stepWorld(world, new Map([[kart.id, neutralInput()],
    [world.players[1]!.id, getCpuInput(world.players[1]!, tick, world)]]), dt);
  for (let tick = 0; tick < 100; tick++) stepWorld(world, new Map(world.players.map(driver => [driver.id, getCpuInput(driver, tick, world)])), dt);
  assert.equal(recoveryItemWeights(world, kart, base).seconds, 0, 'resuming briefly after parking is not enough');
  const reset = rollingRace(190), resetDriver = reset.players[0]!;
  stepWorld(reset, new Map([[resetDriver.id, { ...neutralInput(), reset: true }]]), dt);
  for (let tick = 0; tick < 120; tick++) stepWorld(reset, new Map(reset.players.map(driver => [driver.id, getCpuInput(driver, tick, reset)])), dt);
  assert.equal(recoveryItemWeights(reset, resetDriver, base).seconds, 0, 'manual respawn has a recovery exclusion window');
  const grid = rollingRace(190); grid.raceTime = 2;
  assert.equal(recoveryItemWeights(grid, grid.players[0]!, base).seconds, 0);
  const backwards = rollingRace(190), reverseDriver = backwards.players[0]!;
  for (let tick = 0; tick < 180; tick++) stepWorld(backwards, new Map([[reverseDriver.id, { ...laneInput(reverseDriver), throttle: -1 }],
    [backwards.players[1]!.id, getCpuInput(backwards.players[1]!, tick, backwards)]]), dt);
  assert.ok(reverseDriver.speed < 0, 'the kart really moved backwards');
  assert.equal(recoveryItemWeights(backwards, reverseDriver, base).seconds, 0);
});

test('relays: a real allied draft and pass reward both pilots without an extra button', () => {
  const world = race('lagon', 2); world.teamMode = true;
  const follower = world.players[0]!, leader = world.players[1]!; follower.team = leader.team = 0;
  place(follower, 58, 25); place(leader, 72, 25);
  let drafted = false, relayed = false;
  for (let tick = 0; tick < 240 && !relayed; tick++) {
    const leadInput = laneInput(leader); if (leader.speed > 25) leadInput.throttle = 0;
    const followerInput = laneInput(follower, drafted ? 3.5 : 0);
    stepWorld(world, new Map([[leader.id, leadInput], [follower.id, followerInput]]), dt);
    drafted ||= follower.draftCooldown > 0;
    relayed = follower.fun?.feedbackKind === 'relay';
  }
  assert.ok(drafted, 'normal following charges the existing draft');
  assert.ok(relayed, 'a normal forward pass completes the team relay');
  assert.equal(leader.fun!.feedbackKind, 'relay'); assert.ok(leader.boost > 0);
  assert.ok(follower.boost <= 1.5);
});

test('relays: one pair per lap, cooldown, enemy, height and disconnected guards prevent farming', () => {
  const world = race('lagon', 2); world.teamMode = true;
  const a = world.players[0]!, b = world.players[1]!; a.team = b.team = 0;
  place(a, 40); place(b, 48); armTeamRelay(world, a, b); place(a, 60); place(b, 54); resolveTeamRelays(world);
  assert.equal(a.boost, RELAY_BONUS); assert.equal(b.boost, RELAY_BONUS);
  a.boost = b.boost = 0; world.raceTime += 20;
  place(a, 40); place(b, 48); armTeamRelay(world, a, b); place(a, 60); place(b, 54); resolveTeamRelays(world);
  assert.equal(a.boost, 0, 'same pair and lap stays used after cooldown');
  for (const scenario of ['enemy', 'height', 'disconnected', 'airborne'] as const) {
    const other = race('lagon', 2); other.teamMode = true; const [follower, leader] = other.players;
    follower!.team = leader!.team = 0; place(follower!, 40); place(leader!, 48);
    if (scenario === 'enemy') leader!.team = 1;
    if (scenario === 'height') leader!.elevation = 5;
    if (scenario === 'airborne') follower!.airborne = true;
    armTeamRelay(other, follower!, leader!); place(follower!, 60); place(leader!, 54);
    if (scenario === 'disconnected') leader!.connected = false;
    resolveTeamRelays(other); assert.equal(follower!.boost, 0, scenario);
  }
});
