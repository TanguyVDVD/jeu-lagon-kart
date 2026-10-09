// Design aid: metrics and a plan view of every official circuit currently in shared/track.ts.
import { writeFileSync } from 'node:fs';
import { TRACKS, reliefElevation, reliefSlope, trackBank, trackPoint, type TrackDefinition } from '../shared/track.js';
import { getTrackEvent } from '../shared/track-events.js';

const only = process.argv[2];
const out: string[] = [];
function metrics(t: TrackDefinition) {
  const p = t.points, n = p.length;
  const cum = [0]; for (let i = 0; i < n; i++) { const q = p[(i + 1) % n]!; cum.push(cum[i]! + Math.hypot(q.x - p[i]!.x, q.z - p[i]!.z)); }
  let minR = Infinity, minRAt = 0;
  for (let i = 0; i < n; i++) {
    const a = p[(i + n - 2) % n]!, b = p[i]!, c = p[(i + 2) % n]!;
    const ab = Math.hypot(b.x - a.x, b.z - a.z), bc = Math.hypot(c.x - b.x, c.z - b.z), ac = Math.hypot(c.x - a.x, c.z - a.z);
    const cr = Math.abs((b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x));
    const R = ab * bc * ac / (2 * cr || 1e-12); if (R < minR) { minR = R; minRAt = cum[i]! / t.length; }
  }
  let clearance = Infinity, clearAt = 0, crossings = 0;
  for (let i = 0; i < n; i += 2) for (let j = i + 2; j < n; j += 2) {
    const arc = Math.min(cum[j]! - cum[i]!, t.length - (cum[j]! - cum[i]!));
    const d = Math.hypot(p[i]!.x - p[j]!.x, p[i]!.z - p[j]!.z);
    // Only parts that are far along the road but close on the ground are a hazard.
    if (arc > Math.max(140, d * 2.2) && d < clearance) { clearance = d; clearAt = cum[i]! / t.length; }
    if (arc > 60 && d < 1.5) crossings++;
  }
  let slope = 0, top = 0, bank = 0;
  for (let s = 0; s < t.length; s += 2) { slope = Math.max(slope, Math.abs(reliefSlope(s, t))); top = Math.max(top, reliefElevation(s, t)); bank = Math.max(bank, Math.abs(trackBank(s, t))); }
  let branches = 'OK';
  let event: ReturnType<typeof getTrackEvent> | undefined;
  try { event = getTrackEvent(t.id, 2, 3); branches = event.branches.map(b => `${b.kind[0]}:${(b.start / t.length).toFixed(2)}-${(b.end / t.length).toFixed(2)} R${b.minTurnRadius.toFixed(0)} ${(100 - b.length / (b.end - b.start) * 100).toFixed(0)}%`).join(' '); }
  catch (error) { branches = 'FAIL ' + String(error).slice(0, 60); }
  return { minR, minRAt, clearance, clearAt, crossings, slope, top, bank, branches, event };
}
const cells: string[] = [];
for (const t of TRACKS) {
  if (only && t.id !== only) continue;
  const m = metrics(t);
  const need = t.width + 22;
  out.push(`${t.id.padEnd(9)} len ${t.length.toFixed(0).padStart(5)} w${t.width} minR ${m.minR.toFixed(1).padStart(5)}@${m.minRAt.toFixed(2)} (need>${(t.width / 2 + 8).toFixed(0)}) clear ${m.clearance.toFixed(0).padStart(4)}@${m.clearAt.toFixed(2)} (need>${need}) cross ${m.crossings} top ${m.top.toFixed(1)} slope ${(m.slope * 100).toFixed(1)}% bank ${(m.bank * 100).toFixed(1)}% | ${m.branches}`);
  const xs = t.points.map(q => q.x), zs = t.points.map(q => q.z);
  const pad = 45, minX = Math.min(...xs) - pad, minZ = Math.min(...zs) - pad, w = Math.max(...xs) - minX + pad, h = Math.max(...zs) - minZ + pad;
  const path = (pts: Array<{ x: number; z: number }>, close = true) => pts.map((q, i) => (i ? 'L' : 'M') + q.x.toFixed(1) + ' ' + q.z.toFixed(1)).join('') + (close ? 'Z' : '');
  const span = (a: number, b: number) => path(Array.from({ length: 25 }, (_, i) => trackPoint(a + (b - a) * i / 24, t.id)), false);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minZ} ${w} ${h}" width="470" height="${Math.round(470 * h / w)}" style="background:#24313a">`;
  svg += `<path d="${path(t.points)}" fill="none" stroke="#5c6b70" stroke-width="${t.width + 10}" stroke-linejoin="round"/>`;
  svg += `<path d="${path(t.points)}" fill="none" stroke="#8d9a9c" stroke-width="${t.width}" stroke-linejoin="round"/>`;
  // Relief as colour along the centre line: blue low, red high.
  for (let s = 0; s < t.length; s += 6) { const a = trackPoint(s, t.id), b = trackPoint(s + 6, t.id), k = m.top ? reliefElevation(s, t) / m.top : 0;
    svg += `<path d="M${a.x.toFixed(1)} ${a.z.toFixed(1)}L${b.x.toFixed(1)} ${b.z.toFixed(1)}" stroke="rgb(${Math.round(60 + 195 * k)},${Math.round(90 + 60 * (1 - Math.abs(k - .5) * 2))},${Math.round(255 - 195 * k)})" stroke-width="5"/>`; }
  for (const b of m.event?.branches ?? []) svg += `<path d="${path(b.points, false)}" fill="none" stroke="${b.kind === 'detour' ? '#ffe28c' : b.kind === 'shortcut' ? '#83f6b7' : '#a4e6ff'}" stroke-width="3" stroke-dasharray="6 5"/>`;
  for (const z of t.zones) svg += `<path d="${span(z.start, z.end)}" fill="none" stroke="${z.kind === 'boost' ? '#ffd24a' : z.kind === 'ice' ? '#7df3ff' : '#8a5a3c'}" stroke-width="9" opacity=".9"/>`;
  for (const e of t.elevations) svg += `<path d="${span(e.start, e.end)}" fill="none" stroke="${e.kind === 'bridge' ? '#ff66d9' : '#ff7a2f'}" stroke-width="4"/>`;
  for (let k = 0; k < 20; k++) { const q = trackPoint(k / 20 * t.length, t.id); svg += `<circle cx="${q.x}" cy="${q.z}" r="3.2" fill="#fff"/><text x="${q.x + 6}" y="${q.z - 6}" font-size="13" fill="#fff" font-family="sans-serif">${(k * 5)}</text>`; }
  const start = trackPoint(0, t.id); svg += `<circle cx="${start.x}" cy="${start.z}" r="8" fill="none" stroke="#fff" stroke-width="3"/>`;
  svg += `<text x="${minX + 6}" y="${minZ + 20}" font-size="17" fill="#fff" font-family="sans-serif">${t.id} ${t.length.toFixed(0)}m R${m.minR.toFixed(0)} top${m.top.toFixed(0)}</text></svg>`;
  cells.push(svg);
}
console.log(out.join('\n'));
writeFileSync('test-results/track-plan.html', `<body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(${only ? 1 : 4},470px);gap:6px">${cells.join('')}</body>`);
