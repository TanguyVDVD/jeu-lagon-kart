import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { matchMaker } from '@colyseus/core';
import { createGameServer } from '../server/app.js';
import type { RaceRoom } from '../server/RaceRoom.js';
import type { World, Input } from '../shared/game.js';
import { getTrack, trackPoint } from '../shared/track.js';
import { getTrackEvent } from '../shared/track-events.js';
import { config } from '../server/config.js';

const baseline = process.argv.includes('--baseline');
const destination = resolve('docs/mobile-controls'); await mkdir(destination, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'lagon-touch-')); process.env.PLAYER_DATA_DIR = directory;
const { gameServer, httpServer } = createGameServer(resolve('dist/client'));
await gameServer.listen(0, '127.0.0.1');
const address = httpServer.address(); assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
const page = await context.newPage(); page.setDefaultTimeout(30000);
const errors: string[] = [], checks: string[] = [], captures: string[] = [];
const evidence: Record<string, unknown> = {};
page.on('pageerror', error => errors.push(error.message));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Debug = { world: World; sessionId: string; connected: boolean;
  view: { camera: { position: number[] }; tracked: { position: number[]; projected: number[] } | null } };
const debug = (): Promise<Debug> => page.evaluate(() => (window as unknown as { __lagonDebug: Debug }).__lagonDebug);
async function until(test: () => boolean | Promise<boolean>, label: string) { const end = Date.now() + 25000; while (!await test()) { if (Date.now() > end) throw Error(label); await wait(40); } }
const record = (label: string) => { checks.push(label); console.log('✓ ' + label); };
try {
  const html = await fetch(origin).then(response => response.text());
  evidence.clientAssets = [...html.matchAll(/(?:src|href)="([^"]*assets[^"]+)"/g)].map(match => match[1]);
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as unknown as { __lagonDebug: unknown }).__lagonDebug);
  await page.locator('#practice-button').click();
  await until(async () => (await debug()).world?.phase === 'racing', 'Départ entraînement');
  const roomId = new URL(await page.locator('#share-url').inputValue()).pathname.split('/').pop()!;
  const room = matchMaker.getLocalRoomById(roomId) as RaceRoom;
  const sessionId = (await debug()).sessionId;
  const input = () => (room as unknown as { inputs: Map<string, { input: Input }> }).inputs.get(sessionId)!.input;
  const cdp = await context.newCDPSession(page);
  type Touch = { id: number; x: number; y: number; radiusX: number; radiusY: number };
  let held: Touch[] = [];
  async function down(selector: string, id: number, fraction = .5) {
    const rect = await page.locator(selector).boundingBox(); assert.ok(rect);
    held.push({ id, x: rect.x + rect.width * fraction, y: rect.y + rect.height / 2, radiusX: 4, radiusY: 4 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: held });
  }
  async function up(id?: number) {
    const released = id === undefined ? [] : held.filter(p => p.id === id);
    held = id === undefined ? [] : held.filter(p => p.id !== id);
    // Chromium accepts the released point for a partial touchEnd. Sending the
    // remaining point ends that finger instead; touchMove cannot end a finger.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: released });
  }
  const dimensions = process.argv.includes('--inputs-only') ? [] : [[320,568], [360,640], [390,844], [568,320], [667,375]];
  for (const [width, height] of dimensions) {
    await page.setViewportSize({ width, height }); await wait(650);
    if (!baseline && await page.locator('#touch-resume').isVisible()) await page.locator('#touch-resume').tap();
    const filename = `${baseline ? 'before' : 'after'}-${width}x${height}.png`;
    await page.screenshot({ path: join(destination, filename) }); captures.push(filename);
    if (baseline) continue;
    const boxes = await page.locator('#touch-controls button:not(.hidden)').evaluateAll(nodes => nodes.filter(n => getComputedStyle(n).display !== 'none').map(node => {
      const r = node.getBoundingClientRect(); return { id: node.id || (node as HTMLElement).dataset.touch!, x: r.x, y: r.y, w: r.width, h: r.height };
    }));
    for (const box of boxes) { assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= width + 1 && box.y + box.h <= height + 1, `${width}×${height}: ${box.id} clipped`); assert.ok(box.w >= 44 && box.h >= 44, `${box.id} smaller than 44px`); }
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const p = boxes[a], q = boxes[b]; assert.ok(!(p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y), `Touch overlap: ${p.id}/${q.id}`);
    }
    assert.equal(await page.locator('#menu').isVisible(), false);
    record(`${width}×${height} : commandes ≥44px, dans l’écran, sans chevauchement ; menu masqué.`);
  }
  if (!baseline) {
    await page.setViewportSize({ width: 390, height: 844 }); await wait(300);
    if (await page.locator('#touch-resume').isVisible()) await page.locator('#touch-resume').tap();
    await until(() => input().throttle === 1, 'Accélération auto');
    await down('#touch-steer', 1, .25); await down('[data-touch="drift"]', 2);
    await until(() => input().steer > .4 && input().drift && input().throttle === 1, 'Direction + drift + accélération');
    evidence.steerDrift = { ...input() };
    await up(2);
    await until(() => input().steer > .4 && !input().drift, 'Relâcher drift sans perdre direction');
    record('CDP multitouch : direction analogique + drift + accélération, relâchement indépendant.');
    // The item is a declared fixture on this private room; consumption still
    // goes through the real browser, WebSocket and authoritative game logic.
    const kart = room.world.players.find(kart => kart.id === sessionId)!;
    kart.item = 'tripleTurbo'; kart.itemCharges = 3;
    await down('[data-touch="item"]', 9);
    await until(() => kart.itemCharges === 2, 'Utilisation objet multitouch');
    await wait(450); assert.equal(kart.itemCharges, 2); assert.ok(input().steer > .4);
    await up(9); record('Objet + direction simultanés : une seule charge consommée par pression, autorité serveur.');
    await down('[data-touch="brake"]', 3);
    await until(() => (input().brake || input().throttle === -1) && input().steer > .4 && input().throttle !== 1, 'Frein prioritaire');
    evidence.brake = { ...input() };
    record('Frein/recul prioritaire sur accélération auto, direction maintenue.');
    await up(); await page.locator('#touch-auto').tap();
    await until(() => input().throttle === 0, 'Mode manuel');
    assert.equal(await page.evaluate(() => localStorage.getItem('lagon-touch-auto')), 'false');
    await down('[data-touch="accelerate"]', 4); await until(() => input().throttle === 1, 'Pédale manuelle');
    await up(); await until(() => input().throttle === 0, 'Pédale relâchée');
    record('Mode manuel mémorisé : pédale tenue puis relâchée, aucun gaz coincé.');
    await down('#touch-steer', 5, .75); await down('[data-touch="accelerate"]', 6);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); held = [];
    await until(() => input().steer === 0 && input().throttle === 0 && !input().drift, 'Annulation tactile');
    evidence.cancel = { ...input() };
    assert.ok(await page.locator('#touch-resume').isVisible()); record('Annulation OS : commandes neutralisées, reprise volontaire visible.');
    await page.locator('#touch-resume').tap(); await page.locator('#touch-auto').tap();
    await down('#touch-steer', 7, .25); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await up();
    await until(() => input().throttle === 0 && input().steer === 0, 'Perte focus');
    record('Perte de focus simulée : gaz auto suspendu et direction neutre.');
    await page.locator('#touch-resume').tap();
    await down('#touch-steer', 8, .25); await page.setViewportSize({ width: 667, height: 375 }); await up();
    await until(() => input().steer === 0 && input().throttle === 0, 'Rotation écran');
    record('Portrait → paysage pendant un geste : aucun appui conservé.');
    await page.locator('#touch-resume').tap(); await page.locator('#touch-auto').tap();
    await page.keyboard.down('ArrowUp'); await until(() => input().throttle === 1, 'Clavier conservé');
    await page.keyboard.up('ArrowUp'); await until(() => input().throttle === 0, 'Clavier relâché'); record('Clavier conservé et indépendant des doigts.');

    // Deliberately reproduce the roadside billboard crossing the portrait
    // camera. This fixture is visual only; the control checks above stay real.
    const track = getTrack(kart.trackId);
    const branch = getTrackEvent(track.id, room.world.eventStage, room.world.eventLevel).branches.find(branch => branch.open && branch.kind !== 'shortcut')!;
    assert.ok(branch);
    const warning = trackPoint(branch.start - 42, track.id), offset = track.width / 2 + 1.5;
    const sign = { x: warning.x + Math.cos(warning.angle) * offset, y: 3.8, z: warning.z - Math.sin(warning.angle) * offset };
    const placed = { x: sign.x + Math.sin(warning.angle) * 16, z: sign.z + Math.cos(warning.angle) * 16 };
    const update = (room as unknown as { update(deltaMs: number): void }).update.bind(room);
    room.setSimulationInterval(() => {}, 1000 / config.simHz);
    Object.assign(kart, placed, { angle: warning.angle, speed: 0, turnVelocity: 0, lateralVelocity: 0,
      elevation: 0, verticalVelocity: 0, airborne: false, stun: 0, boost: 0 });
    await page.setViewportSize({ width: 390, height: 844 });
    await until(async () => { const view = (await debug()).view; return !!view.tracked && Math.hypot(view.tracked.position[0] - placed.x, view.tracked.position[2] - placed.z) < .2; }, 'Fixture pancarte reçue');
    await wait(1400);
    const nearby = (await debug()).view;
    const signCameraDistance = Math.hypot(sign.x - nearby.camera.position[0], sign.y - nearby.camera.position[1], sign.z - nearby.camera.position[2]);
    assert.ok(signCameraDistance < 18, 'La fixture doit placer la pancarte dans la zone de masquage proche de la caméra.');
    evidence.nearSign = { sign, kart: placed, camera: nearby.camera, signCameraDistance, tracked: nearby.tracked };
    await page.screenshot({ path: join(destination, 'after-near-sign-390x844.png') }); captures.push('after-near-sign-390x844.png');
    record('Fixture 390×844 : pancarte à moins de 18 m de la caméra, capture ciblée pour vérifier sa disparition et le kart visible.');

    await page.setViewportSize({ width: 320, height: 568 }); await wait(1200);
    const small = (await debug()).view.tracked!;
    const pixel = { x: (small.projected[0] + 1) * 160, y: (1 - small.projected[1]) * 284 };
    const speedBox = await page.locator('.speed-card').boundingBox(); assert.ok(speedBox);
    assert.ok(Math.abs(small.projected[0]) < .95 && Math.abs(small.projected[1]) < .95);
    assert.ok(!(pixel.x >= speedBox.x - 12 && pixel.x <= speedBox.x + speedBox.width + 12 && pixel.y >= speedBox.y - 12 && pixel.y <= speedBox.y + speedBox.height + 12), 'Le point visuel du kart doit être hors compteur, avec 12 px de marge.');
    evidence.smallHud = { kartPixel: pixel, speedBox, projected: small.projected };
    await page.screenshot({ path: join(destination, 'after-hud-clearance-320x568.png') }); captures.push('after-hud-clearance-320x568.png');
    record('Fixture 320×568 : projection du kart hors rectangle du compteur, avec 12 px de marge.');
    room.setSimulationInterval(deltaMs => update(deltaMs), 1000 / config.simHz);
  }
  assert.deepEqual(errors, []);
  await writeFile(join(destination, baseline ? 'before.json' : 'validation.json'), JSON.stringify({ passed: true, checks, errors, captures, evidence,
    fixtures: ['Serveur privé éphémère ; course entraînement démarrée par UI ; contrôles CDP multitouch réels ; perte de focus via événement synthétique.', 'Un triple turbo est attribué au kart privé pour mesurer sa consommation, puis utilisé par le geste CDP normal.', 'Deux images ciblées : simulation privée suspendue, kart placé au sol 16 m devant une pancarte de bifurcation, vitesse/boost/stun neutralisés. Les snapshots continuent. Aucune preuve de pilotage n’est tirée de ce placement ; il vérifie seulement visibilité et absence de chevauchement du compteur.'],
    limitations: ['Chromium/SwiftShader émulé, pas de téléphone physique ni Safari iOS.'] }, null, 2) + '\n');
} catch (error) {
  process.exitCode = 1;
  await writeFile(join(destination, baseline ? 'before.json' : 'validation.json'), JSON.stringify({ passed: false, error: String(error), checks, errors, captures, evidence }, null, 2) + '\n');
  console.error(error);
} finally { await browser.close(); await gameServer.gracefullyShutdown(false); await rm(directory, { recursive: true, force: true }); }
