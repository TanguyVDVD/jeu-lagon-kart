import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Kart } from '../shared/game';
import { DEFAULT_KART_MODEL, getKartModel, KART_MODELS, normalizeKartModelId, type KartModelId } from '../shared/kart-catalog';
import { DEFAULT_CHARACTER, normalizeCharacterId, type CharacterId } from '../shared/characters';
import { addCartoonDriver } from './kart-character';

export const KART_MODEL_URL = getKartModel(DEFAULT_KART_MODEL).url;
const WHEEL_NAMES = ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR'] as const;
type WheelName = typeof WHEEL_NAMES[number];
type PreparedKart = { root: THREE.Group; source: 'asset' | 'fallback'; geometries: Set<THREE.BufferGeometry>; radius: number;
  meshCount: number; triangles: number; bounds: { x: number; y: number; z: number } };
type WheelRig = { pivot: THREE.Group; spin: THREE.Object3D; front: boolean; radius: number; angle: number };

type ModelState = { promise?: Promise<PreparedKart>; status: 'idle' | 'loading' | 'ready' | 'failed';
  loadCount: number; error: string | null; prepared?: PreparedKart };
const modelStates = new Map<KartModelId, ModelState>(KART_MODELS.map(model =>
  [model.id, { status: 'idle', loadCount: 0, error: null }]));
let fallbackTemplate: PreparedKart | undefined;
const characterTemplates = new WeakMap<PreparedKart, Map<CharacterId, PreparedKart>>();
const sharedGeometry = new Set<THREE.BufferGeometry>();
const activeInstances = new Set<KartModelInstance>();
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const paintName = (name: string) => name === 'KartPaint' || name === 'DriverPaint';

/** A fresh diagnostic object exposes no mutable scene objects to the UI. */
export function kartAssetDiagnostics() {
  const instances = [...activeInstances];
  const models = Object.fromEntries(KART_MODELS.map(model => {
    const state = modelStates.get(model.id)!;
    const matching = instances.filter(instance => instance.modelId === model.id);
    return [model.id, { status: state.status, loadCount: state.loadCount, modelUrl: model.url, error: state.error,
      instanceCount: matching.length, importedCount: matching.filter(instance => instance.source === 'asset').length,
      fallbackCount: matching.filter(instance => instance.source === 'fallback').length,
      characters: [...new Set(matching.map(instance => instance.characterId))],
      sourceMeshCount: state.prepared?.meshCount ?? 0, sourceTriangles: state.prepared?.triangles ?? 0,
      sourceBounds: { ...(state.prepared?.bounds ?? { x: 0, y: 0, z: 0 }) } }];
  }));
  const requested = [...modelStates.values()].filter(state => state.status !== 'idle');
  const status = requested.some(state => state.status === 'loading') || requested.length === 0 ? 'loading'
    : requested.some(state => state.status === 'failed') ? 'failed' : 'ready';
  const primary = modelStates.get(DEFAULT_KART_MODEL)!.prepared ?? requested.find(state => state.prepared)?.prepared;
  return Object.freeze({
    status, loadCount: requested.reduce((total, state) => total + state.loadCount, 0), modelUrl: KART_MODEL_URL,
    error: requested.find(state => state.error)?.error ?? null, models,
    instanceCount: instances.length,
    importedCount: instances.filter(instance => instance.source === 'asset').length,
    fallbackCount: instances.filter(instance => instance.source === 'fallback').length,
    sharedGeometryCount: sharedGeometry.size,
    paintMaterialCount: instances.reduce((count, instance) => count + instance.paintMaterialCount, 0),
    sourceMeshCount: primary?.meshCount ?? 0, sourceTriangles: primary?.triangles ?? 0,
    sourceBounds: { ...(primary?.bounds ?? { x: 0, y: 0, z: 0 }) },
  });
}

function standard(name: string, color: string, roughness: number, metalness = 0) {
  const material = new THREE.MeshStandardMaterial({ color, roughness, metalness });
  material.name = name;
  return material;
}

function addMesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material,
  position: [number, number, number], scale: [number, number, number] = [1, 1, 1]) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position); mesh.scale.set(...scale);
  mesh.castShadow = false; mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/** Original, lightweight driver: a seated suit, rounded helmet and dark visor. */
