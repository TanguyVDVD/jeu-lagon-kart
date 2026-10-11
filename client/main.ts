import { Client, type Room } from 'colyseus.js';
import { COLORS, neutralInput, stepKart, cloneKartForPrediction, type Input, type Kart, type World } from '../shared/game';
import { getAvailableTracks, getTrack, getTrackLapCount, isTrackId, isPreviewTrackId, trackPoint } from '../shared/track';
import { configurationMarkup, TournamentControls, trackOutline, trackFeatures, standingsTable, teamsTable } from './tournament-ui';
import { GameRenderer } from './renderer';
import { GameAudio } from './audio';
import { GarageUI } from './garage-ui';
import { CareerUI } from './career-ui';
import { AccountUI } from './account-ui';
import { showReplay } from './replay-view';
import { getTrackEvent } from '../shared/track-events';
import { CHARACTERS } from '../shared/characters';
import type { GhostData, PlayerProfile } from '../shared/progression';
import { KART_MODELS } from '../shared/kart-catalog';
import { MobileControls, mobileControlsMarkup } from './mobile-controls';
import { OnlinePlayersPanel, onlinePlayersMarkup } from './online-players';
import { RaceFeedback, raceFeedbackMarkup } from './race-feedback';
import { PartyUi, partyMarkup } from './party-ui';
import { openSharedReplay, shareReplay } from './replay-sharing';
import { workshopMarkup, updateWorkshop } from './workshop-ui';
import { trackInteractionNotice } from '../shared/track-interactions';
import './style.css';
import './driving-ux.css';
import './home-lobby-ux.css';
import { GraphicsSettings, graphicsSettingsMarkup } from './graphics-settings';
import { HomeRanked, homeRankedMarkup } from './home-ranked';
import { RoomInvitation, invitationMarkup } from './room-invitation';
import { HomeMenu, homeMenuMarkup } from './home-menu';
import { TrackPicker } from './track-picker';
import { TrackEditor } from './track-editor';
import { listCustomTracks, saveCustomTrack, deleteCustomTrack, ensureCustomTrack } from './custom-track-library';
import { customTrackRuntimeId, registerCustomTrack, registerCustomTrackPreview, releaseCustomTrackPreview, type CustomTrackPreview, type CustomTrackDraft, type StoredCustomTrack, type TrackWorkshopSelection } from '../shared/custom-tracks';

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const itemNames = { turbo: 'Turbo', tripleTurbo: 'Triple turbo', trap: 'Balise piège', projectile: 'Disque vert',
  seeker: 'Fusée rouge', leaderBolt: 'Comète bleue', star: 'Étoile d’énergie', shield: 'Bouclier', '': 'Objet mystère' };
const itemIcons = { turbo: '↗', tripleTurbo: '↗³', trap: '△', projectile: '➤', seeker: '⌖', leaderBolt: '☄', star: '★', shield: '◈', '': '?' };
const itemColors = { turbo: '#ffbe5c', tripleTurbo: '#ffc66d', trap: '#f3ac48', projectile: '#68dd91',
  seeker: '#ff737d', leaderBolt: '#74b8ff', star: '#ffe67c', shield: '#84e6ff', '': '#a2c8cd' };
const itemHints = { turbo: 'Une accélération franche', tripleTurbo: 'Une pression par accélération', trap: 'Pose une balise derrière vous',
  projectile: 'Lance un disque qui rebondit sur les murs', seeker: 'Vise le pilote juste devant', leaderBolt: 'Poursuit le premier pilote',
  star: 'Invincible + turbo pendant 5,5 s', shield: 'Absorbe un impact pendant 8 s', '': 'Attrapez un cube sur la piste' };
const audio = new GameAudio();
let chosenColor = localStorage.getItem('lagon-color') ?? COLORS[0];
if (!COLORS.includes(chosenColor)) chosenColor = COLORS[0];
let chosenName = localStorage.getItem('lagon-name') ?? '';
const savedTrackChoice = localStorage.getItem('lagon-track') ?? 'lagon';
let chosenTrack = getTrack(savedTrackChoice).id;
const invitedCode = /^\/room\/([a-zA-Z0-9_-]+)\/?$/.exec(location.pathname)?.[1] ?? '';

el('app').innerHTML = `
  <div class="screen-wash" id="screen-wash"></div>
  <header class="topbar">
    <a class="brand" href="/" aria-label="Lagon Kart, accueil"><span class="brand-mark">L<span>↗</span></span><span>LAGON<span class="brand-light">KART</span></span></a>
    <span class="tournament-badge hidden" id="tournament-badge"></span>
    <div class="top-actions"><span class="connection" id="connection"><i></i> Prêt à rouler</span><button class="quiet compact hidden" id="leave-button">Quitter le salon</button></div>
  </header>
  ${raceFeedbackMarkup}
  ${workshopMarkup}
  ${partyMarkup}
  <main class="menu" id="menu">
    ${homeMenuMarkup({ name: chosenName, invitedCode, color: chosenColor, colors: COLORS, rankedMarkup: homeRankedMarkup, onlineMarkup: onlinePlayersMarkup })}
    <section class="lobby-panel hidden" id="lobby-panel"><div class="lobby-scroll"><div class="eyebrow">LE DÉPART APPROCHE</div><h2>Sur la grille.</h2><p class="muted" id="lobby-description">Partagez le lien, rassemblez votre équipe.</p><div class="room-share"><div><span>CODE DU SALON</span><strong id="room-code">—</strong></div><button class="secondary" id="copy-button">Copier le lien ↗</button></div><input class="share-url" id="share-url" aria-label="Lien d’invitation du salon" readonly />${invitationMarkup}<div class="players-heading"><span>PILOTES</span><span id="player-count">0 / 8</span></div><div id="player-list" class="player-list"></div><button id="lobby-garage-button" class="secondary wide">Mon kart et ses pièces ⚙</button>${configurationMarkup}<div id="lobby-party-options"></div></div><div class="lobby-ready-bar" aria-label="Préparation du départ"><p id="ready-status" role="status" aria-live="polite"></p><div class="lobby-ready-actions"><button class="secondary wide" id="ready-button">Je suis prêt</button><button class="primary wide" id="start-button">Lancer la course <span>→</span></button></div><p class="lobby-hint muted" id="lobby-hint"></p></div></section>
    <section class="results-panel hidden" id="results-panel"><div class="eyebrow">LE DRAPEAU EST TOMBÉ</div><div class="result-icon">⚑</div><h2 id="results-title">Bien joué,<br>les pilotes.</h2><p class="muted" id="results-subtitle">Même soleil, une nouvelle chance ?</p><div id="results-list" class="results-list"></div><div id="cup-standings" class="cup-standings hidden"></div><button class="primary wide hidden" id="next-race-button">Prochaine course <span>→</span></button><button class="primary wide" id="rematch-button">On remet ça <span>↻</span></button><p class="muted" id="results-hint"></p></section>
  </main>
  <section class="race-hud hidden" id="race-hud" aria-label="Informations de course"><div class="race-top"><div class="position-card"><strong id="position">1<span>er</span></strong><span id="field-size">SUR 1 PILOTE</span></div><div class="lap-card"><span>TOUR</span><strong id="lap">1 <em>/ 3</em></strong><span id="race-time">00:00.0</span></div></div><div class="leaderboard" id="leaderboard"></div><div class="item-card" id="item-card"><span class="item-icon" id="item-icon">?</span><div><small>VOTRE OBJET</small><strong id="item-name">Objet mystère</strong><span id="item-hint">Attrapez un cube sur la piste</span><small id="item-effect" class="hidden" aria-live="off"></small></div><kbd>E</kbd></div><div class="speed-card"><div><strong id="speed">0</strong><span>KM/H</span></div><div class="boost-meter"><i id="boost-fill"></i></div><span id="boost-label">GARDEZ LE CAP</span><div class="draft-meter"><i id="draft-fill"></i></div><small id="draft-label">ASPIRATION</small></div><div class="minimap-card"><canvas id="minimap" width="240" height="180" aria-label="Mini-carte du circuit"></canvas><span id="minimap-name">ÎLE DES ALIZÉS</span></div></section>
  <div id="event-banner" class="event-banner hidden" role="status"></div>
  <div class="countdown hidden" id="countdown"></div><div class="race-banner hidden" id="race-banner"></div>
  <footer class="bottom-bar"><div class="controls"><span><kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd> <b>/ ZQSD / WASD</b></span><span><kbd>ESPACE</kbd> Drift</span><span><kbd>E</kbd> Objet</span><span><kbd>R</kbd> Replacer</span><span class="brake-help"><kbd>↓</kbd> Frein / recul</span></div>${graphicsSettingsMarkup}<a class="credits-link" href="/credits.html" target="_blank" rel="noopener">Crédits</a><label class="volume" for="volume-input"><span aria-hidden="true">♫</span><input id="volume-input" type="range" min="0" max="100" value="${audio.level}" aria-label="Volume du jeu" /></label></footer>
  <div id="toast" class="toast hidden" role="status" aria-live="polite"></div>
  <div class="reconnect hidden" id="reconnect"><i></i><strong>On vous garde votre place.</strong><span>Connexion interrompue · tentative de reprise…</span></div>
  ${mobileControlsMarkup}
`;

