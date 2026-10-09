import { baseTrackElevation, type TrackDefinition } from './track.js';

/** Vertical room for a kart and a jump below the next road deck. */
export const CROSSING_CLEARANCE = 5;
export const CROSSING_DECK_THICKNESS = .7;
export interface TrackCrossing {
  id: string; x: number; z: number;
  /** Route metres. The later pass is always above the earlier pass. */
  lowerProgress: number; upperProgress: number;
  /** Plateau intervals around each pass, possibly outside [0, length]. */
  lowerStart: number; lowerEnd: number; upperStart: number; upperEnd: number;
  clearance: number; deckThickness: number;
  /** Added height, on top of the authored relief. */
  lowerHeight: number; height: number; approach: number; layer: number;
}
interface Station { progress: number; start: number; end: number; height: number; layer: number }
interface RawCrossing { x: number; z: number; lowerProgress: number; upperProgress: number; half: number }
const profiles = new WeakMap<TrackDefinition, Station[]>();
const smooth = (t: number) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
const circularDistance = (a: number, b: number, length: number) => { const difference = Math.abs(a - b); return Math.min(difference, length - difference); };
const cross = (x: number, z: number, xx: number, zz: number) => x * zz - z * xx;

/** Spatial bins avoid comparing every spline sample with every other one. */
function findCrossings(track: TrackDefinition): RawCrossing[] {
  const lengths = track.points.map((a, i) => { const b = track.points[(i + 1) % track.points.length]!; return Math.hypot(b.x - a.x, b.z - a.z); });
  const cumulative = [0]; for (const length of lengths) cumulative.push(cumulative[cumulative.length - 1]! + length);
  const cells = new Map<string, number[]>(), cellSize = Math.max(32, track.width * 2), result: RawCrossing[] = [];
  for (let i = 0; i < track.points.length; i++) {
    if (lengths[i]! < 1e-7) continue;
    const a = track.points[i]!, b = track.points[(i + 1) % track.points.length]!;
    const minX = Math.floor(Math.min(a.x, b.x) / cellSize), maxX = Math.floor(Math.max(a.x, b.x) / cellSize);
    const minZ = Math.floor(Math.min(a.z, b.z) / cellSize), maxZ = Math.floor(Math.max(a.z, b.z) / cellSize);
    const candidates = new Set<number>(), keys: string[] = [];
    for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
      const key = `${x},${z}`; keys.push(key); for (const index of cells.get(key) ?? []) candidates.add(index);
    }
    for (const j of candidates) {
      if (Math.abs(i - j) <= 1 || i === track.points.length - 1 && j === 0) continue;
      const c = track.points[j]!, d = track.points[(j + 1) % track.points.length]!;
      const rx = b.x - a.x, rz = b.z - a.z, sx = d.x - c.x, sz = d.z - c.z;
      const denominator = cross(rx, rz, sx, sz);
      let t: number, u: number;
      if (Math.abs(denominator) < 1e-9) {
        // Repeated collinear stretches also need separate floors. One contact
        // per overlapping sampled segment is later merged along its branch.
        if (Math.abs(cross(c.x - a.x, c.z - a.z, rx, rz)) > 1e-6 * lengths[i]!) continue;
        const norm = rx * rx + rz * rz;
        const first = ((c.x - a.x) * rx + (c.z - a.z) * rz) / norm;
        const last = ((d.x - a.x) * rx + (d.z - a.z) * rz) / norm;
        const from = Math.max(0, Math.min(first, last)), to = Math.min(1, Math.max(first, last));
        if (to - from < 1e-5) continue;
        t = (from + to) / 2;
        u = ((a.x + t * rx - c.x) * sx + (a.z + t * rz - c.z) * sz) / (sx * sx + sz * sz);
      } else {
        t = cross(c.x - a.x, c.z - a.z, sx, sz) / denominator;
        u = cross(c.x - a.x, c.z - a.z, rx, rz) / denominator;
        if (t < -1e-8 || t > 1 + 1e-8 || u < -1e-8 || u > 1 + 1e-8) continue;
        t = Math.max(0, Math.min(1, t)); u = Math.max(0, Math.min(1, u));
      }
      const upperProgress = cumulative[i]! + lengths[i]! * t, lowerProgress = cumulative[j]! + lengths[j]! * u;
      const separation = circularDistance(upperProgress, lowerProgress, track.length);
      // Adjacent pieces of a tight bend describe one connected road surface.
      if (separation <= Math.max(8, track.width * 1.5)) continue;
      const sine = Math.abs(denominator) / (lengths[i]! * lengths[j]!);
      const cosine = Math.sqrt(Math.max(0, 1 - sine * sine));
      // Both complete ribbons (including their shoulders) must clear each
      // other, not just the intersection of their two centrelines.
      const half = Math.min(separation * .23, (track.width / 2 + 2) * (1 + cosine) / Math.max(.08, sine));
      result.push({ x: a.x + t * rx, z: a.z + t * rz, lowerProgress, upperProgress, half });
    }
    for (const key of keys) { const entries = cells.get(key); if (entries) entries.push(i); else cells.set(key, [i]); }
  }
  result.sort((a, b) => a.upperProgress - b.upperProgress || a.lowerProgress - b.lowerProgress);
  // At an exact spline vertex four segment pairs describe the same crossing.
  const unique: RawCrossing[] = [], seen = new Set<string>();
  for (const crossing of result) {
    const key = `${Math.round(crossing.lowerProgress * 1e5)}:${Math.round(crossing.upperProgress * 1e5)}`;
    if (seen.has(key)) continue;
    seen.add(key); unique.push(crossing);
  }
  return unique;
}
function reliefRange(track: TrackDefinition, station: Station): { min: number; max: number } {
  const positions = [station.start, station.end, station.progress];
  const features = track.elevations;
  for (const feature of features) for (const point of [feature.start, feature.end, (feature.start + feature.end) / 2,
    ...('approach' in feature ? [feature.start + feature.approach, feature.end - feature.approach] : [])]) {
    for (const turn of [-track.length, 0, track.length]) if (point + turn >= station.start && point + turn <= station.end) positions.push(point + turn);
  }
  for (let i = 1; i < 16; i++) positions.push(station.start + (station.end - station.start) * i / 16);
  const heights = positions.map(progress => baseTrackElevation(progress, track));
  return { min: Math.min(...heights), max: Math.max(...heights) };
}

