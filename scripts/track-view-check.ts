// Screenshots of circuits through the real renderer, without a game server.
//   node --import tsx scripts/track-view-check.ts [id ...] [--shots=overview,0.1,0.5] [--stage=2 --level=3]
// A saved creation is addressed by its file name in data/tracks/ (without .json).
// CHROMIUM_PATH selects a browser when Playwright's own build is not installed.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { TRACK_IDS } from '../shared/track.js';

type Diagnostics = { calls: number; triangles: number };
type Harness = { register(record: unknown): string; overview(id: string): Diagnostics; chase(id: string, fraction: number, lateral?: number, stage?: number, level?: number): Diagnostics };
const project = resolve(fileURLToPath(new URL('..', import.meta.url))), destination = resolve(project, 'test-results/track-views');
const options = Object.fromEntries(process.argv.slice(2).filter(argument => argument.startsWith('--')).map(argument => argument.slice(2).split('=')));
const requested = process.argv.slice(2).filter(argument => !argument.startsWith('--'));
const shots = String(options.shots ?? 'overview,0.1,0.35,0.6,0.85').split(',');
const stage = Number(options.stage ?? 0), level = Number(options.level ?? 0);
await mkdir(destination, { recursive: true });
const vite = await createServer({ configFile: false, root: project, publicDir: resolve(project, 'client/public'),
  optimizeDeps: { include: ['three', 'three/addons/utils/BufferGeometryUtils.js', 'three/addons/loaders/GLTFLoader.js'] },
  server: { host: '127.0.0.1', port: 0, strictPort: true }, logLevel: 'error' });
await vite.listen();
const address = vite.httpServer!.address(); assert.ok(address && typeof address !== 'string');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/track-view.html`);
  await page.waitForFunction(() => '__trackView' in window, undefined, { timeout: 30000 });
  await page.waitForTimeout(1500); // Kart and tree models load from the same origin.
  for (const name of requested.length ? requested : TRACK_IDS) {
    const file = resolve(project, 'data/tracks', name + '.json');
    const id = existsSync(file) ? await page.evaluate(record => (window as unknown as { __trackView: Harness }).__trackView.register(record), JSON.parse(await readFile(file, 'utf8'))) : name;
    for (const shot of shots) {
      const view = await page.evaluate(([id, shot, stage, level]) => {
        const harness = (window as unknown as { __trackView: Harness }).__trackView;
        return shot === 'overview' ? harness.overview(id as string) : harness.chase(id as string, Number(shot), 0, stage as number, level as number);
      }, [id, shot, stage, level] as const);
      const image = `${name}-${shot === 'overview' ? 'overview' : Math.round(Number(shot) * 100)}.png`;
      await page.screenshot({ path: resolve(destination, image) });
      console.log(`${image}: ${view.calls} draw calls, ${view.triangles} triangles`);
    }
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); await vite.close(); }
