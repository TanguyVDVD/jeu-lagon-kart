import { getTrack, getTrackLapCount, nearestTrack, trackPoint, trackSurface, trackElevation, type Surface, type TrackZone, type Vec2 } from './track.js';
import { KART_COLLISION_HEIGHT, trackBlockerHeight } from './obstacle-heights.js';

export type EventLevel = 0 | 1 | 2 | 3;
export type EventStage = number;
export type BranchKind = 'detour' | 'technical' | 'shortcut';
export interface BranchPoint extends Vec2 { progress: number; angle: number }
export interface EventCheckpointGate extends BranchPoint { width: number; branchId: string }
export interface TrackBranch {
  id: string; name: string; kind: BranchKind; start: number; end: number;
  width: number; length: number; minTurnRadius: number; points: BranchPoint[]; open: boolean;
}
export interface TrackBlocker extends Vec2 {
  id: string; angle: number; halfLength: number; halfWidth: number; elevation: number; height: number;
}
export interface TrackEventInfo {
  trackId: string; stage: EventStage; level: EventLevel; title: string; description: string;
  weather: 'clear' | 'rain' | 'snow' | 'ash' | 'storm';
  branches: TrackBranch[]; blockers: TrackBlocker[];
  /** Active, authored road effects only; coordinates are metres along the route. */
  zones?: TrackZone[];
}
export type DriveablePosition = ReturnType<typeof nearestTrack> & {
  width: number; branchId: string; surface: Surface;
};
const layouts = new Map<string, { branches: TrackBranch[]; blocker: TrackBlocker }>();
const branchBounds = new WeakMap<BranchPoint[], { minX: number; maxX: number; minZ: number; maxZ: number }>();
/** Distance from a position to the rectangle holding a whole branch: zero inside it. */
function branchReach(route: TrackBranch, x: number, z: number): number {
  let bounds = branchBounds.get(route.points);
  if (!bounds) {
    bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const point of route.points) { bounds.minX = Math.min(bounds.minX, point.x); bounds.maxX = Math.max(bounds.maxX, point.x); bounds.minZ = Math.min(bounds.minZ, point.z); bounds.maxZ = Math.max(bounds.maxZ, point.z); }
    branchBounds.set(route.points, bounds);
  }
  return Math.hypot(Math.max(bounds.minX - x, 0, x - bounds.maxX), Math.max(bounds.minZ - z, 0, z - bounds.maxZ));
}
const events = new Map<string, TrackEventInfo>();
/** Preview rooms release every derived phase together with their definition. */
export function clearTrackEventCache(trackId:string):void {
  layouts.delete(trackId);
  for(const key of events.keys())if(key.startsWith(trackId+':'))events.delete(key);
}
const clampLevel = (value: number): EventLevel => Math.max(0, Math.min(3, Math.floor(Number.isFinite(value) ? value : 0))) as EventLevel;
const clampStage = (value: number): EventStage => Math.max(0, Math.min(2, Math.floor(Number.isFinite(value) ? value : 0))) as EventStage;

function branch(trackId: string, start: number, end: number, kind: BranchKind, handle: number, bow: number, width: number): TrackBranch {
  const a = trackPoint(start, trackId), b = trackPoint(end, trackId);
  const chord = Math.hypot(b.x - a.x, b.z - a.z), normal = { x: (b.z - a.z) / chord, z: -(b.x - a.x) / chord };
  const first = { x: a.x + Math.sin(a.angle) * chord * handle, z: a.z + Math.cos(a.angle) * chord * handle };
  const last = { x: b.x - Math.sin(b.angle) * chord * handle, z: b.z - Math.cos(b.angle) * chord * handle };
  return measured(trackId, start, end, kind, width, Array.from({ length: 97 }, (_, index) => {
    const t = index / 96, u = 1 - t, offset = 16 * t * t * u * u * bow;
    return { x: u ** 3 * a.x + 3 * u * u * t * first.x + 3 * u * t * t * last.x + t ** 3 * b.x + normal.x * offset,
      z: u ** 3 * a.z + 3 * u * u * t * first.z + 3 * u * t * t * last.z + t ** 3 * b.z + normal.z * offset,
      progress: 0, angle: b.angle };
  }));
}