function addDriver(root: THREE.Group, body: THREE.Object3D, fallback: boolean) {
  const driver = new THREE.Group();
  driver.name = 'LagonDriver'; driver.userData.role = 'driver';
  root.updateMatrixWorld(true);
  const seatMarker = root.getObjectByName('SeatMount');
  const seat = seatMarker ? body.worldToLocal(seatMarker.getWorldPosition(new THREE.Vector3())) : undefined;
  driver.position.set(seat?.x ?? 0, seat ? seat.y + 0.11 : 0.86, seat?.z ?? -0.22);
  const size = fallback ? 1 : 0.82;
  driver.scale.setScalar(size);
  body.add(driver);
  const paint = standard('DriverPaint', '#ffffff', 0.62, 0.02);
  const helmet = standard('KartPaint', '#ffffff', 0.3, 0.16);
  const dark = standard('DriverGloves', '#25333b', 0.8);
  const visor = standard('DriverVisor', '#102d39', 0.2, 0.32);
  const cream = standard('DriverTrim', '#fff3d6', 0.6);
  const sphere = new THREE.SphereGeometry(1, 14, 10);
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const limb = new THREE.CylinderGeometry(0.12, 0.105, 1, 8);
  const steeringMarker = root.getObjectByName('SteeringMount');
  const steering = steeringMarker ? body.worldToLocal(steeringMarker.getWorldPosition(new THREE.Vector3())) : undefined;
  const armSegment = (a: THREE.Vector3, b: THREE.Vector3) => {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const direction = b.clone().sub(a);
    const arm = addMesh(driver, limb, paint, [mid.x, mid.y, mid.z], [1, direction.length(), 1]);
    arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  };
  addMesh(driver, sphere, paint, [0, 0.36, -0.08], [0.34, 0.44, 0.29]);
  addMesh(driver, sphere, dark, [0, 0.08, 0.09], [0.36, 0.19, 0.36]);
  for (const side of [-1, 1]) {
    const thigh = addMesh(driver, sphere, paint, [side * 0.2, 0.06, 0.35], [0.17, 0.16, 0.38]);
    thigh.rotation.x = -0.18;
    addMesh(driver, sphere, dark, [side * 0.23, -0.015, 0.66], [0.17, 0.11, 0.22]);
    const hand = steering ? new THREE.Vector3(side * 0.245 / size, (steering.y - 0.11 - driver.position.y) / size,
      (steering.z - 0.045 - driver.position.z) / size) : new THREE.Vector3(side * 0.29, 0.38, 0.43);
    const shoulder = new THREE.Vector3(side * 0.28, 0.57, -0.015);
    const elbow = new THREE.Vector3(side * 0.38, (shoulder.y + hand.y) * 0.5 - 0.13, hand.z * 0.52);
    armSegment(shoulder, elbow); armSegment(elbow, hand);
    addMesh(driver, sphere, dark, [hand.x, hand.y, hand.z], [0.14, 0.12, 0.13]);
  }
  const head = new THREE.Group(); head.name = 'CharacterHead'; head.position.set(0, 0.97, -0.02); driver.add(head);
  addMesh(head, sphere, helmet, [0, 0, 0], [0.42, 0.44, 0.43]);
  const visorGeometry = new THREE.SphereGeometry(1, 16, 6, -0.84, 1.68, 0.96, 0.76);
  const visorMesh = addMesh(head, visorGeometry, visor, [0, 0.015, 0.015], [0.433, 0.45, 0.44]);
  // SphereGeometry's phi=0 patch faces -X; turn it toward the kart's +Z.
  visorMesh.rotation.y = Math.PI / 2;
  addMesh(head, cube, cream, [0, 0.37, 0.06], [0.085, 0.04, 0.44]);
  addMesh(driver, cube, cream, [0, 0.4, 0.205], [0.075, 0.44, 0.025]);
  // Merge each rigid part separately so the helmet can react to bumps/victory.
  root.updateMatrixWorld(true);
  for (const rigid of [driver, head]) {
    const inverse = rigid.matrixWorld.clone().invert();
    const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const originals: THREE.Mesh[] = [];
    rigid.traverse(object => {
      if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
      if (rigid === driver) {
        let ancestor: THREE.Object3D | null = object.parent;
        while (ancestor && ancestor !== driver) { if (ancestor === head) return; ancestor = ancestor.parent; }
      }
      const geometry = object.geometry.clone();
      geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, object.matrixWorld));
      const batch = batches.get(object.material) ?? [];
      batch.push(geometry); batches.set(object.material, batch); originals.push(object);
    });
    for (const [material, geometries] of batches) {
      const merged = mergeGeometries(geometries)!;
      const mesh = addMesh(rigid, merged, material, [0, 0, 0]);
      mesh.name = material.name;
      for (const geometry of geometries) geometry.dispose();
    }
    for (const geometry of new Set(originals.map(mesh => mesh.geometry))) geometry.dispose();
    for (const mesh of originals) mesh.removeFromParent();
  }
}

