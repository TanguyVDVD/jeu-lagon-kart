import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { nearestTrack, type Kart, type World } from '../shared/game';
import { getTrack, trackBank, trackPoint, trackElevation, trackSlope, type TrackDefinition } from '../shared/track';
import { createKartContactShadow, createKartModel, kartAssetDiagnostics, type KartModelInstance } from './kart-model';
import { DEFAULT_CHARACTER, normalizeCharacterId, type CharacterId } from '../shared/characters';
import { DEFAULT_KART_MODEL, normalizeKartModelId, type KartModelId } from '../shared/kart-catalog';
import { nearestDriveableTrack, getTrackEvent, trackBoundaryGap } from '../shared/track-events';
import { bankLift, groundLift, roadPose, type RoadPose } from '../shared/road-pose';
import { insideRoad, roadEdge, roadRail, roadRibbon, roadRows, roadVerge, type RoadEdgePoint, type RoadRow } from './road-mesh';
import { TrackEventsView } from './track-events';
import { trackZoneGeometry } from './track-zone-geometry';
import { GhostView } from './ghost-view';
import { CrownView } from './crown-view';
import { buildTrackExtras, hasExtraScenery } from './scenery-extras';
import { buildTrackTerrain, terrainHeight } from './scenery-terrain';
import { preloadSceneryAssets, sceneryAssetDiagnostics } from './scenery-assets';
import { isBridgeProgress, trackBoundaryShoulder, driveableGroundHeight } from '../shared/obstacle-heights';
import type { GhostData } from '../shared/progression';
import { GRAPHICS_STORAGE_KEY, graphicsMode, GraphicsPolicy, RenderPacer, type GraphicsMode, type RenderContext } from './graphics-policy';
import { reduceSceneryDetails } from './graphics-scenery';
import { buildCrossingStructures, crossingCameraHeight } from './track-crossings';

const materials = new Map<string, THREE.MeshStandardMaterial>();
function material(color: string | number, roughness = 0.85) {
  const key = `${color}:${roughness}`;
  let mat = materials.get(key);
  if (!mat) { mat = new THREE.MeshStandardMaterial({ color, roughness }); materials.set(key, mat); }
  return mat;
}
const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
const sphereGeometry = new THREE.IcosahedronGeometry(1, 1);
const sparkGeometry = new THREE.OctahedronGeometry(0.16);
const flameGeometry = new THREE.ConeGeometry(0.32, 2.1, 5);
const trapGeometry = new THREE.ConeGeometry(1.1, 1.6, 5);
const objectBaseGeometry = new THREE.CylinderGeometry(1.4, 1.4, 0.15, 8);
const rocketGeometry = new THREE.ConeGeometry(0.6, 1.8, 6);
const shieldGeometry = new THREE.SphereGeometry(1, 12, 8);
const auraGeometry = new THREE.TorusGeometry(1.8, 0.07, 4, 24);
const auraMaterial = new THREE.MeshBasicMaterial({ color: '#ffe67c', transparent: true, opacity: 0.8, depthWrite: false });
const shieldMaterial = new THREE.MeshBasicMaterial({ color: '#66ddff', transparent: true, opacity: 0.13, depthWrite: false });
const shieldRimMaterial = new THREE.MeshBasicMaterial({ color: '#8beeff', transparent: true, opacity: 0.7, depthWrite: false });
const starShape = new THREE.Shape();
for (let i = 0; i <= 10; i++) {
  const radius = i % 2 ? 0.24 : 0.55;
  const angle = Math.PI / 2 + i * Math.PI / 5;
  if (i === 0) starShape.moveTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
  else starShape.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
}
const starGeometry = new THREE.ExtrudeGeometry(starShape, { depth: 0.12, bevelEnabled: false });
let mysteryMaterial: THREE.SpriteMaterial | undefined;
function mysteryBadge() {
  if (!mysteryMaterial) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.font = 'bold 58px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff9ca'; ctx.strokeStyle = '#1c736f'; ctx.lineWidth = 5;
    ctx.strokeText('?', 32, 33); ctx.fillText('?', 32, 33);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    mysteryMaterial = new THREE.SpriteMaterial({ map: texture, depthTest: true });
  }
  const sprite = new THREE.Sprite(mysteryMaterial); sprite.position.y = 1.45; sprite.scale.setScalar(1.4); return sprite;
}
function mesh(geometry: THREE.BufferGeometry, color: string | number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) {
  const object = new THREE.Mesh(geometry, material(color));
  object.position.set(x, y, z);
  object.scale.set(sx, sy, sz);
  object.castShadow = true;
  object.receiveShadow = true;
  return object;
}
function box(color: string | number, x: number, y: number, z: number, sx: number, sy: number, sz: number) {
  return mesh(boxGeometry, color, x, y, z, sx, sy, sz);
}
const roadBasis = new THREE.Matrix4(), basisRight = new THREE.Vector3(), basisUp = new THREE.Vector3(), basisTangent = new THREE.Vector3();
/** Lay an object on the road surface, following its slope and banking. */
function applyRoadOrientation(object: THREE.Object3D, pose: RoadPose) {
  basisRight.set(pose.right.x, pose.right.y, pose.right.z); basisUp.set(pose.up.x, pose.up.y, pose.up.z);
  basisTangent.set(pose.tangent.x, pose.tangent.y, pose.tangent.z);
  roadBasis.makeBasis(basisRight, basisUp, basisTangent); object.quaternion.setFromRotationMatrix(roadBasis);
}
const WORLD_UP = new THREE.Vector3(0, 1, 0);
function label(text: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 384; canvas.height = 80;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(12,36,43,.85)';
  ctx.beginPath(); ctx.roundRect(5, 5, 374, 70, 30); ctx.fill();
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 34px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text.slice(0, 18), 192, 41, 345);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.set(4.4, 0.92, 1); sprite.position.y = 2.6;
  return sprite;
}

