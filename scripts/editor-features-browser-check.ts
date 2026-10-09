import { homeControl } from './menu-navigation.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Page } from 'playwright';
import { createGameServer } from '../server/app.js';
import type { StoredCustomTrack } from '../shared/custom-tracks.js';
import type { World } from '../shared/game.js';

const destination = resolve(process.env.REPORT_DIR ?? 'docs/editor-features'); await mkdir(destination, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'lagon-editor-features-'));
process.env.PLAYER_DATA_DIR = join(directory, 'players'); process.env.CUSTOM_TRACK_DATA_DIR = join(directory, 'tracks');
const { gameServer, httpServer, ready } = createGameServer(resolve('dist/client')); await ready; await gameServer.listen(0, '127.0.0.1');
const address = httpServer.address(); assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const checks: string[] = [], errors: string[] = [], captures: string[] = [];
const evidence: Record<string, unknown> = { origin };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const record = (message: string) => { checks.push(message); console.log('✓ ' + message); };
async function until(predicate: () => Promise<boolean>, message: string, ms = 35000) {
  const end = Date.now() + ms; while (!await predicate()) { if (Date.now() > end) throw Error(message); await pause(100); }
}
type Debug = { world: World | null; sessionId: string | null; connected: boolean };
async function state(page: Page): Promise<Debug> {
  return page.evaluate(() => { const debug = (window as unknown as { __lagonDebug: Debug }).__lagonDebug; return { world: debug.world, sessionId: debug.sessionId, connected: debug.connected }; });
}
async function open(page: Page) {
  page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin, { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => !!(window as unknown as { __lagonDebug?: unknown }).__lagonDebug);
}
async function field(page: Page, selector: string, value: string) { await page.locator(selector).fill(value); await page.locator(selector).press('Tab'); }
async function section(page: Page, id: string) { if (!await page.locator(id).getAttribute('open').then(value => value !== null)) await page.locator(`${id} > summary`).click(); }
async function capture(page: Page, name: string) {
  // Capture the real viewport: the paused canvas beneath an opaque editor can
  // leave Playwright's compositor screenshot waiting under SwiftShader.
  const cdp = await page.context().newCDPSession(page); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: false }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Capture viewport : délai de 35 s dépassé')), 35000); })]);
    await writeFile(join(destination, name), Buffer.from(result.data, 'base64')); captures.push(name);
  } finally { clearTimeout(timer); await cdp.detach(); }
}
async function allTracks(): Promise<StoredCustomTrack[]> { return (await fetch(`${origin}/api/tracks`).then(response => response.json()) as { tracks: StoredCustomTrack[] }).tracks; }
async function save(page: Page) { await page.locator('#editor-save').click(); await until(async () => /Circuit publié/.test(await page.locator('#editor-status').innerText()), 'Confirmation de publication explicite'); }
const feature = (group: string, index: number, name: string) => `[data-group="${group}"][data-index="${index}"][data-feature-field="${name}"]`;
try {
  const html = await fetch(origin).then(response => response.text()); evidence.clientAssets = [...html.matchAll(/(?:src|href)="([^"]*assets[^"]+)"/g)].map(match => match[1]);
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const host = await desktop.newPage(); await open(host); await (await homeControl(host, '#name-input')).fill('Atelier reliefs'); await (await homeControl(host, '#track-editor-button')).click();
  await field(host, '#editor-name', 'Les six tours du relief'); await save(host);
  const original = (await allTracks()).find(track => track.draft.name === 'Les six tours du relief'); assert.ok(original);
  assert.equal(original.draft.lapCount, undefined); assert.equal(original.draft.events, undefined);
  record('Ancien format : ouvrir et sauvegarder ne rajoute aucune option facultative au circuit.');
  await field(host, '#editor-laps', '6');
  await section(host, '#editor-relief-options');
  await host.locator('#editor-add-bridge').click(); await host.locator('#editor-add-jump').click(); await host.locator('#editor-add-jump').click();
  await field(host, feature('elevations', 0, 'start'), '25');
  await field(host, feature('elevations', 2, 'start'), '3');
  assert.equal(await host.locator('[data-feature-marker="elevations-0"]').count(), 1);
  assert.equal(await host.locator('[data-feature-marker="elevations-2"]').count(), 1);
  await host.locator('[data-action="remove-feature"][data-group="elevations"][data-index="2"]').click();
  assert.equal(await host.locator('[data-feature-marker="elevations-2"]').count(), 0);
  await host.locator('#editor-undo').click(); assert.equal(await host.locator('[data-feature-marker="elevations-2"]').count(), 1);
  await host.locator('#editor-redo').click(); assert.equal(await host.locator('[data-feature-marker="elevations-2"]').count(), 0);
  await host.locator('#editor-undo').click();
  await section(host, '#editor-event-options');
  for (const [index, lap, kind] of [[0, 1, 'rain'], [1, 4, 'boost'], [2, 5, 'clear']] as const) {
    await host.locator('#editor-add-event').click(); await field(host, feature('events', index, 'lap'), String(lap));
    await host.locator(feature('events', index, 'kind')).selectOption(kind);
  }
  assert.equal(await host.locator('[data-feature-marker^="events-"]').count(), 3);
  await field(host, '#editor-laps', '3'); assert.equal(await host.locator('#editor-save').isDisabled(), true);
  assert.match(await host.locator('#editor-status').innerText(), /tour|événement/i);
  await field(host, '#editor-laps', '6'); assert.equal(await host.locator('#editor-save').isEnabled(), true);
  record('Six tours, pont, tremplin et événements aux tours1/4/5 ajoutés par UI ; suppression/annuler/rétablir et validation de tour hors course.');
  await host.locator('#editor-close').click(); await host.locator('#track-editor-dialog').waitFor({ state: 'hidden' });
  await host.reload({ waitUntil: 'domcontentloaded' }); await (await homeControl(host, '#track-editor-button')).click();
  assert.equal(await host.locator('#editor-laps').inputValue(), '6');
  await section(host, '#editor-relief-options'); await section(host, '#editor-event-options');
  assert.equal(await host.locator('[data-feature-card^="elevations-"]').count(), 2); assert.equal(await host.locator('[data-feature-card^="events-"]').count(), 3);
  await save(host);
  const saved = (await allTracks()).find(track => track.id === original.id)!;
  assert.equal(saved.revision, 2); assert.equal(saved.draft.lapCount, 6); assert.equal(saved.draft.elevations?.length, 2);
  assert.deepEqual(saved.draft.events?.map(event => [event.lap, event.kind]), [[1, 'rain'], [4, 'boost'], [5, 'clear']]);
  const disk = JSON.parse(await readFile(join(directory, 'tracks', `${saved.id}-v2.json`), 'utf8')) as StoredCustomTrack;
  assert.deepEqual(disk.draft, saved.draft); evidence.saved = { id: saved.id, revision: saved.revision, draft: saved.draft };
  record('Brouillon rechargé intact ; options relues dans l’API et dans le fichier de révision du répertoire data privé.');
  await host.locator('[data-feature-card="elevations-1"]').scrollIntoViewIfNeeded(); await capture(host, 'editor-features-desktop.png');
  await host.locator('#editor-event-options > summary').scrollIntoViewIfNeeded(); await capture(host, 'editor-events-desktop.png');
  const catalogueBeforeTrial = await allTracks();
  await host.locator('#editor-try').click(); await until(async () => (await state(host)).world?.phase === 'racing', 'Essai du circuit enrichi');
  const trial = await state(host); assert.match(trial.world?.trackId ?? '', /^custom-private-/);
  assert.equal(trial.world?.workshop?.selection.group, 'track'); assert.equal(await host.locator('#lap').innerText(), 'LIBRE');
  const initialKart = trial.world?.players.find(player => player.id === trial.sessionId); assert.ok(initialKart);
  await host.keyboard.down('ArrowUp');
  try {
    await until(async () => { const driven = await state(host), kart = driven.world?.players.find(player => player.id === driven.sessionId);
      return !!kart && kart.speed > 1 && Math.hypot(kart.x-initialKart.x, kart.z-initialKart.z) > 1; }, 'Déplacement normal du brouillon privé');
    const driven = await state(host), kart = driven.world!.players.find(player => player.id === driven.sessionId)!;
    evidence.trial = { trackId: driven.world?.trackId, speed: kart.speed, distance: Math.hypot(kart.x-initialKart.x, kart.z-initialKart.z), lapCounter: await host.locator('#lap').innerText() };
  } finally { await host.keyboard.up('ArrowUp'); }
  await capture(host, 'editor-features-trial.png');
  await host.locator('#leave-button').click(); await host.locator('#track-editor-dialog').waitFor({ state: 'visible' });
  assert.deepEqual(await allTracks(), catalogueBeforeTrial, 'the trial keeps the published catalogue unchanged');
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'tracks', `${saved.id}-v2.json`), 'utf8')), disk);
  record('Atelier privé : brouillon enrichi chargé, essai libre, accélération normale et retour à l’éditeur ; publication et fichier v2 inchangés.');

  const mobile = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const guest = await mobile.newPage(); await open(guest); await (await homeControl(guest, '#name-input')).fill('Copie mobile'); await (await homeControl(guest, '#track-editor-button')).click();
  await guest.locator(`[data-action="copy"][data-id="${saved.id}"]`).click();
  await section(guest, '#editor-relief-options'); await section(guest, '#editor-event-options');
  assert.equal(await guest.locator('#editor-laps').inputValue(), '6');
  assert.equal(await guest.locator('[data-feature-card^="events-"]').count(), 3);
  await field(guest, '#editor-name', 'Six tours sur mon mobile');
  await field(guest, feature('elevations', 0, 'height'), '6');
  await guest.locator('[data-feature-card="elevations-0"]').scrollIntoViewIfNeeded(); await capture(guest, 'editor-features-mobile-320.png');
  assert.equal(await guest.locator('#track-editor-dialog').evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
  for (const control of await guest.locator('#editor-relief-options button, #editor-relief-options input, #editor-event-options button, #editor-event-options input, #editor-event-options select').all()) {
    if (!await control.isVisible()) continue; const box = await control.boundingBox(); assert.ok(box && box.height >= 44, 'Contrôle mobile inférieur à44px');
  }
  // Use a real touch on a normal control as well as mobile form entry.
  await guest.locator('#editor-add-event').tap(); await guest.locator('[data-action="remove-feature"][data-group="events"][data-index="3"]').tap();
  await save(guest); const duplicate = (await allTracks()).find(track => track.draft.name === 'Six tours sur mon mobile'); assert.ok(duplicate);
  assert.notEqual(duplicate.id, saved.id); assert.equal(duplicate.draft.elevations?.[0]?.height, 6); assert.notEqual((await allTracks()).find(track => track.id === saved.id)?.draft.elevations?.[0]?.height, 6);
  evidence.duplicate = { id: duplicate.id, lapCount: duplicate.draft.lapCount };
  record('Mobile320 : duplication d’un autre joueur, tous les modules conservés, hauteur modifiée indépendamment et sauvegarde ; cibles≥44px sans débordement.');

  await host.locator('#editor-close').click(); await guest.locator('#editor-close').click();
  await (await homeControl(host, '#create-button')).click(); await until(async () => (await state(host)).world?.phase === 'lobby', 'Salon partagé créé');
  const roomCode = await host.locator('#room-code').innerText();
  await (await homeControl(guest, '#code-input')).fill(roomCode); await (await homeControl(guest, '#join-button')).click();
  await until(async () => !!(await state(guest)).world?.players.some(player => player.name === 'Atelier reliefs'), 'Second navigateur rejoint');
  const hostWorld = (await state(host)).world!, guestWorld = (await state(guest)).world!;
  assert.equal(hostWorld.trackId, `${saved.id}-v2`); assert.equal(guestWorld.trackId, hostWorld.trackId);
  evidence.shared = { hostTrackId: hostWorld.trackId, guestTrackId: guestWorld.trackId, playerCount: hostWorld.players.length };
  await host.locator('#ready-button').click(); await guest.locator('#ready-button').tap(); await host.locator('#start-button').click();
  await until(async () => (await state(host)).world?.phase === 'racing' && (await state(guest)).world?.phase === 'racing', 'Course partagée sur six tours');
  assert.match(await host.locator('#lap').innerText(), /\/\s*6/); assert.match(await guest.locator('#lap').innerText(), /\/\s*6/);
  evidence.shared = { ...(evidence.shared as object), hostLap: await host.locator('#lap').innerText(), guestLap: await guest.locator('#lap').innerText() };
  record('Deux profils dans la même course publiée v2 ; compteur /6 vérifié des deux côtés, distinct de l’essai privé libre.');
  await guest.locator('#leave-button').click(); await host.locator('#leave-button').click();
  await until(async () => (await fetch(`${origin}/healthz`).then(response => response.json()) as { rooms: number }).rooms === 0, 'Salons privés fermés');
  assert.deepEqual(errors, []);
  await writeFile(join(destination, 'browser-validation.json'), JSON.stringify({ passed: true, timestamp: new Date().toISOString(), checks, errors, captures, evidence,
    fixtures: ['Serveur et données privés éphémères ; aucune mutation directe de la simulation. Création, sauvegarde, duplication et conduite uniquement par interface.'],
    remaining: ['Téléphone physique et Safari iOS non testés.', 'Ce scénario ne termine pas les6tours ; la progression et les événements tardifs sont couverts par les tests de simulation séparés.'] }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, checks: checks.length, captures }));
} catch (error) {
  process.exitCode = 1; console.error(error);
  await writeFile(join(destination, 'browser-validation.json'), JSON.stringify({ passed: false, error: String(error), checks, errors, captures, evidence }, null, 2) + '\n');
} finally { await browser.close(); await gameServer.gracefullyShutdown(false); await rm(directory, { recursive: true, force: true }); }