const ANIMATED_PARTS = new Set<string>(['Body', ...WHEEL_NAMES, 'CharacterHead', 'CharacterMouth', 'CharacterBrows', 'CharacterWaveArm']);
/** Each part that moves on its own keeps one mesh per material: a kart costs
 * about ten draw calls instead of more than twenty. */
function mergeRigidParts(root: THREE.Group) {
  root.updateMatrixWorld(true);
  const batches = new Map<string, { owner: THREE.Object3D; material: THREE.Material; meshes: THREE.Mesh[] }>();
  root.traverse(node => {
    const object = node as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
    if (!(node instanceof THREE.Mesh) || 'isSkinnedMesh' in node || 'isInstancedMesh' in node || Array.isArray(node.material) ||
      ANIMATED_PARTS.has(object.name) || object.children.length || Object.keys(object.geometry.morphAttributes).length) return;
    let owner: THREE.Object3D = object.parent!;
    while (owner !== root && !ANIMATED_PARTS.has(owner.name)) owner = owner.parent!;
    const attributes = Object.keys(object.geometry.attributes).sort().map(name => name + object.geometry.attributes[name]!.itemSize).join(',');
    const key = owner.uuid + ':' + object.material.uuid + ':' + attributes;
    const batch = batches.get(key) ?? { owner, material: object.material, meshes: [] };
    batch.meshes.push(object); batches.set(key, batch);
  });
  for (const { owner, material, meshes } of batches.values()) {
    if (meshes.length < 2) continue;
    const inverse = owner.matrixWorld.clone().invert();
    const parts = meshes.map(mesh => {
      const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      return geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld));
    });
    const merged = mergeGeometries(parts);
    for (const part of parts) part.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material); mesh.name = material.name; owner.add(mesh);
    for (const original of meshes) original.removeFromParent();
  }
}

function prepare(root: THREE.Group, source: 'asset' | 'fallback', characterId: CharacterId = DEFAULT_CHARACTER): PreparedKart {
  const body = root.getObjectByName('Body');
  if (!body || WHEEL_NAMES.some(name => !root.getObjectByName(name))) throw new Error('Le modèle de kart ne contient pas ses pièces animables.');
  let paintFound = false;
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (paintName(material.name)) paintFound = true;
    }
  });
  if (!paintFound) throw new Error('Le modèle de kart ne contient pas sa peinture personnalisable.');
  if (characterId === 'racer') addDriver(root, body, source === 'fallback');
  else addCartoonDriver(root, body, characterId, source === 'fallback');
  mergeRigidParts(root);
  root.updateMatrixWorld(true);
  const dimensions = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  const wheelSize = new THREE.Box3().setFromObject(root.getObjectByName('Wheel_FL')!).getSize(new THREE.Vector3());
  const geometries = new Set<THREE.BufferGeometry>();
  let meshCount = 0, triangles = 0;
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    // The blob under each kart is its shadow: karts stay out of the sun's
    // shadow map, which is then rendered once per circuit instead of every frame.
    object.castShadow = false; object.receiveShadow = true;
    geometries.add(object.geometry); sharedGeometry.add(object.geometry);
    meshCount += 1; triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      if (material.name === 'KartPaint') { material.roughness = 0.38; material.metalness = 0.18; }
      else if (/rubber|tyre|tire/i.test(material.name)) { material.roughness = 0.92; material.metalness = 0; }
    }
  });
  return { root, source, geometries, radius: clamp((wheelSize.y + wheelSize.z) / 4, 0.2, 0.9),
    meshCount, triangles: Math.round(triangles), bounds: { x: dimensions.x, y: dimensions.y, z: dimensions.z } };
}

