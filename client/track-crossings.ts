import * as THREE from 'three';
import { getTrack, trackElevation, trackPoint, type TrackDefinition } from '../shared/track';
import { BRIDGE_RAIL_CENTER_Y, BRIDGE_RAIL_THICKNESS, BRIDGE_SHOULDER, TRACK_SHOULDER } from '../shared/obstacle-heights';
import { automaticTrackElevation, CROSSING_DECK_THICKNESS } from '../shared/track-crossings';

const palette = new Map<string, THREE.MeshStandardMaterial>();
function material(color: string) {
  let result = palette.get(color);
  if (!result) { result = new THREE.MeshStandardMaterial({ color, roughness: .9 }); palette.set(color, result); }
  return result;
}
const delta = (progress: number, centre: number, length: number) =>
  ((progress - centre + length / 2) % length + length) % length - length / 2;

/** No pier or tunnel wall may occupy another road's full driving corridor. */
export function crossingSupportClear(track: TrackDefinition, x: number, z: number, bottom: number, top: number, radius = .8): boolean {
  if (!track.crossings?.length) return true;
  let progress = 0;
  for (let index = 0; index < track.points.length; index++) {
    const a = track.points[index]!, b = track.points[(index + 1) % track.points.length]!;
    const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
    if (length < 1e-8) continue;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (length * length)));
    if (Math.hypot(x - a.x - t * dx, z - a.z - t * dz) < track.width / 2 + TRACK_SHOULDER + radius) {
      const road = trackElevation(progress + t * length, track.id);
      if (road + 2.2 > bottom && road - .5 < top) return false;
    }
    progress += length;
  }
  return true;
}

/** Lower the chase camera before entering an underpass, including its chase offset. */
export function crossingCameraHeight(progress: number, trackId: string): number | undefined {
  const track = getTrack(trackId);
  let height: number | undefined;
  for (const crossing of track.crossings ?? []) {
    const centre = (crossing.lowerStart + crossing.lowerEnd) / 2;
    if (Math.abs(delta(progress, centre, track.length)) <= (crossing.lowerEnd - crossing.lowerStart) / 2 + 24)
      height = Math.min(height ?? Infinity, crossing.clearance - 1.5, 3.1);
  }
  return height;
}