type KartVisual = { group: THREE.Group; shadow: THREE.Object3D; model: KartModelInstance | null; modelId: KartModelId; characterId: CharacterId; modelVersion: number; alive: boolean; sparks: THREE.Group; flames: THREE.Group; energy: THREE.Group; shield: THREE.Group; label: THREE.Sprite; name: string; color: string };

export class GameRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly trackEvents = new TrackEventsView(this.scene);
  private readonly ghost = new GhostView(this.scene);
  private readonly crown = new CrownView(this.scene);
  private readonly scenery = new THREE.Group();
  // Rails and bridge parapets open where a branch joins. They are rebuilt alone
  // when a shortcut opens, leaving the island, its road and its decor in place.
  private readonly openings = new THREE.Group();
  private openingsKey = '';
  private rows: RoadRow[] = [];
  private shoulders: RoadEdgePoint[][] = [];
  private readonly aim = new THREE.Vector3();
  private readonly centre = new THREE.Vector3();
  private shadowFrame = 0;
  // Keep nearby karts visible; the distant panorama uses a larger near plane
  // below so road ribbons a centimetre apart retain distinct depth values.
  private readonly camera = new THREE.PerspectiveCamera(52, 1, 1, 900);
  private readonly karts = new Map<string, KartVisual>();
  private readonly pickups = new Map<string, THREE.Group>();
  private readonly objects = new Map<string, THREE.Group>();
  private readonly cameraAim = new THREE.Vector3();
  private readonly cameraGoal = new THREE.Vector3();
  private lastCameraId = '';
  private lastCameraFrame: number | null = null;
  private cameraAngle = 0;
  private compactViewport = false;
  private readonly demo: KartVisual;
  private track: TrackDefinition = getTrack('lagon');
  private previewTrack = 'lagon';
  private eventStage = 0;
  private eventLevel = 3;
  private bounds = { centerX: 0, centerZ: 0, radius: 140 };
  private readonly hemisphere = new THREE.HemisphereLight('#eaffed', '#586c55', 2.7);
  private readonly sun = new THREE.DirectionalLight('#fff0ce', 3.1);
  public frames = 0;
  public fps = 60;
  public quality: 'standard' | 'light' = 'standard';
  private fpsTime = performance.now();
  private readonly graphics = new GraphicsPolicy();
  private readonly pacer = new RenderPacer();
  private renderedFrames = 0;
  private renderState: 'race' | 'menu' | 'hidden' | 'dialog' = 'menu';
  private sceneryDetails = { optional: 0, visible: 0 };
  /** Cubes the local kart has already driven through, ahead of the server. */
  public collectedPickups: { has(id: string): boolean } = new Set<string>();

  get kartAssets() { return kartAssetDiagnostics(); }
  get sceneryAssets() { return sceneryAssetDiagnostics(); }
  get qualityMode() { return this.graphics.mode; }
  get viewDiagnostics() {
    const tracked = this.karts.get(this.lastCameraId)?.group;
    const point = tracked?.getWorldPosition(new THREE.Vector3());
    const normal = tracked ? new THREE.Vector3(0, 1, 0).applyQuaternion(tracked.quaternion) : null;
    const projected = point?.clone().addScaledVector(normal!, 1).project(this.camera);
    return { camera: { position: this.camera.position.toArray(), target: this.cameraAim.toArray(), up: this.camera.up.toArray(), fov: this.camera.fov, near: this.camera.near },
      tracked: point ? { id: this.lastCameraId, position: point.toArray(), up: normal!.toArray(), projected: projected!.toArray() } : null,
      calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, compact: this.compactViewport,
      qualityMode: this.qualityMode, quality: this.quality, pixelRatio: this.renderer.getPixelRatio(),
      shadows: this.renderer.shadowMap.enabled, sceneryDetails: { ...this.sceneryDetails },
      renderedFrames: this.renderedFrames, renderState: this.renderState, menuFpsLimit: this.pacer.menuFps };
  }

  constructor(canvas: HTMLCanvasElement) {
    try { this.graphics.setMode(graphicsMode(localStorage.getItem(GRAPHICS_STORAGE_KEY))); } catch { /* Optional local preference. */ }
    this.quality = this.graphics.quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.graphics.pixelRatio(devicePixelRatio));
    this.renderer.shadowMap.enabled = this.quality === 'standard';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.scene.background = new THREE.Color('#8edbdf');
    this.scene.fog = new THREE.Fog('#8edbdf', 200, 620);
    this.scene.add(this.hemisphere, this.scenery, this.openings);
    const sun = this.sun;
    sun.position.set(-90, 150, 60); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -170, right: 170, top: 170, bottom: -170, far: 400 });
    sun.shadow.normalBias = 0.12;
    // The renderer refreshes the shadow map itself, on alternate race frames.
    sun.shadow.autoUpdate = false;
    this.scene.add(sun);
    // Shaders of effects first shown mid-race (star aura, shield, weather) are
    // compiled with the menu's first frames, not as a freeze when an item is used.
    const warmUp = new THREE.Group(); warmUp.position.y = -60;
    for (const effect of [auraMaterial, shieldMaterial]) { const sample = new THREE.Mesh(boxGeometry, effect); sample.scale.setScalar(.001); warmUp.add(sample); }
    warmUp.add(new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)),
      new THREE.PointsMaterial({ size: .01, transparent: true, opacity: 0, depthWrite: false })));
    for (const sample of warmUp.children) sample.frustumCulled = false;
    this.scene.add(warmUp);
    this.demo = this.buildKart('#ff7659', 'À vous la piste');
    this.demo.label.visible = false;
    this.scene.add(this.demo.group);
    this.setTrack('lagon', true);
    this.camera.position.set(80, 135, 160);
    window.addEventListener('resize', () => this.resize());
    this.resize();
    void preloadSceneryAssets().then(() => this.setTrack(this.track.id, true));
  }

  private resize() {
    this.compactViewport = matchMedia('(pointer: coarse)').matches || innerWidth <= 760;
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.pacer.invalidate();
  }

  setQualityMode(mode: GraphicsMode) {
    this.graphics.setMode(mode); this.applyQuality(); this.pacer.invalidate();
  }

  private applyQuality() {
    const changed = this.quality !== this.graphics.quality;
    this.quality = this.graphics.quality;
    this.renderer.setPixelRatio(this.graphics.pixelRatio(devicePixelRatio));
    this.renderer.shadowMap.enabled = this.quality === 'standard';
    if (changed) {
      // Rebuild only for a real detail change, keeping road/collision markers.
      this.setTrack(this.track.id, true);
      this.scene.traverse(object => {
        if (object instanceof THREE.Mesh) for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.needsUpdate = true;
      });
    }
    this.resize();
  }

  setPreviewTrack(id: string) { this.previewTrack = getTrack(id).id; }
  setGhost(ghost: GhostData | null) { this.ghost.set(ghost); }

  setPreviewKart(color: string, modelId: string, characterId: string = DEFAULT_CHARACTER) {
    this.demo.color = color; this.demo.model?.setColor(color);
    if (this.demo.modelId !== normalizeKartModelId(modelId) || this.demo.characterId !== normalizeCharacterId(characterId)) this.setKartModel(this.demo, modelId, characterId);
  }

  private disposeGroup(group: THREE.Group) {
    const geometries = new Set<THREE.BufferGeometry>();
    group.traverse(object => {
      if (object instanceof THREE.Mesh) geometries.add(object.geometry);
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
    group.clear();
    for (const geometry of geometries) if (geometry !== boxGeometry && geometry !== sphereGeometry) geometry.dispose();
  }

  private setTrack(id: string, force = false) {
    const next = getTrack(id);
    const trackChanged = next.id !== this.track.id;
    const openingsKey = next.id + ':' + getTrackEvent(next.id, this.eventStage, this.eventLevel).branches.filter(branch => branch.open).map(branch => branch.id).join(',');
    if (!force && !trackChanged) {
      if (openingsKey !== this.openingsKey) { this.openingsKey = openingsKey; this.buildOpenings(); }
      return;
    }
    this.openingsKey = openingsKey;
    this.disposeGroup(this.scenery);
    this.track = next;
    const minX = Math.min(...next.points.map(p => p.x)), maxX = Math.max(...next.points.map(p => p.x));
    const minZ = Math.min(...next.points.map(p => p.z)), maxZ = Math.max(...next.points.map(p => p.z));
    this.bounds = { centerX: (minX + maxX) / 2, centerZ: (minZ + maxZ) / 2, radius: Math.max(maxX - minX, maxZ - minZ) / 2 + 39 };
    this.scene.background = new THREE.Color(next.palette.sky);
    this.scene.fog = new THREE.Fog(next.palette.sky, 200, 620);
    const night = next.theme === 'neon';
    this.hemisphere.color.set(night ? '#779bed' : '#eaffed');
    this.hemisphere.groundColor.set(night ? '#402150' : '#736854');
    this.hemisphere.intensity = night ? 1.5 : 2.7;
    this.sun.color.set(next.theme === 'ice' ? '#d3edff' : night ? '#bd82ff' : '#fff0ce');
    this.sun.intensity = night ? 1.5 : 3.1;
    this.buildIsland();
    this.sceneryDetails = this.quality === 'light' ? reduceSceneryDetails(this.scenery) : { optional: 0, visible: 0 };
    this.batchScenery(this.scenery);
    this.buildOpenings();
    const start = trackPoint(0, next.id);
    this.demo.group.position.set(start.x, trackElevation(0, next.id) + 0.055, start.z);
    this.demo.group.rotation.y = start.angle;
    if (trackChanged) this.lastCameraId = '';
  }

  /** Static scenery shares one draw call per material, including the palm grove. */
  private batchScenery(root: THREE.Group) {
    const batches = new Map<string, { material: THREE.Material; cast: boolean; receive: boolean; geometries: THREE.BufferGeometry[] }>();
    const originals: THREE.Mesh[] = [];
    this.scene.updateMatrixWorld(true);
    root.traverseVisible(object => {
      if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh || Array.isArray(object.material)) return;
      const key = `${object.material.uuid}:${object.castShadow}:${object.receiveShadow}`;
      let batch = batches.get(key);
      if (!batch) { batch = { material: object.material, cast: object.castShadow, receive: object.receiveShadow, geometries: [] }; batches.set(key, batch); }
      const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
      geometry.applyMatrix4(object.matrixWorld);
      if (!geometry.getAttribute('uv')) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 2), 2));
      batch.geometries.push(geometry); originals.push(object);
    });
    for (const batch of batches.values()) {
      const geometry = mergeGeometries(batch.geometries);
      if (geometry) { const mesh = new THREE.Mesh(geometry, batch.material); mesh.castShadow = batch.cast; mesh.receiveShadow = batch.receive; root.add(mesh); }
      for (const part of batch.geometries) part.dispose();
    }
    const originalsGeometry = new Set(originals.map(object => object.geometry));
    for (const original of originals) original.removeFromParent();
    for (const geometry of originalsGeometry) if (geometry !== boxGeometry && geometry !== sphereGeometry) geometry.dispose();
    this.sun.shadow.needsUpdate = true;
  }

  /** Guard rails and structures whose openings depend on the branches open now. */
  private buildOpenings() {
    this.disposeGroup(this.openings);
    const track = this.track, { theme } = track;
    const guardColor = theme === 'neon' ? '#69f1ee' : theme === 'ice' ? '#8abccb' : theme === 'canyon' ? '#966b50' : '#e7d9b6';
    this.shoulders.forEach((edge, sideIndex) => {
      const rail = new THREE.Mesh(roadRail(edge, i => {
        const row = this.rows[i]!, a = edge[i]!, b = edge[(i + 1) % edge.length]!;
        return isBridgeProgress(row.progress, track.id) || isBridgeProgress(this.rows[(i + 1) % this.rows.length]!.progress, track.id) ||
          trackBoundaryGap((a.x + b.x) / 2, (a.z + b.z) / 2, track.id, this.eventStage, this.eventLevel) ||
          insideRoad(track, row, a, track.width / 2 + trackBoundaryShoulder(row.progress, track.id));
      }), material(guardColor));
      rail.name = 'guard-rail-' + sideIndex; rail.receiveShadow = true; this.openings.add(rail);
    });
    this.openings.add(buildTrackExtras(track, this.eventStage, this.eventLevel, 'structures'));
    this.batchScenery(this.openings);
  }

  private buildIsland() {
    const { centerX: cx, centerZ: cz, radius } = this.bounds;
    const track = this.track, points = track.points, width = track.width;
    const { palette, theme } = track;
    const scenery = this.scenery;
    if (theme === 'neon') for (const color of ['#69f1ee', '#f28fdf', '#7ddbeb', '#df82e0', '#74f5ef', '#dd80e4']) {
      const light = material(color); light.emissive.set(color); light.emissiveIntensity = 0.55;
    }
    const shore = hasExtraScenery(track) ? palette.ground : theme === 'tropical' ? '#ecd5a1' : theme === 'canyon' ? '#d39564' : theme === 'ice' ? '#dfeff4' : '#252a54';
    const water = mesh(new THREE.PlaneGeometry(2000, 2000), palette.water, cx, -1.5, cz);
    water.rotation.x = -Math.PI / 2; water.receiveShadow = false; water.castShadow = false; scenery.add(water);
    scenery.add(buildTrackTerrain(track));
    const roadMat = material(palette.road), edgeMat = material(theme === 'neon' ? '#69f1ee' : '#efe9cf'), shoulderMat = material(shore);
    roadMat.side = edgeMat.side = shoulderMat.side = THREE.DoubleSide;
    const rows = this.rows = roadRows(track);
    const shoulderReach = (row: RoadRow) => width / 2 + trackBoundaryShoulder(row.progress, track.id);
    const shoulders = this.shoulders = [-1, 1].map(side => roadEdge(track, rows, row => side * shoulderReach(row)));
    scenery.add(new THREE.Mesh(roadRibbon(shoulders[0]!, shoulders[1]!, .01), shoulderMat));
    const road = new THREE.Mesh(roadRibbon(roadEdge(track, rows, -width / 2), roadEdge(track, rows, width / 2), .05), roadMat); road.receiveShadow = true; scenery.add(road);
    for (const side of [-1, 1]) {
      const inner = roadEdge(track, rows, side * (width / 2 - .59)), outer = roadEdge(track, rows, side * (width / 2 - .31));
      // No marking is painted where another part of the road covers this edge.
      scenery.add(new THREE.Mesh(roadRibbon(side < 0 ? outer : inner, side < 0 ? inner : outer, .07,
        i => insideRoad(track, rows[i]!, outer[i]!, width / 2 - .31) || insideRoad(track, rows[(i + 1) % rows.length]!, outer[(i + 1) % rows.length]!, width / 2 - .31)), edgeMat));
    }
    if (track.relief?.length) {
      const ground = terrainHeight(track);
      shoulders.forEach((edge, index) => scenery.add(new THREE.Mesh(roadVerge(track, rows, edge, index ? 1 : -1, ground), shoulderMat)));
    }
    const curbGeometry = new THREE.BoxGeometry(1, 0.18, 1);
    const transform = new THREE.Object3D();
    const curbMatrices: THREE.Matrix4[][] = [[], []];
    const pieces = Math.max(1, Math.round(track.length / 3)), reach = width / 2 + .5;
    for (let i = 0; i < pieces; i++) for (const side of [-1, 1]) {
      const from = i * track.length / pieces, to = (i + 1) * track.length / pieces;
      const a = roadPose(from, track.id, side * reach), b = roadPose(to, track.id, side * reach);
      const length = Math.hypot(b.x - a.x, b.z - a.z), middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
      // A bend tighter than the road is wide has no inner kerb left to draw.
      if (length < .4 || (b.x - a.x) * a.tangent.x + (b.z - a.z) * a.tangent.z <= 0 ||
        nearestDriveableTrack(middle.x, middle.z, track.id, 0, 0, track.crossings?.length ? { progress: from, elevation: a.y } : undefined).distance < reach - .6) continue;
      transform.position.set(middle.x, middle.y + .14, middle.z);
      transform.rotation.set(-Math.atan2(b.y - a.y, length), Math.atan2(b.x - a.x, b.z - a.z), Math.atan(trackBank((from + to) / 2, track)), 'YXZ');
      transform.scale.set(1, 1, length * .96); transform.updateMatrix(); curbMatrices[i % 2]!.push(transform.matrix.clone());
    }
    curbMatrices.forEach((matrices, color) => {
      const instances = new THREE.InstancedMesh(curbGeometry, material(color ? (theme === 'neon' ? '#538fad' : '#f3f0dc') : palette.accent), matrices.length);
      matrices.forEach((matrix, i) => instances.setMatrixAt(i, matrix));
      instances.receiveShadow = true; scenery.add(instances);
    });
    const start = trackPoint(0, track.id);
    const startGroup = new THREE.Group(); startGroup.position.set(start.x, trackElevation(0, track.id) + 0.1, start.z); startGroup.rotation.y = start.angle;
    for (let i = 0; i < 12; i++) for (let j = 0; j < 2; j++) startGroup.add(box((i + j) % 2 ? '#213c43' : '#fff8e6', (i - 5.5) * width / 12, 0.01, j - 0.5, width / 12, 0.02, 1));
    startGroup.add(box(shore, -width / 2 - 2, 5, 0, 0.9, 10, 0.9), box(shore, width / 2 + 2, 5, 0, 0.9, 10, 0.9));
    startGroup.add(box(palette.accent, 0, 9.6, 0, width + 5, 1.5, 1.1));
    for (let i = -4; i <= 4; i++) startGroup.add(box(i % 2 ? '#ffffff' : '#18434a', i * 1.1, 9.6, -0.57, 1.1, 0.7, 0.02));
    scenery.add(startGroup);
    this.buildZones();
    scenery.add(buildTrackExtras(track, 0, 0, 'world'));
    scenery.add(buildCrossingStructures(track));

    if (theme === 'tropical') for (let i = 0; i < 5; i++) {
      const a = i * 1.5 + 0.2, r = radius + 30 + i * 9;
      const boat = new THREE.Group(); boat.position.set(cx + Math.sin(a) * r, -0.8, cz + Math.cos(a) * r); boat.rotation.y = a;
      boat.add(mesh(sphereGeometry, '#fcf2d9', 0, 0, 0, 1.8, 0.6, 5), box('#886a58', 0, 4, 0, 0.15, 8, 0.15));
      boat.add(mesh(new THREE.ConeGeometry(3.5, 6.5, 3), i % 2 ? '#f59471' : '#fff4d5', 0, 4.5, 0, 0.06, 1, 1)); scenery.add(boat);
    }
    if (theme === 'neon') for (const fraction of [0.18, 0.5, 0.77]) {
      const point = trackPoint(track.length * fraction, track.id);
      const arch = new THREE.Group(); arch.position.set(point.x, trackElevation(track.length * fraction, track.id), point.z); arch.rotation.y = point.angle;
      for (const side of [-1, 1]) arch.add(box('#7ddbeb', side * (width / 2 + 2), 6, 0, 0.35, 12, 0.35));
      arch.add(box('#df82e0', 0, 12, 0, width + 4, 0.35, 0.35)); scenery.add(arch);
    }
  }

  private buildZones() {
    let overlayOrder = 1;
    for (const zone of [...this.track.zones].reverse()) {
      const geometry = trackZoneGeometry(this.track.id, zone);
      const color = zone.kind === 'boost' ? '#efc457' : zone.kind === 'ice' ? '#b5eaf1' : '#745449';
      const mat = material(color, zone.kind === 'ice' ? 0.15 : 0.85); mat.side = THREE.DoubleSide;
      const patch = new THREE.Mesh(geometry, mat); patch.receiveShadow = true; patch.renderOrder = overlayOrder++; this.scenery.add(patch);
      if (zone.kind === 'boost') for (let progress = zone.start + 2; progress < zone.end - 1; progress += 3) {
        const pose = roadPose(progress, this.track.id, zone.offset);
        const arrow = new THREE.Group(); arrow.position.set(pose.x, pose.y + .13, pose.z); applyRoadOrientation(arrow, pose);
        for (const side of [-1, 1]) { const line = box('#fff6d2', side * 0.65, 0, 0, 0.35, 0.035, 1.8); line.rotation.y = -side * 0.6; arrow.add(line); }
        this.scenery.add(arrow);
      }
    }
  }

  private buildKart(color: string, name: string, modelId: string = DEFAULT_KART_MODEL, characterId: string = DEFAULT_CHARACTER): KartVisual {
    const group = new THREE.Group();
    group.userData.role = 'kart-instance';
    const shadow = createKartContactShadow(); group.add(shadow);
    const sparks = new THREE.Group();
    for (const x of [-1.1, 1.1]) for (let i = 0; i < 3; i++) sparks.add(mesh(sparkGeometry, '#72eaff', x + (i % 2) * 0.13, 0.3 + i * 0.1, -1.5 - i * 0.45, 1, 1, 2));
    group.add(sparks); sparks.visible = false;
    const flames = new THREE.Group();
    for (const x of [-0.48, 0.48]) { const flame = mesh(flameGeometry, '#ffcf63', x, 0.42, -2.25); flame.rotation.x = -Math.PI / 2; flames.add(flame); }
    group.add(flames); flames.visible = false;
    // Effects have their own materials; shared imported kart materials are never
    // recoloured or made transparent by another player's temporary protection.
    const energy = new THREE.Group();
    const ring = new THREE.Mesh(auraGeometry, auraMaterial); ring.rotation.x = Math.PI / 2; ring.position.y = 0.25;
    energy.add(ring);
    for (let i = 0; i < 3; i++) {
      const star = new THREE.Mesh(starGeometry, auraMaterial);
      star.position.set(Math.sin(i * Math.PI * 2 / 3) * 1.65, 1.5, Math.cos(i * Math.PI * 2 / 3) * 1.65);
      star.scale.setScalar(0.7); energy.add(star);
    }
    energy.visible = false; group.add(energy);
    const shield = new THREE.Group();
    const bubble = new THREE.Mesh(shieldGeometry, shieldMaterial); bubble.position.y = 1; bubble.scale.set(1.6, 1.5, 2.4);
    const rim = new THREE.Mesh(auraGeometry, shieldRimMaterial); rim.rotation.x = Math.PI / 2; rim.scale.set(0.85, 1.3, 1); rim.position.y = 0.35;
    shield.add(bubble, rim); shield.visible = false; group.add(shield);
    const nameLabel = label(name); group.add(nameLabel);
    const visual: KartVisual = { group, shadow, model: null, modelId: normalizeKartModelId(modelId), characterId: normalizeCharacterId(characterId), modelVersion: 0, alive: true, sparks, flames, energy, shield, label: nameLabel, name, color };
    this.setKartModel(visual, modelId, characterId);
    return visual;
  }

  private setKartModel(visual: KartVisual, modelId: string, characterId: string = DEFAULT_CHARACTER) {
    visual.modelId = normalizeKartModelId(modelId); visual.characterId = normalizeCharacterId(characterId);
    const version = ++visual.modelVersion;
    void createKartModel(visual.color, visual.modelId, visual.characterId).then(model => {
      // A selection can change again while its GLB is loading. Retain only the latest request.
      if (!visual.alive || visual.modelVersion !== version) { model.dispose(); return; }
      visual.model?.dispose(); model.setColor(visual.color);
      visual.model = model; visual.group.add(model.group);
    });
  }

  private removeKart(visual: KartVisual) {
    visual.alive = false;
    visual.group.removeFromParent(); visual.model?.dispose();
    visual.label.material.map?.dispose(); visual.label.material.dispose();
  }

  render(world: World | null, players: Kart[], localId: string, dt: number, now: number, context: RenderContext = {}) {
    const racing = world?.phase === 'racing' || world?.phase === 'countdown';
    const hidden = context.hidden ?? document.hidden;
    this.renderState = hidden ? 'hidden' : context.opaqueDialog ? 'dialog' : racing ? 'race' : 'menu';
    if (!this.pacer.shouldRender(now, racing, { ...context, hidden })) {
      if (hidden || context.opaqueDialog) { this.frames = 0; this.fpsTime = now; this.lastCameraFrame = null; this.lastCameraId = ''; this.graphics.observeFps(0, false); }
      return false;
    }
    if (!racing) this.graphics.observeFps(0, false);
    // Simulation dt is capped by the caller. Camera smoothing must follow the
    // actual frame interval, otherwise slow rendering leaves it behind the kart.
    const cameraElapsed = this.lastCameraFrame === null ? dt : (now - this.lastCameraFrame) / 1000;
    const cameraDt = Math.max(0, Math.min(0.5, cameraElapsed));
    this.lastCameraFrame = now;
    // Re-anchor after an inactive tab instead of sweeping across an old position.
    if (cameraElapsed > 0.5) { this.lastCameraId = ''; this.frames = 0; this.fpsTime = now; }
    const eventStage = world?.eventStage ?? 0, eventLevel = world?.eventLevel ?? 3;
    this.eventStage = eventStage; this.eventLevel = eventLevel;
    // Only the rail openings follow the shared phase; the island stays in place.
    this.setTrack(world?.trackId ?? this.previewTrack);
    this.trackEvents.update(world?.trackId ?? this.previewTrack, world?.eventStage ?? 0, world?.eventLevel ?? 3, world?.time ?? now / 1000, world?.interactions);
    this.ghost.update(world);
    this.frames++;
    if (now - this.fpsTime >= 1000) {
      this.fps = this.frames * 1000 / (now - this.fpsTime); this.frames = 0; this.fpsTime = now;
      // A deliberately capped menu must never look like a slow GPU to Auto.
      if (this.graphics.observeFps(this.fps, racing)) this.applyQuality();
    }
    const ids = new Set(players.map(p => p.id));
    for (const [id, visual] of this.karts) if (!ids.has(id)) { this.removeKart(visual); this.karts.delete(id); }
    this.demo.group.visible = !world;
    for (const kart of players) {
      let visual = this.karts.get(kart.id);
      if (!visual) { visual = this.buildKart(kart.color, kart.name, kart.modelId, kart.characterId); this.karts.set(kart.id, visual); this.scene.add(visual.group); }
      if (visual.modelId !== normalizeKartModelId(kart.modelId) || visual.characterId !== normalizeCharacterId(kart.characterId)) this.setKartModel(visual, kart.modelId, kart.characterId);
      if (visual.color !== kart.color) { visual.model?.setColor(kart.color); visual.color = kart.color; }
      if (visual.name !== kart.name) { visual.group.remove(visual.label); visual.label.material.map?.dispose(); visual.label.material.dispose(); visual.label = label(kart.name); visual.group.add(visual.label); visual.name = kart.name; }
      visual.group.visible = !kart.spectator && !kart.abandoned;
      const groundY = kart.surface === 'offroad' ? 0.015
        : kart.surface === 'boost' || kart.surface === 'ice' || kart.surface === 'mud' ? 0.09 : 0.055;
      const near = nearestDriveableTrack(kart.x, kart.z, kart.trackId, kart.eventStage, kart.eventLevel,
        { progress: kart.routeProgress ?? kart.progress, elevation: kart.elevation });
      const kartTrack = getTrack(kart.trackId), heading = kart.angle - near.angle;
      // On the main road the kart rests on its banked surface; a branch is level
      // except where it leaves a banked bend.
      const lift = near.branchId ? groundLift(kart.x, kart.z, kart.trackId)
        : bankLift(near.progress, (kart.x - near.x) * Math.cos(near.angle) - (kart.z - near.z) * Math.sin(near.angle), kartTrack);
      visual.group.position.set(kart.x, kart.elevation + lift + groundY, kart.z);
      const height = Math.max(0, kart.elevation - driveableGroundHeight(near, kart.trackId, kart.elevation));
      visual.shadow.position.y = .01 - height; visual.shadow.scale.setScalar(1 + height * .08);
      visual.group.rotation.set(0, kart.angle, 0);
      if (visual.model) {
        const pitch = kart.airborne ? -Math.atan2(kart.verticalVelocity, Math.max(12, Math.abs(kart.speed))) * .45
          : -Math.atan(trackSlope(near.progress, kart.trackId)) * Math.cos(heading);
        const roll = kart.airborne || near.branchId ? 0 : Math.atan(trackBank(near.progress, kartTrack)) * Math.cos(heading);
        const settle = 1 - Math.exp(-dt * 12);
        visual.model.group.rotation.x += (pitch - visual.model.group.rotation.x) * settle;
        visual.model.group.rotation.z += (roll - visual.model.group.rotation.z) * settle;
        visual.model.animate(kart, dt, now);
      }
      visual.label.visible = kart.id !== localId && kart.id !== this.lastCameraId;
      visual.sparks.visible = kart.driftCharge > 0.1; visual.sparks.scale.setScalar(0.8 + (Math.sin(now * 0.08) + 1) * 0.4);
      visual.flames.visible = kart.boost > 0; visual.flames.scale.z = 0.85 + Math.sin(now * 0.1) * 0.2;
      visual.energy.visible = kart.invincible > 0; visual.energy.rotation.y = now * 0.004;
      visual.shield.visible = kart.shield > 0; visual.shield.scale.setScalar(1 + Math.sin(now * 0.006) * 0.025);
    }
    this.renderObjects(world, now);
    this.crown.update(world, players, now);
    const local = players.find(k => k.id === localId && !k.spectator && !k.abandoned) ?? (world && world.phase !== 'lobby' ? players.find(k => !k.spectator && !k.abandoned) : undefined);
    const following = local && world && world.phase !== 'lobby' && world.phase !== 'finished';
    if (following) {
      this.camera.near = 1;
      this.camera.far = 900;
      (this.scene.fog as THREE.Fog).near = 200; (this.scene.fog as THREE.Fog).far = 620;
      const blend = 1 - Math.exp(-cameraDt * 5);
      const portrait = this.compactViewport && innerHeight > innerWidth;
      if (this.lastCameraId !== local.id) { this.cameraAngle = local.angle; this.cameraAim.set(local.x, 1 + local.elevation, local.z); }
      this.cameraAngle += Math.atan2(Math.sin(local.angle - this.cameraAngle), Math.cos(local.angle - this.cameraAngle)) * (1 - Math.exp(-cameraDt * 4));
      const distance = (portrait ? 14.5 : 11.5) + Math.min(2.5, Math.abs(local.speed) / 16);
      const tunnelHeight = crossingCameraHeight(local.routeProgress ?? local.progress, local.trackId);
      const tunnelCameraY = tunnelHeight === undefined ? undefined : trackElevation(local.routeProgress ?? local.progress, local.trackId) + tunnelHeight;
      const chase = tunnelHeight === undefined ? distance : 7;
      this.cameraGoal.set(local.x - Math.sin(this.cameraAngle) * chase, tunnelCameraY ?? (portrait ? 8.6 : 6.3) + local.elevation, local.z - Math.cos(this.cameraAngle) * chase);
      this.aim.set(local.x + Math.sin(this.cameraAngle) * 5.5, Math.min(1.05 + local.elevation, tunnelCameraY ?? Infinity), local.z + Math.cos(this.cameraAngle) * 5.5);
      this.camera.position.lerp(this.cameraGoal, this.lastCameraId === local.id ? blend : 1);
      if (tunnelCameraY !== undefined) this.camera.position.y = Math.min(this.camera.position.y, tunnelCameraY);
      this.cameraAim.lerp(this.aim, blend);
      this.camera.up.lerp(WORLD_UP, blend).normalize();
      this.camera.lookAt(this.cameraAim); this.lastCameraId = local.id;
      const fov = (portrait ? 68 : this.compactViewport ? 60 : 55) + (local.boost > 0 ? 7 : 0); this.camera.fov += (fov - this.camera.fov) * blend; this.camera.updateProjectionMatrix();
    } else {
      this.camera.near = 10;
      const { centerX: x, centerZ: z, radius } = this.bounds;
      const angle = now * 0.000018 + 0.55;
      const framing = 1 / Math.min(1, this.camera.aspect);
      this.cameraGoal.set(x + Math.sin(angle) * radius * 1.75 * framing, radius * 2.25 * framing, z + Math.cos(angle) * radius * 1.75 * framing);
      this.camera.position.lerp(this.cameraGoal, 1 - Math.exp(-cameraDt * 2));
      this.centre.set(x, 0, z);
      this.cameraAim.lerp(this.centre, 1 - Math.exp(-cameraDt * 2));
      this.camera.up.lerp(WORLD_UP, 1 - Math.exp(-cameraDt * 8)).normalize();
      const distance = this.camera.position.distanceTo(this.centre);
      // The complete island is far away: reserve depth precision for its thin
      // road layers instead of the empty space directly in front of the camera.
      this.camera.near = Math.max(10, distance * .1);
      this.camera.far = Math.max(900, distance + radius * 3);
      (this.scene.fog as THREE.Fog).near = Math.max(200, distance - radius * .25);
      (this.scene.fog as THREE.Fog).far = Math.max(620, distance + radius * 3);
      this.camera.lookAt(this.cameraAim); this.camera.fov += (52 - this.camera.fov) * Math.min(1, cameraDt * 3); this.camera.updateProjectionMatrix(); this.lastCameraId = '';
    }
    for (const visual of this.karts.values()) if (visual.label.visible) {
      const scale = Math.min(1, visual.group.position.distanceTo(this.camera.position) / 22);
      visual.label.scale.set(4.4 * scale, .92 * scale, 1);
    }
    this.trackEvents.updateCamera(this.camera);
    // Moving shadows are soft and small: refreshing the map every other race
    // frame (and rarely in the slow menu orbit) halves its cost unnoticed.
    if (this.shadowFrame++ % (racing ? 2 : 20) === 0) this.sun.shadow.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
    this.renderedFrames++;
    return true;
  }

  private renderObjects(world: World | null, now: number) {
    // Items rest on the same banked surface as the karts.
    const surfaceY = (item: { x: number; z: number; progress?: number; elevation?: number }) =>
      (item.elevation ?? trackElevation(nearestDriveableTrack(item.x, item.z, this.track.id, world?.eventStage, world?.eventLevel, item).progress, this.track.id)) +
      groundLift(item.x, item.z, this.track.id);
    const pickups = world?.pickups ?? [];
    for (const pickup of pickups) {
      let visual = this.pickups.get(pickup.id);
      if (!visual) {
        visual = new THREE.Group();
        const cube = box('#a5ffe9', 0, 0, 0, 1.7, 1.7, 1.7); (cube.material as THREE.MeshStandardMaterial) = material('#8ce8d0', 0.2);
        visual.add(cube, mysteryBadge());
        this.pickups.set(pickup.id, visual); this.scene.add(visual);
      }
      visual.visible = pickup.cooldown <= 0 && !this.collectedPickups.has(pickup.id);
      if (!visual.visible) continue;
      visual.position.set(pickup.x, surfaceY(pickup) + 1.6 + Math.sin(now * .003 + pickup.x) * .25, pickup.z);
      visual.rotation.set(.15, now * .0009, .15, 'YXZ');
    }
    const pickupIds = new Set(pickups.map(p => p.id));
    for (const [id, visual] of this.pickups) if (!pickupIds.has(id)) { this.scene.remove(visual); this.pickups.delete(id); }
    const ids = new Set((world?.objects ?? []).map(o => o.id));
    for (const [id, visual] of this.objects) if (!ids.has(id)) { this.scene.remove(visual); this.objects.delete(id); }
    for (const object of world?.objects ?? []) {
      let visual = this.objects.get(object.id);
      if (!visual) {
        visual = new THREE.Group();
        if (object.kind === 'trap') {
          visual.add(mesh(trapGeometry, '#ffbf47', 0, 0.7, 0), mesh(objectBaseGeometry, '#ee704a', 0, 0.15, 0));
        } else if (object.kind === 'seeker') {
          const rocket = mesh(rocketGeometry, '#ff5b67', 0, 0.85, 0); rocket.rotation.x = Math.PI / 2;
          visual.add(rocket, box('#fff0cc', 0, 0.8, -0.45, 1.6, 0.14, 0.6), mesh(sphereGeometry, '#ffcf63', 0, 0.85, -1, 0.3, 0.3, 0.6));
        } else if (object.kind === 'leaderBolt') {
          visual.add(mesh(sphereGeometry, '#4c9dff', 0, 1.5, 0, 0.9, 0.9, 1.1),
            box('#e7faff', 0, 1.5, 0, 2.1, 0.18, 0.4), mesh(sphereGeometry, '#9edcff', 0, 1.5, -1.3, 0.45, 0.45, 1));
          const crown = mesh(starGeometry, '#fff28e', 0, 2.6, 0); visual.add(crown);
        } else visual.add(mesh(sphereGeometry, '#62d982', 0, 0.85, 0, 0.85, 0.65, 1.2), box('#fff0cc', 0, 0.85, 0, 1.8, 0.15, 0.3));
        this.objects.set(object.id, visual); this.scene.add(visual);
      }
      visual.position.set(object.x, surfaceY(object), object.z); visual.rotation.y = object.angle;
    }
  }
}
