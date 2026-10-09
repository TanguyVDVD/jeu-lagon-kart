import * as THREE from 'three';
import type { TrackZone } from '../shared/track';
import { roadPose } from '../shared/road-pose';
import { roadMeshRows } from './track-mesh-sampling';

/** Permanent and lap-triggered zones follow the same road, slopes and banking included. */
export function trackZoneGeometry(trackId: string, zone: Pick<TrackZone, 'start' | 'end' | 'width' | 'offset'>, lift = .085) {
  const vertices: number[] = [], indices: number[] = [];
  const pieces = roadMeshRows(zone.end - zone.start);
  for (let i = 0; i <= pieces; i++) {
    const progress = zone.start + (zone.end - zone.start) * i / pieces;
    for (const side of [-1, 1]) {
      const pose = roadPose(progress, trackId, zone.offset + side * zone.width / 2);
      vertices.push(pose.x, pose.y + lift, pose.z);
    }
    if (i < pieces) { const a = i * 2, b = a + 2; indices.push(a, b, a + 1, a + 1, b, b + 1); }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}