/** Kept solely as a local fallback when the GLB fails to load or validate. */
function fallbackKart(): PreparedKart {
  if (fallbackTemplate) return fallbackTemplate;
  const root = new THREE.Group(), body = new THREE.Group(); body.name = 'Body'; root.add(body);
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const paint = standard('KartPaint', '#ffffff', 0.45, 0.08);
  const cream = standard('FallbackTrim', '#f4eacb', 0.78);
  const dark = standard('FallbackChassis', '#173a43', 0.75);
  addMesh(body, cube, paint, [0, 0.75, 0], [1.9, 0.65, 3.1]);
  addMesh(body, cube, cream, [0, 0.5, 1.55], [2.1, 0.35, 0.4]);
  addMesh(body, cube, dark, [0, 0.6, -1.5], [2.2, 0.3, 0.35]);
  addMesh(body, cube, paint, [0, 1.1, -1.55], [2.4, 0.18, 0.65]);
  const tireGeometry = new THREE.CylinderGeometry(0.53, 0.53, 0.42, 12).rotateZ(Math.PI / 2);
  const hubGeometry = new THREE.CylinderGeometry(0.25, 0.25, 0.445, 8).rotateZ(Math.PI / 2);
  const rubber = standard('FallbackRubber', '#20282f', 0.95);
  const metal = standard('FallbackRims', '#b7c5c9', 0.28, 0.65);
  WHEEL_NAMES.forEach(name => {
    const wheel = new THREE.Group(); wheel.name = name;
    wheel.position.set(name.endsWith('L') ? 1.05 : -1.05, 0.53, name.includes('_F') ? 1 : -1);
    addMesh(wheel, tireGeometry, rubber, [0, 0, 0]);
    addMesh(wheel, hubGeometry, metal, [0, 0, 0]);
    root.add(wheel);
  });
  fallbackTemplate = prepare(root, 'fallback');
  return fallbackTemplate;
}

function loadKart(modelId: KartModelId): Promise<PreparedKart> {
  const state = modelStates.get(modelId)!;
  if (!state.promise) {
    state.loadCount += 1; state.status = 'loading';
    state.promise = new GLTFLoader().loadAsync(getKartModel(modelId).url).then(gltf => {
      const model = prepare(gltf.scene, 'asset');
      state.status = 'ready'; state.prepared = model;
      return model;
    }).catch(error => {
      state.status = 'failed';
      state.error = error instanceof Error ? error.message : String(error);
      console.warn('Le modèle de kart est indisponible ; le kart de secours local est utilisé.', error);
      state.prepared = fallbackKart();
      return state.prepared;
    });
  }
  return state.promise;
}

export class KartModelInstance {
  readonly group: THREE.Group;
  readonly source: 'asset' | 'fallback';
  readonly modelId: KartModelId;
  readonly characterId: CharacterId;
  private readonly body: THREE.Object3D;
  private readonly bodyPosition: THREE.Vector3;
  private readonly bodyRotation: THREE.Euler;
  private readonly bodyBounds: THREE.Box3;
  private readonly posedBounds = new THREE.Box3();
  private readonly poseMatrix = new THREE.Matrix4();
  private readonly wheels: WheelRig[] = [];
  private readonly paints: THREE.MeshStandardMaterial[] = [];
  private readonly wheelRadius: number;
  private readonly head: THREE.Object3D | undefined;
  private readonly mouth: THREE.Object3D | undefined;
  private readonly mouthScale: THREE.Vector3 | undefined;
  private readonly brows: THREE.Object3D | undefined;
  private readonly browsHeight: number;
  private readonly waveArm: THREE.Object3D | undefined;
  private spin = 0;
  private steering = 0;
  private previousSpeed = 0;
  private disposed = false;
  get paintMaterialCount() { return this.paints.length; }

