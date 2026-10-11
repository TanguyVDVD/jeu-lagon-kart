import * as THREE from 'three';
import { BRANCH_POST_HEIGHT } from '../shared/obstacle-heights';
import { getTrack, nearestTrack, trackElevation, trackPoint, type Vec2 } from '../shared/track';
import { getTrackEvent, type TrackBranch, type TrackEventInfo } from '../shared/track-events';
import { trackZoneGeometry } from './track-zone-geometry';
import { bankLift, roadPose } from '../shared/road-pose';
import { interactionStatus, interactionZones, type TrackInteractionState } from '../shared/track-interactions';

function ribbon(points: Array<Vec2 & { progress?: number; angle?: number }>, width: number, height: number, trackId: string, offset = 0) {
  // Branch positions carry the same virtual progress as their checkpoint gates.
  // Preserve the precise ramp lip on these ribbons as well as the main road.
  const boundaries = [...new Set(getTrack(trackId).elevations.flatMap(feature =>
    [feature.start, feature.end, feature.end + .05]))].sort((a, b) => a - b);
  const sampled: Array<Vec2 & { progress?: number; angle?: number }> = [];
  points.forEach((point, index) => {
    sampled.push(point);
    const next = points[index + 1];
    if (point.progress === undefined || next?.progress === undefined) return;
    for (const progress of boundaries) if (progress > point.progress && progress < next.progress) {
      const t = (progress - point.progress) / (next.progress - point.progress);
      const turn = point.angle === undefined || next.angle === undefined ? undefined
        : Math.atan2(Math.sin(next.angle - point.angle), Math.cos(next.angle - point.angle));
      sampled.push({ x: point.x + (next.x - point.x) * t, z: point.z + (next.z - point.z) * t, progress,
        angle: turn === undefined ? undefined : point.angle! + turn * t });
    }
  });
  points = sampled;
  const track = getTrack(trackId);
  const positions: number[] = [], indices: number[] = [];
  // A shared one-metre lateral grid keeps the road and its coloured overlays
  // on compatible triangles through turns and elevation changes.
  const left = offset - width / 2, right = offset + width / 2;
  const columns = [left, ...Array.from({ length: Math.max(0, Math.ceil(right) - Math.floor(left) - 1) }, (_, index) => Math.floor(left) + index + 1)
    .filter(value => value > left && value < right), right];
  points.forEach((point, index) => {
    const before = points[Math.max(0, index - 1)]!, after = points[Math.min(points.length - 1, index + 1)]!;
    const dx = after.x - before.x, dz = after.z - before.z, length = Math.hypot(dx, dz) || 1;
    const nx = point.angle === undefined ? dz / length : Math.cos(point.angle);
    const nz = point.angle === undefined ? -dx / length : -Math.sin(point.angle);
    const own = point.progress === undefined ? undefined : trackElevation(point.progress, trackId);
    for (const column of columns) {
      const x = point.x + nx * column, z = point.z + nz * column, near = nearestTrack(x, z, trackId);
      // Over the main road a branch lies on its surface, slope and banking included:
      // a ribbon crossing it at an angle would otherwise rise through the tarmac.
      // Further out it eases onto the height of its own centre line.
      const local = trackElevation(near.progress, trackId) + bankLift(near.progress, (x - near.x) * Math.cos(near.angle) - (z - near.z) * Math.sin(near.angle), track);
      const apart = own === undefined ? 0 : Math.max(0, Math.min(1, (near.distance - track.width / 2 - 2) / 10));
      positions.push(x, height + local + ((own ?? local) - local) * apart * apart * (3 - 2 * apart), z);
    }
    if (index < points.length - 1) for (let column = 0; column < columns.length - 1; column++) {
      const a = index * columns.length + column, b = a + columns.length;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

/** Procedural ribbons, signs and weather, rebuilt only when the shared phase changes. */
export class TrackEventsView {
  readonly group = new THREE.Group();
  private key = '';
  /** Incremented whenever the debris and signs are rebuilt. */
  revision = 0;
  private trackId = 'lagon';
  private readonly box = new THREE.BoxGeometry(1, 1, 1);
  private readonly rock = new THREE.IcosahedronGeometry(1, 0);
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private weather: THREE.Points | null = null;
  private weatherKind = 'clear';
  private signTextures: THREE.Texture[] = [];
  private signMaterials: THREE.Material[] = [];
  constructor(parent?: THREE.Object3D) { this.group.name = 'track-events'; if (parent) this.attach(parent); }
  attach(parent: THREE.Object3D) { parent.add(this.group); return this; }

  private material(color: string) {
    let result = this.materials.get(color);
    if (!result) { result = new THREE.MeshStandardMaterial({ color, roughness: .88, side: THREE.DoubleSide }); this.materials.set(color, result); }
    return result;
  }
  private mesh(geometry: THREE.BufferGeometry, color: string) {
    const result = new THREE.Mesh(geometry, this.material(color)); result.receiveShadow = true; this.group.add(result); return result;
  }
  private post(x: number, z: number, color: string, height = 1, progress?: number) {
    const mesh = this.mesh(this.box, color); mesh.position.set(x, height / 2 + trackElevation(progress ?? nearestTrack(x, z, this.trackId).progress, this.trackId), z); mesh.scale.set(.35, height, .35); return mesh;
  }
  private sign(text: string, point: Vec2 & { progress?: number }, color: string) {
    if (typeof document === 'undefined') return; // Signs are drawn on a canvas; geometry-only use has none.
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 112;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#163038'; ctx.fillRect(0, 0, 512, 112); ctx.strokeStyle = color; ctx.lineWidth = 8; ctx.strokeRect(4, 4, 504, 104);
    ctx.fillStyle = '#fff7df'; ctx.font = 'bold 30px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 256, 56, 480);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: true });
    const y = trackElevation(point.progress ?? nearestTrack(point.x, point.z, this.trackId).progress, this.trackId);
    const sprite = new THREE.Sprite(material); sprite.position.set(point.x, y + 3.8, point.z); sprite.scale.set(9, 1.8, 1);
    this.signTextures.push(texture); this.signMaterials.push(material); this.group.add(sprite);
  }
  private route(route: TrackBranch, event: TrackEventInfo) {
    const track = getTrack(event.trackId);
    const start = route.points[0]!, offset = route.kind === 'shortcut' ? -track.width / 2 - 1.5 : track.width / 2 + 1.5;
    const signPoint = { x: start.x + Math.cos(start.angle) * offset, z: start.z - Math.sin(start.angle) * offset, progress: route.start };
    const warning = trackPoint(route.start - 42, track.id);
    const warningPoint = { x: warning.x + Math.cos(warning.angle) * offset, z: warning.z - Math.sin(warning.angle) * offset, progress: route.start - 42 };
    if (!route.open) { this.sign('RACCOURCI · OUVRE AU TOUR 3', signPoint, '#e7aa61'); return; }
    const accent = route.kind === 'detour' ? '#ffe28c' : route.kind === 'technical' ? '#b7eeff' : '#83f6b7';
    // Compute the frame before slicing overlays, so their first and last rows
    // retain the same tangent as the underlying complete branch.
    const routePoints = route.points.map((point, index) => {
      const before = route.points[Math.max(0, index - 1)]!, after = route.points[Math.min(route.points.length - 1, index + 1)]!;
      return { ...point, angle: Math.atan2(after.x - before.x, after.z - before.z) };
    });
    for (const side of [-1, 1])
      this.mesh(ribbon(routePoints, .55, .035, track.id, side * (route.width / 2 + .275)), accent);
    this.mesh(ribbon(routePoints, route.width, .035, track.id), track.palette.road);
    const overlay = (from: number, to: number, color: string) => {
      const startProgress = route.start + (route.end - route.start) * from, endProgress = route.start + (route.end - route.start) * to;
      const points = routePoints.filter(point => point.progress >= startProgress && point.progress <= endProgress);
      // Keep the coloured lane clear of the main road at branch joins, even
      // from the distant overview camera (one millimetre was insufficient).
      this.mesh(ribbon(points, route.width - .45, .095, track.id), color);
    };
    if (route.kind === 'technical') { overlay(.2, .35, '#70d9a7'); overlay(.6, .7, '#aadce9'); }
    for (let index = 5; index < route.points.length - 4; index += 5) {
      const point = route.points[index]!;
      for (const side of [-1, 1]) {
        const x = point.x + Math.cos(point.angle) * side * (route.width / 2 + .6), z = point.z - Math.sin(point.angle) * side * (route.width / 2 + .6);
        // Posts line the branch where it is a road of its own, never the lanes of the main road it leaves.
        if (nearestTrack(x, z, track.id).distance > track.width / 2 + 1) this.post(x, z, accent, BRANCH_POST_HEIGHT, point.progress);
      }
    }
    const saved = Math.round((1 - route.length / (route.end - route.start)) * 100);
    const title = route.kind === 'detour' ? 'DÉVIATION LARGE · OBJETS' : route.kind === 'technical' ? 'VOIE TURBO · GRANDES COURBES' : 'RACCOURCI · −' + saved + ' %';
    this.sign(title, signPoint, accent);
    this.sign(route.kind === 'shortcut' ? 'RACCOURCI À 40 m · ←' : 'BIFURCATION À 40 m · →', warningPoint, accent);
    // Chevrons show the entry direction without requiring text or a minimap.
    for (const index of [4, 9, 14]) {
      const point = route.points[index]!;
      const arrow = this.mesh(this.box, accent); arrow.position.set(point.x, .075 + trackElevation(point.progress, track.id), point.z); arrow.rotation.y = point.angle; arrow.scale.set(.8, .05, 2.5);
    }
  }

  private rebuild(event: TrackEventInfo, states?:readonly TrackInteractionState[], time=0) {
    this.clear();
    const track = getTrack(event.trackId);
    this.trackId = track.id;
    for (const [index,module] of (track.interactions??[]).entries()) {
      const status=interactionStatus(module,states,time),color=status==='active'?'#75f4ba':status==='warning'?'#ffcc62':status==='cooldown'?'#7e8e92':'#68c8cb';
      const plate=this.mesh(trackZoneGeometry(track.id,{start:Math.max(0,module.trigger-1.3),end:Math.min(track.length,module.trigger+1.3),width:module.width,offset:module.offset},.21),color);
      plate.name=`interaction-plate-${module.id}`; plate.renderOrder=150;
      const target=this.mesh(trackZoneGeometry(track.id,module,.13),status==='active'?'#75f4ba':'#426d76');
      target.name=`interaction-target-${module.id}`;
      const pose=roadPose(module.trigger,track.id,track.width/2+2);
      this.sign(`PLAQUE ${index+1} → ${module.kind==='boost'?'TURBO':'SAUT'} · ${status==='active'?'ACTIF':status==='warning'?'DANS 1 s':status==='cooldown'?'RECHARGE':'ROULEZ DESSUS'}`,
        {x:pose.x,z:pose.z,progress:module.trigger},color);
      const destination=roadPose(module.start,track.id,track.width/2+2);
      this.sign(`CIBLE ${index+1} · ${module.kind==='boost'?'TURBO':'SAUT'} ${status==='active'?'ACTIF':'SUR PLAQUE'}`,
        {x:destination.x,z:destination.z,progress:module.start},color);
    }
    for (const route of event.branches) this.route(route, event);
    for (const blocker of event.blockers) {
      const icy = track.theme === 'ice', wet = track.theme === 'tropical';
      const zone = this.mesh(this.box, icy ? '#d6f3fb' : wet ? '#368e9d' : '#473e3a');
      const groundY = blocker.elevation;
      zone.position.set(blocker.x, groundY + .085, blocker.z); zone.rotation.y = blocker.angle;
      zone.scale.set(blocker.halfWidth * 2, .17, blocker.halfLength * 2 + 1.2);
      for (let index = 0; index < 9; index++) {
        const across = (index / 8 * 2 - 1) * (blocker.halfWidth - 1);
        const object = this.mesh(wet || track.theme === 'neon' ? this.box : this.rock,
          icy ? '#bddfec' : wet ? '#edbd67' : track.theme === 'neon' ? '#f2ab61' : '#906b55');
        object.position.set(blocker.x + Math.cos(blocker.angle) * across, groundY + blocker.height * (.65 + index % 2 * .15) / (wet || track.theme === 'neon' ? 1.6 : 2.4),
          blocker.z - Math.sin(blocker.angle) * across);
        object.scale.set(1.4, blocker.height * (1.3 + index % 2 * .3) / (wet || track.theme === 'neon' ? 1.6 : 2.4), 1.2); object.rotation.y = blocker.angle + index * .18; object.castShadow = true;
      }
      const before = { x: blocker.x - Math.sin(blocker.angle) * 4, z: blocker.z - Math.cos(blocker.angle) * 4 };
      this.sign('ROUTE BARRÉE · DÉVIATION →', before, '#ffc16d');
    }
    // Authored events supply the exact active intervals used by the simulation.
    // Draw the first matching zone last, above permanent surface decorations.
    let overlayOrder = 100;
    for (const zone of [...(event.zones ?? [])].reverse()) {
      const color = zone.kind === 'boost' ? '#efc457' : zone.kind === 'ice' ? '#b5eaf1' : '#745449';
      const patch = this.mesh(trackZoneGeometry(track.id, zone, .18), color);
      patch.renderOrder = overlayOrder++;
      patch.name = `event-zone-${zone.id}`;
      patch.userData = { kind: zone.kind, start: zone.start, end: zone.end };
      const pose = roadPose(zone.start, track.id, track.width / 2 + 2);
      this.sign(zone.kind === 'boost' ? 'TURBO · CE TOUR' : zone.kind === 'ice' ? 'GLACE · CE TOUR' : 'BOUE · CE TOUR',
        { x: pose.x, z: pose.z, progress: zone.start }, color);
    }
    if (event.weather !== 'clear') {
      const surfaceColor = track.theme === 'ice' ? '#c6e8f5' : '#847c6c';
      const weatherBands = track.id.startsWith('custom-') ? [] : [[.51, .565], ...(event.level === 3 && event.stage === 2 ? [[.86, .90]] : [])];
      for (const [start, end] of weatherBands) {
        const points = Array.from({ length: 19 }, (_, i) => { const progress = (start + (end - start) * i / 18) * track.length; return { ...trackPoint(progress, track.id), progress }; });
        this.mesh(ribbon(points, track.width - .2, .065, track.id), surfaceColor);
        this.sign(track.theme === 'ice' ? 'VERGLAS' : event.weather === 'ash' ? 'CENDRES · RALENTISSEZ' : 'SOL DÉTREMPÉ', points[0]!, '#a8d8ea');
      }
      const positions = new Float32Array(180 * 3);
      const minX = Math.min(...track.points.map(point => point.x)) - 24, maxX = Math.max(...track.points.map(point => point.x)) + 24;
      const minZ = Math.min(...track.points.map(point => point.z)) - 24, maxZ = Math.max(...track.points.map(point => point.z)) + 24;
      for (let i = 0; i < 180; i++) {
        positions[i * 3] = minX + ((i * .61803398875) % 1) * (maxX - minX);
        positions[i * 3 + 1] = ((i * .38196601125) % 1) * 24;
        positions[i * 3 + 2] = minZ + ((i * .41421356237) % 1) * (maxZ - minZ);
      }
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const material = new THREE.PointsMaterial({ color: event.weather === 'ash' ? '#a87e58' : '#dceef5', size: event.weather === 'snow' ? .45 : .2,
        transparent: true, opacity: .6, depthWrite: false });
      this.signMaterials.push(material); this.weather = new THREE.Points(geometry, material); this.weather.frustumCulled = false;
      this.weatherKind = event.weather; this.group.add(this.weather);
    }
    // Posts, arrows and debris share a handful of draw calls and geometries.
    const batches = new Map<string, THREE.Mesh[]>();
    for (const child of this.group.children) if (child instanceof THREE.Mesh && (child.geometry === this.box || child.geometry === this.rock)) {
      const key = child.geometry.uuid + ':' + (child.material as THREE.Material).uuid;
      const batch = batches.get(key) ?? []; batch.push(child); batches.set(key, batch);
    }
    for (const batch of batches.values()) {
      const first = batch[0]!;
      const instances = new THREE.InstancedMesh(first.geometry, first.material, batch.length);
      batch.forEach((object, index) => { object.updateMatrix(); instances.setMatrixAt(index, object.matrix); object.removeFromParent(); });
      instances.castShadow = batch.some(object => object.castShadow); instances.receiveShadow = true; this.group.add(instances);
    }
  }

  update(trackId: string, stage = 0, level = 0, time = 0, states?:readonly TrackInteractionState[]) {
    const base=getTrackEvent(trackId,stage,level),active=interactionZones(trackId,states,time);
    const event=active.length?{...base,zones:[...active,...(base.zones??[])]}:base;
    const key = [event.trackId,event.stage,event.level,...(getTrack(trackId).interactions??[]).map(module=>`${module.id}:${interactionStatus(module,states,time)}`)].join(':');
    if (key !== this.key) { this.key = key; this.rebuild(event,states,time); this.revision++; }
    if (this.weather) {
      const positions = this.weather.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < positions.count; i++) positions.setY(i, ((i * 9.167 - time * (this.weatherKind === 'snow' ? 2.3 : 9)) % 24 + 24) % 24);
      positions.needsUpdate = true;
    }
  }
  /** Roadside directions must never become a full-screen billboard when the
   * chase camera passes close to them, especially in portrait orientation. */
  updateCamera(camera: THREE.Camera) {
    for (const child of this.group.children) if (child instanceof THREE.Sprite) {
      const distance = child.position.distanceTo(camera.position);
      child.material.opacity = Math.max(0, Math.min(1, (distance - 18) / 12));
      child.visible = child.material.opacity > 0;
    }
  }
  private clear() {
    const geometries = new Set<THREE.BufferGeometry>();
    this.group.traverse(object => { if (object instanceof THREE.Mesh || object instanceof THREE.Points) geometries.add(object.geometry); if (object instanceof THREE.InstancedMesh) object.dispose(); });
    this.group.clear();
    for (const geometry of geometries) if (geometry !== this.box && geometry !== this.rock) geometry.dispose();
    for (const texture of this.signTextures) texture.dispose();
    for (const material of this.signMaterials) material.dispose();
    this.signTextures = []; this.signMaterials = []; this.weather = null;
  }
  dispose() { this.clear(); this.group.removeFromParent(); this.box.dispose(); this.rock.dispose(); for (const material of this.materials.values()) material.dispose(); this.materials.clear(); this.key = ''; }
}
