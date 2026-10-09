import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client, type Room } from 'colyseus.js';
import { matchMaker } from '@colyseus/core';
import { createPartyState, startPartyVote, castPartyVote, resolvePartyVote, RaceHighlights } from '../shared/party.js';
import { createKart, createWorld, neutralInput, type World } from '../shared/game.js';
import { CUSTOM_TRACK_TEMPLATES, customTrackRuntimeId, getTrackWorkshopStart, type StoredCustomTrack } from '../shared/custom-tracks.js';
import { getTrack, trackPoint } from '../shared/track.js';
import type { RaceRoom } from '../server/RaceRoom.js';

test('party vote has one editable ballot, strict deadline and rotating ties', () => {
  const party = createPartyState(['lagon', 'neon', 'canyon']); startPartyVote(party, 1000);
  assert.equal(castPartyVote(party, 'a', 'lagon', 1001), true); assert.equal(castPartyVote(party, 'a', 'neon', 1002), true);
  assert.deepEqual(party.votes, { a: 'neon' }); assert.equal(castPartyVote(party, 'b', 'canyon', 9000), false);
  assert.equal(castPartyVote(party, 'b', 'unknown', 1003), false);
  assert.equal(resolvePartyVote(party, ['a'], 1), 'neon');
  startPartyVote(party, 10000); castPartyVote(party, 'gone', 'lagon', 10001);
  assert.equal(resolvePartyVote(party, ['a'], 2), 'canyon', 'disconnected votes ignored; empty tie rotates');
});

test('highlights report observed events once and never invent a parked action', () => {
  const world = createWorld(); world.phase = 'racing'; world.players = [createKart('a', 'Alice', '#ff0000', 0), createKart('b', 'Bob', '#00ff00', 1)];
  const observer = new RaceHighlights(); world.raceTime = 2; observer.sample(world, .1); assert.equal(observer.entries.length, 0);
  world.players[0]!.rank = 2; world.players[1]!.rank = 1; world.raceTime = 3; observer.sample(world, .1);
  assert.equal(observer.entries[0]?.label, 'Bob prend la tête'); assert.equal(observer.entries[0]?.atMs, 3000);
  world.players[1]!.airborne = true;
  for (let index = 0; index < 9; index++) { world.raceTime += .1; observer.sample(world, .1); }
  world.players[1]!.airborne = false; observer.sample(world, .1); assert.equal(observer.entries[1]?.kind, 'jump');
  world.phase = 'finished'; world.raceTime = 41; Object.assign(world.players[1]!, { finished: true, finishTime: 40 }); Object.assign(world.players[0]!, { finished: true, finishTime: 40.2 });
  observer.sample(world, .1); const count = observer.entries.length; observer.sample(world, .1);
  assert.equal(observer.entries.length, count); assert.equal(observer.entries.at(-1)?.kind, 'close-finish');
});

test('CPU actions are not advertised as replay moments and humans behind a CPU are not leaders', () => {
  const world = createWorld(); world.phase = 'racing';
  world.players = [createKart('cpu', 'CPU', '#ff0000', 0), createKart('human', 'Alice', '#00ff00', 1)];
  world.players[0]!.cpu = true;
  const observer = new RaceHighlights(); world.raceTime = 2; observer.sample(world, .1);
  world.players[0]!.airborne = true;
  for (let index = 0; index < 10; index++) { world.raceTime += .1; observer.sample(world, .1); }
  world.players[0]!.airborne = false; observer.sample(world, .1);
  assert.equal(observer.entries.length, 0, 'CPU jump and human in second place do not produce a moment');
  world.players[0]!.rank = 2; world.players[1]!.rank = 1; observer.sample(world, .1);
  assert.equal(observer.entries[0]?.label, 'Alice prend la tête', 'real human overtaking a CPU is replayable');
});

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string, timeout = 7000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw Error(label); await pause(20); } }
type Peer = { room: Room; world?: World; tracks?: StoredCustomTrack[]; notices: string[] };
function observe(room: Room): Peer {
  const peer: Peer = { room, notices: [] }; room.onMessage('snapshot', (snapshot: { world: World; tracks?: StoredCustomTrack[] }) => { peer.world = snapshot.world; peer.tracks = snapshot.tracks; });
  room.onMessage('notice', (notice: { message: string }) => peer.notices.push(notice.message)); room.onError(() => {}); return peer;
}