  constructor(template: PreparedKart, color: string, modelId: KartModelId = DEFAULT_KART_MODEL, characterId: CharacterId = DEFAULT_CHARACTER) {
    this.source = template.source;
    this.modelId = modelId;
    this.characterId = characterId;
    this.group = template.root.clone(true);
    this.group.userData.role = 'kart-model'; this.group.userData.source = this.source;
    this.group.userData.modelId = modelId;
    this.group.userData.characterId = characterId;
    this.body = this.group.getObjectByName('Body')!;
    this.body.userData.role = 'kart-body';
    this.bodyPosition = this.body.position.clone(); this.bodyRotation = this.body.rotation.clone();
    this.group.updateMatrixWorld(true);
    this.bodyBounds = new THREE.Box3().setFromObject(this.body).applyMatrix4(this.body.matrixWorld.clone().invert());
    this.wheelRadius = template.radius;
    this.head = this.group.getObjectByName('CharacterHead');
    this.mouth = this.group.getObjectByName('CharacterMouth'); this.mouthScale = this.mouth?.scale.clone();
    this.brows = this.group.getObjectByName('CharacterBrows'); this.browsHeight = this.brows?.position.y ?? 0;
    this.waveArm = this.group.getObjectByName('CharacterWaveArm');
    const paintClones = new Map<THREE.Material, THREE.MeshStandardMaterial>();
    this.group.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const recolor = (source: THREE.Material) => {
        if (!(source instanceof THREE.MeshStandardMaterial) || !paintName(source.name)) return source;
        let material = paintClones.get(source);
        if (!material) { material = source.clone(); paintClones.set(source, material); this.paints.push(material); }
        object.userData.role = 'paint';
        return material;
      };
      object.material = Array.isArray(object.material) ? object.material.map(recolor) : recolor(object.material);
    });
    for (const name of WHEEL_NAMES) this.addWheel(name);
    this.setColor(color);
    activeInstances.add(this);
  }

  private addWheel(name: WheelName) {
    const spin = this.group.getObjectByName(name)!;
    const parent = spin.parent!;
    const pivot = new THREE.Group(); pivot.name = `${name}_Steering`;
    pivot.position.copy(spin.position); pivot.quaternion.copy(spin.quaternion); pivot.scale.copy(spin.scale);
    pivot.userData.role = 'wheel-pivot'; pivot.userData.front = name.includes('_F');
    parent.add(pivot); pivot.add(spin);
    spin.position.set(0, 0, 0); spin.rotation.set(0, 0, 0); spin.scale.set(1, 1, 1);
    spin.userData.role = 'wheel-spin';
    const radius = typeof spin.userData.radius === 'number' && spin.userData.radius > 0
      ? spin.userData.radius : this.wheelRadius;
    this.wheels.push({ pivot, spin, front: name.includes('_F'), radius, angle: 0 });
  }

  setColor(color: string) { for (const paint of this.paints) paint.color.set(color); }

  animate(kart: Pick<Kart, 'speed' | 'turnVelocity' | 'driftDirection' | 'driftCharge' | 'stun'> & Partial<Pick<Kart, 'finished' | 'rank'>>, dt: number, now: number) {
    if (this.disposed) return;
    const delta = clamp(dt, 0, 0.1), speed = kart.speed;
    const speedFactor = Math.min(Math.abs(speed) / 12, 1);
    const turn = kart.turnVelocity / (1.32 * Math.max(0.2, speedFactor)) * (speed < 0 ? -1 : 1);
    const targetSteer = clamp(turn, -1, 1) * 0.43;
    this.steering += (targetSteer - this.steering) * (1 - Math.exp(-delta * 13));
    this.spin = (this.spin + speed * delta / this.wheelRadius) % (Math.PI * 2);
    for (const wheel of this.wheels) {
      wheel.pivot.rotation.y = wheel.front ? this.steering : 0;
      wheel.angle = (wheel.angle + speed * delta / wheel.radius) % (Math.PI * 2);
      wheel.spin.rotation.x = wheel.angle;
    }
    const acceleration = delta > 0.001 ? clamp((speed - this.previousSpeed) / delta, -40, 40) : 0;
    const drift = kart.driftCharge > 0.1 ? kart.driftDirection * 0.02 : 0;
    const roll = clamp(-kart.turnVelocity * Math.abs(speed) * 0.0018 - drift, -0.075, 0.075);
    const wobble = kart.stun > 0 ? Math.sin(now * 0.027) * 0.035 : 0;
    const blend = 1 - Math.exp(-delta * 9);
    this.body.rotation.z += (this.bodyRotation.z + roll + wobble - this.body.rotation.z) * blend;
    this.body.rotation.x += (this.bodyRotation.x - acceleration * 0.00075 - this.body.rotation.x) * blend;
    // The chassis is very low: its visual suspension lifts it during lean so
    // the outside sill never crosses the road while all four tires stay put.
    this.poseMatrix.makeRotationFromEuler(this.body.rotation);
    this.posedBounds.copy(this.bodyBounds).applyMatrix4(this.poseMatrix);
    const clearance = Math.max(0, 0.012 - this.posedBounds.min.y);
    this.body.position.y = this.bodyPosition.y + clearance + Math.max(0, Math.sin(this.spin * 2)) * 0.006 * speedFactor;
    const celebrating = kart.finished === true;
    if (this.head) {
      const nod = kart.stun > 0 ? Math.sin(now * .024) * .17 : celebrating ? Math.sin(now * .005) * .1 : -acceleration * .001;
      this.head.rotation.x += (nod - this.head.rotation.x) * blend;
      this.head.rotation.z += ((kart.stun > 0 ? Math.sin(now * .03) * .16 : celebrating ? Math.sin(now * .004) * .08 : -roll * .5) - this.head.rotation.z) * blend;
      this.head.rotation.y += ((celebrating ? Math.sin(now * .003) * .3 : -this.steering * .3) - this.head.rotation.y) * blend;
    }
    if (this.mouth && this.mouthScale) {
      const open = kart.stun > 0 ? 3.5 : celebrating ? 1.8 : 1;
      this.mouth.scale.y += (this.mouthScale.y * open - this.mouth.scale.y) * blend;
      this.mouth.scale.x += (this.mouthScale.x * (kart.stun > 0 ? .55 : celebrating ? 1.2 : 1) - this.mouth.scale.x) * blend;
    }
    if (this.brows) this.brows.position.y += (this.browsHeight + (kart.stun > 0 ? .065 : celebrating ? .035 : 0) - this.brows.position.y) * blend;
    if (this.waveArm) {
      const salute = celebrating ? -1.7 + Math.sin(now * .007) * .16 : kart.stun > 0 ? -.3 : 0;
      this.waveArm.rotation.x += (salute - this.waveArm.rotation.x) * blend;
      this.waveArm.rotation.z += ((celebrating ? -.5 + Math.sin(now * .009) * .15 : 0) - this.waveArm.rotation.z) * blend;
    }
    this.previousSpeed = speed;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    // Buffers and static materials belong to the cached template, not a player.
    for (const paint of this.paints) paint.dispose();
    activeInstances.delete(this);
  }
}

