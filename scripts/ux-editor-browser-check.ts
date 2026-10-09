import { homeControl } from './menu-navigation.js';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium,type Browser,type Page} from 'playwright';
import {createGameServer} from '../server/app.js';
import {sampleCustomTrackAnchors,type CustomTrackDraft,type StoredCustomTrack} from '../shared/custom-tracks.js';
import {customTrackModule,type TrackModuleSelection} from '../shared/custom-track-editing.js';
import {isPreviewTrackId} from '../shared/track.js';

const destination=resolve(process.env.REPORT_DIR??'docs/ux-editor');await mkdir(destination,{recursive:true});
const directory=await mkdtemp(join(tmpdir(),'lagon-ux-editor-'));process.env.PLAYER_DATA_DIR=join(directory,'players');process.env.CUSTOM_TRACK_DATA_DIR=join(directory,'tracks');
const {gameServer,httpServer,ready}=createGameServer(resolve('dist/client'));await ready;await gameServer.listen(0,'127.0.0.1');
const address=httpServer.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;
const checks:string[]=[],errors:string[]=[],captures:string[]=[],captureFailures:string[]=[],evidence:Record<string,unknown>={origin};let browser:Browser|undefined,passed=false,failure:string|undefined;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const mark=(message:string)=>{checks.push(message);console.log('✓ '+message);};
async function until(predicate:()=>Promise<boolean>,message:string,timeout=35_000){const end=Date.now()+timeout;while(!await predicate()){if(Date.now()>end)throw Error(message);await pause(100);}}
async function open(page:Page){page.setDefaultTimeout(30_000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin,{waitUntil:'domcontentloaded',timeout:40_000});await page.waitForFunction(()=>!!(window as unknown as {__lagonDebug?:unknown}).__lagonDebug);}
async function field(page:Page,selector:string,value:string){await page.locator(selector).fill(value);await page.locator(selector).press('Tab');}
async function section(page:Page,id:string){if(await page.locator(id).getAttribute('open')===null)await page.locator(`${id}>summary`).click();}
async function capture(page:Page,name:string){
  // Chromium/SwiftShader can wait forever for a compositor frame beneath an opaque
  // editor dialog. Capture the real viewport directly, without changing the page.
  const cdp=await page.context().newCDPSession(page);let timer:ReturnType<typeof setTimeout>|undefined;
  try{const result=await Promise.race([cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:false}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Capture viewport : délai de 35 s dépassé')),35_000);})]);await writeFile(join(destination,name),Buffer.from(result.data,'base64'));captures.push(name);}
  catch(error){captureFailures.push(name+': '+String(error));console.warn('Capture différée : '+name+' : '+String(error));}
  finally{clearTimeout(timer);await cdp.detach();}
}
const feature=(group:string,name:string)=>`[data-group="${group}"][data-index="0"][data-feature-field="${name}"]`;
const marker=(selection:TrackModuleSelection)=>`[data-module-group="${selection.group}"][data-module-index="${selection.index}"][data-module-handle="${selection.handle??'target'}"]`;
async function records():Promise<StoredCustomTrack[]>{return (await fetch(origin+'/api/tracks',{signal:AbortSignal.timeout(10_000)}).then(response=>response.json())as{tracks:StoredCustomTrack[]}).tracks;}
async function localDraft(page:Page):Promise<CustomTrackDraft>{return page.evaluate(async()=>{
  const token=localStorage.getItem('lagon-player-token'),response=token?await fetch('/api/me',{headers:{Authorization:`Bearer ${token}`}}):null;
  const id=response?.ok?(await response.json()).profile.id:'local',saved=localStorage.getItem('lagon-track-editor-draft-v1:'+id)??localStorage.getItem('lagon-track-editor-draft-v1:local');
  if(!saved)throw Error('Brouillon local absent');return JSON.parse(saved).draft;
});}
async function progression(page:Page){return page.evaluate(async()=>{const token=localStorage.getItem('lagon-player-token');if(!token)return null;const headers={Authorization:`Bearer ${token}`};
  const {profile}=await fetch('/api/me',{headers}).then(response=>response.json()),{replays}=await fetch('/api/replays',{headers}).then(response=>response.json());
  return {xp:profile.xp,stats:profile.stats,mmr:profile.mmr,careerLevel:profile.careerLevel,replays:replays.map((value:{id:string})=>value.id)};});}
type State={phase:string|null;trackId:string;workshop:string|null;x:number;z:number;speed:number};
async function state(page:Page):Promise<State>{return page.evaluate(()=>{const debug=(window as unknown as {__lagonDebug:{world:{phase:string;trackId:string;workshop?:{label:string};players:Array<{id:string;x:number;z:number;speed:number}>}|null;sessionId:string}}).__lagonDebug,world=debug.world,kart=world?.players.find(kart=>kart.id===debug.sessionId);
  return {phase:world?.phase??null,trackId:world?.trackId??'',workshop:world?.workshop?.label??null,x:kart?.x??0,z:kart?.z??0,speed:kart?.speed??0};});}
function pointAt(draft:CustomTrackDraft,fraction:number){const points=sampleCustomTrackAnchors(draft.anchors),lengths=points.map((point,index)=>Math.hypot(points[(index+1)%points.length]!.x-point.x,points[(index+1)%points.length]!.z-point.z));let distance=fraction*lengths.reduce((a,b)=>a+b,0);
  for(let index=0;index<points.length;index++){if(distance<=lengths[index]!&&lengths[index]!>1e-8){const a=points[index]!,b=points[(index+1)%points.length]!,t=distance/lengths[index]!;return{x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t};}distance-=lengths[index]!;}return points[0]!;}
async function drag(page:Page,selection:TrackModuleSelection,touch=false){
  await page.locator('#editor-canvas').scrollIntoViewIfNeeded();const source=await localDraft(page),selected=customTrackModule(source,selection)!;
  const control=page.locator(marker(selection)),handle=control.locator(selection.handle==='trigger'?'circle':'rect').first();await handle.scrollIntoViewIfNeeded();const box=await handle.boundingBox();assert.ok(box);
  const fraction=selection.handle==='trigger'&&'trigger'in selected?selected.trigger:(selected.start+selected.end)/2;
  const destination=pointAt(source,Math.min(.96,fraction+.045));const to=await page.locator('#editor-canvas').evaluate((svg,p)=>{const matrix=(svg as SVGSVGElement).getScreenCTM()!,point=new DOMPoint(p.x,p.z).matrixTransform(matrix);return{x:point.x,y:point.y};},destination);
  const from={x:box.x+box.width/2,y:box.y+box.height/2};
  if(touch){const cdp=await page.context().newCDPSession(page);try{await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[from]});for(let step=1;step<=10;step++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:from.x+(to.x-from.x)*step/10,y:from.y+(to.y-from.y)*step/10}]});await pause(20);}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}finally{await cdp.detach();}}
  else{await page.mouse.move(from.x,from.y);await page.mouse.down();try{await page.mouse.move(to.x,to.y,{steps:12});}finally{await page.mouse.up();}}
  const after=await localDraft(page),changed=customTrackModule(after,selection)!;
  const beforeAt=selection.handle==='trigger'&&'trigger'in selected?selected.trigger:selected.start,afterAt=selection.handle==='trigger'&&'trigger'in changed?changed.trigger:changed.start;
  assert.ok(Math.abs(afterAt-beforeAt)>.005,`${selection.group}/${selection.handle??'target'} was not moved`);
  assert.ok(Math.abs((changed.end-changed.start)-(selected.end-selected.start))<1e-10,'drag keeps length');
  return {group:selection.group,handle:selection.handle??'target',before:beforeAt,after:afterAt,length:changed.end-changed.start,touch};
}
async function tryPrivate(page:Page,button:string){const catalogue=await records();await page.locator(button).click();await until(async()=>{const value=await state(page);return value.phase==='racing'&&!!value.workshop&&value.trackId.startsWith('custom-private-');},'Essai privé du brouillon');
  const initial=await state(page);await page.keyboard.down('ArrowUp');let moving:State;try{await until(async()=>{const value=await state(page);return value.speed>2&&Math.hypot(value.x-initial.x,value.z-initial.z)>1;},'Conduite autoritaire du brouillon');moving=await state(page);}finally{await page.keyboard.up('ArrowUp');}
  assert.deepEqual(await records(),catalogue);assert.ok(isPreviewTrackId(initial.trackId));return{initial,moving: moving!,catalogueCount:catalogue.length};}