/** Rebuilt from the source draft on server, client, preview, import and reload. */
export function deriveTrackCrossings(track: TrackDefinition): void {
  const raw = findCrossings(track); if (!raw.length) return;
  const events = raw.flatMap(crossing => [{ progress: crossing.lowerProgress, half: crossing.half }, { progress: crossing.upperProgress, half: crossing.half }]).sort((a, b) => a.progress - b.progress);
  const stations: Station[] = [];
  for (const event of events) {
    const previous = stations[stations.length - 1];
    if (previous && event.progress - previous.progress < .1) {
      previous.start = Math.min(previous.start, event.progress - event.half); previous.end = Math.max(previous.end, event.progress + event.half);
    } else stations.push({ progress: event.progress, start: event.progress - event.half, end: event.progress + event.half, height: 0, layer: 0 });
  }
  // Keep consecutive crossing stations distinct, including very short creative
  // stretches. Their transitions may be compressed but never reject the draft.
  for (let i = 0; i < stations.length; i++) {
    const station = stations[i]!, previous = stations[(i + stations.length - 1) % stations.length]!, next = stations[(i + 1) % stations.length]!;
    const previousProgress = previous.progress - (i === 0 ? track.length : 0), nextProgress = next.progress + (i === stations.length - 1 ? track.length : 0);
    station.start = Math.max(station.start, station.progress - (station.progress - previousProgress) * .45);
    station.end = Math.min(station.end, station.progress + (nextProgress - station.progress) * .45);
  }
  const byProgress = (progress: number) => {
    let low = 0, high = stations.length - 1;
    while (low < high) { const mid = (low + high) >>> 1; if (stations[mid]!.progress < progress - .099999) low = mid + 1; else high = mid; }
    return stations[low]!;
  };
  const ranges = new Map(stations.map(station => [station, reliefRange(track, station)]));
  const crossings: TrackCrossing[] = [];
  for (const [index, crossing] of raw.entries()) {
    const lower = byProgress(crossing.lowerProgress), upper = byProgress(crossing.upperProgress);
    if (lower === upper) continue;
    upper.height = Math.max(upper.height, lower.height + ranges.get(lower)!.max - ranges.get(upper)!.min + CROSSING_CLEARANCE + CROSSING_DECK_THICKNESS);
    upper.layer = Math.max(upper.layer, lower.layer + 1);
    crossings.push({ id: `${track.id}-crossing-${index}`, x: crossing.x, z: crossing.z,
      lowerProgress: crossing.lowerProgress, upperProgress: crossing.upperProgress,
      lowerStart: lower.start, lowerEnd: lower.end, upperStart: upper.start, upperEnd: upper.end,
      lowerHeight: lower.height, height: upper.height, approach: Math.max(24, upper.height * 10),
      clearance: CROSSING_CLEARANCE, deckThickness: CROSSING_DECK_THICKNESS, layer: upper.layer });
  }
  // Several roads can share the same upper station. Publish its final height
  // after every lower floor has contributed its clearance constraint.
  for (const crossing of crossings) {
    const lower = byProgress(crossing.lowerProgress), upper = byProgress(crossing.upperProgress);
    crossing.lowerHeight = lower.height; crossing.height = upper.height; crossing.layer = upper.layer;
    crossing.approach = Math.max(24, upper.height * 10);
  }
  if (crossings.length) { track.crossings = crossings; profiles.set(track, stations); }
}
function profile(track: TrackDefinition): Station[] {
  const saved = profiles.get(track); if (saved) return saved;
  const stations = (track.crossings ?? []).flatMap(c => [
    { progress: c.lowerProgress, start: c.lowerStart, end: c.lowerEnd, height: c.lowerHeight, layer: 0 },
    { progress: c.upperProgress, start: c.upperStart, end: c.upperEnd, height: c.height, layer: c.layer },
  ]).sort((a, b) => a.progress - b.progress).filter((station, i, values) => i === 0 || Math.abs(station.progress - values[i - 1]!.progress) >= .1);
  profiles.set(track, stations); return stations;
}
/** Circular, C1 approaches interpolate between floors without lifting the road
 * underneath a later overpass. Authored relief is added by trackElevation. */
