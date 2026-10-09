import { homeControl, selectHomeTrack, refreshHomeTracks } from './menu-navigation.js';
/** Public smoke: real UI only, one retained class circuit, no ranked matchmaking. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';

const origin = (process.env.BASE_URL ?? 'https://miles-blades-tulsa-citizens.trycloudflare.com').replace(/\/$/, '');
const output = process.env.REPORT_DIR ?? `${process.cwd()}/docs/editor-features/public`;
const statePath = process.env.STATE_PATH ?? '/tmp/lagon-public-editor-presence-check-state.json';
const title = 'L’atelier des reliefs';
const ownerName = 'Atelier Reliefs', guestName = 'Invité Atelier';
await mkdir(output, { recursive: true });
interface SavedTrack { id: string; revision: number; runtimeId?: string; authorId: string; draft: {
  name: string; lapCount?: number; elevations?: Array<{kind: string;start:number;end:number;height:number}>;
  events?: Array<{lap:number;kind:string;start:number;end:number}>;
} }
interface Presence { connected: number; searchingRanked: number; players: Array<{id:string;name:string;status:string}> }
interface Player {id:string;name:string;x:number;z:number;speed:number;ready:boolean;spectator:boolean;connected:boolean}
interface State {phase:string|null;trackId:string|null;sessionId:string|null;connected:boolean;players:Player[];eventStage:number|null}
interface Journal {origin:string;trackId?:string;ownerState?:Awaited<ReturnType<BrowserContext['storageState']>>;guestState?:Awaited<ReturnType<BrowserContext['storageState']>>}
let journal: Journal = {origin};
try { const existing = JSON.parse(await readFile(statePath,'utf8')) as Journal; if(existing.origin===origin)journal=existing; }
catch(error) { if((error as {code?:string}).code!=='ENOENT')throw error; }
const checks:string[]=[],errors:string[]=[],captures:string[]=[];
const evidence:Record<string,unknown>={origin,scope:'Public HTTP/WSS; deux profils isolés, actions UI, aucune recherche classée ni mutation directe de simulation.'};
try{
  const previous=JSON.parse(await readFile(`${output}/browser-validation.json`,'utf8')) as {timestamp?:string;evidence?:{origin?:string;published?:{id?:string;createdThisRun?:boolean};catalogue?:{createdIds?:string[]}}};
  if(previous.evidence?.origin===origin&&previous.evidence.published?.id===journal.trackId&&previous.evidence.published?.createdThisRun)
    evidence.initialPublication={timestamp:previous.timestamp,createdIds:previous.evidence.catalogue?.createdIds,cleanupHarnessFix:'Le script initial de préremplissage écrivait aussi sur about:blank ; il est maintenant limité à l’origine du jeu.'};
}catch{ /* First execution has no previous evidence. */ }
const mark=(message:string)=>{checks.push(message);console.log('✓ '+message);};
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function limited<T>(promise:Promise<T>,label:string,ms=40_000):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Délai dépassé : '+label)),ms);})]);}
  finally{if(timer)clearTimeout(timer);}
}
async function request<T>(path:string):Promise<T>{const response=await fetch(origin+path,{signal:AbortSignal.timeout(20_000)});assert.equal(response.status,200,path);return await response.json() as T;}
async function until(predicate:()=>Promise<boolean>,label:string,ms=35_000){const deadline=Date.now()+ms;while(Date.now()<deadline){if(await limited(predicate(),label,Math.max(1,deadline-Date.now())))return;await pause(150);}throw Error('Délai dépassé : '+label);}
async function state(page:Page):Promise<State>{return limited(page.evaluate(()=>{
  const debug=(window as unknown as {__lagonDebug?:{world:{phase:string;trackId:string;eventStage:number;players:Player[]}|null;sessionId:string|null;connected:boolean}}).__lagonDebug;
  const world=debug?.world;
  return {phase:world?.phase??null,trackId:world?.trackId??null,sessionId:debug?.sessionId??null,connected:debug?.connected??false,eventStage:world?.eventStage??null,
    players:world?.players.map(({id,name,x,z,speed,ready,spectator,connected})=>({id,name,x,z,speed,ready,spectator,connected}))??[]};
}),'état du navigateur');}
async function field(page:Page,selector:string,value:string){await page.locator(selector).fill(value);await page.locator(selector).press('Tab');}
async function section(page:Page,id:string){if(await page.locator(id).getAttribute('open')===null)await page.locator(`${id}>summary`).click();}
const feature=(group:string,index:number,name:string)=>`[data-group="${group}"][data-index="${index}"][data-feature-field="${name}"]`;
async function capture(page: Page, name: string) {
  // Capture the real viewport: the paused canvas beneath an opaque editor can
  // leave Playwright's compositor screenshot waiting under SwiftShader.
  const cdp = await page.context().newCDPSession(page); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: false }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Capture viewport : délai de 35 s dépassé')), 35000); })]);
    await writeFile(`${output}/${name}`, Buffer.from(result.data, 'base64')); captures.push(name);
  } finally { clearTimeout(timer); await cdp.detach(); }
}
async function open(page:Page){page.setDefaultTimeout(25_000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin,{waitUntil:'domcontentloaded',timeout:40_000});await page.waitForFunction(()=>!!(window as unknown as {__lagonDebug?:unknown}).__lagonDebug,{},{timeout:40_000});}
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--disable-dev-shm-usage']});
let ownerContext:BrowserContext|undefined,guestContext:BrowserContext|undefined,host:Page|undefined,guest:Page|undefined;
let passed=false,failure:string|undefined;
async function checkpoint(){journal.ownerState=await ownerContext?.storageState();journal.guestState=await guestContext?.storageState();await writeFile(statePath,JSON.stringify(journal),{mode:0o600});}
try{
  const healthBefore=await request<{rooms:number;status?:string}>('/healthz');const presenceBefore=await request<Presence>('/api/presence');
  evidence.before={health:healthBefore,presence:{connected:presenceBefore.connected,searchingRanked:presenceBefore.searchingRanked}};
  const catalogueBefore=(await request<{tracks:SavedTrack[]}>('/api/tracks')).tracks;
  const existing=catalogueBefore.find(track=>track.draft.name===title);
  assert.ok(!existing || existing.id===journal.trackId,'Un circuit portant ce nom existe déjà sans appartenir à ce contrôle ; aucune modification autorisée.');
  const htmlResponse=await fetch(origin,{signal:AbortSignal.timeout(20_000)});assert.equal(htmlResponse.status,200);
  const html=await htmlResponse.text(),assetPaths=[...html.matchAll(/(?:src|href)="([^\"]*assets[^\"]+)"/g)].map(match=>match[1]!);
  assert.ok(assetPaths.some(path=>path.endsWith('.js'))&&assetPaths.some(path=>path.endsWith('.css')));
  evidence.assets=await Promise.all(assetPaths.map(async path=>{const response=await fetch(new URL(path,origin),{signal:AbortSignal.timeout(20_000)});assert.equal(response.status,200,path);return {path,status:response.status,contentType:response.headers.get('content-type'),bytes:(await response.arrayBuffer()).byteLength};}));
  ownerContext=await browser.newContext({viewport:{width:1180,height:850},deviceScaleFactor:1,...(journal.ownerState?{storageState:journal.ownerState}:{})});
  guestContext=await browser.newContext({viewport:{width:320,height:568},deviceScaleFactor:1,isMobile:true,hasTouch:true,...(journal.guestState?{storageState:journal.guestState}:{})});
  for(const [context,name] of [[ownerContext,ownerName],[guestContext,guestName]] as const)await context.addInitScript(({name,origin})=>{if(location.origin!==origin)return;localStorage.setItem('lagon-name',name);localStorage.setItem('lagon-volume','0');},{name,origin});
  host=await ownerContext.newPage();await open(host);guest=await guestContext.newPage();await open(guest);
  await until(async()=>await host!.locator('#online-player-list li:has(small)').count()===1&&await guest!.locator('#online-player-list li:has(small)').count()===1,'identités de présence publiques');
  const ownerId=await host.locator('#online-player-list li:has(small)').getAttribute('data-player-id'),guestId=await guest.locator('#online-player-list li:has(small)').getAttribute('data-player-id');assert.ok(ownerId&&guestId&&ownerId!==guestId);
  await checkpoint();
  await until(async()=>await host!.locator(`#online-player-list [data-player-id="${guestId}"]`).count()===1&&await guest!.locator(`#online-player-list [data-player-id="${ownerId}"]`).count()===1,'présence mutuelle des deux profils');
  for(const page of [host,guest])assert.ok(parseInt(await page.locator('#online-player-count').innerText())>=2);
  await (await homeControl(guest, '#online-players')).scrollIntoViewIfNeeded();const panel=await guest.locator('#online-players').boundingBox();assert.ok(panel&&panel.x>=0&&panel.x+panel.width<=320.5);
  evidence.presence={ownerId,guestId,ownerCount:await host.locator('#online-player-count').innerText(),guestCount:await guest.locator('#online-player-count').innerText(),mobilePanel:panel};
  await capture(guest,'mobile-presence-320.png');mark('Deux profils publics se voient mutuellement ; compteur inclusif et panneau mobile320 sans débordement.');

  await (await homeControl(host, '#track-editor-button')).click();
  if(existing){await host.locator(`[data-action="open"][data-id="${existing.id}"]`).click();}
  else{
    await field(host,'#editor-name',title);await field(host,'#editor-laps','6');await host.locator('#editor-theme').selectOption('forest');
    await section(host,'#editor-relief-options');await host.locator('#editor-add-bridge').click();await host.locator('#editor-add-jump').click();
    await field(host,feature('elevations',0,'height'),'5');
    await section(host,'#editor-event-options');
    for(const [index,lap,kind,start,duration] of [[0,2,'rain',30,6],[1,4,'boost',26,2]] as const){
      await host.locator('#editor-add-event').click();await field(host,feature('events',index,'lap'),String(lap));await host.locator(feature('events',index,'kind')).selectOption(kind);
      await field(host,feature('events',index,'start'),String(start));await field(host,feature('events',index,'duration'),String(duration));
    }
    assert.equal(await host.locator('#editor-save').isEnabled(),true);
    const publication=host.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/tracks',{timeout:30_000});
    await host.locator('#editor-save').click();const published=await publication;assert.equal(published.status(),201);
    journal.trackId=((await published.json()) as {track:SavedTrack}).track.id;await checkpoint();
    await until(async()=>/Circuit publié/.test(await host!.locator('#editor-status').innerText()),'publication publique du circuit');
  }
  const saved=(await request<{tracks:SavedTrack[]}>('/api/tracks')).tracks.find(track=>track.draft.name===title);assert.ok(saved);assert.equal(saved.authorId,ownerId);
  journal.trackId=saved.id;await checkpoint();const runtimeId=saved.runtimeId??`${saved.id}-v${saved.revision}`;
  assert.equal(saved.draft.lapCount,6);assert.deepEqual(saved.draft.elevations?.map(item=>item.kind),['bridge','jump']);
  assert.deepEqual(saved.draft.events?.map(event=>[event.lap,event.kind]),[[2,'rain'],[4,'boost']]);assert.deepEqual((await request<{track:SavedTrack}>('/api/tracks/'+runtimeId)).track,saved);
  evidence.published={id:saved.id,runtimeId,revision:saved.revision,name:title,createdThisRun:!existing,draft:saved.draft};
  await host.locator('#editor-canvas').scrollIntoViewIfNeeded();await capture(host,'public-editor-modules.png');
  mark('Un seul exemple utile publié par UI : six tours, pont, tremplin, pluie au tour2 et turbo au tour4 ; relecture API identique.');
  await host.locator('#editor-close').click();
  await refreshHomeTracks(guest);await selectHomeTrack(guest,runtimeId,title);
  await selectHomeTrack(host,runtimeId,title);await (await homeControl(host, '#create-button')).click();await until(async()=>(await state(host!)).phase==='lobby','salon public de démonstration');
  const roomCode=await host.locator('#room-code').innerText();evidence.roomCode=roomCode;
  await (await homeControl(guest, '#code-input')).fill(roomCode);await (await homeControl(guest, '#join-button')).tap();
  await until(async()=>{const a=await state(host!),b=await state(guest!);return a.players.length>=2&&b.players.length>=2&&a.trackId===runtimeId&&b.trackId===runtimeId;},'les deux navigateurs sur le même circuit');
  await host.locator('#ready-button').click();await guest.locator('#ready-button').tap();await host.locator('#start-button').click();
  await until(async()=>(await state(host!)).phase==='racing'&&(await state(guest!)).phase==='racing','compte à rebours et course partagés');
  const initial=await state(host),initialKart=initial.players.find(player=>player.id===initial.sessionId);assert.ok(initialKart);
  assert.match(await host.locator('#lap').innerText(),/\/\s*6/);assert.match(await guest.locator('#lap').innerText(),/\/\s*6/);
  await host.keyboard.down('ArrowUp');
  try{
    await until(async()=>{const sample=await state(host!),kart=sample.players.find(player=>player.id===sample.sessionId);if(kart&&kart.speed>2&&Math.hypot(kart.x-initialKart.x,kart.z-initialKart.z)>2){evidence.driving={speed:kart.speed,distance:Math.hypot(kart.x-initialKart.x,kart.z-initialKart.z),lapCounter:await host!.locator('#lap').innerText()};return true;}return false;},'déplacement serveur normal pendant appui');
  }finally{await host.keyboard.up('ArrowUp');}
  evidence.shared={trackId:runtimeId,hostPlayers:(await state(host)).players.length,guestPlayers:(await state(guest)).players.length,hostLap:await host.locator('#lap').innerText(),guestLap:await guest.locator('#lap').innerText()};
  await capture(host,'public-multiplayer-six-laps.png');mark('Deux profils dans une vraie course WSS sur ce circuit ; compteur /6 des deux côtés et déplacement autoritaire normal.');
  await guest.locator('#leave-button').tap();await host.locator('#leave-button').click();await until(async()=>!(await state(host!)).trackId&&!(await state(guest!)).trackId,'sortie des deux pilotes');
  const finalTracks=(await request<{tracks:SavedTrack[]}>('/api/tracks')).tracks;
  const added=finalTracks.filter(track=>!catalogueBefore.some(before=>before.id===track.id));
  const ownAdded=added.filter(track=>track.authorId===ownerId);
  assert.ok(ownAdded.length<=1&&ownAdded.every(track=>track.id===saved.id),'Le contrôle ne doit ajouter que son propre exemple.');
  evidence.catalogue={before:catalogueBefore.length,after:finalTracks.length,createdIds:ownAdded.map(track=>track.id),otherConcurrentCreations:added.length-ownAdded.length,retainedExample:saved.id};
  assert.deepEqual(errors,[]);passed=true;
}catch(error){failure=String(error);process.exitCode=1;console.error(error);}
finally{
  for(const page of [guest,host])if(page&&!page.isClosed())try{
    await page.keyboard.up('ArrowUp');const current=await state(page);if(current.trackId&&await page.locator('#leave-button').isVisible())await page.locator('#leave-button').click({timeout:10_000});
  }catch{ /* browser closure still releases the room connection */ }
  if(ownerContext&&guestContext)await checkpoint().catch(()=>{});
  for(const page of [host,guest])if(page&&!page.isClosed())await page.goto('about:blank',{timeout:10_000}).catch(()=>{});
  const ownPresence=evidence.presence as {ownerId:string;guestId:string}|undefined;
  if(ownPresence)try{await until(async()=>!(await request<Presence>('/api/presence')).players.some(player=>player.id===ownPresence.ownerId||player.id===ownPresence.guestId),'retrait des présences de vérification',20_000);}catch(error){evidence.presenceCleanup=String(error);}
  await browser.close();
  try{await pause(700);evidence.after={health:await request('/healthz'),presence:await request('/api/presence')};}catch(error){evidence.afterError=String(error);}
  // The public presence report retains only aggregate counts, never other pilots' identities.
  const after=evidence.after as {health:unknown;presence:Presence}|undefined;if(after)evidence.after={health:after.health,presence:{connected:after.presence.connected,searchingRanked:after.presence.searchingRanked}};
  if(errors.length){passed=false;process.exitCode=1;failure??='Erreurs JavaScript observées pendant le contrôle ou son nettoyage.';}
  await writeFile(`${output}/browser-validation.json`,JSON.stringify({passed,timestamp:new Date().toISOString(),checks,errors,captures,evidence,...(failure?{failure}:{}),remaining:['Téléphone physique et Safari iOS non testés.','Le contrôle public ne termine pas six tours et ne déclenche pas la file classée ; ces points sont validés séparément en privé.']},null,2)+'\n');
  console.log(JSON.stringify({passed,checks:checks.length,output,captures}));
}
