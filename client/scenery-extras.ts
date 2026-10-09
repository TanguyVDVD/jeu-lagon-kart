import * as THREE from 'three';
import { buildSceneryWorld } from './scenery-world';
import { terrainHeight } from './scenery-terrain';
import { BRIDGE_RAIL_THICKNESS, BRIDGE_RAIL_CENTER_Y, BRIDGE_SHOULDER } from '../shared/obstacle-heights';
import { trackElevation, trackPoint, type TrackDefinition, type TrackElevation } from '../shared/track';
import { trackBoundaryGap } from '../shared/track-events';
import { crossingSupportClear } from './track-crossings';

// Original scenery plus the optional Kenney CC0 tree; no external runtime requests.
// Materials survive track changes; geometry belongs to this group and can be batched/disposed.
const materials = new Map<string, THREE.MeshStandardMaterial>();
function mat(color: string, glow = false) {
  const key = `${color}:${glow}`;
  let material = materials.get(key);
  if (!material) {
    material = new THREE.MeshStandardMaterial({ color, roughness: .88,
      emissive: glow ? color : '#000000', emissiveIntensity: glow ? .32 : 0 });
    materials.set(key, material);
  }
  return material;
}
export function hasExtraScenery(track: TrackDefinition): boolean {
  return Boolean(track.theme);
}

/** Add before GameRenderer.batchScenery(). The renderer draws the road at trackElevation().
 * `parts` separates the bridges and ramps, whose parapets open with the branches,
 * from the landscape that never changes during a race. */
