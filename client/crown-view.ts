import * as THREE from 'three';
import type { Kart, World } from '../shared/game';
import { groundLift } from '../shared/road-pose';

/** Two lightweight meshes track the authoritative holder. */
export class CrownView {
  private readonly group = new THREE.Group();
  private readonly protection: THREE.Mesh;

  constructor(scene: THREE.Scene) {
    const vertices: number[] = [];
    for (let index = 0; index < 16; index++) {
      const a = index / 16 * Math.PI * 2, b = (index + 1) / 16 * Math.PI * 2;
      const x1 = Math.sin(a) * .7, z1 = Math.cos(a) * .7, x2 = Math.sin(b) * .7, z2 = Math.cos(b) * .7;
      const y1 = index % 2 ? .75 : .25, y2 = index % 2 ? .25 : .75;
      vertices.push(x1, 0, z1, x2, 0, z2, x1, y1, z1, x1, y1, z1, x2, 0, z2, x2, y2, z2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.computeVertexNormals();
    const crown = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: '#ffce50', side: THREE.DoubleSide }));
    this.protection = new THREE.Mesh(new THREE.TorusGeometry(.95, .06, 4, 24), new THREE.MeshBasicMaterial({ color: '#fff4bf', transparent: true, opacity: .8 }));
    this.protection.rotation.x = Math.PI / 2;
    this.group.add(crown, this.protection); this.group.visible = false; scene.add(this.group);
  }

  update(world: World | null, players: readonly Kart[], now: number) {
    const state = world?.crown, holder = state && players.find(kart => kart.id === state.holderId);
    this.group.visible = !!holder && world?.phase === 'racing';
    if (!holder || !world || !state) return;
    this.group.position.set(holder.x, holder.elevation + groundLift(holder.x, holder.z, holder.trackId) + 3.3 + Math.sin(now * .004) * .12, holder.z);
    this.group.rotation.y = now * .001;
    this.protection.visible = world.raceTime < state.protectedUntil;
  }
}
