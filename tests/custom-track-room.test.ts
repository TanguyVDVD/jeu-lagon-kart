import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Client, type Room } from 'colyseus.js';
import { matchMaker } from '@colyseus/core';
import type { RaceRoom } from '../server/RaceRoom.js';
import { CUSTOM_TRACK_TEMPLATES, compileCustomTrack, customTrackRuntimeId, registerCustomTrack, type StoredCustomTrack } from '../shared/custom-tracks.js';
import { getTrack, getTrackLapCount, TRACK_LAYOUT_REVISION } from '../shared/track.js';
import { neutralInput, type World } from '../shared/game.js';
import { getTrackEvent } from '../shared/track-events.js';
import { seasonId, type PlayerProfile, type ReplayData } from '../shared/progression.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => unknown, label: string, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timeout: ${label}`);
    await pause(20);
  }
}
type Snapshot = { world: World; tracks?: StoredCustomTrack[]; tick: number };
type Peer = { room: Room; latest?: Snapshot; snapshots: Snapshot[]; notices: string[] };
function observe(room: Room): Peer {
  const peer: Peer = { room, snapshots: [], notices: [] };
  room.onMessage('snapshot', (message: Snapshot) => {
    peer.latest = message; peer.snapshots.push(message);
    if (peer.snapshots.length > 200) peer.snapshots.shift();
  });
  room.onMessage('notice', (message: { message: string }) => peer.notices.push(message.message));
  room.onError(() => {});
  return peer;
}

