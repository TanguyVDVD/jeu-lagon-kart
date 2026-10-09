import * as THREE from 'three';
import { nearestTrack, trackElevation, trackPoint, type TrackDefinition } from '../shared/track';
import { bankLift } from '../shared/road-pose';
import { ROAD_RAIL_CENTER_Y, ROAD_RAIL_HEIGHT, isBridgeProgress, trackBoundaryShoulder } from '../shared/obstacle-heights';
import { roadMeshRows } from './track-mesh-sampling';
import { TERRAIN_DROP } from './scenery-terrain';

/** One cross-section of the closed road: centre, right-hand normal and height. */
export interface RoadRow { progress: number; x: number; y: number; z: number; nx: number; nz: number }
export interface RoadEdgePoint { x: number; y: number; z: number }

/** Rows every two metres, on every spline point and on both sides of each ramp lip. */
export function roadRows(track: TrackDefinition): RoadRow[] {
  const count = roadMeshRows(track.length);
  const wrap = (progress: number) => (progress % track.length + track.length) % track.length;
  const base = [...new Set([
    ...Array.from({ length: count }, (_, i) => i * track.length / count),
    ...track.elevations.flatMap(feature => [feature.start, feature.end, feature.end + .05]).map(wrap),
    ...(track.crossings ?? []).flatMap(c => [c.lowerStart, c.lowerEnd, c.upperStart - c.approach, c.upperStart, c.upperEnd, c.upperEnd + c.approach]).map(wrap),
  ])].sort((a, b) => a - b);
  // The simulation follows the sampled spline. Keeping its own vertices makes
  // the drawn road and the driven road the same polyline in tight bends.
  const samples = [...base];
  let arc = 0, cursor = 0;
  track.points.forEach((point, i) => {
    while (cursor < base.length - 1 && base[cursor + 1]! <= arc) cursor++;
    if (Math.abs(base[cursor]! - arc) > .3 && Math.abs((base[cursor + 1] ?? track.length) - arc) > .3) samples.push(arc);
    const next = track.points[(i + 1) % track.points.length]!;
    arc += Math.hypot(next.x - point.x, next.z - point.z);
  });
  samples.sort((a, b) => a - b);
  const centres = samples.map(progress => trackPoint(progress, track.id));
  return samples.map((progress, i) => {
    const before = centres[(i + centres.length - 1) % centres.length]!, after = centres[(i + 1) % centres.length]!;
    const dx = after.x - before.x, dz = after.z - before.z, length = Math.hypot(dx, dz) || 1;
    return { progress, x: centres[i]!.x, z: centres[i]!.z, y: trackElevation(progress, track.id), nx: dz / length, nz: -dx / length };
  });
}

/** Parallel line `distance(row)` metres to the right of the centre line. Where a
 * bend is tighter than that distance the naive offset folds back over the road;
 * those rows meet at the single point where the two edges really cross. */
export function roadEdge(track: TrackDefinition, rows: readonly RoadRow[], distance: number | ((row: RoadRow) => number)): RoadEdgePoint[] {
  const count = rows.length, offsets = rows.map(row => typeof distance === 'number' ? distance : distance(row));
  const line = rows.map((row, i) => ({ x: row.x + row.nx * offsets[i]!, z: row.z + row.nz * offsets[i]!,
    y: row.y + bankLift(row.progress, offsets[i]!, track) }));
  const arcDistance = (a: number, b: number) => { const d = Math.abs(rows[a]!.progress - rows[b]!.progress); return Math.min(d, track.length - d); };
  const folded = line.map((point, i) => {
    const reach = Math.abs(offsets[i]!);
    if (reach < .5) return false;
    const limit = (reach - Math.max(.25, reach * .03)) ** 2, window = reach * 3 + 12;
    for (const direction of [-1, 1]) for (let step = direction < 0 ? 1 : 0; step < count; step++) {
      const a = ((i + direction * step) % count + count) % count, b = (a + 1) % count;
      if (arcDistance(i, direction < 0 ? b : a) > window) break;
      const p = rows[a]!, q = rows[b]!, dx = q.x - p.x, dz = q.z - p.z, squared = dx * dx + dz * dz;
      const t = squared > 1e-12 ? Math.max(0, Math.min(1, ((point.x - p.x) * dx + (point.z - p.z) * dz) / squared)) : 0;
      if ((point.x - p.x - dx * t) ** 2 + (point.z - p.z - dz * t) ** 2 < limit) return true;
    }
    return false;
  });
  const first = folded.indexOf(false);
  if (first < 0 || !folded.includes(true)) return line;
  for (let offset = 1; offset <= count; offset++) {
    const start = (first + offset) % count;
    if (!folded[start]) continue;
    let length = 1;
    while (folded[(start + length) % count]) length++;
    const before = line[(start + count - 1) % count]!, after = line[(start + length) % count]!;
    for (let k = 0; k < length; k++) {
      const point = line[(start + k) % count]!;
      point.x = (before.x + after.x) / 2; point.z = (before.z + after.z) / 2;
    }
    offset += length;
  }
  return line;
}