async function back(page:Page,id:string){await page.locator('#leave-button').click();await page.locator('#track-editor-dialog').waitFor({state:'visible'});await until(async()=>!isPreviewTrackId(id),'Définition privée libérée');}
try{
  const html=await fetch(origin).then(response=>response.text());evidence.assets=[...html.matchAll(/(?:src|href)="([^\"]*assets[^\"]+)"/g)].map(match=>match[1]);
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
  const desktop=await browser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:1});await desktop.addInitScript(origin=>{if(location.origin===origin)localStorage.setItem('lagon-volume','0');},origin);
  const page=await desktop.newPage();await open(page);await (await homeControl(page, '#name-input')).fill('Éditeur privé');await (await homeControl(page, '#track-editor-button')).click();await field(page,'#editor-name','Mon brouillon confidentiel');
  await section(page,'#editor-relief-options');await page.locator('#editor-add-bridge').click();await page.locator('#editor-add-jump').click();await field(page,feature('elevations','start'),'30');await field(page,feature('elevations','duration'),'8');
  await section(page,'#editor-event-options');await page.locator('#editor-add-event').click();await field(page,feature('events','start'),'72');await field(page,feature('events','duration'),'4');
  await section(page,'#editor-interaction-options');await page.locator('#editor-add-switch-boost').click();await field(page,feature('interactions','trigger'),'82');await field(page,feature('interactions','start'),'88');await field(page,feature('interactions','duration'),'3');
  const movements=[];for(const group of ['zones','elevations','events','interactions']as const){
    const before=await localDraft(page),movement=await drag(page,{group,index:0});movements.push(movement);
    await page.locator('#editor-undo').click();assert.deepEqual(await localDraft(page),before,'single undo reverts the entire drag');await page.locator('#editor-redo').click();
    assert.ok(Math.abs(customTrackModule(await localDraft(page),{group,index:0})!.start-movement.after)<1e-10);
  }
  movements.push(await drag(page,{group:'interactions',index:0,handle:'trigger'}));evidence.movements=movements;
  const current=page.locator(marker({group:'elevations',index:1}));await current.focus();const previous=await localDraft(page);await current.press('ArrowRight');
  assert.ok(Math.abs((await localDraft(page)).elevations![1]!.start-previous.elevations![1]!.start-.005)<1e-8);await page.locator('#editor-undo').click();
  await page.locator(marker({group:'elevations',index:1})).focus();await page.keyboard.press('Enter');await page.locator(feature('elevations','height')).waitFor({state:'visible'});
  assert.deepEqual(await records(),[]);assert.deepEqual(await readdir(join(directory,'tracks')),[]);
  await page.locator('#editor-canvas').scrollIntoViewIfNeeded();await capture(page,'direct-module-placement.png');
  mark('Quatre types de modules et plaque déplacés directement sur le plan ; longueur conservée, annuler/rétablir en une action, réglages et flèches accessibles.');
  const before=await progression(page);assert.ok(before);evidence.progressionBefore=before;
  const first=await tryPrivate(page,'[data-feature-card="elevations-0"] [data-action="try-feature"]');await capture(page,'private-draft-workshop.png');await back(page,first.initial.trackId);
  const retained=await localDraft(page);assert.equal(retained.name,'Mon brouillon confidentiel');
  const second=await tryPrivate(page,'#editor-try');await back(page,second.initial.trackId);assert.notEqual(first.initial.trackId,second.initial.trackId);
  assert.deepEqual(await records(),[]);assert.deepEqual(await readdir(join(directory,'tracks')),[]);evidence.privateTrials=[first,second];
  await page.locator('#editor-close').click();await page.reload({waitUntil:'domcontentloaded'});await (await homeControl(page, '#track-editor-button')).click();assert.deepEqual(await localDraft(page),retained);
  mark('Deux essais privés module/circuit entier : conduite réelle, sources éphémères libérées, aucun circuit ni fichier publié ; brouillon retrouvé après rechargement.');
  await page.locator('#editor-save').click();await until(async()=>/Circuit publié/.test(await page.locator('#editor-status').innerText()),'Publication explicite');
  const published=(await records())[0]!;assert.equal(published.revision,1);assert.deepEqual(published.draft,retained);assert.equal((await readdir(join(directory,'tracks'))).length,1);
  await section(page,'#editor-relief-options');await field(page,feature('elevations','height'),'26');const third=await tryPrivate(page,'[data-feature-card="elevations-0"] [data-action="try-feature"]');await back(page,third.initial.trackId);
  assert.deepEqual(await records(),[published]);assert.equal((await readdir(join(directory,'tracks'))).length,1);evidence.privateTrials=(evidence.privateTrials as unknown[]).concat(third);
  assert.deepEqual(await progression(page),before);evidence.progressionAfter=await progression(page);
  mark('Publication volontaire version1, puis modification et nouvel essai : la version publique et la progression restent intactes.');

  const storageState=await desktop.storageState();await desktop.close();const mobile=await browser.newContext({viewport:{width:320,height:568},isMobile:true,hasTouch:true,deviceScaleFactor:1,storageState});
  const phone=await mobile.newPage();await open(phone);await (await homeControl(phone, '#track-editor-button')).click();
  const touchMove=await drag(phone,{group:'zones',index:0},true);evidence.touchMove=touchMove;
  await phone.locator(marker({group:'zones',index:0})).locator('rect').first().tap();
  await phone.locator('[data-zone="0"][data-field="start"]').waitFor({state:'visible'});
  assert.equal(await phone.locator('#track-editor-dialog').evaluate(node=>node.scrollWidth>node.clientWidth+1),false);
  for(const selector of ['#editor-save','#editor-try','[data-action="try-feature"][data-group="zones"][data-index="0"]']){const box=await phone.locator(selector).first().boundingBox();assert.ok(box&&box.height>=44&&box.width>=44);}
  await capture(phone,'mobile-touch-module-settings.png');const mobileDraft=await localDraft(phone);assert.deepEqual(await records(),[published]);
  await phone.locator('#editor-save').tap();await until(async()=>(await records())[0]?.revision===2,'Publication mobile explicite version2');assert.deepEqual((await records())[0]!.draft,mobileDraft);
  assert.equal((await readdir(join(directory,'tracks'))).length,2);evidence.published={id:published.id,revisions:2};
  mark('Mobile320 : vrai glisser tactile, toucher vers réglages, commandes ≥44px et aucun débordement ; seule la publication explicite crée la version2.');
  await mobile.close();await until(async()=>((await fetch(origin+'/healthz').then(response=>response.json()))as{rooms:number}).rooms===0,'Salons privés fermés');assert.deepEqual(errors,[]);passed=true;
}catch(error){failure=String(error);process.exitCode=1;console.error(error);}
finally{await browser?.close();await gameServer.gracefullyShutdown(false);await rm(directory,{recursive:true,force:true});}
if(errors.length){passed=false;process.exitCode=1;failure??='Erreurs JavaScript pendant le nettoyage';}
await writeFile(join(destination,'browser-validation.json'),JSON.stringify({passed,timestamp:new Date().toISOString(),checks,errors,captures,captureFailures,evidence,...(failure?{error:failure}:{}),
  scope:'Serveur privé, données temporaires. UI souris/clavier/toucher uniquement ; lecture des brouillons locaux et API. Aucune mutation de simulation. Données et serveur nettoyés.',
  remaining:['Téléphone physique et Safari iOS non testés.','La publication de ce scénario ne concerne que son serveur privé.']},null,2)+'\n');console.log(JSON.stringify({passed,checks:checks.length,captures}));
