import test from 'node:test';
import assert from 'node:assert/strict';
import { COLORS, createKart, createWorld, getTrack, neutralInput, stepWorld, trackPoint,
  type Item, type Kart, type World, type WorldObject } from '../shared/game.js';
import { applyConfiguration, createTournament, recordRound, type TournamentDriver } from '../shared/tournament.js';
import { teamStandings } from '../shared/teams.js';

const dt = 1 / 30;
function place(kart: Kart, progress: number) {
  const track = getTrack(kart.trackId), local = progress % track.length;
  Object.assign(kart, trackPoint(local, track.id), { progress, lap: Math.floor(progress / track.length), speed: 0,
    nextCheckpoint: (Math.floor(local / (track.length / 12)) + 1) % 12 });
}
function race(count = 3): World {
  const world = createWorld(false); world.phase = 'racing'; world.teamMode = true; world.pickups = [];
  world.players = Array.from({ length: count }, (_, index) => createKart('p' + index, 'Pilote ' + index, COLORS[index]!, index));
  world.players.forEach((kart, index) => { place(kart, 40 + 40 * index); kart.team = index < 2 ? 0 : 1; });
  return world;
}
function use(world: World, item: Item) {
  const owner = world.players[0]!; owner.item = item; owner.itemCharges = 1; owner.itemLatch = false;
  stepWorld(world, new Map([[owner.id, { ...neutralInput(), use: true }]]), dt);
}

test('red and blue guided items skip allies ahead, including the overall allied leader', () => {
  for (const kind of ['seeker', 'leaderBolt'] as const) {
    const world = race(5);
    const [owner, ally, nearEnemy, farEnemy, alliedLeader] = world.players;
    alliedLeader!.team = 0; place(alliedLeader!, getTrack().length + 30);
    nearEnemy!.rank = 99; farEnemy!.rank = 8; ally!.rank = 1;
    use(world, kind);
    assert.equal(world.objects.length, 1);
    assert.equal(world.objects[0]!.targetId, kind === 'seeker' ? nearEnemy!.id : farEnemy!.id);
    assert.equal(owner!.stun, 0); assert.equal(ally!.stun, 0); assert.equal(alliedLeader!.stun, 0);
  }
});

test('a guided item becomes a turbo when only teammates and inactive opponents remain', () => {
  for (const kind of ['seeker', 'leaderBolt'] as const) {
    const world = race(6);
    world.players[2]!.connected = false; world.players[3]!.finished = true;
    world.players[4]!.spectator = true; world.players[5]!.abandoned = true;
    use(world, kind);
    assert.equal(world.objects.length, 0); assert.equal(world.players[0]!.item, '');
    assert.ok(world.players[0]!.boost > 1); assert.equal(world.players[1]!.stun, 0);
  }
});

for (const kind of ['trap', 'projectile', 'seeker', 'leaderBolt'] as const)
  test(kind + ': allies do not absorb or suffer friendly objects but enemies still take the hit', () => {
    const world = race(), [owner, ally, enemy] = world.players;
    ally!.shield = 4;
    const object: WorldObject = { id: 'friendly-' + kind, kind, x: ally!.x, z: ally!.z,
      angle: ally!.angle, owner: owner!.id, ttl: 10, targetId: enemy!.id };
    world.objects = [object];
    stepWorld(world, new Map(), dt);
    assert.equal(ally!.stun, 0); assert.ok(ally!.shield > 3.9, 'friendly fire must not consume the ally shield');
    assert.equal(world.objects.length, 1, 'an ally must not absorb an object intended for an enemy');
    Object.assign(enemy!, { x: object.x, z: object.z, speed: 0 });
    stepWorld(world, new Map(), dt);
    assert.ok(enemy!.stun > 0, 'enemy impact must still work');
    assert.equal(ally!.stun, 0); assert.ok(ally!.shield > 3.8); assert.equal(world.objects.length, 0);
  });

test('a disconnected owner retains team protection for an already launched projectile', () => {
  const world = race(), [owner, ally] = world.players;
  owner!.connected = false; owner!.abandoned = true;
  world.objects = [{ id: 'departed-shot', kind: 'projectile', x: ally!.x, z: ally!.z, angle: ally!.angle, owner: owner!.id, ttl: 4 }];
  stepWorld(world, new Map(), dt);
  assert.equal(ally!.stun, 0); assert.equal(world.objects.length, 1);
});

test('a star passes through teammates without consuming their shield but stuns an unprotected enemy', () => {
  const world = race(), [star, ally, enemy] = world.players;
  use(world, 'star');
  Object.assign(ally!, { x: star!.x + .5, z: star!.z, elevation: star!.elevation, speed: 0, shield: 4 });
  Object.assign(enemy!, { x: star!.x - .5, z: star!.z, elevation: star!.elevation, speed: 0 });
  stepWorld(world, new Map(), dt);
  assert.equal(star!.stun, 0); assert.equal(ally!.stun, 0); assert.ok(ally!.shield > 3.9);
  assert.ok(enemy!.stun > 0); assert.ok(star!.invincible > 5);
});

test('ordinary free-for-all races keep object and star impacts even for identical stored team numbers', () => {
  for (const effect of ['trap', 'star'] as const) {
    const world = race(), [owner, victim] = world.players; world.teamMode = false;
    assert.equal(owner!.team, victim!.team);
    if (effect === 'trap') world.objects = [{ id: 'free-for-all', kind: 'trap', x: victim!.x, z: victim!.z, angle: 0, owner: owner!.id, ttl: 10 }];
    else { use(world, 'star'); Object.assign(victim!, { x: owner!.x + .5, z: owner!.z }); }
    stepWorld(world, new Map(), dt); assert.ok(victim!.stun > 0, effect);
  }
});

test('collective scores update exactly once per round and retain a departed teammates earned points', () => {
  const tournament = applyConfiguration(createTournament(), { mode: 'tournament', selection: 'manual', raceCount: 2,
    schedule: ['lagon', 'dunes'] }, 'lagon').tournament;
  const drivers: TournamentDriver[] = Array.from({ length: 8 }, (_, index) => ({ id: 'p' + index, name: 'Pilote ' + index,
    color: COLORS[index]!, team: index % 2 as 0 | 1, rank: index + 1, finished: true, finishTime: 60 + index + 1 }));
  const collective = () => teamStandings(tournament.standings, new Map(tournament.standings.map(row => [row.id, row.team!])));
  assert.equal(recordRound(tournament, 'lagon', drivers), true);
  assert.deepEqual(collective().map(team => [team.team, team.points]), [[0, 33], [1, 25]]);
  const once = structuredClone(collective());
  assert.equal(recordRound(tournament, 'lagon', drivers), false); assert.deepEqual(collective(), once);
  tournament.raceIndex = 1;
  const returning = drivers.slice(1).map(driver => ({ ...driver, rank: 9 - driver.rank, finishTime: 60 + 9 - driver.rank }));
  const spectator: TournamentDriver = { id: 'watcher', name: 'Public', color: COLORS[0]!, team: 0, spectator: true, rank: 1, finished: true, finishTime: 1 };
  assert.equal(recordRound(tournament, 'dunes', [...returning, spectator]), true);
  assert.equal(tournament.completed, true); assert.equal(tournament.standings.find(row => row.id === 'p0')!.points, 15);
  assert.equal(tournament.standings.some(row => row.id === 'watcher'), false);
  assert.deepEqual(collective().map(team => [team.team, team.points]), [[1, 58], [0, 57]]);
  const final = structuredClone(collective());
  assert.equal(recordRound(tournament, 'dunes', returning), false); assert.deepEqual(collective(), final);
});