let renderer: GameRenderer;
try { renderer = new GameRenderer(el<HTMLCanvasElement>('game')); }
catch (error) { el('menu').innerHTML = '<section class="lobby-panel"><h2>La piste attend<br>votre navigateur.</h2><p>Le rendu 3D n’a pas démarré. Activez l’accélération graphique, puis actualisez cette page avec un navigateur récent.</p></section>'; throw error; }

const graphicsSettings = new GraphicsSettings(mode => renderer.setQualityMode(mode));
const homeMenu = new HomeMenu(el('home-panel'));
const client = new Client(window.location.origin.replace(/^http/, 'ws'));
let room: Room | null = null;
let world: World | null = null;
let predicted: Kart | null = null;
let pending: Input[] = [];
let sequence = 0;
let epoch = -1;
let connected = false;
let busy = false;
let editorPractice = false;
let privatePreviewId: string | null = null;
let modalOpen = false;
let nameEdited = false;
let accounts: AccountUI;
let leaving = false;
let reconnecting = false;
let connectionGeneration = 0;
let toastTimer = 0;
let autoPractice = false;
let uiTime = 0;
let lastLobbySignature = '';
let lastResultSignature = '';
let previousPhase = '';
let raceProfileBaseline: number | undefined;
let correction = { x: 0, z: 0 };
let fixedStep = 1 / 30;
let accumulator = 0;
const keys = new Set<string>();
let usePressed = false;
let resetPressed = false;
const mobileControls = new MobileControls(() => audio.activate());
type Snapshot = { world: World; serverTime: number; tick: number; simHz: number; tracks?: StoredCustomTrack[]; previewTrack?: CustomTrackPreview };
const snapshots: { at: number; world: World }[] = [];
// The local kart is drawn ahead of the server: a cube it touches disappears at
// once and the item slot spins until the authoritative draw arrives.
const collectedPickups = new Map<string, number>();
const itemRoll = ['turbo', 'projectile', 'shield', 'trap', 'star', 'seeker'] as const;
let itemRollUntil = 0;
let predictedRound = -1;
let serverClockOffset = 0;
const garage = new GarageUI(choice => {
  renderer.setPreviewKart(chosenColor, choice.modelId, choice.characterId);
  if (room && world?.phase === 'lobby') room.send('profile', choice);
});
renderer.setPreviewKart(chosenColor, garage.value.modelId, garage.value.characterId);
renderer.collectedPickups = collectedPickups;
const career: CareerUI = new CareerUI({
  canQueue: () => !busy && !room && !reconnecting && !trackEditor.isOpen,
  prepareRanked: ensureCareer,
  profile: saved => { garage.setLevel(saved.careerLevel); accounts?.update(saved); trackEditor.identityChanged(); if (saved.username && !nameEdited) setSavedName(saved.name); }, error: toast, replay: replay => { void ensureCustomTrack(replay.trackId).then(() => showReplay(replay)).catch(error => toast(errorMessage(error))); },
  championship: async id => {
    if (busy || room) return;
    audio.activate(); setBusy(true);
    try { await career.cancelQueue(); await ensureCareer(); const next = await client.create('race', { ...profile(), token: career.authToken, practice: true, trackId: chosenTrack }); attachRoom(next); next.send('configure', { championshipId: id }); }
    finally { setBusy(false); }
  },
  ranked: async id => { if (busy || room) return; audio.activate(); setBusy(true); try { document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach(dialog => dialog.close()); attachRoom(await client.joinById(id, { ...profile(), token: career.authToken })); } finally { setBusy(false); } },
});
const homeRanked = new HomeRanked(career, el('home-ranked'));
const roomInvitation = new RoomInvitation(el('room-invitation'), { message: toast });
accounts = new AccountUI(career, el('account-card'), {
  allowed: () => {
    if (room || reconnecting) { toast('Quittez le salon avant de changer de compte.'); return false; }
    if (!busy && career.isSearching) void career.cancelQueue();
    return !busy;
  }, busy: setBusy, prepareGuest: ensureCareer, error: toast,
  changed: saved => {
    // A different account must never resume the previous pilot's room seat.
    ++connectionGeneration; sessionStorage.removeItem('lagon-session'); resetPrediction(); renderer.setGhost(null);
    nameEdited = false; setSavedName(saved?.name ?? ''); garage.setLevel(saved?.careerLevel ?? 0);
    trackEditor.identityChanged();
    onlinePlayers.refresh();
    toast(saved ? `Compte ${saved.username} connecté. Votre progression est sauvegardée.` : 'Vous êtes déconnecté. Votre progression reste sauvegardée sur votre compte.');
  },
});
void career.restore().catch(error => toast(errorMessage(error)));
const onlinePlayers = new OnlinePlayersPanel(async () => {
  // Presence must not overwrite a nickname the player is currently typing.
  const saved = career.currentProfile ?? await career.restore()
    ?? await career.ensure(el<HTMLInputElement>('name-input').value.trim() || 'Pilote');
  return { token: career.authToken, playerId: saved.id };
}, snapshot => homeMenu.setPresence(snapshot));
const tournamentControls = new TournamentControls((type, payload) => room?.send(type, payload));
const raceFeedback = new RaceFeedback();
const partyUi = new PartyUi({
  configure: payload => room?.send('funConfigure', payload),
  vote: trackId => room?.send('partyVote', { trackId }),
  replay: (id, time) => { void openSharedReplay(id, time).catch(error => toast(errorMessage(error))); },
  share: (id, time) => { void shareReplay(id, time).then(copied => { if (copied) toast('Lien du passage copié !'); }).catch(error => toast(errorMessage(error))); },
});
const trackEditor: TrackEditor = new TrackEditor({
  getPlayerId: () => career.currentProfile?.id ?? '',
  canModerateTracks: () => career.currentProfile?.canModerateTracks === true,
  list: async () => { const tracks = await listCustomTracks(); refreshTrackCards(); return tracks; },
  save: async (draft, previous) => { await ensureCareer(); return saveCustomTrack(draft, career.authToken, previous); },
  remove: record => deleteCustomTrack(record.id, record.revision, career.authToken),
  onDeleted: () => refreshTrackCards(),
  onSaved: record => { chooseTrack(customTrackRuntimeId(record)); refreshTrackCards(); },
  onTry: async (draft, selection) => {
    if (!await connect('practice', selection, draft)) throw new Error('Connexion à l’entraînement impossible. Réessayez.');
    editorPractice = true; el('leave-button').textContent = 'Retour à l’éditeur';
  },
});
// A catalogue response can arrive after the player has made a new choice.
// Only restore the saved custom track while that initial choice is untouched.
let trackChoiceRevision = 0;
function chooseTrack(id: string) { ++trackChoiceRevision; previewTrack(id); }
const trackPicker = new TrackPicker({
  getSelected: () => chosenTrack,
  onSelect: id => { if (!busy && !room) chooseTrack(id); },
  onRefresh: async () => { await listCustomTracks(); refreshTrackCards(); },
  onCreate: () => { void openTrackEditor(); },
});
function refreshTrackCards() {
  if (!room && chosenTrack.startsWith('custom-') && !getAvailableTracks().some(track => track.id === chosenTrack)) {
    // Preserve a newer published revision when one exists; a deleted circuit
    // returns to an official track instead of leaving an unusable home choice.
    const logical = chosenTrack.replace(/-v\d+$/, '');
    const replacement = getAvailableTracks().find(track => track.id.replace(/-v\d+$/, '') === logical);
    chooseTrack(replacement?.id ?? 'lagon');
  }
  trackPicker.refresh();
}
trackPicker.setLoading(true);
const catalogReady = listCustomTracks().then(() => {
  if (!room && trackChoiceRevision === 0 && getAvailableTracks().some(track => track.id === savedTrackChoice)) previewTrack(savedTrackChoice);
  refreshTrackCards();
}).catch(() => {
  trackPicker.setError('Créations indisponibles pour le moment. Les circuits officiels restent accessibles. Réessayez avec Actualiser.');
}).finally(() => trackPicker.setLoading(false));


