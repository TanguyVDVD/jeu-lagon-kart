import { getTrack, nearestTrack, trackBank, trackElevation, trackPoint, trackSlope, type TrackDefinition } from './track.js';
import { TRACK_SHOULDER } from './obstacle-heights.js';

export interface Vec3 { x: number; y: number; z: number }
/** Orthonormal frame of the road surface at one point: its slope along the route
 * and the visual banking of its bends. */
export interface RoadPose extends Vec3 { angle: number; right: Vec3; up: Vec3; tangent: Vec3 }

/** Height added by a banked bend, `lateral` metres to the right of the centre
 * line. It fades out beyond the shoulder so branches and the verge join level ground. */
export function bankLift(progress: number, lateral: number, track: TrackDefinition): number {
  const bank = trackBank(progress, track);
  if (!bank) return 0;
  const edge = track.width / 2 + TRACK_SHOULDER, distance = Math.abs(lateral);
  return bank * lateral * (distance <= edge ? 1 : Math.max(0, 1 - (distance - edge) / 10) * edge / distance);
}

/** Banking under any point near the main road: karts, items and branch ribbons
 * all rest on the same tilted surface. */
export function groundLift(x: number, z: number, trackId: string, hint?: { progress?: number; elevation?: number }): number {
  const track = getTrack(trackId);
  if (track.id.startsWith('custom-')) return 0;
  const near = nearestTrack(x, z, track.id, hint);
  return bankLift(near.progress, (x - near.x) * Math.cos(near.angle) - (z - near.z) * Math.sin(near.angle), track);
}

export function roadPose(progress: number, trackId: string, lateral = 0): RoadPose {
  const track = getTrack(trackId), point = trackPoint(progress, track.id);
  const slope = trackSlope(progress, track.id), bank = trackBank(progress, track);
  const sine = Math.sin(point.angle), cosine = Math.cos(point.angle);
  const along = Math.hypot(1, slope), across = Math.hypot(1, bank);
  const tangent = { x: sine / along, y: slope / along, z: cosine / along };
  const right = { x: cosine / across, y: bank / across, z: -sine / across };
  const up = { x: tangent.y * right.z - tangent.z * right.y, y: tangent.z * right.x - tangent.x * right.z,
    z: tangent.x * right.y - tangent.y * right.x };
  const length = Math.hypot(up.x, up.y, up.z);
  return { x: point.x + cosine * lateral, y: trackElevation(progress, track.id) + bankLift(progress, lateral, track),
    z: point.z - sine * lateral, angle: point.angle, tangent, right, up: { x: up.x / length, y: up.y / length, z: up.z / length } };
}
