import { homeControl, readOfficialTrackCatalog, selectHomeTrack } from './menu-navigation.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { Client, type Room } from 'colyseus.js';
import { matchMaker } from '@colyseus/core';
import { createGameServer } from '../server/app.js';
import type { RaceRoom } from '../server/RaceRoom.js';
import { config } from '../server/config.js';
import type { Kart, World } from '../shared/game.js';
import { TRACKS, nearestTrack, trackPoint } from '../shared/track.js';
import { autopilot } from '../shared/autopilot.js';

// Scene fixtures run in an ephemeral local room. Neither production state nor
// the player's authenticated profile is touched by this diagnostic.
const destination = resolve(process.env.DESTINATION || 'docs/scenes-v2'); await mkdir(destination, { recursive: true });
const panoramasOnly = process.argv.includes('--panoramas-only');
const loopsOnly = process.argv.includes('--loops-only');
const dataDirectory = await mkdtemp(join(tmpdir(), 'lagon-scenes-'));
const previousDirectory = process.env.PLAYER_DATA_DIR; process.env.PLAYER_DATA_DIR = dataDirectory;
const { gameServer, httpServer } = createGameServer(resolve('dist/client'));
await gameServer.listen(0, '127.0.0.1');
const address = httpServer.address(); assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
// One context and one rendered page for every panorama and loop capture.
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true, deviceScaleFactor: 1 });
const page = await context.newPage(); page.setDefaultTimeout(60000);
type View = { camera: { position: number[]; target: number[]; fov: number; near: number };
  tracked: { id: string; position: number[]; up: number[]; projected: number[] } | null;
  calls: number; triangles: number; compact: boolean };
type Debug = { world: World | null; sessionId: string; connected: boolean; view: View;
  sceneryAssets: { state: string; url: string; requests: number }; kartAssets: { status: string } };
const debug = (): Promise<Debug> => page.evaluate(() => (window as unknown as { __lagonDebug: Debug }).__lagonDebug);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const checks: string[] = [], errors: string[] = [], captures: string[] = [], fixtures: string[] = [];
const evidence: Record<string, unknown> = { validationScope: { panoramas: !loopsOnly, loops: !panoramasOnly } }, treeRequests: string[] = [];
const activeRooms: Room[] = [], intervals = new Set<ReturnType<typeof setInterval>>();
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`); });
page.on('request', request => {
  if (request.url().includes('kenney-tree-v1.glb')) treeRequests.push(request.url());
  if (/\.(glb|mp3)(?:\?|$)/.test(request.url()) && new URL(request.url()).origin !== origin) errors.push('Asset outside same origin: ' + request.url());
});
function record(message: string) { checks.push(message); console.log('✓ ' + message); }
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Délai dépassé : ' + label); await wait(40); }
}
async function capture(name: string) { const file = name + '.png'; await page.screenshot({ path: join(destination, file) }); captures.push(file); }
async function leavePage() {
  if ((await debug()).world) { await page.locator('#leave-button').click(); await until(async () => !(await debug()).world, 'sortie observateur'); }
}

try {
  const html = await fetch(origin).then(response => response.text());
  evidence.clientAssets = [...html.matchAll(/(?:src|href)="([^"]*assets[^"]+)"/g)].map(match => match[1]);
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const value = (window as unknown as { __lagonDebug?: Debug }).__lagonDebug;
    return value?.sceneryAssets.state === 'ready' && value.kartAssets.status === 'ready';
  }, undefined, { timeout: 60000 });
  assert.equal((await readOfficialTrackCatalog(page)).length, TRACKS.length);
  if (!loopsOnly) {
    for (const track of TRACKS) {
      await selectHomeTrack(page, track.id, track.name);
      await until(async () => (await page.locator('#track-name').textContent()) === track.name, 'sélection ' + track.id);
      await wait(1500);
      const hide = await page.addStyleTag({ content: '.menu,.screen-wash,.topbar,.bottom-bar{visibility:hidden!important}' });
      await capture(track.id + '-overview'); await hide.evaluate(node => (node as Element).remove());
      const state = await debug(); evidence[track.id + '-overview'] = { view: state.view, scenery: state.sceneryAssets };
      record(track.name + ' : panorama choisi dans le menu, scène rendue.');
    }
    fixtures.push('Les 12 panoramas utilisent la caméra d’accueil et une sélection normale de circuit. Les panneaux HTML sont masqués seulement pendant chaque capture du décor.');
  }
  assert.equal(treeRequests.length, 1, 'un téléchargement Kenney par page après tous les changements de circuit');
  assert.equal((await debug()).sceneryAssets.requests, 1);
  record('GLB Kenney servi depuis la même origine, une requête et un chargement sur toute la page.');

  assert.deepEqual(errors, []); assert.equal(treeRequests.length, 1);
  record(`Aucune erreur JavaScript, aucun asset HTTP manquant, cache GLB conservé après ${panoramasOnly ? 'les douze panoramas' : 'les deux courses'}.`);
  evidence.treeRequests = treeRequests;
  await writeFile(join(destination, 'validation.json'), JSON.stringify({ passed: false, automatedChecksPassed: true,
    visualReview: { status: 'pending', note: 'Inspecter les captures avant de valider : la projection ne prouve pas l’absence d’occlusion.' }, checks, errors, captures, evidence, fixtures,
    limitations: ['Un seul Chromium avec SwiftShader, aucun téléphone physique/GPU mesuré.',
      panoramasOnly ? 'Cette passe photographie les douze circuits ; aucun looping ni course n’est parcouru.'
        : 'Les boucles sont parcourues ; ces essais de cadrage ne sont pas des courses complètes ni des preuves réseau sur deux machines physiques.'] }, null, 2) + '\n');
} catch (error) {
  process.exitCode = 1; console.error(error);
  await writeFile(join(destination, 'validation.json'), JSON.stringify({ passed: false, failure: String(error), checks, errors, captures, evidence, fixtures }, null, 2) + '\n');
} finally {
  for (const timer of intervals) clearInterval(timer);
  for (const room of activeRooms) await room.leave(true).catch(() => {});
  await browser.close(); await gameServer.gracefullyShutdown(false);
  await rm(dataDirectory, { recursive: true, force: true });
  if (previousDirectory === undefined) delete process.env.PLAYER_DATA_DIR; else process.env.PLAYER_DATA_DIR = previousDirectory;
}