/** True when another part of the road already covers this point of an edge. */
export function insideRoad(track: TrackDefinition, row: RoadRow, point: RoadEdgePoint, reach: number): boolean {
  const hint = track.crossings?.length ? { progress: row.progress, elevation: row.y } : undefined;
  return nearestTrack(point.x, point.z, track.id, hint).distance < reach - .6;
}

/** Closed ribbon between two edges, `lift` metres above them. */
export function roadRibbon(left: readonly RoadEdgePoint[], right: readonly RoadEdgePoint[], lift: number, hidden?: (row: number) => boolean): THREE.BufferGeometry {
  const vertices: number[] = [], indices: number[] = [], count = left.length;
  for (let i = 0; i <= count; i++) {
    const a = left[i % count]!, b = right[i % count]!;
    vertices.push(a.x, a.y + lift, a.z, b.x, b.y + lift, b.z);
    if (i < count && !hidden?.(i)) { const n = i * 2; indices.push(n, n + 2, n + 1, n + 1, n + 2, n + 3); }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

/** Continuous guard rail along one shoulder edge, open wherever `gap` says so. */
export function roadRail(edge: readonly RoadEdgePoint[], gap: (row: number) => boolean): THREE.BufferGeometry {
  const vertices: number[] = [], indices: number[] = [], count = edge.length;
  const bottom = ROAD_RAIL_CENTER_Y - ROAD_RAIL_HEIGHT / 2, top = ROAD_RAIL_CENTER_Y + ROAD_RAIL_HEIGHT / 2;
  for (let i = 0; i < count; i++) {
    const a = edge[i]!, b = edge[(i + 1) % count]!;
    const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
    if (length < .05 || gap(i)) continue;
    const ox = dz / length * .2, oz = -dx / length * .2, base = vertices.length / 3;
    for (const point of [a, b]) vertices.push(
      point.x - ox, point.y + bottom, point.z - oz, point.x - ox, point.y + top, point.z - oz,
      point.x + ox, point.y + top, point.z + oz, point.x + ox, point.y + bottom, point.z + oz);
    for (let face = 0; face < 3; face++) {
      const p = base + face, q = base + face + 1;
      indices.push(p, q, p + 4, q, q + 4, p + 4);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

/** Slope from the shoulder edge down to the surrounding ground, so a raised or
 * banked road never shows a gap above the terrain. */
export function roadVerge(track: TrackDefinition, rows: readonly RoadRow[], edge: readonly RoadEdgePoint[], side: number,
  ground: (x: number, z: number) => number): THREE.BufferGeometry {
  const outer = roadEdge(track, rows, row => side * (track.width / 2 + trackBoundaryShoulder(row.progress, track.id) + 7));
  outer.forEach((point, i) => { point.y = Math.min(edge[i]!.y, ground(point.x, point.z)) - TERRAIN_DROP - .15; });
  return roadRibbon(side < 0 ? outer : edge, side < 0 ? edge : outer, 0, row => isBridgeProgress(rows[row]!.progress, track.id));
}