function setSavedName(name: string) {
  chosenName = name; el<HTMLInputElement>('name-input').value = name; localStorage.setItem('lagon-name', name);
}
async function ensureCareer(): Promise<PlayerProfile> {
  const fieldValue = el<HTMLInputElement>('name-input').value;
  const requestedName = profile().name, explicitRename = nameEdited;
  let saved = await career.ensure(requestedName, explicitRename);
  // A guest may still be materialising for presence when the first rename
  // arrives. Once that shared request finishes, apply the explicit edit once.
  if (explicitRename && el<HTMLInputElement>('name-input').value === fieldValue && saved.name !== requestedName)
    saved = await career.ensure(requestedName, true);
  // A slow save must not replace newer text that the player is still typing.
  if (el<HTMLInputElement>('name-input').value === fieldValue) { nameEdited = false; setSavedName(saved.name); }
  return saved;
}

function previewTrack(id: string, persist = true) {
  const track = getTrack(id);
  chosenTrack = track.id;
  if (persist) localStorage.setItem('lagon-track', chosenTrack);
  renderer.setPreviewTrack(chosenTrack);
  trackPicker.refresh();
  el('track-name').textContent = track.name;
  el('track-name').title = track.name;
  el('home-track-outline').innerHTML = trackOutline(track);
  el('home-track-outline').style.color = track.palette.accent;
  el('track-number').textContent = track.id.startsWith('custom-') ? '✎' : String(getAvailableTracks().findIndex(option => option.id === track.id) + 1).padStart(2, '0');
  el('track-description').textContent = track.description;
  const laps = getTrackLapCount(track.id);
  el('track-tags').innerHTML = `<span>${escape(track.difficulty.toUpperCase())}</span><span>⚑ ${laps} TOUR${laps > 1 ? 'S' : ''}</span>`;
  el('island-card').dataset.theme = track.theme;
  document.body.dataset.theme = track.theme;
}
previewTrack(chosenTrack, false);

function toast(message: string) {
  el('toast').textContent = message; el('toast').classList.remove('hidden');
  window.clearTimeout(toastTimer); toastTimer = window.setTimeout(() => el('toast').classList.add('hidden'), 5000);
}
function connection(text: string, state: 'online' | 'offline' | 'pending') {
  el('connection').innerHTML = `<i></i>${escape(text)}`; el('connection').dataset.state = state;
}
function setBusy(value: boolean) {
  busy = value;
  for (const id of ['create-button', 'join-button', 'practice-button', 'track-editor-button', 'choose-track-button']) el<HTMLButtonElement>(id).disabled = value;
}
function profile() {
  chosenName = el<HTMLInputElement>('name-input').value.trim().slice(0, 18) || 'Pilote';
  localStorage.setItem('lagon-name', chosenName); localStorage.setItem('lagon-color', chosenColor);
  return { name: chosenName, color: chosenColor, ...garage.value };
}
function clearControls() { keys.clear(); usePressed = false; resetPressed = false; mobileControls.clear(); }
function resetPrediction() { collectedPickups.clear(); itemRollUntil = 0; pending = []; predicted = null; snapshots.length = 0; accumulator = 0; correction = { x: 0, z: 0 }; epoch = -1; sequence = 0; clearControls(); }
function saveSession() {
  if (room) sessionStorage.setItem('lagon-session', JSON.stringify({ token: room.reconnectionToken, roomId: room.roomId }));
}
function errorMessage(error: unknown) {
  const value = error as { message?: string; code?: number };
  const message = value?.message ?? String(error);
  if (/full|maxClients|locked/i.test(message)) return 'Ce salon est complet. Demandez un autre code à vos amis.';
  if (/not found|not exist|invalid room|expired|seat|4212|4214/i.test(message)) return 'Ce salon n’existe plus ou a expiré. Vérifiez le code ou créez-en un nouveau.';
  if (/fetch|network|connect|timeout|ECONN/i.test(message)) return 'Connexion au serveur impossible. Vérifiez votre connexion et que le jeu est démarré.';
  return message.length < 180 ? message : 'La connexion au salon a échoué. Réessayez dans un instant.';
}

const previousObjectAngles = new Map<string, number>();