export async function createKartModel(color: string, modelId: KartModelId = DEFAULT_KART_MODEL, characterId: CharacterId = DEFAULT_CHARACTER): Promise<KartModelInstance> {
  const selected = normalizeKartModelId(modelId);
  const character = normalizeCharacterId(characterId);
  const base = await loadKart(selected);
  if (character === 'racer') return new KartModelInstance(base, color, selected, character);
  let variants = characterTemplates.get(base);
  if (!variants) { variants = new Map(); characterTemplates.set(base, variants); }
  let template = variants.get(character);
  if (!template) {
    const root = base.root.clone(true); root.getObjectByName('LagonDriver')?.removeFromParent();
    template = prepare(root, base.source, character); variants.set(character, template);
  }
  return new KartModelInstance(template, color, selected, character);
}

let contactTexture: THREE.CanvasTexture | undefined;
let contactMaterial: THREE.MeshBasicMaterial | undefined;
const contactGeometry = new THREE.PlaneGeometry(3.3, 4.8).rotateX(-Math.PI / 2);
export function createKartContactShadow() {
  if (!contactTexture) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
    const context = canvas.getContext('2d')!;
    const gradient = context.createRadialGradient(64, 64, 8, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(10,22,29,0.55)');
    gradient.addColorStop(0.45, 'rgba(10,22,29,0.36)');
    gradient.addColorStop(1, 'rgba(10,22,29,0)');
    context.fillStyle = gradient; context.fillRect(0, 0, 128, 128);
    contactTexture = new THREE.CanvasTexture(canvas);
    contactMaterial = new THREE.MeshBasicMaterial({ map: contactTexture, transparent: true, depthWrite: false,
      opacity: 0.66, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  }
  const shadow = new THREE.Mesh(contactGeometry, contactMaterial!);
  shadow.position.y = 0.01; shadow.userData.role = 'contact-shadow'; shadow.renderOrder = 1;
  return shadow;
}