/** A lane that leaves the road sideways, runs beside it and returns. Unlike a
 * chord it follows every bend, so it fits hairpins and esses as well as ovals. */
function bypass(trackId: string, start: number, end: number, kind: BranchKind, side: number, width: number): TrackBranch {
  const reach = side * (getTrack(trackId).width / 2 + 15), ease = (t: number) => t * t * (3 - 2 * t);
  return measured(trackId, start, end, kind, width, Array.from({ length: 97 }, (_, index) => {
    const t = index / 96, progress = start + (end - start) * t, point = trackPoint(progress, trackId);
    // The sampled spline turns in small steps. Averaging it gives the lane a
    // steady curve; both ends stay exactly on the road they join.
    let x = 0, z = 0;
    for (let step = -3; step <= 3; step++) { const sample = trackPoint(progress + step * 3, trackId); x += sample.x / 7; z += sample.z / 7; }
    const smooth = Math.min(1, t / .1, (1 - t) / .1);
    const before = trackPoint(progress - 10, trackId), after = trackPoint(progress + 10, trackId);
    const dx = after.x - before.x, dz = after.z - before.z, chord = Math.hypot(dx, dz) || 1;
    const offset = reach * ease(Math.min(1, t / .4)) * ease(Math.min(1, (1 - t) / .4));
    return { x: point.x + (x - point.x) * smooth + dz / chord * offset, z: point.z + (z - point.z) * smooth - dx / chord * offset, progress: 0, angle: point.angle };
  }));
}

function measured(trackId: string, start: number, end: number, kind: BranchKind, width: number, points: BranchPoint[]): TrackBranch {
  const b = points[points.length - 1]!;
  let length = 0, maximumCurvature = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!, b = points[i + 1]!;
    a.angle = Math.atan2(b.x - a.x, b.z - a.z);
    length += Math.hypot(b.x - a.x, b.z - a.z);
    b.progress = length;
    if (i + 2 < points.length) {
      const c = points[i + 2]!, ab = Math.hypot(b.x - a.x, b.z - a.z), bc = Math.hypot(c.x - b.x, c.z - b.z), ac = Math.hypot(c.x - a.x, c.z - a.z);
      maximumCurvature = Math.max(maximumCurvature, 2 * Math.abs((b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x)) / (ab * bc * ac));
    }
  }
  // Beside the road a branch shares its coordinate, and so its height on a hill:
  // where both ribbons overlap they form one surface. Away from it the branch
  // spreads the rest of the sector evenly over its own length.
  const overlap = getTrack(trackId).width / 2 + width / 2 + 4;
  let previous = start;
  points.forEach((point, index) => {
    const even = start + point.progress / length * (end - start), near = nearestTrack(point.x, point.z, trackId);
    const blend = near.progress < start - 1 || near.progress > end + 1 ? 0 : 1 - Math.max(0, Math.min(1, (near.distance - overlap) / 30));
    const weight = blend * blend * (3 - 2 * blend);
    point.progress = index === 0 ? start : index === points.length - 1 ? end
      : Math.min(end - (points.length - 1 - index) * 1e-6, Math.max(previous + 1e-6, even + (near.progress - even) * weight));
    previous = point.progress;
  });
  return { id: trackId + '-' + kind, name: kind === 'detour' ? 'Déviation large' : kind === 'technical' ? 'Voie turbo' : 'Raccourci',
    kind, start, end, width, length, minTurnRadius: 1 / maximumCurvature, points, open: true };
}