function attachRoom(next: Room) {
  room = next; connected = true; reconnecting = false; leaving = false; resetPrediction(); previousObjectAngles.clear();
  raceProfileBaseline = undefined;
  saveSession(); history.replaceState(null, '', `/room/${encodeURIComponent(next.roomId)}`);
  connection('En ligne', 'online'); el('reconnect').classList.add('hidden');
  el('leave-button').classList.remove('hidden');
  next.onMessage('snapshot', (snapshot: Snapshot) => {
    if (room !== next) return;
    if (snapshot.previewTrack) {
      try {
        registerCustomTrackPreview(snapshot.previewTrack);
        if (privatePreviewId && privatePreviewId !== snapshot.previewTrack.id) releaseCustomTrackPreview(privatePreviewId);
        privatePreviewId = snapshot.previewTrack.id; next.send('tracksReady', { ids: [privatePreviewId] });
      } catch { toast('Impossible de charger le brouillon privé. Revenez à l’éditeur pour le réessayer.'); return; }
    }
    if (snapshot.tracks?.length) {
      try {
        for (const record of snapshot.tracks) registerCustomTrack(record);
        next.send('tracksReady', { ids: snapshot.tracks.map(customTrackRuntimeId) });
      } catch { toast('Impossible de charger la version du circuit du salon.'); return; }
    }
    if (!isTrackId(snapshot.world.trackId) && !(snapshot.world.trackId === privatePreviewId && isPreviewTrackId(snapshot.world.trackId))) { toast('La version du circuit est en cours de chargement.'); return; }
    const now = performance.now();
    const trackChanged = world?.trackId !== snapshot.world.trackId;
    if (trackChanged) resetPrediction();
    world = snapshot.world;
    for (const object of world.objects) {
      if (object.kind === 'projectile') {
        const prev = previousObjectAngles.get(object.id);
        if (prev !== undefined && Math.abs(Math.atan2(Math.sin(object.angle - prev), Math.cos(object.angle - prev))) > 0.15) {
          audio.bounce();
        }
        previousObjectAngles.set(object.id, object.angle);
      }
    }
    const currentObjectIds = new Set(world.objects.map(o => o.id));
    for (const id of previousObjectAngles.keys()) if (!currentObjectIds.has(id)) previousObjectAngles.delete(id);
    fixedStep = 1 / Math.max(10, Math.min(60, snapshot.simHz || 30));
    const offset = now - snapshot.serverTime;
    serverClockOffset = snapshots.length ? Math.min(serverClockOffset, offset) : offset;
    snapshots.push({ at: snapshot.serverTime + serverClockOffset, world });
    while (snapshots.length > 40) snapshots.shift();
    const me = world.players.find(player => player.id === next.sessionId);
    // A new start (or a workshop restart) never replays commands of the previous run.
    if (world.round !== predictedRound) { predictedRound = world.round; pending = []; correction = { x: 0, z: 0 }; collectedPickups.clear(); itemRollUntil = 0; }
    if (me) {
      if (me.item) itemRollUntil = 0;
      if (epoch !== me.epoch) { epoch = me.epoch; pending = []; sequence = Math.max(0, me.lastSeq + 1); correction = { x: 0, z: 0 }; accumulator = 0; }
      pending = pending.filter(input => input.epoch === epoch && input.seq > me.lastSeq).slice(-90);
      const previous = predicted;
      predicted = cloneKartForPrediction(me);
      if (world.phase === 'racing') for (const input of pending) stepKart(predicted, input, fixedStep);
      if (previous && world.phase === 'racing' && previous.epoch === epoch) {
        const dx = previous.x - predicted.x, dz = previous.z - predicted.z;
        if (Math.hypot(dx, dz) < 7) { correction.x += dx; correction.z += dz; } else correction = { x: 0, z: 0 };
      }
      if (autoPractice && world.phase === 'lobby') { autoPractice = false; next.send('ready', { ready: true }); next.send('start', {}); }
    }
    updateUI(now, true);
  });
  next.onMessage('notice', (notice: { message: string }) => toast(notice.message));
  next.onMessage('profile-updated', () => {
    if (room === next) void career.refresh().catch(() => {});
  });
  next.onError((_code, message) => toast(message || 'Le serveur a signalé une erreur.'));
  next.onLeave((code) => {
    if (room !== next || leaving) return;
    connected = false; clearControls(); pending = []; accumulator = 0;
    if (code === 4000) { sessionStorage.removeItem('lagon-session'); returnHome(); toast('Le salon est fermé. Vous pouvez en créer un nouveau.'); return; }
    void reconnect(next.reconnectionToken);
  });
  setBusy(false);
}

async function connect(mode: 'create' | 'join' | 'practice', workshop?: TrackWorkshopSelection, previewDraft?: CustomTrackDraft): Promise<boolean> {
  if (busy) return false;
  audio.activate(); setBusy(true); connection('Connexion…', 'pending');
  try {
    await career.cancelQueue();
    // Official circuits can start while the community catalogue loads. A saved
    // custom choice needs its definition before we can create the room.
    if (savedTrackChoice.startsWith('custom-') && trackChoiceRevision === 0) await catalogReady;
    await ensureCareer();
    const options = { ...profile(), token: career.authToken }; autoPractice = mode === 'practice';
    const code = el<HTMLInputElement>('code-input').value.trim().replace(/^.*\/room\//, '').replace(/[/?#].*$/, '').toUpperCase();
    if (mode === 'join' && !code) throw new Error('Saisissez le code du salon partagé par vos amis.');
    renderer.setGhost(null);
    if (mode === 'practice' && !workshop && !previewDraft && el<HTMLInputElement>('ghost-toggle').checked) {
      const result = await fetch(`/api/ghost?track=${encodeURIComponent(chosenTrack)}&level=3`).then(response => response.json()) as { ghost?: GhostData | null };
      if (result.ghost) renderer.setGhost(result.ghost); else toast('Aucun fantôme enregistré pour ce circuit et ces événements.');
    }
    const next = mode === 'join' ? await client.joinById(code, options) : await client.create('race', { ...options, practice: mode === 'practice', ...(previewDraft ? { previewDraft } : { trackId: chosenTrack }), ...(workshop ? { workshop } : {}) });
    attachRoom(next); return true;
  } catch (error) { autoPractice = false; toast(errorMessage(error)); connection('Hors ligne', 'offline'); setBusy(false); return false; }
}

async function reconnect(token: string) {
  if (reconnecting) return;
  reconnecting = true; connected = false; clearControls(); pending = [];
  const generation = ++connectionGeneration;
  const deadline = performance.now() + 29_000;
  el('reconnect').classList.remove('hidden'); connection('Reconnexion…', 'pending');
  setBusy(true);
  let lastError: unknown;
  while (performance.now() < deadline && generation === connectionGeneration) {
    try { const resumed = await client.reconnect(token); if (generation !== connectionGeneration) { await resumed.leave(); return; } attachRoom(resumed); toast('Vous avez retrouvé votre place. Bonne course !'); return; }
    catch (error) {
      lastError = error;
      const detail = error as { message?: string; code?: number };
      // A reload can race the old socket close. Code 4214 also means the
      // still-valid token has not reached allowReconnection yet: keep trying.
      if (detail.code === 4212 || /disposed|introuvable|not found|not exist|invalid reconnection token format/i.test(String(detail.message))) break;
      await new Promise(resolve => window.setTimeout(resolve, 900));
    }
  }
  if (generation !== connectionGeneration) return;
  sessionStorage.removeItem('lagon-session'); returnHome(); toast(lastError ? errorMessage(lastError) : 'Le délai de reconnexion est dépassé. Rejoignez à nouveau votre salon.');
}

function returnHome() {
  if (privatePreviewId) { releaseCustomTrackPreview(privatePreviewId); privatePreviewId = null; renderer.setPreviewTrack(chosenTrack); }
  world = null; room = null; connected = false; reconnecting = false; resetPrediction(); setBusy(false);
  editorPractice = false; el('leave-button').textContent = 'Quitter le salon';
  connection('Prêt à rouler', 'offline'); el('reconnect').classList.add('hidden'); el('leave-button').classList.add('hidden');
  history.replaceState(null, '', '/'); updateUI(performance.now(), true);
  void career.refresh().catch(() => {});
  void listCustomTracks().then(() => refreshTrackCards()).catch(() => {});
}

el('name-input').addEventListener('input', () => { nameEdited = true; });
el('name-input').addEventListener('change', () => {
  void ensureCareer().then(() => onlinePlayers.refresh()).catch(error => toast(errorMessage(error)));
});
el('garage-button').addEventListener('click', () => {
  if (!busy && !room) void ensureCareer().then(() => {
    if (!busy && !room && homeMenu.currentView === 'play' && !document.querySelector('dialog[open]')) garage.open();
  }).catch(error => toast(error.message));
});
el('career-button').addEventListener('click', () => {
  const canShow = () => !busy && !room && homeMenu.currentView === 'options' && !document.querySelector('dialog[open]');
  if (canShow()) void ensureCareer().then(saved => career.open(saved.name, false, canShow)).catch(error => toast(error.message));
});
el('lobby-garage-button').addEventListener('click', () => { if (connected && world?.phase === 'lobby') garage.open(); });
el('create-button').addEventListener('click', () => void connect('create'));
el('join-button').addEventListener('click', () => void connect('join'));
el('practice-button').addEventListener('click', () => void connect('practice'));
async function openTrackEditor() {
  if (busy || room) return;
  setBusy(true);
  try { await career.cancelQueue(); await ensureCareer(); trackEditor.open(); }
  catch (error) { toast(errorMessage(error)); }
  finally { setBusy(false); }
}
el('track-editor-button').addEventListener('click', () => void openTrackEditor());
el('choose-track-button').addEventListener('click', () => { if (!busy && !room) trackPicker.open(); });
el('code-input').addEventListener('keydown', event => { if (event.key === 'Enter') void connect('join'); });
el('swatches').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-color]');
  if (!button) return; chosenColor = button.dataset.color!;
  renderer.setPreviewKart(chosenColor, garage.value.modelId, garage.value.characterId);
  document.querySelectorAll<HTMLButtonElement>('[data-color]').forEach(swatch => { const selected = swatch.dataset.color === chosenColor; swatch.classList.toggle('selected', selected); swatch.setAttribute('aria-pressed', String(selected)); });
});
el('ready-button').addEventListener('click', () => { if (tournamentControls.hasPendingChanges || partyUi.hasPendingChanges) { toast(tournamentControls.hasPendingChanges ? tournamentControls.pendingMessage : partyUi.pendingMessage); return; } audio.activate(); room?.send('ready', { ready: !world?.players.find(p => p.id === room?.sessionId)?.ready }); });
el('start-button').addEventListener('click', () => { if (tournamentControls.hasPendingChanges || partyUi.hasPendingChanges) { toast(tournamentControls.hasPendingChanges ? tournamentControls.pendingMessage : partyUi.pendingMessage); return; } audio.activate(); room?.send('start', {}); });
el('rematch-button').addEventListener('click', () => room?.send('rematch', {}));
el('next-race-button').addEventListener('click', () => room?.send('nextRace', {}));
el('workshop-restart').addEventListener('click', () => {
  clearControls();
  if (world?.workshop && connected) room?.send('workshop-restart', {});
});
el('leave-button').addEventListener('click', async () => {
  leaving = true; connectionGeneration++; sessionStorage.removeItem('lagon-session');
  const reopenEditor = editorPractice;
  const previousRoom = room; returnHome(); await previousRoom?.leave(true);
  if (reopenEditor) trackEditor.open();
});
el('copy-button').addEventListener('click', async () => {
  const input = el<HTMLInputElement>('share-url');
  try { await navigator.clipboard.writeText(input.value); toast('Lien copié. À vos amis de jouer !'); }
  catch { input.focus(); input.select(); toast('Le lien est sélectionné. Copiez-le avec Ctrl+C.'); }
});
el('volume-input').addEventListener('input', event => { audio.activate(); audio.setVolume(Number((event.target as HTMLInputElement).value)); });

const driveKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyZ', 'KeyQ', 'Space', 'KeyE', 'KeyR']);
function press(code: string) { if (!keys.has(code)) { if (code === 'KeyE') usePressed = true; if (code === 'KeyR') resetPressed = true; } keys.add(code); }
window.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]')) return;
  if (event.target instanceof HTMLElement && event.target.matches('input, textarea, select')) return;
  if (driveKeys.has(event.code) && world && world.phase !== 'lobby') { event.preventDefault(); press(event.code); audio.activate(); }
});
window.addEventListener('keyup', event => keys.delete(event.code));
window.addEventListener('blur', () => { clearControls(); mobileControls.clear(true); if (connected && room && predicted) room.send('input', neutralInput(sequence++, epoch)); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { clearControls(); mobileControls.clear(true); } });

function makeInput(): Input {
  const input = neutralInput(sequence++, epoch);
  if (!world || !['racing', 'countdown'].includes(world.phase) || !predicted || predicted.finished || predicted.spectator || document.hidden || modalOpen) return input;
  const touch = mobileControls.sample(world.phase === 'racing');
  const backward = ['ArrowDown', 'KeyS'].some(key => keys.has(key)) || touch.backward;
  const forward = !backward && (['ArrowUp', 'KeyW', 'KeyZ'].some(key => keys.has(key)) || touch.forward);
  if (world.phase === 'countdown') { input.throttle = forward ? 1 : 0; input.brake = backward; return input; }
  input.throttle = forward ? 1 : backward && predicted.speed < 0.8 ? -1 : 0;
  input.brake = backward && predicted.speed >= 0.8;
  // A kart faces +Z: positive Y rotation turns left in the chase-camera frame.
  input.steer = Math.max(-1, Math.min(1, touch.steer + Number(keys.has('ArrowLeft') || keys.has('KeyA') || keys.has('KeyQ')) - Number(keys.has('ArrowRight') || keys.has('KeyD'))));
  input.drift = keys.has('Space') || touch.drift; input.use = usePressed || touch.use; input.reset = resetPressed || touch.reset;
  usePressed = false; resetPressed = false;
  return input;
}

function renderPlayers(now: number): Kart[] {
  if (!world) return [];
  const target = now - 110;
  let a = snapshots[0], b = snapshots[snapshots.length - 1];
  for (let i = 0; i < snapshots.length - 1; i++) if (snapshots[i].at <= target && snapshots[i + 1].at >= target) { a = snapshots[i]; b = snapshots[i + 1]; break; }
  if (a && target >= b.at) a = b;
  const t = a && b && b.at > a.at ? Math.max(0, Math.min(1, (target - a.at) / (b.at - a.at))) : 1;
  return world.players.map(kart => {
    if (kart.id === room?.sessionId && predicted && connected) return { ...predicted, x: predicted.x + correction.x, z: predicted.z + correction.z };
    const before = a?.world.players.find(p => p.id === kart.id), after = b?.world.players.find(p => p.id === kart.id);
    if (!before || !after) return kart;
    return { ...after, elevation: before.elevation + (after.elevation - before.elevation) * t, x: before.x + (after.x - before.x) * t, z: before.z + (after.z - before.z) * t, angle: before.angle + Math.atan2(Math.sin(after.angle - before.angle), Math.cos(after.angle - before.angle)) * t };
  });
}