test('live party rooms, crown persistence isolation and workshop sessions', { timeout: 50000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lagon-party-room-'));
  const oldPlayers = process.env.PLAYER_DATA_DIR, oldTracks = process.env.CUSTOM_TRACK_DATA_DIR;
  process.env.PLAYER_DATA_DIR = join(directory, 'players'); process.env.CUSTOM_TRACK_DATA_DIR = join(directory, 'tracks');
  const { createGameServer } = await import('../server/app.js'); const { playerStore } = await import('../server/career.js');
  const { PlayerStore } = await import('../server/player-store.js');
  const { gameServer, httpServer, ready } = createGameServer(directory); const trackStore = await ready;
  const peers: Peer[] = [];
  t.after(async () => {
    await Promise.allSettled(peers.filter(peer => peer.room.connection.isOpen).map(peer => peer.room.leave()));
    await gameServer.gracefullyShutdown(false); await (await playerStore()).flush();
    if (oldPlayers === undefined) delete process.env.PLAYER_DATA_DIR; else process.env.PLAYER_DATA_DIR = oldPlayers;
    if (oldTracks === undefined) delete process.env.CUSTOM_TRACK_DATA_DIR; else process.env.CUSTOM_TRACK_DATA_DIR = oldTracks;
    await rm(directory, { recursive: true, force: true });
  });
  await gameServer.listen(0, '127.0.0.1'); const address = httpServer.address(); assert.ok(address && typeof address !== 'string');
  const sdk = new Client(`ws://127.0.0.1:${address.port}`), store = await playerStore();
  const account = await store.createPlayer('Host'), second = await store.createPlayer('Guest');
  const host = observe(await sdk.create('race', { name: 'Host', token: account.token })); peers.push(host);
  const guest = observe(await sdk.joinById(host.room.roomId, { name: 'Guest', token: second.token })); peers.push(guest);
  await until(() => host.world?.players.length === 2, 'two peers');
  const live = matchMaker.getLocalRoomById(host.room.roomId) as RaceRoom;
  await t.test('host only and atomic mode validation preserve a six-round programme', async () => {
    guest.room.send('funConfigure', { crown: true, party: true, choices: ['lagon', 'neon', 'canyon'] });
    await until(() => guest.notices.length > 0, 'guest rejected'); assert.equal(live.world.crown, undefined);
    host.room.send('funConfigure', { crown: true, party: true, choices: ['lagon', 'lagon', 'canyon'] });
    await until(() => host.notices.length > 0, 'duplicate choices rejected'); assert.equal(live.world.crown, undefined);
    host.room.send('configure', { mode: 'tournament', selection: 'manual', raceCount: 6, schedule: ['lagon', 'canyon', 'neon', 'lagon', 'canyon', 'neon'] });
    await until(() => host.world?.tournament.raceCount === 6, 'six races configured');
    host.room.send('funConfigure', { crown: true, party: true, choices: ['lagon', 'neon', 'canyon'] });
    await until(() => !!host.world?.crown && !!guest.world?.party, 'modes shared');
    assert.equal(live.world.tournament.raceCount, 6); assert.equal(live.world.tournament.schedule.length, 6);
  });
  await t.test('natural countdown, declared clock fixture, real votes and same-room ready transition', async () => {
    host.room.send('ready', { ready: true }); guest.room.send('ready', { ready: true });
    await until(() => live.world.players.every(player => player.ready), 'ready'); host.room.send('start');
    await until(() => live.world.phase === 'racing', 'countdown'); assert.equal(live.world.players.some(player => player.finished), false);
    await pause(250);
    // Time-only fixture: the normal simulation finishes the 90-second mode;
    // no injected results, scores, votes or persistence calls.
    live.world.raceTime = 89.98;
    await until(() => host.world?.phase === 'finished' && host.world.party?.phase === 'voting', 'crown finish opens vote');
    assert.equal(live.world.players.every(player => player.finished), true);
    host.room.send('partyVote', { trackId: 'neon' }); guest.room.send('partyVote', { trackId: 'neon' });
    await until(() => Object.values(live.world.party!.votes).filter(id => id === 'neon').length === 2, 'two live votes');
    live.world.party!.endsAt = Date.now() - 1; // Deadline fixture; vote resolution remains authoritative.
    await until(() => guest.world?.phase === 'lobby' && guest.world.tournament.raceIndex === 1, 'same room next lobby');
    assert.equal(live.world.trackId, 'neon'); assert.equal(live.world.tournament.rounds.length, 1); assert.equal(live.world.tournament.raceCount, 6);
    assert.equal(live.world.players.every(player => !player.ready), true); assert.equal(host.room.connection.isOpen && guest.room.connection.isOpen, true);
    assert.deepEqual(live.world.tournament.standings.map(row => row.points).sort((a, b) => b - a), [15, 12]);
  });
  await t.test('crown replay survives reload without XP, races, records, ghosts or MMR', async () => {
    await until(() => !!live.world.party?.lastReplayId, 'crown replay saved'); await store.flush();
    const replay = await store.getReplay(live.world.party!.lastReplayId!); assert.ok(replay); assert.equal(replay.mode, 'crown'); assert.equal(replay.ranked, false);
    assert.equal(replay.drivers.every(driver => driver.frames.at(-1)![5] === 0 && driver.finished), true);
    assert.equal(await store.bestGhost('lagon'), null);
    for (const saved of [account, second]) { const profile = store.getProfile(saved.profile.id)!; assert.equal(profile.xp, 0); assert.equal(profile.stats.races, 0); assert.equal(profile.mmr, saved.profile.mmr); assert.deepEqual(profile.stats.bestTimes, {}); }
    const reopened = await PlayerStore.open(join(directory, 'players')); assert.equal((await reopened.getReplay(replay.id))?.mode, 'crown'); assert.equal(await reopened.bestGhost('lagon'), null);
  });
  await t.test('workshop validates a solo module, places its approach, restarts and never rewards results', async () => {
    const draft = structuredClone(CUSTOM_TRACK_TEMPLATES[0]!.draft); draft.lapCount = 6; draft.elevations = [{ kind: 'bridge', start: .3, end: .4, height: 6, approach: 20 }];
    const source = await trackStore.save({ id: account.profile.id, name: 'Host' }, draft), id = customTrackRuntimeId(source);
    await assert.rejects(sdk.create('race', { trackId: id, workshop: { group: 'elevations', index: 0 } }));
    await assert.rejects(sdk.create('race', { practice: true, trackId: id, workshop: { group: 'elevations', index: 9 } }));
    const workshop = observe(await sdk.create('race', { practice: true, trackId: id, workshop: { group: 'elevations', index: 0 }, token: account.token })); peers.push(workshop);
    await until(() => !!workshop.world?.workshop, 'workshop source');
    workshop.room.send('ready', { ready: true }); await until(() => workshop.world!.players[0]!.ready, 'workshop ready'); workshop.room.send('start');
    await until(() => workshop.world?.phase === 'racing', 'workshop begins immediately');
    const selection = getTrackWorkshopStart(id, { group: 'elevations', index: 0 })!, point = trackPoint(selection.progress, id);
    assert.ok(Math.hypot(workshop.world!.players[0]!.x - point.x, workshop.world!.players[0]!.z - point.z) < .01);
    const round = workshop.world!.round; workshop.room.send('workshop-restart'); await until(() => workshop.world!.round > round, 'module restart');
    const scene = matchMaker.getLocalRoomById(workshop.room.roomId) as RaceRoom, before = store.listReplays(account.profile.id).length;
    scene.world.phase = 'finished'; await pause(160); await store.flush();
    assert.equal(store.listReplays(account.profile.id).length, before); assert.equal(store.getProfile(account.profile.id)!.xp, 0);
  });
  await t.test('two ordinary peers share immutable interaction source and a real trigger crossing', async () => {
    const draft = structuredClone(CUSTOM_TRACK_TEMPLATES[0]!.draft);
    draft.interactions = [{ kind: 'boost', trigger: .12, start: .14, end: .22, offset: 0, width: 8, duration: 7 }];
    const source = await trackStore.save({ id: account.profile.id, name: 'Host' }, draft), id = customTrackRuntimeId(source);
    const a = observe(await sdk.create('race', { name: 'Plaque A', trackId: id })); peers.push(a);
    const b = observe(await sdk.joinById(a.room.roomId, { name: 'Plaque B' })); peers.push(b);
    await until(() => !!a.tracks?.length && !!b.tracks?.length, 'interaction sources received');
    assert.deepEqual(a.tracks, [source]); assert.deepEqual(b.tracks, [source]);
    a.room.send('ready', { ready: true }); b.room.send('ready', { ready: true });
    await until(() => a.world?.players.every(player => player.ready) === true, 'interaction drivers ready'); a.room.send('start');
    await until(() => a.world?.phase === 'racing', 'normal multiplayer countdown');
    const scene = matchMaker.getLocalRoomById(a.room.roomId) as RaceRoom, kart = scene.world.players.find(player => player.id === a.room.sessionId)!;
    const module = getTrack(id).interactions![0]!, position = module.trigger - 1;
    // Private placement fixture shortens the approach only. A normal movement
    // step must cross the plate; no trigger/state message is injected.
    Object.assign(kart, trackPoint(position, id), { progress: position, speed: 15 });
    a.room.send('input', { ...neutralInput(0, kart.epoch), throttle: 1 });
    await until(() => a.world?.interactions?.length === 1 && b.world?.interactions?.length === 1, 'shared plate state');
    assert.deepEqual(a.world!.interactions, b.world!.interactions);
    assert.equal(a.world!.interactions![0]!.triggeredBy, a.room.sessionId);
    assert.equal(a.world!.interactions![0]!.activeAt - a.world!.interactions![0]!.triggeredAt, 1);
    assert.deepEqual(trackStore.get(id), source);
  });
});
