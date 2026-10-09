import * as THREE from 'three';
import { TRACKS, trackPoint, type TrackDefinition } from '../shared/track';
import { nearestDriveableTrack } from '../shared/track-events';
import { createSceneryTree } from './scenery-assets';

const palette = new Map<string, THREE.MeshStandardMaterial>();
function material(color: string, glow = false) {
  const key=`${color}:${glow}`;
  let m=palette.get(key);
  if(!m) { m=new THREE.MeshStandardMaterial({color,roughness:.86,flatShading:true,
    emissive:glow?color:'#000000',emissiveIntensity:glow?.5:0});palette.set(key,m); }
  return m;
}
/** Composed landmarks, midground architecture, and small vegetation all use original geometry,
 * except the optional CC0 Kenney tree. No scenery changes the authoritative driving simulation. */
export function buildSceneryWorld(track: TrackDefinition): THREE.Group {
  const world=new THREE.Group();world.name=`world-${track.id}`;
  // Reuse the chosen theme's decoration recipe while placing it against the
  // creation's actual route. Official circuits retain their distinct recipes.
  const sceneryId=track.id.startsWith('custom-') ? TRACKS.find(candidate=>candidate.theme===track.theme)!.id : track.id;
  const cube=new THREE.BoxGeometry(1,1,1), cylinder=new THREE.CylinderGeometry(1,1,1,10), cone=new THREE.ConeGeometry(1,1,8);
  const rock=new THREE.IcosahedronGeometry(1,0), crown=new THREE.IcosahedronGeometry(1,1), torus=new THREE.TorusGeometry(1,.13,5,24);
  const up=new THREE.Vector3(0,1,0);
  const points=track.points, cx=(Math.min(...points.map(p=>p.x))+Math.max(...points.map(p=>p.x)))/2;
  const cz=(Math.min(...points.map(p=>p.z))+Math.max(...points.map(p=>p.z)))/2;
  const radius=Math.max(...points.map(p=>Math.hypot(p.x-cx,p.z-cz)));
  const reserved:Array<{x:number,z:number,radius:number,name:string}>=[];
  let seed=track.id.split('').reduce((n,c)=>n*31+c.charCodeAt(0),42)>>>0;
  const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  const add=(g:THREE.Object3D,geometry:THREE.BufferGeometry,color:string,x:number,y:number,z:number,sx=1,sy=1,sz=1,glow=false)=>{
    const mesh=new THREE.Mesh(geometry,material(color,glow));mesh.position.set(x,y,z);mesh.scale.set(sx,sy,sz);
    mesh.castShadow=true;mesh.receiveShadow=true;g.add(mesh);return mesh;
  };
  const box=(g:THREE.Object3D,color:string,x:number,y:number,z:number,sx:number,sy:number,sz:number,glow=false)=>add(g,cube,color,x,y,z,sx,sy,sz,glow);
  const beam=(g:THREE.Object3D,color:string,a:THREE.Vector3,b:THREE.Vector3,w:number)=>{
    const d=b.clone().sub(a),m=box(g,color,(a.x+b.x)/2,(a.y+b.y)/2,(a.z+b.z)/2,w,d.length(),w);
    m.quaternion.setFromUnitVectors(up,d.normalize());return m;
  };
  const clear=(x:number,z:number,r:number)=>{
    if(reserved.some(p=>Math.hypot(p.x-x,p.z-z)<=p.radius+r+2))return false;
    const near=nearestDriveableTrack(x,z,track.id,2,3);
    const extra=sceneryId==='sky'||sceneryId==='foundry'?35:8;
    return near.distance>near.width/2+r+extra;
  };
  function site(name:string,footprint:number,desiredX=cx,desiredZ=cz) {
    let best:{x:number,z:number,score:number}|undefined;
    for(let ring=0;ring<10;ring++) {
      // Further rings cannot improve the non-negative distance score.
      if(best && ring*radius/6>best.score)break;
      for(let i=0;i<(ring?24:1);i++) {
      const angle=i*Math.PI/12+ring*.12,distance=ring*radius/6;
      const x=desiredX+Math.sin(angle)*distance,z=desiredZ+Math.cos(angle)*distance;
      if(clear(x,z,footprint)) { const score=distance+Math.hypot(x-cx,z-cz)*.15;
        if(!best||score<best.score) best={x,z,score}; }
      }
    }
    if(!best) return null;
    const g=new THREE.Group();g.name=name;g.position.set(best.x,0,best.z);world.add(g);
    reserved.push({x:best.x,z:best.z,radius:footprint,name});return g;
  }
  const at=(name:string,r:number,fraction:number,offset:number)=>{
    const p=trackPoint(fraction*track.length,track.id);
    return site(name,r,p.x+Math.cos(p.angle)*offset,p.z-Math.sin(p.angle)*offset);
  };
  const tree=(g:THREE.Object3D,x:number,z:number,h:number,pine=false)=>{
    const imported=!pine?createSceneryTree(h):null;
    if(imported){ imported.position.set(x,0,z);g.add(imported);return; }
    add(g,cylinder,'#816749',x,h*.34,z,h*.055,h*.68,h*.055);
    if(pine)for(let i=0;i<3;i++)add(g,cone,i%2?'#547856':'#426748',x,h*(.57+i*.17),z,h*(.31-i*.055),h*.51,h*(.31-i*.055));
    else {add(g,crown,'#547e58',x,h*.7,z,h*.27,h*.37,h*.27);add(g,crown,'#769863',x+h*.11,h*.92,z,h*.23,h*.25,h*.23);}
  };
  const palm=(g:THREE.Object3D,x:number,z:number,h:number)=>{
    const trunk=add(g,new THREE.CylinderGeometry(.65,1,1,6),'#a48960',x,h*.45,z,.55,h*.9,.55);trunk.rotation.z=.12;
    for(let i=0;i<6;i++){const a=i*Math.PI/3;const leaf=add(g,cone,i%2?'#588865':'#75a075',x+Math.sin(a)*2.5,h,z+Math.cos(a)*2.5,.65,6,1.3);leaf.rotation.set(1.2,a,0,'YXZ');}
  };
  function cliff(g:THREE.Object3D,x:number,z:number,h:number,w:number,ice=false){
    for(let tier=0;tier<3;tier++) add(g,new THREE.CylinderGeometry(.84,1,1,7),ice?(tier===2?'#e9f5ec':tier===1?'#abd3de':'#7eacbb'):(tier===2?'#e0ad78':tier===1?'#c28b61':'#ac7051'),x,h*(tier*.29+.15),z,w*(1-tier*.13),h*.34,w*(.8-tier*.1));
  }
  function windows(g:THREE.Object3D,w:number,h:number,d:number,color:string){
    for(let y=3;y<h-2;y+=4)for(let x=-w/2+2;x<w/2-1;x+=4){box(g,color,x,y,d/2+.04,1.2,1.35,.08,true);box(g,color,x,y,-d/2-.04,1.2,1.35,.08,true);}
  }
  const floor=(g:THREE.Object3D,color:string,x:number,z:number,w:number,d:number)=>{const m=box(g,color,x,-.03,z,w,.035,d);m.castShadow=false;return m;};
  const flag=(g:THREE.Object3D,x:number,y:number,z:number,color:string)=>{box(g,'#ead8b4',x,y,z,.18,6,.18);box(g,color,x+1.8,y+1.7,z,3.5,1.5,.15);};

  if(sceneryId==='lagon') {
    const lighthouse=at('alizes-lighthouse',16,.48,48);
    if(lighthouse){const g=lighthouse;add(g,cylinder,'#e7dfc5',0,1,0,11,2,11);
      for(let i=0;i<5;i++)add(g,new THREE.CylinderGeometry(.88,1,1,12),i%2?'#488d9c':'#fff0d2',0,4+i*5,0,5-i*.28,5,5-i*.28);
      add(g,cylinder,'#eee1bd',0,27,0,5,1,5);add(g,cylinder,'#80c3c0',0,29,0,3.7,3.5,3.7);add(g,cone,'#e18d60',0,32,0,5,3,5);
      for(const x of[-7,7])palm(g,x,5,10);floor(g,'#edd7a7',0,0,27,25);}
    const resort=at('beach-resort',24,.13,-50);
    if(resort){for(let i=-1;i<=1;i++){box(resort,'#eeddb4',i*12,3,0,9,6,10);const roof=add(resort,cone,'#bc805b',i*12,7.2,0,7,3,7);roof.rotation.y=Math.PI/4;box(resort,'#689a9e',i*12,3,5.04,5,2.5,.1);palm(resort,i*12,12,9);}}
    for(let i=0;i<11;i++){const g=at(`beach-palm-${i}`,6,i/11,track.width/2+15);if(g)palm(g,0,0,10+random()*4);}
  } else if(sceneryId==='canyon') {
    const mesa=site('canyon-stratified-mesa',35);if(mesa){cliff(mesa,-9,0,38,23);cliff(mesa,19,6,27,12);cliff(mesa,-18,19,18,11);}
    const arch=at('canyon-natural-arch',26,.33,60);if(arch){cliff(arch,-16,0,24,8);cliff(arch,16,0,24,8);const top=box(arch,'#cf976c',0,24,0,36,7,10);top.rotation.z=.08;for(let i=0;i<6;i++)box(arch,'#a96f50',-13+i*5,24.5,5.1,.22,4,.15);}
    for(let i=0;i<10;i++){const g=at(`canyon-buttes-${i}`,11,i/10,35);if(g){cliff(g,0,0,12+random()*15,8);box(g,'#67835c',10,3,0,1,6,1);box(g,'#67835c',11,3,0,3,.8,.8);}}
  } else if(sceneryId==='glacier') {
    const glacier=site('glacier-ice-cathedral',35);if(glacier){for(let i=-2;i<=2;i++) {const h=30+(2-Math.abs(i))*13;cliff(glacier,i*10,Math.abs(i)*6,h,11,true);const crystal=add(glacier,new THREE.OctahedronGeometry(1),'#b9e7eb',i*10,h+2,Math.abs(i)*6,5,12,5);crystal.rotation.z=i*.11;}}
    const camp=at('polar-research-station',20,.55,-48);if(camp){box(camp,'#cadbdd',0,3,0,24,6,10);box(camp,'#eb8b61',0,6.3,0,25,1,11);for(let x=-8;x<=8;x+=4)box(camp,'#4e8299',x,3.5,5.1,2,2,.1);box(camp,'#7f939b',10,10,0,.25,10,.25);const dish=add(camp,cone,'#e8eee2',10,16,0,3,2,3);dish.rotation.z=.6;}
    for(let i=0;i<12;i++){const g=at(`ice-ridges-${i}`,10,i/12,32);if(g){for(let j=0;j<3;j++){const m=add(g,new THREE.OctahedronGeometry(1),j%2?'#aedee8':'#82b9d1',j*3-3,4+j*2,0,2,6+j*2,3);m.rotation.z=(j-1)*.23;}}}
  } else if(sceneryId==='neon') {
    const hub=site('neon-tower-district',33);if(hub){for(let i=-1;i<=1;i++)for(let j=-1;j<=1;j++){const block=new THREE.Group();block.position.set(i*16,0,j*16);hub.add(block);const h=24+(i+1)*11+(j+1)*5;box(block,(i+j)%2?'#343c5d':'#414765',0,h/2,0,12,h,12);windows(block,12,h,12,(i+j)%2?'#71d7df':'#da8cce');box(block,'#80dcdf',0,h,0,12.5,.3,12.5,true);if(!i&&!j){add(block,cylinder,'#788dae',0,h+8,0,.3,16,.3);add(block,torus,'#e389d5',0,h+4,0,5,5,5,true).rotation.x=Math.PI/2;}}}
    for(let i=0;i<9;i++){const g=at(`neon-boulevard-${i}`,10,i/9,27);if(g){const h=15+i%3*8;box(g,'#343d59',0,h/2,0,11,h,10);windows(g,11,h,10,i%2?'#ef98cb':'#68cadc');box(g,'#bf85d3',0,h+2,0,12,4,.45,true);for(let x=-4;x<=4;x+=2)box(g,'#e9e0dc',x,h+2,-.24,.65,1.8,.08,true);}}
  } else if(sceneryId==='mangrove') {
    const village=site('mangrove-stilt-village',30);if(village){floor(village,'#427c70',0,0,57,49);for(let i=-1;i<=1;i++){for(const x of[-3,3])for(const z of[-4,4])box(village,'#876b51',i*16+x,2,z,.5,4,.5);box(village,'#ae9369',i*16,4.2,0,10,.5,11);box(village,'#c5ad7d',i*16,7,0,8,5,8);add(village,cone,'#7b9673',i*16,11,0,7,4,7).rotation.y=Math.PI/4;box(village,'#5a786e',i*16,7,4.1,2.5,3,.1);}box(village,'#aa9168',0,3.8,10,42,.3,3);}
    for(let i=0;i<16;i++){const g=at(`mangrove-root-cluster-${i}`,9,i/16,29);if(g){tree(g,0,0,14);for(let k=0;k<5;k++){const a=k*Math.PI*.4;beam(g,'#7f6950',new THREE.Vector3(0,4,0),new THREE.Vector3(Math.sin(a)*7,0,Math.cos(a)*7),.65);}floor(g,'#4b8876',0,0,17,16);for(let j=0;j<3;j++)add(g,cylinder,'#83a867',j*4-3,.04,6,1.3,.05,1.1);}}
  } else if(sceneryId==='dunes') {
    const ruins=site('dunes-lost-observatory',34);if(ruins){const pyramid=add(ruins,new THREE.ConeGeometry(1,1,4),'#dbb17a',0,16,0,29,32,29);pyramid.rotation.y=Math.PI/4;for(let i=0;i<5;i++)box(ruins,'#c49766',0,i*3+.7,20-i*2,18-i*2,.5,3);for(const x of[-25,25]){box(ruins,'#b88a60',x,12,0,4,24,4);add(ruins,cone,'#eed195',x,25,0,3,3,3);}}
    const oasis=at('dunes-oasis-caravan',22,.62,55);if(oasis){add(oasis,cylinder,'#6ea8a1',0,-.04,0,18,.03,12);for(let i=0;i<4;i++)palm(oasis,Math.sin(i*1.6)*17,Math.cos(i*1.6)*12,9);for(let i=-1;i<=1;i++){const roof=add(oasis,cone,i%2?'#ca8d61':'#ddbf8b',i*10,3,18,6,5,6);roof.rotation.y=.6;}}
    for(let i=0;i<8;i++){const g=at(`dunes-wind-carved-rock-${i}`,10,i/8,32);if(g){const dune=add(g,rock,'#dfb581',0,3,0,11,5,8);dune.rotation.y=i*.7;add(g,rock,'#c49a70',4,2,3,5,4,5);}}
  } else if(sceneryId==='volcan') {
    const volcano=site('volcano-open-caldera',45);if(volcano){add(volcano,new THREE.CylinderGeometry(.49,1,1,12,1,true),'#5a4c48',0,23,0,42,46,42);add(volcano,cylinder,'#f9a64b',0,43,0,20,.3,20,true);add(volcano,torus,'#383c40',0,46,0,21,21,12).rotation.x=Math.PI/2;
      for(let i=0;i<8;i++){const a=i*Math.PI/4;const ridge=add(volcano,rock,i%2?'#594e4b':'#776454',Math.sin(a)*26,12,Math.cos(a)*26,14,18,12);ridge.rotation.y=a;}
      for(let i=0;i<4;i++)add(volcano,crown,'#a49387',i*5,57+i*10,0,7+i*2,7+i*2,7+i*2);}
    for(let i=0;i<10;i++){const g=at(`basalt-vent-${i}`,12,i/10,39);if(g){for(let j=0;j<5;j++){const h=5+(j%3)*4;add(g,new THREE.CylinderGeometry(1,1,1,6),j%2?'#474a4c':'#63605b',(j-2)*3,h/2,0,2,h,2);}floor(g,'#dc8a45',0,4,18,3);}}
  } else if(sceneryId==='forest') {
    const ancient=site('forest-ancient-tree-house',30);if(ancient){tree(ancient,0,0,60);box(ancient,'#a0875e',8,16,3,17,1,13);box(ancient,'#c8b78b',8,21,3,12,9,10);add(ancient,cone,'#71885c',8,28,3,10,6,9).rotation.y=Math.PI/4;box(ancient,'#526f62',8,21,8.1,4,4,.1);
      for(let i=0;i<12;i++)box(ancient,'#aa8c62',15,1+i*1.2,5,3,.2,.45);for(const x of[13.5,16.5])box(ancient,'#80694d',x,8,5,.2,17,.2);}
    for(let i=0;i<24;i++){const g=at(`forest-grove-${i}`,8,i/24,28+i%3*15);if(g){tree(g,0,0,16+i%5*3,i%4===0);if(i%3===0){add(g,cylinder,'#e6d8ae',5,.8,0,.4,1.6,.4);add(g,crown,'#c98270',5,1.8,0,2,.65,2);}}}
    const camp=at('forest-waterfall-camp',23,.56,-53);if(camp){cliff(camp,0,-3,23,13,true);box(camp,'#a5d6d2',0,10.8,9,7,22,.2);floor(camp,'#77a99b',0,12,20,13);for(const x of[-17,17])tree(camp,x,0,21,true);}
  } else if(sceneryId==='harbor') {
    const port=site('harbor-container-terminal',37);if(port){floor(port,'#687f83',0,0,68,60);for(let row=0;row<3;row++)for(let col=0;col<4;col++){const color=['#bf795f','#699399','#d7b878'][(row+col)%3]!;const x=col*13-20,z=row*17-17;box(port,color,x,3,z,11,6,14);for(let r=-4;r<=4;r+=2)box(port,'#ddcba6',x+r,3,z+7.02,.13,5.4,.12);if((row+col)%3===0)box(port,color,x,9,z,11,6,14);}}
    const crane=at('harbor-shipyard-crane',29,.35,65);if(crane){for(const x of[-14,14]){box(crane,'#e4be6c',x,20,0,1.5,40,2);for(let y=3;y<38;y+=8)beam(crane,'#bd9957',new THREE.Vector3(x-2,y,0),new THREE.Vector3(x+2,y+7,0),.35);}box(crane,'#dfb360',0,39,0,47,2,4);box(crane,'#637c85',-7,36,0,7,5,6);beam(crane,'#d0a15a',new THREE.Vector3(-23,39,0),new THREE.Vector3(0,52,0),.7);beam(crane,'#d0a15a',new THREE.Vector3(23,39,0),new THREE.Vector3(0,52,0),.7);box(crane,'#536f78',18,25,0,.18,28,.18);box(crane,'#536f78',18,11,0,4,.6,1);}
    const ship=at('harbor-cargo-ship',30,.7,-70);if(ship){floor(ship,track.palette.water,0,0,52,63);add(ship,rock,'#586f7e',0,2,0,12,5,28);box(ship,'#e6dfc6',0,8,-14,14,10,10);box(ship,'#6da5ae',0,10,-8.95,12,2,.1);for(let j=0;j<3;j++)box(ship,['#be795d','#d8b768','#74989a'][j]!,0,7,j*10-1,12,6,8);}
  } else if(sceneryId==='sky') {
    const observatory=site('sky-floating-observatory',33);if(observatory){const island=add(observatory,cone,'#9d8dba',0,-12,0,31,26,28);island.rotation.z=Math.PI;add(observatory,cylinder,'#b5c8a1',0,.7,0,29,1.3,25);add(observatory,cylinder,'#e0d6bc',0,11,0,10,21,10);add(observatory,crown,'#a0bad0',0,22,0,12,9,12);const telescope=add(observatory,cylinder,'#e7d2aa',6,28,0,2,18,2);telescope.rotation.z=-.8;for(let i=0;i<5;i++)add(observatory,crown,'#f0f1ee',-21+i*10,-9,15,11,5,9);}
    for(let i=0;i<8;i++){const g=at(`sky-satellite-island-${i}`,16,i/8,75);if(g){const island=add(g,cone,'#a69abe',0,-8,0,13,18,13);island.rotation.z=Math.PI;add(g,cylinder,'#c5d6a2',0,1,0,13,1.3,13);if(i%2){add(g,crown,i%3?'#d9abc7':'#dcc18d',0,33,0,10,14,10);box(g,'#bd9b77',0,13,0,4,4,4);for(const x of[-2,2])beam(g,'#e0d3b1',new THREE.Vector3(x,15,0),new THREE.Vector3(x*2,23,0),.15);}else{tree(g,0,0,13);}}}
  } else if(sceneryId==='foundry') {
    const works=site('foundry-steel-works',39);if(works){box(works,'#8b7667',0,9,0,57,18,43);for(let x=-20;x<=20;x+=20){box(works,'#66777a',x,20,0,16,5,40);add(works,cylinder,'#997860',x,35,-10,3,40,3);for(const y of[28,36,44,52])add(works,cylinder,'#c6b597',x,y,-10,3.12,1.2,3.12);box(works,'#e8a361',x,9,21.55,10,8,.15,true);add(works,crown,'#b5ada1',x+3,62,-10,7,8,7);}}
    const reactor=at('foundry-cooling-towers',23,.52,-75);if(reactor){for(const x of[-11,11]){add(reactor,new THREE.CylinderGeometry(.75,1,1,12,1,true),'#96968b',x,18,0,10,36,10);add(reactor,torus,'#c4bda9',x,36,0,7.5,7.5,4).rotation.x=Math.PI/2;add(reactor,crown,'#c7c2b5',x,46,0,8,9,8);}}
    for(let i=0;i<6;i++){const g=at(`foundry-valve-station-${i}`,12,i/6,61);if(g){box(g,'#596f76',0,3,0,18,6,9);for(const x of[-5,5]){add(g,cylinder,'#a9a99c',x,9,0,1.5,13,1.5);const valve=add(g,torus,'#dbab67',x,13,2,3,3,3);for(let j=0;j<4;j++){const bar=box(g,'#dbab67',x,13,2,.3,6,.3);bar.rotation.z=j*Math.PI/4;}valve.rotation.y=.1;}}}
  } else if(sceneryId==='castle') {
    const fort=site('castle-royal-citadel',45);if(fort){for(const z of[-25,25])box(fort,'#b2b09c',0,8,z,50,16,3);for(const x of[-25,25])box(fort,'#b2b09c',x,8,0,3,16,50);for(const x of[-25,25])for(const z of[-25,25]){add(fort,cylinder,'#a1a794',x,14,z,6,28,6);add(fort,cone,'#8e7ea7',x,33,z,8,11,8);flag(fort,x,41,z,'#bc96b1');for(let k=0;k<6;k++)box(fort,'#c8c4ad',x+Math.cos(k*Math.PI/3)*5.5,28,z+Math.sin(k*Math.PI/3)*5.5,2,3,2);}for(let i=-21;i<=21;i+=6)for(const z of[-25,25])box(fort,'#cfccb7',i,17,z,3,3,3.3);box(fort,'#a1a797',0,18,0,23,36,23);add(fort,cone,'#9685aa',0,43,0,18,16,18);for(let y=12;y<=29;y+=8)box(fort,'#707d80',0,y,11.56,3,5,.1);}
    const gate=at('castle-garden-gate',24,.42,54);if(gate){for(const x of[-15,15]){add(gate,cylinder,'#b7b5a0',x,10,0,6,20,6);add(gate,cone,'#9787b0',x,25,0,8,12,8);flag(gate,x,34,0,'#cfaf75');}box(gate,'#c3c0aa',0,15,0,28,5,5);for(let i=-10;i<=10;i+=4)box(gate,'#8f8267',i,9,0,.35,10,.4);floor(gate,'#83a172',0,0,45,20);}
    for(let i=0;i<12;i++){const g=at(`castle-orchard-${i}`,7,i/12,28);if(g){tree(g,0,0,12);add(g,cylinder,'#b1b69f',5,1,2,1.2,2,1.2);}}
  }
  // A few ground-level rocks and grasses give scale without hiding the driving line.
  if(!['neon','harbor','foundry','sky'].includes(track.theme))for(let i=0;i<14;i++){
    const p=trackPoint((i+.5)*track.length/14,track.id),side=i%2?1:-1,distance=track.width/2+14;
    const x=p.x+Math.cos(p.angle)*side*distance,z=p.z-Math.sin(p.angle)*side*distance;
    if(!clear(x,z,3))continue;
    const g=new THREE.Group();g.position.set(x,0,z);world.add(g);add(g,rock,track.theme==='ice'?'#c1e0df':track.theme==='canyon'?'#c49068':'#8d9980',0,.65,0,2,1.2,1.5);
  }
  world.userData.landmarks=reserved;
  world.userData.theme=track.theme;
  return world;
}
