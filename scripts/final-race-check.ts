import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import { Client, type Room } from 'colyseus.js';
import { autopilot } from '../shared/autopilot.js';
import { COLORS, getTrack, type World } from '../shared/game.js';
import { KART_MODELS } from '../shared/kart-catalog.js';
import { TRACK_LAYOUT_REVISION } from '../shared/track.js';
import type { PlayerProfile, ReplayData, ReplaySummary } from '../shared/progression.js';

// Public interfaces only: no server fixture, debug mutation or artificial finish.
const origin = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const trackId = process.env.TRACK_ID || 'sky';
assert.equal(getTrack(trackId).id, trackId, 'Unknown requested circuit');
const reportPath = process.env.REPORT_PATH || 'test-results/final-race.json';
const prefix = process.env.CAPTURE_PREFIX || 'test-results/final-race';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const checks: string[] = [], errors: string[] = [];
const requests = Array.from({ length: 2 }, () => ({ glb: [] as string[], mp3: [] as string[] }));
const eventStages = new Set<number>(), airborneDrivers = new Set<string>();
const invertedDrivers = new Set<string>();
const musicSelections = [new Set<string>(), new Set<string>()];
const itemKinds = new Set<string>();
const started = Date.now();
let maximumElevation = 0, snapshots = 0, success = false, failure = '';
const record = (message: string) => { checks.push(message); console.log(`✓ ${message}`); };
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error(`Délai dépassé : ${label}`); await sleep(80); }
}
async function api<T>(path: string, token?: string, body?: unknown): Promise<T> {
  const response = await fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`); return await response.json() as T;
}
type Assets = { status: string; loadCount: number; importedCount: number; fallbackCount: number;
  models: Record<string, { status: string; loadCount: number; importedCount: number; fallbackCount: number; characters: string[]; error: string | null }> };
type Debug = { world: World | null; sessionId: string; fps: number; quality: string; kartAssets: Assets;
  sceneryAssets: { state: string; requests: number; url: string };
  music: { running: boolean; selected: string; track: string; currentTime: number; activeElements: number;
    elementCount: number; loadCount: number; error: string | null } };
type Driver = { room: Room; token: string; profile: PlayerProfile; world?: World; sequence: number; epoch: number;
  timer?: ReturnType<typeof setInterval>; laps: Set<number> };
const drivers: Driver[] = [], pages: Page[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let results: unknown[] = [], savedProfiles: PlayerProfile[] = [], savedReplay: ReplayData | undefined;
let browserStates: Debug[] = [];
const debug = (page: Page): Promise<Debug> => page.evaluate(() => (window as unknown as { __lagonDebug: Debug }).__lagonDebug);
function attach(room: Room, account: { token: string; profile: PlayerProfile }) {
  const driver: Driver = { room, ...account, sequence: 0, epoch: -1, laps: new Set() };
  room.onMessage('notice', (notice: { message: string }) => { if (/sauvegarde.*échoué/i.test(notice.message)) errors.push(notice.message); });
  room.onMessage('snapshot', (snapshot: { world: World }) => {
    driver.world = snapshot.world; snapshots++;
    if (snapshot.world.phase !== 'racing') return;
    eventStages.add(snapshot.world.eventStage);
    for (const kart of snapshot.world.players.filter(kart => !kart.spectator)) {
      if (kart.airborne) airborneDrivers.add(kart.playerId);
      maximumElevation = Math.max(maximumElevation, kart.elevation);
      if (kart.item) itemKinds.add(kart.item);
      if (kart.id === room.sessionId && kart.lap < 3) driver.laps.add(kart.lap);
    }
    for (const object of snapshot.world.objects) itemKinds.add(object.kind);
  });
  drivers.push(driver); return driver;
}
try {
  await mkdir('test-results', { recursive: true });
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  const accounts = await Promise.all(Array.from({ length: 4 }, (_, index) =>
    api<{ token: string; profile: PlayerProfile }>('/api/profile', undefined, { name: `Démo ciel ${index + 1}` })));
  const models = ['zsky', 'sprint', 'retro', 'zsky'], characters = ['queen', 'obama', 'trump', 'kim'];
  for (let index = 0; index < 4; index++) {
    const account = accounts[index]!, sdk = new Client(origin.replace(/^http/, 'ws'));
    const options = { token: account.token, name: account.profile.name, color: COLORS[index], modelId: models[index], characterId: characters[index], trackId };
    attach(index === 0 ? await sdk.create('race', options) : await sdk.joinById(drivers[0]!.room.roomId, options), account);
  }
  const first = drivers[0]!;
  await until(() => drivers.every(driver => driver.world?.players.length === 4), 'quatre pilotes authentifiés');
  assert.equal(first.world!.trackId, trackId); assert.equal(first.world!.eventLevel, 3);
  assert.deepEqual(first.world!.players.map(kart => kart.modelId), models);
  assert.deepEqual(first.world!.players.map(kart => kart.characterId), characters);
  assert.deepEqual(first.world!.players.map(kart => kart.playerId), accounts.map(account => account.profile.id));
  record('Quatre profils créés par API : trois modèles GLB et quatre personnages distincts');
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] });
  for (let index = 0; index < 2; index++) {
    const context = await browser.newContext({ viewport: { width: index === 0 ? 1280 : 390, height: index === 0 ? 800 : 844 },
      isMobile: index === 1, hasTouch: index === 1, deviceScaleFactor: 1 });
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('.glb')) requests[index]!.glb.push(request.url());
      if (url.pathname.endsWith('.mp3')) requests[index]!.mp3.push(request.url());
    });
    page.on('response', response => {
      if (/\.(glb|mp3)(\?|$)/.test(response.url()) && ![200, 206, 304].includes(response.status())) errors.push(`Asset HTTP ${response.status()}: ${response.url()}`);
    });
    page.on('websocket', socket => {
      const url = new URL(socket.url());
      if (url.host !== new URL(origin).host || url.protocol !== (origin.startsWith('https:') ? 'wss:' : 'ws:')) errors.push('Origine WebSocket incorrecte');
    });
  }
  await Promise.all(pages.map(async page => {
    await page.goto(origin);
    await page.waitForFunction(() => (window as unknown as { __lagonDebug?: Debug }).__lagonDebug?.kartAssets.status === 'ready', undefined, { timeout: 45000 });
  }));
  for (const driver of drivers) driver.room.send('ready', { ready: true });
  await until(() => first.world!.players.every(kart => kart.ready), 'tous prêts');
  first.room.send('start');
  await until(() => drivers.every(driver => driver.world?.phase === 'racing'), 'course démarrée');
  for (const driver of drivers) driver.timer = setInterval(() => {
    const kart = driver.world?.players.find(player => player.id === driver.room.sessionId);
    if (!kart || !driver.room.connection.isOpen || kart.finished) return;
    if (kart.epoch !== driver.epoch) { driver.epoch = kart.epoch; driver.sequence = Math.max(0, kart.lastSeq + 1); }
    driver.room.send('input', autopilot(kart, driver.sequence++, true));
  }, 1000 / 30);
  await Promise.all(pages.map(async (page, index) => {
    await page.locator('#name-input').fill(`Observateur ciel ${index + 1}`);
    await page.locator('#code-input').fill(first.room.roomId);
    await page.locator('#join-button').click();
    await page.waitForFunction(() => {
      const state = (window as unknown as { __lagonDebug: Debug }).__lagonDebug;
      return state.world?.phase === 'racing' && state.kartAssets.status === 'ready' && state.kartAssets.loadCount === 3;
    }, undefined, { timeout: 45000 });
  }));
  record('Deux sessions Chromium indépendantes observent les pilotes qui envoient uniquement les commandes ordinaires');
  await Promise.all(pages.map(page => page.waitForFunction(() => {
    const music = (window as unknown as { __lagonDebug: Debug }).__lagonDebug.music;
    return music.running && music.selected === 'lap1' && music.currentTime > .2;
  }, undefined, { timeout: 20000 })));
  for (const selection of musicSelections) selection.add('lap1');
  await pages[0]!.screenshot({ path: `${prefix}-tour-1.png` });
  let nextLog = 0, capturedThird = false;
  await until(async () => {
    const states = await Promise.all(pages.map(debug));
    states.forEach((state, index) => { if (state.music.running && state.music.currentTime > .2) musicSelections[index]!.add(state.music.selected); });
    if (!capturedThird && first.world!.eventStage === 2) { capturedThird = true; await pages[0]!.screenshot({ path: `${prefix}-tour-3.png` }); }
    if (Date.now() > nextLog) {
      nextLog = Date.now() + 15000;
      console.log(first.world!.players.filter(kart => !kart.spectator).map(kart => `${kart.name}: ${kart.lap}/3, porte ${kart.nextCheckpoint}`).join(' · '));
    }
    await sleep(500);
    return drivers.every(driver => driver.world?.phase === 'finished');
  }, 'trois tours complets sans fixture', 280000);
  for (const driver of drivers) clearInterval(driver.timer);
  const racers = first.world!.players.filter(kart => !kart.spectator);
  assert.ok(racers.every(kart => kart.finished && kart.lap === 3));
  assert.deepEqual([...eventStages].sort(), [0, 1, 2]);
  for (const driver of drivers) assert.deepEqual([...driver.laps].sort(), [0, 1, 2]);
  assert.ok(airborneDrivers.size > 0, 'Au moins un décollage observé dans les snapshots réels');
  assert.ok(maximumElevation > 1);
  results = racers.map(kart => [kart.id, kart.rank, kart.lap, kart.finished, kart.finishTime]);
  for (const driver of drivers) assert.deepEqual(driver.world!.players.filter(kart => !kart.spectator)
    .map(kart => [kart.id, kart.rank, kart.lap, kart.finished, kart.finishTime]), results);
  await Promise.all(pages.map(page => page.waitForFunction(() => {
    const state = (window as unknown as { __lagonDebug: Debug }).__lagonDebug;
    return state.world?.phase === 'finished' && !state.music.running && state.music.activeElements === 0;
  })));
  browserStates = await Promise.all(pages.map(debug));
  for (const [index, state] of browserStates.entries()) {
    assert.deepEqual(state.world!.players.filter(kart => !kart.spectator).map(kart => [kart.id, kart.rank, kart.lap, kart.finished, kart.finishTime]), results);
    assert.equal(state.world!.players.filter(kart => kart.spectator).length, 2);
    assert.equal(state.kartAssets.loadCount, 3); assert.equal(state.kartAssets.fallbackCount, 0);
    assert.ok(state.kartAssets.importedCount >= 4);
    for (const model of KART_MODELS) { const info = state.kartAssets.models[model.id]!; assert.equal(info.status, 'ready'); assert.equal(info.loadCount, 1); assert.equal(info.error, null); }
    const renderedCharacters = new Set(Object.values(state.kartAssets.models).flatMap(model => model.characters));
    for (const character of characters) assert.ok(renderedCharacters.has(character));
    assert.equal(state.music.track, trackId); assert.equal(state.music.elementCount, 2); assert.equal(state.music.loadCount, 2); assert.equal(state.music.error, null);
    assert.deepEqual([...musicSelections[index]!].sort(), ['lap1', 'lap2']);
    assert.equal(state.sceneryAssets.state, 'ready'); assert.equal(state.sceneryAssets.requests, 1);
    assert.deepEqual(requests[index]!.glb.map(url => new URL(url).pathname).sort(), [...KART_MODELS.map(model => model.url), state.sceneryAssets.url].sort());
    assert.deepEqual([...new Set(requests[index]!.mp3.map(url => new URL(url).pathname))].sort(), ['/audio/lap-1-v1.mp3', '/audio/lap-2-v1.mp3']);
    assert.ok([...requests[index]!.glb, ...requests[index]!.mp3].every(url => new URL(url).origin === origin));
  }
  record('Trois tours et trois phases observés ; sauts réels ; résultats identiques sur les six connexions');
  record('Un chargement par modèle et par page, quatre personnages, MP3 lus puis arrêtés, même origine HTTP/WebSocket');
  await until(async () => {
    savedProfiles = await Promise.all(drivers.map(driver => api<{ profile: PlayerProfile }>('/api/me', driver.token).then(result => result.profile)));
    return savedProfiles.every(profile => profile.stats.races === 1 && profile.stats.finishes === 1);
  }, 'statistiques persistées');
  let replayLists: { replays: ReplaySummary[] }[] = [];
  await until(async () => {
    replayLists = await Promise.all(drivers.map(driver => api<{ replays: ReplaySummary[] }>('/api/replays', driver.token)));
    return replayLists.every(list => list.replays.some(replay => replay.trackId === trackId));
  }, 'replay sauvegardé');
  const replayId = replayLists[0]!.replays.find(replay => replay.trackId === trackId)?.id;
  assert.ok(replayId); assert.ok(replayLists.every(list => list.replays.some(replay => replay.id === replayId)));
  savedReplay = (await api<{ replay: ReplayData }>(`/api/replays/${replayId}`)).replay;
  assert.equal(savedReplay.trackId, trackId); assert.equal(savedReplay.eventLevel, 3); assert.equal(savedReplay.drivers.length, 4);
  assert.equal(savedReplay.trackRevision, TRACK_LAYOUT_REVISION);
  for (const driver of savedReplay.drivers) { assert.ok(driver.finished); assert.equal(driver.frames.at(-1)![5], 3); assert.ok(driver.frames.length > 100); }
  const publicEvidence = JSON.stringify({ savedProfiles, savedReplay, worlds: browserStates.map(state => state.world) });
  for (const account of accounts) assert.ok(!publicEvidence.includes(account.token), 'Aucun jeton dans les projections publiques');
  record('Statistiques des quatre profils et replay commun disponibles par API, aucun secret dans snapshots ou replay');
  await pages[0]!.screenshot({ path: `${prefix}-resultats.png` });
  assert.deepEqual(errors, []); success = true; record('Aucune erreur JavaScript ni erreur de chargement détectée');
} catch (error) { failure = error instanceof Error ? error.message : String(error); throw error;
} finally {
  await writeFile(reportPath, JSON.stringify({ origin, trackId, success, failure, checks, errors, durationSeconds: (Date.now() - started) / 1000,
    drivers: 4, browserObservers: 2, inputMethod: 'Four authenticated SDK drivers send ordinary controls; two Chromium contexts observe. No fixture or forced finish.',
    renderer: 'Chromium headless / SwiftShader, desktop and 390x844 touch mobile emulation', snapshots, eventStages: [...eventStages], airborneDrivers: [...airborneDrivers], invertedDrivers: [...invertedDrivers], maximumElevation,
    requests, musicSelections: musicSelections.map(selections => [...selections]), itemKinds: [...itemKinds], results,
    profiles: savedProfiles.map(profile => ({ id: profile.id, stats: profile.stats, xp: profile.xp })),
    replay: savedReplay ? { id: savedReplay.id, trackId: savedReplay.trackId, trackRevision: savedReplay.trackRevision, eventLevel: savedReplay.eventLevel, frames: savedReplay.drivers.map(driver => driver.frames.length) } : null,
    browserDiagnostics: browserStates.map(state => ({ kartAssets: state.kartAssets, sceneryAssets: state.sceneryAssets, music: state.music, fps: state.fps, quality: state.quality })) }, null, 2));
  for (const driver of drivers) { clearInterval(driver.timer); if (driver.room.connection.isOpen) await driver.room.leave().catch(() => {}); }
  await browser?.close();
}