export function automaticTrackElevation(progress: number, track: TrackDefinition): number {
  if (!track.crossings?.length) return 0;
  const stations = profile(track), wrapped = ((progress % track.length) + track.length) % track.length;
  let low = 0, high = stations.length;
  while (low < high) { const mid = (low + high) >>> 1; if (stations[mid]!.progress <= wrapped) low = mid + 1; else high = mid; }
  const before = stations[(low + stations.length - 1) % stations.length]!, after = stations[low % stations.length]!;
  const beforeEnd = before.end - (low === 0 ? track.length : 0), afterStart = after.start + (low === stations.length ? track.length : 0);
  if (wrapped <= beforeEnd) return before.height;
  if (wrapped >= afterStart) return after.height;
  const gap = afterStart - beforeEnd, down = before.height > 0 ? Math.max(24, before.height * 10) : 0, up = after.height > 0 ? Math.max(24, after.height * 10) : 0;
  if (gap > down + up) {
    if (down && wrapped < beforeEnd + down) return before.height * (1 - smooth((wrapped - beforeEnd) / down));
    if (up && wrapped > afterStart - up) return after.height * smooth((wrapped - (afterStart - up)) / up);
    return 0;
  }
  return before.height + (after.height - before.height) * smooth((wrapped - beforeEnd) / gap);
}
