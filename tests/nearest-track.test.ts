import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS, nearestTrack } from '../shared/track.js';

/** The reference scan the spatial grid must reproduce exactly. */
function scan(track: typeof TRACKS[number], x: number, z: number) {
  let best = -1, bestSquared = Infinity, bestT = 0;
  track.points.forEach((a, i) => {
    const b = track.points[(i + 1) % track.points.length]!, dx = b.x - a.x, dz = b.z - a.z, squared = dx * dx + dz * dz;
    if (squared < 1e-14) return;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / squared)), distance = (x - (a.x + dx * t)) ** 2 + (z - (a.z + dz * t)) ** 2;
    if (distance < bestSquared) { bestSquared = distance; best = i; bestT = t; }
  });
  const a = track.points[best]!, b = track.points[(best + 1) % track.points.length]!;
  return { index: best, x: a.x + (b.x - a.x) * bestT, z: a.z + (b.z - a.z) * bestT, distance: Math.sqrt(bestSquared) };
}

test('the segment grid returns exactly the nearest road position of a full scan, on and far from every circuit', () => {
  let seed = 12345;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  for (const track of TRACKS) {
    const samples: Array<[number, number]> = [];
    // On the road and its verge, on the vertices themselves, and well out at sea.
    for (const point of track.points) samples.push([point.x, point.z], [point.x + (random() - .5) * 60, point.z + (random() - .5) * 60]);
    for (let i = 0; i < 300; i++) samples.push([(random() - .5) * 1400, (random() - .5) * 1400]);
    for (const [x, z] of samples) {
      const near = nearestTrack(x, z, track.id), expected = scan(track, x, z);
      assert.equal(near.index, expected.index, `${track.id} at ${x},${z}`);
      assert.equal(near.x, expected.x); assert.equal(near.z, expected.z); assert.equal(near.distance, expected.distance);
    }
  }
});