function layout(trackId: string) {
  const track = getTrack(trackId);
  const cached = layouts.get(track.id);
  if (cached) return cached;
  const width = track.width >= 20 ? 14 : 12;
  const candidates: Array<{ detour: TrackBranch; shortcut: TrackBranch; blocker: TrackBlocker; score: number }> = [];
  const outward = (start: number, end: number, kind: BranchKind, handle: number) => {
    const base = branch(track.id, start, end, kind, handle, 0, width);
    const a = base.points[0]!, b = base.points.at(-1)!, middle = trackPoint((start + end) / 2, track.id), mid = base.points[48]!;
    const chord = Math.hypot(b.x - a.x, b.z - a.z);
    const bow = ((middle.x - mid.x) * (b.z - a.z) - (middle.z - mid.z) * (b.x - a.x)) / chord + track.width / 2 + 18;
    return branch(track.id, start, end, kind, handle, bow, width);
  };
  // A branch leaves the road once and returns once. On circuits with hairpins
  // and esses a chord could otherwise brush or cross another part of its own
  // sector, opening an unplanned junction in the middle of the main road.
  const safeSector = (route: TrackBranch) => {
    // A detour must be a road of its own for a good part of the closed sector;
    // a turbo lane may stay closer to the road it accompanies.
    const share = route.kind === 'detour' ? .3 : route.kind === 'shortcut' ? .2 : .15;
    let runs = 0, clear = 0, apart = false, side = 0, swings = 0, left = 0;
    for (const point of route.points) {
      const near = nearestTrack(point.x, point.z, track.id);
      if (near.progress < route.start - 18 || near.progress > route.end + 18) return false;
      const separate = near.distance > track.width / 2 + route.width / 2 + 6;
      // A junction may slide across the road once; it never weaves over it.
      const lateral = (point.x - near.x) * Math.cos(near.angle) - (point.z - near.z) * Math.sin(near.angle);
      if (separate) side = swings = left = 0;
      else if (Math.abs(lateral) > 4) {
        // Once its centre has left the carriageway on one side, coming back over
        // the road would cut through the rail it has just opened.
        if (left && Math.sign(lateral) !== left) return false;
        if (side && Math.sign(lateral) !== side && ++swings > 1) return false;
        side = Math.sign(lateral);
        if (Math.abs(lateral) > track.width / 2 + route.width / 2) left = side;
      }
      if (separate && !apart) runs++;
      if (separate) clear++;
      apart = separate;
    }
    return runs === 1 && clear >= route.points.length * share;
  };
  // Which side of the road a branch runs on: the sign of the area it encloses with its sector.
  const side = (route: TrackBranch) => {
    const outline = [...Array.from({ length: 49 }, (_, index) => trackPoint(route.start + (route.end - route.start) * index / 48, track.id)),
      ...[...route.points].reverse()];
    let area = 0;
    outline.forEach((point, index) => { const next = outline[(index + 1) % outline.length]!; area += point.x * next.z - next.x * point.z; });
    return Math.sign(area);
  };
  // A branch is a ground-level road: it never spans a bridge or a ramp, whose
  // height it would otherwise copy without any deck underneath.
  const level = (start: number, end: number) => !track.elevations.some(feature => start < feature.end + 12 && end > feature.start - 12);
  // Long Bézier transitions preserve the road's entry/exit tangents. Candidate
  // selection favours broad turns and a real geometric shortcut, never a turbo
  // used to disguise a longer, hairpin-shaped route.
  for (const span of [3, 4, 5]) for (let gate = 1; gate + span <= 11; gate++) {
    const start = gate * track.length / 12 + 8, end = (gate + span) * track.length / 12 - 8;
    if (!level(start, end)) continue;
    for (const handle of [.24, .28, .32, .36]) {
      const shortcut = branch(track.id, start, end, 'shortcut', handle, 0, width);
      const gain = 1 - shortcut.length / (end - start);
      if (gain < .05 || gain > .34 || shortcut.minTurnRadius < 25 || !safeSector(shortcut)) continue;
      // A wide chord around the outside of a bend, or a lane beside a straighter stretch.
      for (const detour of [...[.38, .44, .5].map(outerHandle => outward(start, end, 'detour', outerHandle)),
        ...[1, -1].map(side => bypass(track.id, start, end, 'detour', side, width))]) {
        if (detour.minTurnRadius < 21 || detour.length < (end - start) * .95 || detour.length > (end - start) * 1.25 || !safeSector(detour)) continue;
        // The two routes of one sector leave on opposite sides; side by side
        // their shoulders would merge and hide which rail is really open.
        if (side(detour) === side(shortcut)) continue;
        let blocker: TrackBlocker | undefined, clearance = -Infinity;
        for (const fraction of [.3, .4, .5, .6, .7]) {
          const point = trackPoint(start + (end - start) * fraction, track.id);
          const candidate = { id: track.id + '-collapse', x: point.x, z: point.z, angle: point.angle,
            halfLength: 2.6, halfWidth: track.width / 2 + 5.5,
            elevation: trackElevation(start + (end - start) * fraction, track.id), height: trackBlockerHeight(track.id) };
          let space = Infinity;
          for (const route of [detour, shortcut]) for (const sample of route.points) {
            const along = (sample.x - point.x) * Math.sin(point.angle) + (sample.z - point.z) * Math.cos(point.angle);
            if (Math.abs(along) > candidate.halfLength + width / 2 + 2) continue;
            const across = Math.abs((sample.x - point.x) * Math.cos(point.angle) - (sample.z - point.z) * Math.sin(point.angle));
            space = Math.min(space, across - candidate.halfWidth - width / 2 - 1);
          }
          if (space > clearance) { clearance = space; blocker = candidate; }
        }
        if (!blocker || clearance < .5) continue;
        const score = Math.min(shortcut.minTurnRadius, 45) * .003 + Math.min(detour.minTurnRadius, 40) * .003 + gain * .6 - Math.max(0, detour.length / (end - start) - 1) * .2;
        candidates.push({ detour, shortcut, blocker, score });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) throw new Error('Aucune bifurcation fluide et sûre pour le circuit ' + track.id);
  // The best pair that still leaves room elsewhere for the turbo lane.
  const turboLane = (detour: TrackBranch) => {
    const alternatives: TrackBranch[] = [];
    for (const span of [3, 4]) for (let gate = 1; gate + span <= 11; gate++) {
      const start = gate * track.length / 12 + 8, end = (gate + span) * track.length / 12 - 8;
      if (start < detour.end + 10 && end > detour.start - 10 || !level(start, end)) continue;
      for (const candidate of [...[.38, .44, .5].map(handle => outward(start, end, 'technical', handle)),
        ...[1, -1].map(side => bypass(track.id, start, end, 'technical', side, width))])
        if (candidate.minTurnRadius >= 20 && candidate.length <= (end - start) * 1.2 && safeSector(candidate)) alternatives.push(candidate);
    }
    return alternatives.sort((a, b) => b.minTurnRadius - a.minTurnRadius)[0];
  };
  let chosen: typeof candidates[number] | undefined, technical: TrackBranch | undefined;
  for (const candidate of candidates) { technical = turboLane(candidate.detour); if (technical) { chosen = candidate; break; } }
  if (!chosen || !technical) throw new Error('Aucune voie secondaire fluide pour le circuit ' + track.id);
  const { detour, shortcut, blocker } = chosen;
  const result = { branches: [detour, technical, shortcut], blocker };
  layouts.set(track.id, result);
  return result;
}

/** Shared phase comes from the leader's lap, never from an individual client. */
export function getTrackEvent(trackId: string, stage = 0, level = 0): TrackEventInfo {
  // Authored events use the leader's actual lap. Built-in three-phase layouts
  // keep their original behavior and never generate branches on arbitrary roads.
  const track = getTrack(trackId), custom = track.id.startsWith('custom-');
  const currentStage = custom ? Math.max(0, Math.min(getTrackLapCount(track.id)-1, Math.floor(Number.isFinite(stage)?stage:0))) : clampStage(stage);
  const currentLevel = custom ? 0 : clampLevel(level);
  const key = [track.id, currentStage, currentLevel].join(':');
  const cached = events.get(key);
  if (cached) return cached;
  if (custom && track.lapEvents?.length) {
    const active = track.lapEvents.filter(event=>event.lap===currentStage+1);
    const weatherKinds = ['clear','rain','snow','ash','storm'] as const;
    const weather = [...active].reverse().find(event=>(weatherKinds as readonly string[]).includes(event.kind))?.kind as TrackEventInfo['weather'] | undefined;
    const zones: TrackZone[] = active.filter(event=>event.kind!=='clear').map(event=>({
      id:event.id, kind:event.kind==='snow' || event.kind==='ice' ? 'ice' : event.kind==='boost' ? 'boost' : 'mud',
      start:event.start,end:event.end,offset:0,width:track.width,
    }));
    const labels = {clear:'Éclaircie',rain:'Pluie',snow:'Neige',ash:'Cendres',storm:'Tempête',boost:'Turbo',ice:'Verglas',mud:'Boue'};
    const titles = [...new Set(active.map(event=>labels[event.kind]))];
    const result: TrackEventInfo = {trackId:track.id,stage:currentStage,level:weather==='storm'?3:weather && weather!=='clear'?2:active.length?1:0,
      title:`Tour ${currentStage+1} · ${titles.join(' + ') || 'Piste libre'}`,
      description:active.length ? 'Événements du tour du leader, identiques pour tous les pilotes. Les zones colorées indiquent leurs effets sur la route.' : 'Aucun événement programmé pendant ce tour du leader.',
      weather:weather ?? 'clear',branches:[],blockers:[],zones};
    events.set(key,result); return result;
  }
  const active = currentLevel >= 2 && currentStage >= 1;
  const name = track.theme === 'ice' ? 'Avalanche' : track.theme === 'canyon' ? 'Éboulement'
    : track.theme === 'volcano' ? 'Coulée volcanique' : track.theme === 'sky' ? 'Tempête'
      : track.theme === 'foundry' ? 'Incident industriel' : track.theme === 'castle' ? 'Pont coupé'
        : track.theme === 'neon' ? 'Route coupée' : 'Inondation';
  const result: TrackEventInfo = { trackId: track.id, stage: currentStage, level: currentLevel,
    title: currentLevel === 0 ? 'Circuit classique' : active ? currentStage === 2 ? name + ' · raccourci ouvert' : name + ' · suivez la déviation'
      : currentStage === 2 ? 'Raccourci ouvert' : 'Choisissez votre route',
    description: currentLevel === 0 ? getTrackLapCount(track.id) === 3 ? 'La piste reste identique pendant les trois tours.' : `La piste reste identique pendant ${getTrackLapCount(track.id)} ${getTrackLapCount(track.id)===1?'tour':'tours'}.` : active
      ? currentStage === 2 ? 'La route principale reste barrée. Le raccourci intérieur, plus court que la route normale, est ouvert.'
        : 'Une section de la route est barrée pour tous les pilotes. La voie extérieure large contourne les débris.'
      : currentStage === 2 ? 'Un raccourci large s’ouvre. La route normale, la déviation et la voie turbo restent disponibles.'
        : 'La déviation large donne des objets ; la voie turbo offre une accélération avec une courte zone glissante annoncée.',
    weather: active ? currentLevel === 3 && currentStage === 2 ? 'storm' : track.theme === 'ice' ? 'snow'
      : ['canyon', 'volcano', 'foundry'].includes(track.theme) ? 'ash' : 'rain' : 'clear',
    branches: currentLevel === 0 ? [] : layout(track.id).branches.map(route => ({ ...route,
      open: route.kind !== 'shortcut' || currentStage >= 2 })),
    blockers: active ? [layout(track.id).blocker] : [] };
  events.set(key, result);
  return result;
}

/** A rail opening exists only for a branch actually open in the current race. */
export function trackBoundaryGap(x: number, z: number, trackId: string, stage = 0, level = 0): boolean {
  return getTrackEvent(trackId, stage, level).branches.some(branch => branch.open && branch.points.some(point =>
    Math.hypot(point.x - x, point.z - z) < branch.width / 2 + 2));
}

function branchSurface(route: TrackBranch, progress: number): Surface {
  const t = (progress - route.start) / (route.end - route.start);
  if (route.kind === 'technical') return t > .2 && t < .35 ? 'boost' : t > .6 && t < .7 ? 'ice' : 'road';
  return 'road';
}

export function nearestDriveableTrack(x: number, z: number, trackId: string, stage = 0, level = 0,
  hint?: { progress?: number; elevation?: number }): DriveablePosition {
  const track = getTrack(trackId), base = nearestTrack(x, z, track.id, hint);
  let result: DriveablePosition = { ...base, width: track.width, branchId: '', surface: trackSurface(x, z, track.id, base).surface };
  // Keep the main surface where ribbons join, unless the branch centre is closer.
  for (const route of getTrackEvent(track.id, stage, level).branches) {
    if (!route.open) continue;
    // A branch can only replace the current answer from closer than it, or from within its own width.
    if (branchReach(route, x, z) > Math.max(result.distance, route.width / 2)) continue;
    for (let index = 0; index < route.points.length - 1; index++) {
      const a = route.points[index]!, b = route.points[index + 1]!;
      const dx = b.x - a.x, dz = b.z - a.z;
      const fraction = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
      const px = a.x + dx * fraction, pz = a.z + dz * fraction, distance = Math.hypot(x - px, z - pz);
      const inside = distance <= route.width / 2, resultInside = result.distance <= result.width / 2;
      // The driveable area is the union of road ribbons. A nearby narrow branch
      // cannot turn the outer lane of the wider main road into offroad terrain.
      if ((!inside && resultInside) || (inside === resultInside && distance >= result.distance)) continue;
      const progress = a.progress + (b.progress - a.progress) * fraction;
      result = { x: px, z: pz, distance, progress, index, angle: a.angle, width: route.width,
        branchId: route.id, surface: distance <= route.width / 2 ? branchSurface(route, progress) : 'offroad' };
    }
  }
  return result;
}

export function dynamicSurface(x: number, z: number, trackId: string, stage = 0, level = 0,
  near = nearestDriveableTrack(x, z, trackId, stage, level)): { surface: Surface; zone?: TrackZone } {
  const track = getTrack(trackId), event = getTrackEvent(track.id, stage, level);
  if (near.branchId) {
    const route = event.branches.find(candidate => candidate.id === near.branchId)!;
    return { surface: near.surface, zone: near.surface === 'boost' ? {
      id: route.id + '-boost', kind: 'boost', start: route.start, end: route.end, offset: 0, width: route.width,
    } : undefined };
  }
  const contact = trackSurface(x, z, track.id, near);
  const scriptedZone = event.zones?.find(zone=>near.progress>=zone.start && near.progress<=zone.end);
  if (scriptedZone && contact.surface!=='offroad') return {surface:scriptedZone.kind,zone:scriptedZone};
  if (track.id.startsWith('custom-') || event.level < 2 || event.stage < 1 || contact.surface !== 'road') return contact;
  const fraction = near.progress / track.length;
  if ((fraction > .51 && fraction < .565) || (event.level === 3 && event.stage === 2 && fraction > .86 && fraction < .90))
    return { surface: track.theme === 'ice' ? 'ice' : 'mud' };
  return contact;
}

/** Ordinary CPU guidance; progress is still earned by crossing the real gates. */
export function eventRoutePoint(progress: number, trackId: string, stage = 0, level = 0): Vec2 & { angle: number } {
  const track = getTrack(trackId), event = getTrackEvent(track.id, stage, level);
  const wrapped = ((progress % track.length) + track.length) % track.length;
  if (event.blockers.length) {
    const route = event.branches.find(candidate => candidate.kind === 'detour')!;
    if (wrapped >= route.start && wrapped <= route.end) return pointOnBranch(route, wrapped);
  }
  return trackPoint(wrapped, track.id);
}

export function pointOnBranch(route: TrackBranch, progress: number): Vec2 & { angle: number } {
  const value = Math.max(route.start, Math.min(route.end, progress));
  let low = 0, high = route.points.length - 2;
  while (low < high) { const middle = (low + high) >>> 1; if (route.points[middle + 1]!.progress < value) low = middle + 1; else high = middle; }
  const a = route.points[low]!, b = route.points[low + 1]!, fraction = (value - a.progress) / (b.progress - a.progress);
  return { x: a.x + (b.x - a.x) * fraction, z: a.z + (b.z - a.z) * fraction, angle: a.angle };
}

/** Physical alternatives for one ordered checkpoint, never a free progress grant. */
export function eventCheckpointGates(trackId: string, checkpointIndex: number, stage = 0, level = 0): EventCheckpointGate[] {
  const track = getTrack(trackId), checkpoint = track.checkpoints[checkpointIndex];
  if (!checkpoint) return [];
  const gates: EventCheckpointGate[] = [{ ...checkpoint, width: track.width, branchId: '' }];
  for (const route of getTrackEvent(track.id, stage, level).branches) if (route.open && checkpoint.progress > route.start && checkpoint.progress < route.end)
    gates.push({ ...pointOnBranch(route, checkpoint.progress), progress: checkpoint.progress, width: route.width, branchId: route.id });
  return gates;
}

export function trackEventPickups(trackId: string, stage = 0, level = 0): Array<Vec2 & { id: string; cooldown: number; progress: number; elevation: number }> {
  const route = getTrackEvent(trackId, stage, level).branches.find(candidate => candidate.kind === 'detour');
  if (!route) return [];
  return [.36, .76].map((fraction, index) => {
    const progress = route.start + (route.end - route.start) * fraction;
    return { ...pointOnBranch(route, progress), progress, elevation: trackElevation(progress, trackId),
      id: route.id + '-pickup-' + index, cooldown: 0 };
  });
}

/** Swept finite box: fast motion is blocked only while its vertical span overlaps. */
export function constrainTrackEvent(x: number, z: number, previousX: number, previousZ: number, speed: number,
  trackId: string, stage = 0, level = 0, vertical?: { previous: number; current: number }): { x: number; z: number; speed: number; blocked: boolean } {
  for (const blocker of getTrackEvent(trackId, stage, level).blockers) {
    const sine = Math.sin(blocker.angle), cosine = Math.cos(blocker.angle);
    const local = (px: number, pz: number) => ({ along: (px - blocker.x) * sine + (pz - blocker.z) * cosine,
      across: (px - blocker.x) * cosine - (pz - blocker.z) * sine });
    const a = local(previousX, previousZ), b = local(x, z);
    const halfLength = blocker.halfLength + .95, halfWidth = blocker.halfWidth + .95;
    const fromY = vertical?.previous ?? blocker.elevation, toY = vertical?.current ?? blocker.elevation;
    const bottom = blocker.elevation - KART_COLLISION_HEIGHT, top = blocker.elevation + blocker.height;
    if (Math.abs(a.along) < halfLength && Math.abs(a.across) < halfWidth && toY < top && toY > bottom) {
      // A phase can change while a kart occupies this tile. Eject to the closest
      // longitudinal face, instead of trapping the kart inside the new debris.
      const along = Math.sign(a.along || b.along || 1) * (halfLength + .05);
      return { x: blocker.x + sine * along + cosine * a.across,
        z: blocker.z + cosine * along - sine * a.across, speed: 0, blocked: true };
    }
    let entry = 0, exit = 1;
    for (const [start, end, low, high] of [[a.along, b.along, -halfLength, halfLength], [a.across, b.across, -halfWidth, halfWidth], [fromY, toY, bottom, top]]) {
      const delta = end - start;
      if (Math.abs(delta) < 1e-9) { if (start < low || start > high) { entry = 2; break; } continue; }
      const first = (low - start) / delta, second = (high - start) / delta;
      entry = Math.max(entry, Math.min(first, second)); exit = Math.min(exit, Math.max(first, second));
    }
    if (entry <= exit && entry >= 0 && entry <= 1) {
      const fraction = Math.max(0, entry - .002);
      return { x: previousX + (x - previousX) * fraction, z: previousZ + (z - previousZ) * fraction, speed: 0, blocked: true };
    }
  }
  return { x, z, speed, blocked: false };
}
