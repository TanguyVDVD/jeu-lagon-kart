import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TRACKS, reliefElevation, trackPoint } from '../shared/track.js';
import { getTrackEvent, nearestDriveableTrack } from '../shared/track-events.js';
import { groundLift } from '../shared/road-pose.js';
import { buildTrackTerrain } from '../client/scenery-terrain.js';
import { buildSceneryWorld } from '../client/scenery-world.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

for(const track of TRACKS) test(`${track.id}: composed scenery preserves every route and stays within a mobile geometry budget`,()=>{
  const world=buildSceneryWorld(track),terrain=buildTrackTerrain(track);terrain.updateMatrixWorld(true);
  const landmarks=world.userData.landmarks as Array<{name:string,x:number,z:number,radius:number}>;
  assert.ok(landmarks.length>=3,`${track.id}: visible themed landmarks`);
  for(const landmark of landmarks){
    const near=nearestDriveableTrack(landmark.x,landmark.z,track.id,2,3);
    assert.ok(near.distance>near.width/2+landmark.radius+7,`${landmark.name}: ordinary/future route clearance`);
  }
  let triangles=0;
  for(const scene of[world,terrain])scene.traverse(object=>{if(object instanceof THREE.Mesh){
    const position=object.geometry.getAttribute('position');triangles+=(object.geometry.index?.count??position.count)/3;
    for(let i=0;i<position.count;i++)assert.ok(Number.isFinite(position.getX(i))&&Number.isFinite(position.getY(i))&&Number.isFinite(position.getZ(i)));
  }});
  assert.ok(triangles<35000,`${track.id}: ${triangles} triangles in static world+terrain`);
  const ray=new THREE.Raycaster(new THREE.Vector3(),new THREE.Vector3(0,-1,0));
  const routeSamples=Array.from({length:Math.ceil(track.length/4)},(_,i)=>({...trackPoint(i*4,track.id),progress:i*4,width:track.width}));
  routeSamples.push(...getTrackEvent(track.id,2,3).branches.flatMap(branch=>branch.points.map(p=>({...p,width:branch.width}))));
  const fullWidthSamples=routeSamples.flatMap(p=>[-1,0,1].map(side=>({...p,x:p.x+Math.cos(p.angle)*side*(p.width/2+3),z:p.z-Math.sin(p.angle)*side*(p.width/2+3)})));
  
  for(const p of fullWidthSamples){
    ray.ray.origin.set(p.x,100,p.z);
    const hit=ray.intersectObject(terrain,true)[0];
    assert.ok(hit,`${track.id}: terrain supports the driving corridor`);
    // The hills carry the road: the ground stays under its surface, banking included.
    const surface=reliefElevation(p.progress,track)+groundLift(p.x,p.z,track.id);
    assert.ok(hit.point.y<surface-.1,`${track.id}: raised landscape covers road at ${p.x.toFixed(1)},${p.z.toFixed(1)}: ${hit.point.y} >= ${surface}`);
  }
});

test('Kenney CC0 tree is a tiny self-contained, unmodified local asset with its source and license',()=>{
  const original=readFileSync(new URL('../assets/sources/kenney-nature/tree-original.glb',import.meta.url));
  const served=readFileSync(new URL('../client/public/models/scenery/kenney-tree-v1.glb',import.meta.url));
  assert.deepEqual(served,original);assert.equal(served.length,14480);
  assert.equal(createHash('sha256').update(served).digest('hex'),'caed11c17aeb268c4351f1eb147e9a07ec79e29070e11ae18d7bc68c2e2c4570');
  const document=JSON.parse(served.subarray(20,20+served.readUInt32LE(12)).toString());
  assert.equal(document.meshes.length,1);assert.equal(document.materials.length,2);
  assert.equal(document.textures?.length??0,0);assert.equal(document.animations?.length??0,0);
  const primitives=document.meshes.flatMap((mesh:{primitives:Array<{indices:number}>})=>mesh.primitives);
  assert.equal(primitives.reduce((sum:number,p:{indices:number})=>sum+document.accessors[p.indices].count/3,0),200);
  const evidence=JSON.parse(readFileSync(new URL('../assets/sources/kenney-nature/source-page-evidence.json',import.meta.url),'utf8'));
  assert.equal(evidence.modelMetadata.Creator.Username,'Kenney');assert.equal(evidence.modelMetadata.Licence,'CC0 1.0');
  assert.match(readFileSync(new URL('../assets/sources/kenney-nature/LICENSE-CC0-1.0.txt',import.meta.url),'utf8'),/CC0 1.0 Universal/);
});