/** Structural geometry is retained even with the mobile scenery setting. */
export function buildCrossingStructures(track: TrackDefinition): THREE.Group {
  const group = new THREE.Group(); group.name = `crossings-${track.id}`;
  if (!track.crossings?.length) return group;
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const concrete = track.theme === 'forest' ? '#826043' : '#526b72';
  const add = (name: string, color: string, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    const mesh = new THREE.Mesh(cube, material(color)); mesh.name = name;
    mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz); mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh); return mesh;
  };
  const beam = (name: string, color: string, a: THREE.Vector3, b: THREE.Vector3, thickness: number) => {
    const vector = b.clone().sub(a), mesh = add(name, color, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, thickness, vector.length(), thickness);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vector.normalize()); return mesh;
  };
  const point = (progress: number, side = 0, lift = 0) => {
    const p = trackPoint(progress, track.id);
    return new THREE.Vector3(p.x + Math.cos(p.angle) * side, trackElevation(progress, track.id) + lift, p.z - Math.sin(p.angle) * side);
  };
  const rows = Math.min(4096, Math.max(2, Math.ceil(track.length / 3)));
  const detailed = track.crossings.slice(0, 48);
  const intervals: Array<[number, number]> = [];
  for (const crossing of track.crossings) for (const shift of [-track.length, 0, track.length]) {
    const start = Math.max(0, crossing.upperStart + shift), end = Math.min(track.length, crossing.upperEnd + shift);
    if (end >= start) intervals.push([start, end]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const plateaus: Array<[number, number]> = [];
  for (const interval of intervals) {
    const last = plateaus[plateaus.length - 1];
    if (last && last[1] >= interval[0]) last[1] = Math.max(last[1], interval[1]); else plateaus.push([...interval]);
  }
  let plateauIndex = 0;
  const samples = [...new Set([0, track.length, ...Array.from({ length: rows }, (_, i) => i * track.length / rows),
    ...detailed.flatMap(c => [c.upperStart - c.approach, c.upperStart, c.upperEnd, c.upperEnd + c.approach])
      .map(p => (p % track.length + track.length) % track.length)])].sort((a, b) => a - b);
  for (let index = 0; index + 1 < samples.length; index++) {
    const start = samples[index]!, end = samples[index + 1]!, middle = (start + end) / 2;
    while (plateauIndex < plateaus.length && plateaus[plateauIndex]![1] < middle) plateauIndex++;
    const onPlateau = plateauIndex < plateaus.length && plateaus[plateauIndex]![0] <= middle;
    if (!onPlateau && automaticTrackElevation(middle, track) < .01) continue;
    const a = point(start), b = point(end), length = Math.hypot(b.x - a.x, b.z - a.z);
    const thickness = CROSSING_DECK_THICKNESS;
    const deck = add('crossing-deck', concrete, (a.x + b.x) / 2, (a.y + b.y) / 2 - thickness / 2,
      (a.z + b.z) / 2, track.width + BRIDGE_SHOULDER * 2, thickness, length + .08);
    deck.rotation.set(-Math.atan2(b.y - a.y, length), Math.atan2(b.x - a.x, b.z - a.z), 0, 'YXZ');
    for (const side of [-1, 1]) {
      const offset = side * (track.width / 2 + BRIDGE_SHOULDER);
      const railA = point(start, offset, BRIDGE_RAIL_CENTER_Y), railB = point(end, offset, BRIDGE_RAIL_CENTER_Y);
      beam('crossing-rail', track.palette.accent, railA, railB, BRIDGE_RAIL_THICKNESS);
      if (index % 2 === 0) beam('crossing-rail-post', concrete, point(start, offset), railA, BRIDGE_RAIL_THICKNESS);
      if (index % 5 === 0) {
        const top = point(start, offset, -thickness);
        if (top.y > 1 && crossingSupportClear(track, top.x, top.z, -.2, top.y))
          add('crossing-pier', concrete, top.x, (top.y - .2) / 2, top.z, 1.2, top.y + .2, 1.2);
      }
    }
  }
  for (const crossing of detailed) {
    // The elevated deck forms the ceiling. Frames and side walls identify both
    // mouths without placing a solid pillar or decoration in a driving lane.
    const roof = trackElevation(crossing.upperProgress, track.id) - crossing.deckThickness;
    const count = Math.min(128, Math.max(2, Math.ceil((crossing.lowerEnd - crossing.lowerStart) / 3)));
    for (let row = 0; row < count; row++) {
      const progress = crossing.lowerStart + (row + .5) * (crossing.lowerEnd - crossing.lowerStart) / count;
      const p = trackPoint(progress, track.id), base = trackElevation(progress, track.id);
      const height = Math.min(crossing.clearance, roof - base);
      if (height < 2.5) continue;
      for (const side of [-1, 1]) {
        const offset = side * (track.width / 2 + TRACK_SHOULDER + .8);
        const x = p.x + Math.cos(p.angle) * offset, z = p.z - Math.sin(p.angle) * offset;
        if (!crossingSupportClear(track, x, z, base, base + height, .6)) continue;
        const wall = add('tunnel-wall', concrete, x, base + height / 2, z, .6, height, (crossing.lowerEnd - crossing.lowerStart) / count + .03);
        wall.rotation.y = p.angle;
        if (row === 0 || row === count - 1) {
          const trim = add('tunnel-mouth', track.palette.accent, x - Math.cos(p.angle) * side * .34, base + height / 2,
            z + Math.sin(p.angle) * side * .34, .08, height, .4); trim.rotation.y = p.angle;
        }
      }
    }
  }
  return group;
}