function formatTime(seconds: number) { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`; }
function show(id: string, visible: boolean) { el(id).classList.toggle('hidden', !visible); }
function updateUI(now: number, force = false) {
  if (!force && now - uiTime < 100) return;
  uiTime = now;
  raceFeedback.update(world, room?.sessionId ?? '', now);
  partyUi.update(world, room?.sessionId ?? null, now - serverClockOffset);
  updateWorkshop(world, connected);
  homeRanked.setAvailable(!busy && !room && !reconnecting && !trackEditor.isOpen, 'Revenez à l’accueil pour chercher une course classée.');
  roomInvitation.update(room?.roomId ?? null);
  const phase = world?.phase ?? 'home';
  const racing = phase === 'racing' || phase === 'countdown';
  show('menu', !racing); show('home-panel', phase === 'home');
  homeMenu.setVisible(phase === 'home');
  show('lobby-panel', phase === 'lobby'); show('results-panel', phase === 'finished'); show('race-hud', racing);
  show('screen-wash', !racing);
  document.body.classList.toggle('in-race', racing);
  document.body.classList.toggle('in-lobby', phase === 'lobby');
  document.body.classList.toggle('in-workshop', !!world?.workshop);
  document.body.classList.toggle('in-crown', !!world?.crown);
  const me = world?.players.find(p => p.id === room?.sessionId);
  mobileControls.setDriving(racing && connected && !!me && !me.spectator && !me.finished);
  const players = [...(world?.players ?? [])].sort((a, b) => a.rank - b.rank);
  const competitors = players.filter(p => !p.spectator);
  const tracked = me?.spectator ? world?.players.find(p => !p.spectator && !p.abandoned) : me;
  const displayedTrack = getTrack(world?.trackId ?? chosenTrack);
  document.body.dataset.theme = displayedTrack.theme;
  show('tournament-badge', !!world);
  if (world && room) {
    const host = world.hostId === room.sessionId;
    const cup = world.tournament;
    el('tournament-badge').textContent = `${cup.mode === 'tournament' ? `COURSE ${cup.raceIndex + 1}/${cup.raceCount} · ` : ''}${displayedTrack.name}`;
    el('minimap-name').textContent = displayedTrack.name.toUpperCase();
    el('room-code').textContent = room.roomId;
    el<HTMLInputElement>('share-url').value = `${location.origin}/room/${encodeURIComponent(room.roomId)}`;
    el('player-count').textContent = `${players.length} PILOTE${players.length > 1 ? 'S' : ''}`;
    if (phase === 'lobby') {
      tournamentControls.update(world, room.sessionId);
      const signature = players.map(p => `${p.id}:${p.name}:${p.color}:${p.team}:${p.cpu}:${p.modelId}:${p.characterId}:${JSON.stringify(p.build)}:${p.ready}:${p.connected}:${p.spectator}`).join('|') + world.hostId;
      if (signature !== lastLobbySignature) {
        el('player-list').innerHTML = players.map((p, index) => `<div class="player-row"><span class="player-avatar" style="--kart:${escape(p.color)}">${String(index + 1).padStart(2, '0')}</span><div><strong>${escape(p.name)}${p.id === room?.sessionId ? '<small> VOUS</small>' : ''}</strong><span>${p.id === world?.hostId ? 'Créateur du salon · ' : ''}${escape(KART_MODELS.find(model => model.id === p.modelId)?.name ?? 'Zsky')} · ${escape(CHARACTERS.find(character => character.id === p.characterId)?.name ?? 'Pilote')}${world?.teamMode ? ` · ${p.team === 0 ? 'Corail' : 'Lagon'}` : ''}${p.cpu ? ' · CPU' : ''}</span></div><span class="ready-tag ${p.ready ? 'is-ready' : ''}">${!p.connected ? 'Reconnexion' : p.ready ? '✓ Prêt' : 'En préparation'}</span></div>`).join('');
        lastLobbySignature = signature;
      }
      el('ready-button').textContent = me?.ready ? '✓ Prêt · Annuler' : 'Je suis prêt';
      el('ready-button').classList.toggle('is-ready', !!me?.ready);
      const pendingConfiguration = host && (tournamentControls.hasPendingChanges || partyUi.hasPendingChanges);
      el<HTMLButtonElement>('ready-button').disabled = !connected || pendingConfiguration;
      show('start-button', host);
      const connectedCompetitors = competitors.filter(p => p.connected);
      el<HTMLButtonElement>('start-button').disabled = !connected || pendingConfiguration || connectedCompetitors.length < (world.practice ? 1 : 2) || connectedCompetitors.some(p => !p.ready);
      const laps = getTrackLapCount(displayedTrack.id);
      el('lobby-description').textContent = `${displayedTrack.name} · ${laps} tour${laps > 1 ? 's' : ''} · ${trackFeatures[displayedTrack.id] ?? displayedTrack.description}`;
      const waiting = connectedCompetitors.filter(player => !player.ready);
      const needed = world.practice ? 1 : 2;
      el('ready-status').textContent = `${connectedCompetitors.filter(player => player.ready).length}/${connectedCompetitors.length} pilotes prêts`;
      el('ready-status').dataset.ready = String(connectedCompetitors.length >= needed && waiting.length === 0 && !pendingConfiguration);
      el('lobby-hint').textContent = !connected ? 'Reconnexion en cours…' : pendingConfiguration ? tournamentControls.hasPendingChanges ? tournamentControls.pendingMessage : partyUi.pendingMessage
        : connectedCompetitors.length < needed ? 'Invitez un autre pilote ou ajoutez un CPU dans les réglages.'
        : !me?.ready ? 'Appuyez sur « Je suis prêt » pour confirmer votre départ.'
        : waiting.length ? `En attente de ${waiting.slice(0, 3).map(player => player.name).join(', ')}${waiting.length > 3 ? ` et ${waiting.length - 3} autre(s)` : ''}.`
        : host ? 'Tout le monde est prêt. Lancez la course !' : 'Tout le monde est prêt. Le créateur peut lancer la course.';
    }
    if (phase === 'finished') {
      const signature = JSON.stringify([players.map(p => [p.id, p.rank, p.finishTime, p.finished, p.spectator, p.name]), cup, world.crown?.scores]);
      if (signature !== lastResultSignature) {
        el('results-list').innerHTML = competitors.map(p => `<div class="result-row ${p.id === room?.sessionId ? 'is-you' : ''}"><strong>${p.rank}<small>${p.rank === 1 ? 'er' : 'e'}</small></strong><span class="result-swatch" style="background:${escape(p.color)}"></span><span>${escape(p.name)}</span><b>${world?.crown ? `${p.finished ? '' : p.abandoned || !p.connected ? 'Abandon · ' : 'Non classé · '}${world.crown.scores[p.id] ?? 0} pts` : p.finished ? formatTime(p.finishTime) : p.abandoned ? 'Abandon' : 'Non classé'}</b></div>`).join('');
        lastResultSignature = signature;
        if (cup.mode === 'tournament') el('cup-standings').innerHTML = (world.teamMode ? teamsTable(cup.standings) : '') + standingsTable(cup.standings, room.sessionId, cup.completed);
      }
      const intermediate = cup.mode === 'tournament' && !cup.completed;
      show('cup-standings', cup.mode === 'tournament');
      show('next-race-button', host && intermediate && world.party?.phase !== 'voting');
      show('rematch-button', host && !intermediate);
      el('results-title').innerHTML = cup.mode === 'tournament' ? cup.completed ? 'Le podium<br>du tournoi.' : 'Une escale<br>de plus.' : 'Bien joué,<br>les pilotes.';
      el('results-subtitle').textContent = cup.mode === 'tournament' ? cup.completed ? `${cup.standings[0]?.name ?? 'Le premier'} remporte le tournoi · ${cup.raceCount} courses` : `Course ${cup.raceIndex + 1}/${cup.raceCount} · ${displayedTrack.name}` : displayedTrack.name;
      if (intermediate) el('next-race-button').textContent = `Prochaine course · ${getTrack(cup.schedule[cup.raceIndex + 1]).name} →`;
      el('rematch-button').innerHTML = cup.mode === 'tournament' ? 'Rejouer le tournoi <span>↻</span>' : 'On remet ça <span>↻</span>';
      el('results-hint').textContent = world.party?.phase === 'voting' ? 'Votez ci-dessus. Vous resterez ensemble dans ce salon pour la prochaine manche.' : intermediate ? host ? 'Les points sont conservés. Tout le monde se prépare pour la prochaine manche.' : 'Le créateur passera à la prochaine course.' : host ? 'Une revanche ramène tous les pilotes au salon.' : 'Le créateur du salon peut proposer une revanche.';
    }
    if (racing) {
      const speed = tracked?.id === room.sessionId ? predicted?.speed ?? tracked?.speed ?? 0 : tracked?.speed ?? 0;
      const rank = tracked?.rank ?? 1;
      el('position').innerHTML = `${rank}<span>${rank === 1 ? 'er' : 'e'}</span>`;
      el('field-size').textContent = `SUR ${competitors.length} PILOTE${competitors.length > 1 ? 'S' : ''}`;
      const laps = getTrackLapCount(world.trackId);
      el('lap').innerHTML = world.crown ? `${Math.ceil(world.crown.remaining)} <em>s</em>` : world.workshop ? 'LIBRE' : `${Math.min(laps, (tracked?.lap ?? 0) + 1)} <em>/ ${laps}</em>`;
      const lapLabel = document.querySelector('.lap-card > span');
      if (lapLabel) lapLabel.textContent = world.crown ? 'RESTE' : world.workshop ? 'ESSAI' : 'TOUR';
      el('race-time').textContent = formatTime(world.raceTime);
      el('speed').textContent = String(Math.round(Math.abs(speed) * 3.6));
      const item = me?.item ?? '';
      const rolling = !item && itemRollUntil > now, shown = rolling ? itemRoll[Math.floor(now / 100) % itemRoll.length]! : item;
      mobileControls.setItem(itemIcons[shown], itemNames[item], itemColors[shown], !!item);
      el('item-icon').textContent = itemIcons[shown]; el('item-icon').style.color = itemColors[shown];
      el('item-name').textContent = rolling ? 'Tirage…' : itemNames[item] + (item === 'tripleTurbo' ? ` · ${me?.itemCharges ?? 3}/3` : '');
      el('item-hint').textContent = rolling ? 'Votre objet arrive' : item ? `E · ${itemHints[item]}` : itemHints[''];
      el('item-card').classList.toggle('has-item', !!item || rolling);
      const effects = [me && me.invincible > 0 ? `★ Invincible ${me.invincible.toFixed(1)} s` : '',
        me && me.shield > 0 ? `◈ Bouclier ${me.shield.toFixed(1)} s` : ''].filter(Boolean);
      el('item-effect').textContent = effects.join(' · '); show('item-effect', effects.length > 0);
      el('boost-fill').style.width = `${Math.min(100, (predicted?.driftCharge ?? 0) / 2 * 100)}%`;
      const surfaceLabels = { road: 'GARDEZ LE CAP', offroad: 'HORS PISTE', boost: 'BANDE TURBO', ice: 'GLACE · ANTICIPEZ', mud: 'BOUE · RALENTISSEMENT' };
      el('boost-label').textContent = (predicted?.boost ?? 0) > 0 ? 'TURBO !' : (predicted?.driftCharge ?? 0) >= 0.65 ? 'RELÂCHEZ : MINI-TURBO' : (predicted?.driftCharge ?? 0) > 0 ? 'DRIFT EN CHARGE' : surfaceLabels[predicted?.surface ?? 'road'];
      el('draft-fill').style.width = `${Math.min(100, (me?.draftCharge ?? 0) * 100)}%`;
      el('draft-label').textContent = (me?.draftCharge ?? 0) > 0 ? 'ASPIRATION EN CHARGE' : (me?.draftCooldown ?? 0) > 0 ? 'ASPIRATION · TURBO' : 'SUIVEZ UN KART : ASPIRATION';
      el('leaderboard').innerHTML = competitors.map(p => `<div class="${p.id === room?.sessionId ? 'is-you' : ''}"><b>${p.rank}</b><i style="background:${escape(p.color)}"></i><span>${escape(p.name)}</span>${world?.crown ? `<small>${p.connected ? '' : '… · '}${world.crown.scores[p.id] ?? 0} pts</small>` : p.finished ? '<small>⚑</small>' : !p.connected ? '<small>…</small>' : cup.mode === 'tournament' ? `<small>${cup.standings.find(entry => entry.id === p.id)?.points ?? 0} pts</small>` : ''}</div>`).join('');
    }
  }
  const count = world?.phase === 'countdown' ? Math.max(1, Math.ceil(world.countdown)) : world?.phase === 'racing' && world.raceTime < 0.8 ? 0 : -1;
  show('countdown', count >= 0); if (count >= 0) el('countdown').textContent = count === 0 ? 'GO !' : String(count);
  const launchHint = world?.phase === 'countdown' ? me?.launchFault ? 'Trop tôt ! Vous prendrez un départ normal.' : world.countdown <= 1 ? 'MAINTENANT ! Maintenez l’accélérateur pour le départ turbo.' : mobileControls.available ? 'Turbo : joystick ↑ à 1 · ↓ pour freiner/reculer.' : 'Départ turbo : attendez la dernière seconde pour accélérer.' : '';
  const banner = me?.spectator && racing ? 'Vous arrivez en cours de route · À vous la prochaine course !' : me?.finished && racing ? `Arrivée ! ${me.rank}${me.rank === 1 ? 'er' : 'e'} · Les autres pilotes terminent…` : launchHint;
  show('race-banner', !!banner); el('race-banner').textContent = banner;
  audio.update(predicted?.speed ?? 0, connected && phase === 'racing' && !me?.finished && !me?.spectator, me?.item ?? '', (predicted?.boost ?? 0) > 0, count, world?.trackId, connected && phase === 'racing', tracked?.lap ?? 0);
  show('event-banner', phase === 'racing' && (world?.eventLevel ?? 0) > 0);
  if (world) {
    const event = getTrackEvent(world.trackId, world.eventStage, world.eventLevel);
    const interaction = trackInteractionNotice(world.trackId, world.interactions, world.time);
    show('event-banner', phase === 'racing' && (!!interaction || event.level > 0));
    el('event-banner').textContent = interaction?.title ?? event.title;
    el('event-banner').title = interaction?.description ?? event.description;
  }
  if (phase !== previousPhase && phase === 'racing') raceProfileBaseline = career.currentProfile?.stats.races;
  if (phase !== previousPhase && phase === 'finished') {
    const receivesProgression = !!me?.playerId && !me.spectator && !world?.crown && !world?.workshop;
    const minimumRaces = receivesProgression ? (raceProfileBaseline ?? career.currentProfile?.stats.races ?? 0) + 1 : undefined;
    // Persistence finishes after the first results snapshot. A bounded refresh
    // also survives leaving the room before its profile-updated notification.
    void career.refresh({ minimumRaces }).catch(() => {});
  }
  if (phase !== previousPhase) {
    // A garage, replay or picker left open in the lobby would otherwise stay over
    // the race: it pauses 3D rendering and blocks every driving command.
    if (racing && previousPhase !== 'countdown' && previousPhase !== 'racing')
      document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach(dialog => dialog.close());
    if (!(previousPhase === 'countdown' && phase === 'racing')) clearControls();
    if (!racing) { el('menu').scrollTop = 0; if (phase === 'lobby') document.querySelector('.lobby-scroll')!.scrollTop = 0; }
    previousPhase = phase;
  }
}

const mapCanvas = el<HTMLCanvasElement>('minimap');
const mapContext = mapCanvas.getContext('2d')!;
let mapTrackId = '', mapScale = 1, mapCenterX = 0, mapCenterZ = 0;
const mapLayer = document.createElement('canvas'); mapLayer.width = 240; mapLayer.height = 180;
let mapLayerKey = '';
const mapX = (x: number) => 120 + (x - mapCenterX) * mapScale;
const mapZ = (z: number) => 90 + (z - mapCenterZ) * mapScale;
function drawMap(players: Kart[]) {
  const track = getTrack(world?.trackId ?? chosenTrack);
  const event = getTrackEvent(track.id, world?.eventStage ?? 0, world?.eventLevel ?? 0);
  const mapKey = track.id + ':' + event.level;
  if (mapKey !== mapTrackId) {
    mapTrackId = mapKey;
    // Include even the future shortcut, so the map never jumps or crops a route
    // when a shared event opens it during the race.
    const points = [...track.points, ...event.branches.flatMap(route => route.points)];
    const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
    const minZ = Math.min(...points.map(p => p.z)), maxZ = Math.max(...points.map(p => p.z));
    mapCenterX = (minX + maxX) / 2; mapCenterZ = (minZ + maxZ) / 2;
    mapScale = Math.min(204 / (maxX - minX), 136 / (maxZ - minZ));
  }
  // The circuit, its zones and branches only change with the shared phase:
  // they are painted once, then only the karts are redrawn every frame.
  const layerKey = mapKey + ':' + event.stage;
  if (layerKey !== mapLayerKey) {
    mapLayerKey = layerKey;
    const layer = mapLayer.getContext('2d')!;
    layer.clearRect(0, 0, 240, 180);
    layer.beginPath(); track.points.forEach((point, i) => i ? layer.lineTo(mapX(point.x), mapZ(point.z)) : layer.moveTo(mapX(point.x), mapZ(point.z))); layer.closePath();
    layer.lineJoin = 'round'; layer.lineCap = 'round'; layer.strokeStyle = 'rgba(240,247,233,.3)'; layer.lineWidth = Math.max(4, track.width * mapScale); layer.stroke();
    layer.strokeStyle = '#eff4dc'; layer.lineWidth = 1.7; layer.stroke();
    for (const zone of track.zones) {
      layer.beginPath();
      for (let i = 0; i <= 8; i++) { const p = trackPoint(zone.start + (zone.end - zone.start) * i / 8, track.id); if (i) layer.lineTo(mapX(p.x), mapZ(p.z)); else layer.moveTo(mapX(p.x), mapZ(p.z)); }
      layer.lineWidth = 4; layer.strokeStyle = zone.kind === 'boost' ? '#ffd477' : zone.kind === 'ice' ? '#80ecf4' : '#b07d62'; layer.stroke();
    }
    for (const route of event.branches) {
      const color = route.kind === 'detour' ? '#ffe28c' : route.kind === 'shortcut' ? '#83f6b7' : '#a4e6ff';
      layer.beginPath();
      route.points.forEach((point, index) => index ? layer.lineTo(mapX(point.x), mapZ(point.z)) : layer.moveTo(mapX(point.x), mapZ(point.z)));
      layer.strokeStyle = route.open ? color : 'rgba(164,181,181,.65)';
      layer.lineWidth = route.open ? Math.max(2.8, route.width * mapScale) : 1.5;
      layer.setLineDash(route.open ? [] : [3, 4]); layer.stroke(); layer.setLineDash([]);
      if (!route.open) {
        const midpoint = route.points[Math.floor(route.points.length / 2)]!;
        layer.font = 'bold 9px system-ui'; layer.fillStyle = '#d3ded7'; layer.fillText('T3', mapX(midpoint.x) + 4, mapZ(midpoint.z) - 4);
      }
    }
    for (const blocker of event.blockers) {
      const acrossX = Math.cos(blocker.angle) * blocker.halfWidth, acrossZ = -Math.sin(blocker.angle) * blocker.halfWidth;
      layer.beginPath(); layer.moveTo(mapX(blocker.x - acrossX), mapZ(blocker.z - acrossZ));
      layer.lineTo(mapX(blocker.x + acrossX), mapZ(blocker.z + acrossZ));
      layer.strokeStyle = '#ff7773'; layer.lineWidth = 4; layer.stroke();
      layer.font = 'bold 12px system-ui'; layer.fillStyle = '#ffb4a2'; layer.fillText('×', mapX(blocker.x) - 4, mapZ(blocker.z) + 4);
    }
    if (event.branches.length) {
      layer.font = '8px system-ui'; layer.fillStyle = '#ffe28c'; layer.fillText('Déviation', 15, 174);
      layer.fillStyle = '#83f6b7'; layer.fillText('Raccourci', 81, 174);
      layer.fillStyle = '#a4e6ff'; layer.fillText('Turbo', 149, 174);
    }
    mapCanvas.setAttribute('aria-label', 'Carte du circuit ' + track.name + '. ' + event.title);
  }
  mapContext.clearRect(0, 0, 240, 180); mapContext.drawImage(mapLayer, 0, 0);
  for (const p of players) {
    if (p.spectator || p.abandoned) continue;
    mapContext.beginPath(); mapContext.arc(mapX(p.x), mapZ(p.z), p.id === room?.sessionId ? 5 : 3.5, 0, Math.PI * 2); mapContext.fillStyle = p.color; mapContext.fill();
    mapContext.lineWidth = p.id === room?.sessionId ? 2 : 1; mapContext.strokeStyle = '#fffbed'; mapContext.stroke();
  }
}

function predictPickups(now: number) {
  for (const [id, until] of collectedPickups) if (until <= now) collectedPickups.delete(id);
  const me = world?.players.find(player => player.id === room?.sessionId);
  if (!world || world.phase !== 'racing' || !connected || !predicted || !me || me.item || me.spectator || predicted.finished || itemRollUntil > now) return;
  const kart = predicted;
  const touched = world.pickups.find(pickup => pickup.cooldown <= 0 && !collectedPickups.has(pickup.id) &&
    Math.hypot(kart.x - pickup.x, kart.z - pickup.z) < 2.8 && Math.abs(kart.elevation - (pickup.elevation ?? kart.elevation)) < 2.8);
  // If the server disagrees (another kart was first), the cube simply returns.
  if (touched) { collectedPickups.set(touched.id, now + 700); itemRollUntil = now + 700; }
}

let previousFrame = performance.now();
function frame(now: number) {
  const hasDialog = !!document.querySelector('dialog[open]');
  if (hasDialog && !modalOpen) { clearControls(); mobileControls.clear(true); }
  modalOpen = hasDialog;
  const dt = Math.min(0.1, (now - previousFrame) / 1000); previousFrame = now;
  if (connected && room && world && predicted) {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= fixedStep && steps < 3) {
      const input = makeInput();
      room.send('input', input);
      if (world.phase === 'racing') stepKart(predicted, input, fixedStep);
      // Commands sent while the "GO" snapshot is still travelling are replayed
      // on arrival, so the launch is predicted from its very first frame.
      if (world.phase === 'racing' || world.phase === 'countdown') { pending.push(input); if (pending.length > 90) pending.shift(); }
      accumulator -= fixedStep; steps++;
    }
    if (steps >= 3) accumulator = 0;
  } else accumulator = 0;
  predictPickups(now);
  const decay = Math.exp(-dt * 11); correction.x *= decay; correction.z *= decay;
  const players = renderPlayers(now);
  renderer.render(world, players, room?.sessionId ?? '', dt, now, { hidden: document.hidden, opaqueDialog: modalOpen });
  if (world?.phase === 'racing' || world?.phase === 'countdown') drawMap(players);
  updateUI(now); requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Refresh keeps the session per tab; the server rotates tokens on successful resume.
try {
  const saved = JSON.parse(sessionStorage.getItem('lagon-session') ?? 'null') as { token: string; roomId: string } | null;
  if (saved?.token && saved.roomId === invitedCode) void reconnect(saved.token);
  else if (invitedCode) toast('Vous êtes invité ! Choisissez votre pseudo, puis rejoignez le salon.');
} catch { sessionStorage.removeItem('lagon-session'); }

const sharedReplay = new URLSearchParams(location.search);
if (!invitedCode && sharedReplay.has('replay')) {
  void catalogReady.then(() => openSharedReplay(sharedReplay.get('replay')!, Number(sharedReplay.get('t') ?? 0))).catch(error => toast(errorMessage(error)));
}

// Read-only copies support browser diagnostics without exposing gameplay mutations.
Object.defineProperty(window, '__lagonDebug', { value: Object.freeze({
  get world() { return world ? structuredClone(world) : null; },
  get sessionId() { return room?.sessionId ?? null; },
  get predicted() { return predicted ? structuredClone(predicted) : null; },
  get fps() { return renderer.fps; },
  get quality() { return renderer.quality; },
  get qualityMode() { return renderer.qualityMode; },
  get view() { return structuredClone(renderer.viewDiagnostics); },
  get sceneryAssets() { return structuredClone(renderer.sceneryAssets); },
  get kartAssets() { return structuredClone(renderer.kartAssets); },
  get music() { return structuredClone(audio.musicStatus); },
  get connected() { return connected; },
  get pendingInputs() { return pending.length; }
}) });
