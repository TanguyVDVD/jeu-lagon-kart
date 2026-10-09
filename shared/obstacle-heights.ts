import { getTrack, trackElevation, reliefElevation, type TrackDefinition } from './track.js';
import { automaticTrackElevation } from './track-crossings.js';

/** Metres above the local road; shared with the procedural renderers. */
export const ROAD_RAIL_HEIGHT = .6;
export const ROAD_RAIL_CENTER_Y = .42;
export const ROAD_RAIL_TOP = ROAD_RAIL_CENTER_Y + ROAD_RAIL_HEIGHT / 2;
export const BRIDGE_RAIL_THICKNESS = .24;
export const BRIDGE_RAIL_CENTER_Y = 1.1;
export const BRIDGE_RAIL_TOP = BRIDGE_RAIL_CENTER_Y + BRIDGE_RAIL_THICKNESS / 2;
export const BRANCH_POST_HEIGHT = .65;
export const TRACK_SHOULDER = 5;
export const BRIDGE_SHOULDER = 1.5;
export const KART_COLLISION_HEIGHT = 1.8;

const upperDeckRanges = new WeakMap<TrackDefinition, Array<{ start: number; end: number }>>();
function onUpperDeck(wrapped: number, track: TrackDefinition): boolean {
  if (!track.crossings?.length) return false;
  let ranges = upperDeckRanges.get(track);
  if (!ranges) {
    const intervals = track.crossings.flatMap(crossing => {
      const span = crossing.upperEnd - crossing.upperStart;
      const start = ((crossing.upperStart % track.length) + track.length) % track.length, end = start + span;
      return end <= track.length ? [{ start, end }] : [{ start, end: track.length }, { start: 0, end: end - track.length }];
    }).sort((a, b) => a.start - b.start);
    ranges = [];
    for (const interval of intervals) {
      const previous = ranges[ranges.length - 1];
      if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
      else ranges.push({ ...interval });
    }
    upperDeckRanges.set(track, ranges);
  }
  let low = 0, high = ranges.length;
  while (low < high) { const middle = (low + high) >>> 1; if (ranges[middle]!.start <= wrapped) low = middle + 1; else high = middle; }
  return low > 0 && wrapped <= ranges[low - 1]!.end;
}

export function isBridgeProgress(progress: number, trackId: string): boolean {
  const track = getTrack(trackId), remainder = progress % track.length;
  const wrapped = remainder < 0 ? remainder + track.length : remainder;
  return automaticTrackElevation(progress, track) > .02 || onUpperDeck(wrapped, track) ||
    track.elevations.some(feature => feature.kind === 'bridge' && wrapped >= feature.start && wrapped <= feature.end);
}
export function trackBoundaryHeight(progress: number, trackId: string, branchId = ''): number {
  return branchId ? BRANCH_POST_HEIGHT : isBridgeProgress(progress, trackId) ? BRIDGE_RAIL_TOP : ROAD_RAIL_TOP;
}
export function trackBoundaryShoulder(progress: number, trackId: string, branchId = ''): number {
  return !branchId && isBridgeProgress(progress, trackId) ? BRIDGE_SHOULDER : TRACK_SHOULDER;
}
export function driveableGroundHeight(position: { progress: number; distance: number; width: number; branchId: string }, trackId: string, elevation = Infinity): number {
  const height = trackElevation(position.progress, trackId);
  // A kart can climb the continuous approaches, but driving under a high deck
  // must not lift it onto that deck. One metre exceeds the steepest permitted
  // rise per bounded physics step, including the compressed branch routes.
  return height <= elevation + 1 && position.distance <= position.width / 2 + trackBoundaryShoulder(position.progress, trackId, position.branchId) + .02
    ? height : reliefElevation(position.progress, getTrack(trackId));
}
export function trackBlockerHeight(trackId: string): number {
  const theme = getTrack(trackId).theme;
  return theme === 'tropical' || theme === 'neon' ? 1.6 : 2.4;
}