export function buildTrackExtras(track: TrackDefinition, eventStage = 0, eventLevel = 3, parts: 'all' | 'structures' | 'world' = 'all'): THREE.Group {
  const result = new THREE.Group(); result.name = `scenery-${track.id}`;
  result.userData.theme = track.theme; result.userData.structures = [] as string[];
  if (!hasExtraScenery(track)) return result;
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const cone = new THREE.ConeGeometry(1, 1, 8);
  const vectorY = new THREE.Vector3(0, 1, 0);
  const add = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, color: string,
    x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, glow = false) => {
    const mesh = new THREE.Mesh(geometry, mat(color, glow));
    mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz);
    mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
  };
  const box = (parent: THREE.Object3D, color: string, x: number, y: number, z: number, sx: number, sy: number, sz: number) =>
    add(parent, boxGeometry, color, x, y, z, sx, sy, sz);
  const beam = (parent: THREE.Object3D, color: string, a: THREE.Vector3, b: THREE.Vector3, width: number) => {
    const direction = new THREE.Vector3().subVectors(b, a);
    const mesh = box(parent, color, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, width, direction.length(), width);
    mesh.quaternion.setFromUnitVectors(vectorY, direction.normalize()); return mesh;
  };
  const group = (name: string, x = 0, z = 0) => {
    const item = new THREE.Group(); item.name = name; item.position.set(x, 0, z);
    result.add(item); (result.userData.structures as string[]).push(name); return item;
  };
  const roadPosition = (progress: number, offset = 0, height = 0) => {
    const point = trackPoint(progress, track.id);
    return new THREE.Vector3(point.x + Math.cos(point.angle) * offset,
      trackElevation(progress, track.id) + height, point.z - Math.sin(point.angle) * offset);
  };
  const ground = terrainHeight(track);
  const branchGap = (point: THREE.Vector3) => trackBoundaryGap(point.x, point.z, track.id, eventStage, eventLevel);
  const structural = track.theme === 'forest' ? '#826043' : track.theme === 'castle' ? '#a4a598'
    : track.theme === 'sky' ? '#ae99be' : track.theme === 'volcano' ? '#45484c' : '#526e76';
  const trim = track.theme === 'forest' ? '#c4a56d' : track.theme === 'castle' ? '#c9c5b4' : track.palette.accent;

  function bridge(feature: TrackElevation) {
    const bridge = group(feature.id);
    const steps = Math.ceil((feature.end - feature.start) / 5);
    for (let i = 0; i < steps; i++) {
      const aProgress = feature.start + (feature.end - feature.start) * i / steps;
      const bProgress = feature.start + (feature.end - feature.start) * (i + 1) / steps;
      const a = roadPosition(aProgress), b = roadPosition(bProgress);
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const deck = box(bridge, structural, (a.x + b.x) / 2, (a.y + b.y) / 2 - .35,
        (a.z + b.z) / 2, track.width + BRIDGE_SHOULDER * 2, .5, length + .1);
      deck.rotation.set(-Math.atan2(b.y - a.y, length), Math.atan2(b.x - a.x, b.z - a.z), 0, 'YXZ');
      for (const side of [-1, 1]) {
        const offset = side * (track.width / 2 + BRIDGE_SHOULDER);
        const railA = roadPosition(aProgress, offset, BRIDGE_RAIL_CENTER_Y), railB = roadPosition(bProgress, offset, BRIDGE_RAIL_CENTER_Y);
        const railMiddle = new THREE.Vector3().addVectors(railA, railB).multiplyScalar(.5);
        if (branchGap(railA) || branchGap(railB) || branchGap(railMiddle)) continue;
        beam(bridge, trim, railA, railB, BRIDGE_RAIL_THICKNESS);
        const foot = roadPosition(aProgress, offset, -.15);
        beam(bridge, structural, foot, railA, BRIDGE_RAIL_THICKNESS);
        if (i % 2 === 0 && a.y > 1.3) {
          const post = roadPosition(aProgress, offset, -.45);
          if (crossingSupportClear(track, post.x, post.z, -1.4, post.y))
            box(bridge, structural, post.x, (post.y - 1.4) / 2, post.z, 1.2, post.y + 1.4, 1.2);
          if (track.theme === 'harbor' || track.theme === 'foundry')
            beam(bridge, trim, roadPosition(aProgress, offset, .2), roadPosition(bProgress, offset, BRIDGE_RAIL_CENTER_Y), .18);
        }
      }
    }
    const middle = (feature.start + feature.end) / 2, p = trackPoint(middle, track.id);
    if (track.theme !== 'sky') {
      // Water/lava is below the elevated deck and never obscures the road.
      const river = box(bridge, track.theme === 'volcano' ? '#f19a47' : track.palette.water,
        p.x, ground(p.x, p.z) + .12, p.z, track.width + 38, .035, 24);
      river.rotation.y = p.angle; river.castShadow = false;
    }
  }
  function jump(feature: TrackElevation) {
    const ramp = group(feature.id), steps = Math.ceil((feature.end - feature.start) / 2);
    // Side supports reveal the genuine ramp height, with no invisible jump trigger elsewhere.
    for (let i = 0; i < steps; i++) {
      const progress = feature.start + (feature.end - feature.start) * (i + .5) / steps;
      const p = trackPoint(progress, track.id), y = trackElevation(progress, track.id);
      for (const side of [-1, 1]) {
        const sx = p.x + Math.cos(p.angle) * side * (track.width / 2 + .9), sz = p.z - Math.sin(p.angle) * side * (track.width / 2 + .9);
        if (!crossingSupportClear(track, sx, sz, 0, y - .7)) continue;
        const support = box(ramp, structural, p.x + Math.cos(p.angle) * side * (track.width / 2 + .9),
          y / 2, p.z - Math.sin(p.angle) * side * (track.width / 2 + .9), 1.1, Math.max(.05, y), 2.1);
        support.rotation.y = p.angle;
      }
    }
    for (let progress = feature.start + 3; progress < feature.end - 2; progress += 5) {
      const p = trackPoint(progress, track.id), arrows = new THREE.Group();
      arrows.position.copy(roadPosition(progress, 0, .13)); arrows.rotation.set(-Math.atan2(feature.height, feature.end - feature.start), p.angle, 0, 'YXZ');
      for (const lane of [-5, 0, 5]) for (const side of [-1, 1]) {
        const arrow = box(arrows, '#fff2b1', lane + side * .55, 0, 0, .28, .04, 1.55);
        arrow.rotation.y = -side * .65;
      }
      ramp.add(arrows);
    }
    for (const side of [-1, 1]) {
      const p = roadPosition(feature.end, side * (track.width / 2 + 2.2));
      box(ramp, structural, p.x, p.y + 1.5, p.z, .25, 3, .25);
      const flag = box(ramp, trim, p.x, p.y + 2.5, p.z, 1.7, .7, .15);
      flag.rotation.y = trackPoint(feature.end, track.id).angle;
      // The landing zone is clear; only small markers sit outside the full road width.
      const landing = roadPosition(feature.end + 42, side * (track.width / 2 + 2));
      add(ramp, cone, trim, landing.x, landing.y + .8, landing.z, .55, 1.6, .55);
    }
  }
  if (parts !== 'world') for (const feature of track.elevations) feature.kind === 'bridge' ? bridge(feature) : jump(feature);
  if (parts !== 'structures') {
    // Landmarks and vegetation stand on the hills instead of the old flat floor.
    const world = buildSceneryWorld(track);
    for (const item of world.children) item.position.y += ground(item.position.x, item.position.z);
    result.add(world);
  }
  return result;
}