test('custom track versions travel through live rooms and remain usable by saved profiles', { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lagon-custom-room-'));
  const oldPlayers = process.env.PLAYER_DATA_DIR, oldTracks = process.env.CUSTOM_TRACK_DATA_DIR;
  process.env.PLAYER_DATA_DIR = join(directory, 'players'); delete process.env.CUSTOM_TRACK_DATA_DIR;
  process.env.SIMULATED_LATENCY_MS = '0'; process.env.RECONNECT_SECONDS = '1';
  const { createGameServer } = await import('../server/app.js');
  const { playerStore } = await import('../server/career.js');
  const { PlayerStore } = await import('../server/player-store.js');
  const { gameServer, httpServer, ready } = createGameServer(directory);
  const peers: Peer[] = [];
  t.after(async () => {
    await Promise.allSettled(peers.filter(peer => peer.room.connection.isOpen).map(peer => peer.room.leave()));
    await gameServer.gracefullyShutdown(false);
    await (await playerStore()).flush();
    if (oldPlayers === undefined) delete process.env.PLAYER_DATA_DIR; else process.env.PLAYER_DATA_DIR = oldPlayers;
    if (oldTracks === undefined) delete process.env.CUSTOM_TRACK_DATA_DIR; else process.env.CUSTOM_TRACK_DATA_DIR = oldTracks;
    await rm(directory, { recursive: true, force: true });
  });
  await ready; await gameServer.listen(0, '127.0.0.1');
  const address = httpServer.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const sdk = new Client(origin.replace('http:', 'ws:'));
  const browserWithoutCatalogue = new Client(origin.replace('http:', 'ws:'));
  const trackDraft = structuredClone(CUSTOM_TRACK_TEMPLATES[0]!.draft);
  async function request(path: string, method = 'GET', body?: unknown, token?: string) {
    const response = await fetch(origin + path, { method, headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any };
  }
  const author = (await request('/api/profile', 'POST', { name: 'Créateur circuit' })).data as { token: string; profile: PlayerProfile };
  const published = await request('/api/tracks', 'POST', { draft: trackDraft }, author.token);
  assert.equal(published.status, 201);
  const first = published.data.track as StoredCustomTrack, firstId = customTrackRuntimeId(first);
  const originalGeometry = JSON.stringify(getTrack(firstId));
  let host: Peer, guest: Peer, second: StoredCustomTrack, secondId: string;

  await t.test('a host and direct-link guest receive their exact circuit without first fetching the catalogue', async () => {
    host = observe(await sdk.create('race', { name: 'Hôte', trackId: firstId })); peers.push(host);
    guest = observe(await browserWithoutCatalogue.joinById(host.room.roomId, { name: 'Invité lien direct' })); peers.push(guest);
    await until(() => host.latest?.tracks?.length && guest.latest?.tracks?.length, 'custom definitions on both peers');
    assert.deepEqual(host.latest!.tracks, [first]); assert.deepEqual(guest.latest!.tracks, [first]);
    assert.equal(host.latest!.world.trackId, firstId); assert.equal(guest.latest!.world.trackId, firstId);
    assert.equal(guest.latest!.world.players.length, 2);
    const publicPayload = JSON.stringify(guest.latest);
    assert.ok(!publicPayload.includes(author.token)); assert.ok(!publicPayload.includes('tokenHash'));
  });

  await t.test('definitions repeat until acknowledged and then stay out of periodic snapshots', async () => {
    host.room.send('tracksReady', { ids: [firstId] });
    await until(() => host.latest?.tracks === undefined, 'host acknowledgement consumed');
    const marker = host.latest!.tick;
    await pause(220);
    assert.ok(host.snapshots.filter(snapshot => snapshot.tick > marker).length >= 2);
    assert.ok(host.snapshots.filter(snapshot => snapshot.tick > marker).every(snapshot => snapshot.tracks === undefined));
    assert.deepEqual(guest.latest!.tracks, [first], 'unacknowledged guest still receives the geometry');
    guest.room.send('tracksReady', { ids: [firstId] });
    await until(() => guest.latest?.tracks === undefined, 'guest acknowledgement consumed');
  });

  await t.test('publishing a new revision during a real countdown/race leaves the original room untouched', async () => {
    host.room.send('ready', { ready: true }); guest.room.send('ready', { ready: true });
    await until(() => host.latest?.world.players.every(player => player.ready), 'both ready');
    host.room.send('start');
    await until(() => host.latest?.world.phase === 'racing', 'natural countdown completed');
    const changed = structuredClone(trackDraft); changed.name = 'Nouvelle version portuaire'; changed.theme = 'harbor';
    changed.anchors = changed.anchors.map(point => ({ x: point.x * 1.08, z: point.z * 1.05 }));
    const updated = await request('/api/tracks/' + first.id, 'PUT', { draft: changed, revision: 1 }, author.token);
    assert.equal(updated.status, 200); second = updated.data.track; secondId = customTrackRuntimeId(second);
    await pause(140);
    assert.equal(host.latest!.world.trackId, firstId); assert.equal(guest.latest!.world.trackId, firstId);
    assert.equal(JSON.stringify(getTrack(firstId)), originalGeometry);
    assert.notEqual(JSON.stringify(getTrack(secondId)), originalGeometry);
    assert.deepEqual((await request('/api/tracks/' + firstId)).data.track, first);
    assert.deepEqual((await request('/api/tracks')).data.tracks, [second]);
    const kart = host.latest!.world.players.find(player => player.id === host.room.sessionId)!;
    const position = { x: kart.x, z: kart.z };
    for (let seq = 0; seq < 5; seq++) {
      host.room.send('input', { ...neutralInput(seq, kart.epoch), throttle: 1 }); await pause(70);
    }
    const moved = host.latest!.world.players.find(player => player.id === host.room.sessionId)!;
    assert.ok(Math.hypot(moved.x - position.x, moved.z - position.z) > .2, 'real controls drive the original revision');
    assert.equal(moved.trackId, firstId);
  });

  await t.test('late joiners receive the historical version while new rooms and mixed tournaments use the new revision', async () => {
    const late = observe(await browserWithoutCatalogue.joinById(host.room.roomId, { name: 'Spectateur nouveau' })); peers.push(late);
    await until(() => late.latest?.tracks?.length, 'late peer receives old geometry');
    assert.deepEqual(late.latest!.tracks, [first]); assert.equal(late.latest!.world.trackId, firstId);
    assert.equal(late.latest!.world.players.find(player => player.id === late.room.sessionId)!.spectator, true);
    const fresh = observe(await sdk.create('race', { name: 'Autre hôte', trackId: secondId })); peers.push(fresh);
    await until(() => fresh.latest?.tracks?.length, 'new room geometry');
    assert.deepEqual(fresh.latest!.tracks, [second]);
    fresh.room.send('configure', { mode: 'tournament', selection: 'manual', raceCount: 3,
      schedule: [secondId, 'lagon', firstId] });
    await until(() => fresh.latest?.world.tournament.mode === 'tournament', 'mixed tournament configured');
    assert.deepEqual(fresh.latest!.world.tournament.schedule, [secondId, 'lagon', firstId]);
    assert.deepEqual(fresh.latest!.tracks, [second, first]);
    fresh.room.send('tracksReady', { ids: [secondId, firstId] });
    await until(() => fresh.latest?.tracks === undefined, 'whole tournament geometry acknowledged');
    assert.equal(host.latest!.world.trackId, firstId);
  });

  await t.test('registered fixtures outside this server data folder cannot be selected by rooms or tournaments', async () => {
    const orphan: StoredCustomTrack = { ...first, id: `custom-${randomUUID()}` };
    delete orphan.runtimeId;
    registerCustomTrack(orphan);
    const orphanId = customTrackRuntimeId(orphan);
    await assert.rejects(sdk.create('race', { trackId: orphanId }), /circuit.*inconnu/i);
    const lobby = peers.at(-1)!;
    const before = JSON.stringify(lobby.latest!.world.tournament);
    lobby.room.send('configure', { mode: 'tournament', selection: 'manual', raceCount: 2, schedule: ['lagon', orphanId] });
    await until(() => lobby.notices.some(message => message.includes('indisponible')), 'orphan tournament refusal');
    assert.equal(JSON.stringify(lobby.latest!.world.tournament), before);
  });

  await t.test('a declared synthetic result/replay can be saved and reopened against the exact custom version', async () => {
    // Storage fixture only: no full race completion is claimed by this test.
    const store = await playerStore(), now = Date.now();
    const result = await store.recordRace({ id: 'custom-result-fixture', trackId: firstId, ranked: false, finishedAt: now,
      entries: [{ playerId: author.profile.id, rank: 1, finished: true, finishTime: 60 }] });
    assert.equal(result.recorded, true);
    const replay: ReplayData = { version: 1, id: 'custom-replay-fixture', trackId: firstId, trackRevision: TRACK_LAYOUT_REVISION,
      createdAt: now, season: seasonId(new Date(now)), durationMs: 60_000, ranked: false, eventLevel: 0,
      drivers: [{ playerId: author.profile.id, name: author.profile.name, color: '#fc735d', rank: 1, finished: true,
        finishTime: 60, frames: [[0, 0, 0, 0, 0, 0, 0], [60_000, 0, 0, 0, 0, 3, 0]] }] };
    await store.saveReplay(replay); await store.flush();
    const reopened = await PlayerStore.open(join(directory, 'players'));
    assert.equal(reopened.getProfile(author.profile.id)!.xp, 45);
    assert.equal(reopened.getProfile(author.profile.id)!.stats.bestTimes[firstId], 60);
    assert.deepEqual(await reopened.getReplay(replay.id), replay);
    assert.equal((await reopened.bestGhost(firstId))!.trackId, firstId);
  });

  await t.test('deletion blocks cached room selections while active races, pre-started tournaments and their late joiners keep history', async () => {
    const waiting = observe(await sdk.create('race', { name: 'Salon avant suppression', practice: true, trackId: firstId })); peers.push(waiting);
    const tournament = observe(await sdk.create('race', { name: 'Tournoi avant suppression', practice: true, trackId: 'lagon' })); peers.push(tournament);
    await until(() => waiting.latest && tournament.latest, 'deletion fixtures connected');
    tournament.room.send('configure', { mode: 'tournament', selection: 'manual', raceCount: 2, schedule: ['lagon', firstId] });
    await until(() => tournament.latest?.world.tournament.mode === 'tournament', 'future custom round scheduled');
    tournament.room.send('ready', { ready: true });
    await until(() => tournament.latest?.world.players.every(player => player.ready), 'tournament pilot ready');
    tournament.room.send('start');
    await until(() => tournament.latest?.world.phase === 'racing', 'tournament actually started before deletion');
    const deletion = await request('/api/tracks/' + first.id, 'DELETE', { revision: 2 }, author.token);
    assert.equal(deletion.status, 200);
    assert.equal(host.latest!.world.phase, 'racing'); assert.equal(host.latest!.world.trackId, firstId);
    assert.deepEqual((await request('/api/tracks/' + firstId)).data.track, first);
    assert.equal(JSON.stringify(getTrack(firstId)), originalGeometry);
    await assert.rejects(sdk.create('race', { trackId: firstId }), /supprimé|inconnu/i);
    await assert.rejects(sdk.create('race', { trackId: secondId }), /supprimé|inconnu/i);
    waiting.room.send('ready', { ready: true });
    await until(() => waiting.latest?.world.players.every(player => player.ready), 'deleted-track lobby ready');
    waiting.room.send('start');
    await until(() => waiting.notices.some(message => message.includes('supprimé')), 'deleted track cannot start a new race');
    assert.equal(waiting.latest!.world.phase, 'lobby');
    waiting.room.send('configure', { mode: 'single', selection: 'manual', trackId: firstId });
    await until(() => waiting.notices.some(message => message.includes('indisponible')), 'cached selection rejected');
    waiting.room.send('configure', { mode: 'single', selection: 'manual', trackId: 'neon' });
    await until(() => waiting.latest?.world.trackId === 'neon', 'lobby can select an available circuit');

    const late = observe(await browserWithoutCatalogue.joinById(host.room.roomId, { name: 'Spectateur après suppression' })); peers.push(late);
    await until(() => late.latest?.tracks?.length, 'late spectator receives retired geometry');
    assert.deepEqual(late.latest!.tracks, [first]);
    const kart = host.latest!.world.players.find(player => player.id === host.room.sessionId)!;
    const position = { x: kart.x, z: kart.z };
    for (let seq = 10; seq < 15; seq++) {
      host.room.send('input', { ...neutralInput(seq, kart.epoch), throttle: 1 }); await pause(70);
    }
    const moved = host.latest!.world.players.find(player => player.id === host.room.sessionId)!;
    assert.ok(Math.hypot(moved.x - position.x, moved.z - position.z) > .2, 'active race keeps accepting real inputs after deletion');

    // Declared end-of-round fixture: this tests lifecycle/persistence, not a driven lap.
    const live = matchMaker.getLocalRoomById(tournament.room.roomId) as RaceRoom;
    live.world.phase = 'finished'; live.world.raceTime = 30;
    for (const player of live.world.players) { player.finished = true; player.finishTime = 30; player.lap = getTrackLapCount(live.world.trackId); }
    await until(() => tournament.latest?.world.phase === 'finished', 'first tournament result published');
    tournament.room.send('nextRace');
    await until(() => tournament.latest?.world.phase === 'lobby' && tournament.latest.world.trackId === firstId, 'retired circuit remains in already-started tournament');
    tournament.room.send('ready', { ready: true });
    await until(() => tournament.latest?.world.players.every(player => player.ready), 'historical second round ready');
    tournament.room.send('start');
    await until(() => tournament.latest?.world.phase === 'racing', 'historical scheduled round starts');
    live.world.phase = 'finished'; live.world.raceTime = 31;
    for (const player of live.world.players) { player.finished = true; player.finishTime = 31; player.lap = getTrackLapCount(live.world.trackId); }
    await until(() => tournament.latest?.world.phase === 'finished' && tournament.latest.world.tournament.completed, 'historical tournament completes');
    tournament.room.send('rematch');
    await until(() => tournament.notices.some(message => message.includes('revanche a été supprimé')), 'new tournament cannot reuse deleted schedule');
    assert.equal(tournament.latest!.world.phase, 'finished');
    const reopened = await PlayerStore.open(join(directory, 'players'));
    assert.equal((await reopened.getReplay('custom-replay-fixture'))!.trackId, firstId);
    assert.equal(reopened.getProfile(author.profile.id)!.stats.bestTimes[firstId], 60);
  });

  await t.test('a missing historical circuit after a fresh process start never makes saved profiles unreadable', async () => {
    await rm(join(directory, 'tracks', firstId + '.json'));
    // A separate process proves the fallback without the parent's in-memory custom registry.
    const careerUrl = pathToFileURL(resolve('server/career.ts')).href;
    const tracksUrl = pathToFileURL(resolve('shared/track.ts')).href;
    const script = `
      import assert from 'node:assert/strict';
      const { isTrackId } = await import(${JSON.stringify(tracksUrl)});
      assert.equal(isTrackId(process.env.TEST_CUSTOM_VERSION), false);
      const { playerStore } = await import(${JSON.stringify(careerUrl)});
      const store = await playerStore();
      assert.equal(isTrackId(process.env.TEST_CUSTOM_VERSION), false);
      const profile = store.getProfile(process.env.TEST_CUSTOM_AUTHOR);
      assert.equal(profile.xp, 45);
      assert.equal(profile.stats.bestTimes[process.env.TEST_CUSTOM_VERSION], 60);
      assert.equal(store.listReplays(profile.id).length, 1);
      process.stdout.write(JSON.stringify({ profileLoaded: true, bestTimeRetained: true, replayIndexRetained: true }));
      process.exit(0);
    `;
    const child = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: resolve('.'), env: { ...process.env, TEST_CUSTOM_VERSION: firstId, TEST_CUSTOM_AUTHOR: author.profile.id }, timeout: 15_000,
    });
    assert.deepEqual(JSON.parse(child.stdout), { profileLoaded: true, bestTimeRetained: true, replayIndexRetained: true });
  });
  await t.test('advanced modules, six-lap rules and scheduled weather hydrate identically over Colyseus', async () => {
    const advanced=structuredClone(trackDraft);advanced.name='Six tours et reliefs';advanced.lapCount=6;
    advanced.elevations=[{kind:'bridge',start:.1,end:.24,height:5,approach:25},{kind:'jump',start:.4,end:.42,height:2,approach:0,launchSpeed:7}];
    advanced.events=[{lap:1,kind:'rain',start:.3,end:.4},{lap:5,kind:'boost',start:.7,end:.75}];
    const publication=await request('/api/tracks','POST',{draft:advanced},author.token);assert.equal(publication.status,201);
    const definition=publication.data.track as StoredCustomTrack,id=customTrackRuntimeId(definition);
    const a=observe(await sdk.create('race',{name:'Architecte relief',trackId:id}));peers.push(a);
    const b=observe(await browserWithoutCatalogue.joinById(a.room.roomId,{name:'Invité relief'}));peers.push(b);
    await until(()=>a.latest?.tracks?.length && b.latest?.tracks?.length,'advanced source hydration');
    for(const peer of [a,b]){
      assert.deepEqual(peer.latest!.tracks,[definition]);
      const compiled=compileCustomTrack(peer.latest!.tracks![0]!);
      assert.deepEqual(compiled,getTrack(id));assert.equal(compiled.lapCount,6);
      assert.equal(compiled.elevations.length,2);assert.equal(compiled.lapEvents?.length,2);
      peer.room.send('tracksReady',{ids:[id]});peer.room.send('ready',{ready:true});
    }
    await until(()=>a.latest?.world.players.every(player=>player.ready),'advanced peers ready');a.room.send('start');
    await until(()=>a.latest?.world.phase==='racing' && b.latest?.world.phase==='racing','advanced real countdown');
    assert.equal(getTrackLapCount(a.latest!.world.trackId),6);
    for(const peer of [a,b])assert.equal(getTrackEvent(peer.latest!.world.trackId,peer.latest!.world.eventStage,peer.latest!.world.eventLevel).weather,'rain');
  });

});
