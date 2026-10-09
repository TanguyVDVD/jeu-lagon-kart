import { getAvailableTracks, getTrack, type TrackDefinition } from '../shared/track';
import type { World } from '../shared/game';
import type { TournamentEntry } from '../shared/tournament';
import { teamStandings } from '../shared/teams';

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const trackFeatures: Record<string, string> = {
  lagon: 'Épingle de plage · Premiers turbos', canyon: 'Lacets en montée · Boue',
  glacier: 'Crête glacée · Trajectoires larges', neon: 'Angles droits · Pistes turbo',
  mangrove: 'Serpent de virages · Boue alternée', dunes: 'Lignes droites vallonnées · Quatre turbos',
  volcan: 'Montée du cratère · Viaduc de lave', forest: 'Pont des cimes · Saut forestier',
  harbor: 'Pont des cargos · Rampe de quai', sky: 'Deux viaducs · Saut des nuages',
  foundry: 'Passerelle industrielle · Tremplin', castle: 'Montée au donjon · Saut des remparts',
};
export function trackOutline(track: TrackDefinition) {
  const minX = Math.min(...track.points.map(point => point.x)), maxX = Math.max(...track.points.map(point => point.x));
  const minZ = Math.min(...track.points.map(point => point.z)), maxZ = Math.max(...track.points.map(point => point.z));
  const scale = Math.min(104 / (maxX - minX), 51 / (maxZ - minZ));
  const path = track.points.filter((_, index) => index % 3 === 0).map((point, index) => `${index ? 'L' : 'M'}${(60 + (point.x - (minX + maxX) / 2) * scale).toFixed(1)},${(32 + (point.z - (minZ + maxZ) / 2) * scale).toFixed(1)}`).join(' ') + 'Z';
  return `<svg viewBox="0 0 120 64" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/></svg>`;
}
export function trackCards(selected: string) {
  return getAvailableTracks().map((track, index) => `<button class="track-card ${track.id === selected ? 'selected' : ''}" data-track="${track.id}" aria-pressed="${track.id === selected}" style="--track-accent:${track.palette.accent}"><span class="track-card-number">${String(index + 1).padStart(2, '0')}</span>${trackOutline(track)}<strong>${escape(track.name)}</strong><small>${track.id.startsWith('custom-') ? 'Création des joueurs' : escape(track.difficulty)}</small></button>`).join('');
}
export function standingsTable(entries: TournamentEntry[], me: string, final = false) {
  return `<div class="standings-heading"><span>${final ? 'CLASSEMENT FINAL DU TOURNOI' : 'CLASSEMENT DU TOURNOI'}</span><span>POINTS</span></div>${entries.map(entry => `<div class="standing-row ${entry.id === me ? 'is-you' : ''}"><b>${entry.rank}</b><i style="background:${escape(entry.color)}"></i><span>${escape(entry.name)}${entry.id === me ? '<small> VOUS</small>' : ''}</span><strong>${entry.points}<small> pts</small></strong></div>`).join('')}<p class="score-note" title="À égalité : victoires, courses terminées, puis temps cumulé.">15 · 12 · 10 · 8 · 6 · 4 · 2 · 1 points à l’arrivée. Abandon : 0.</p>`;
}
export function teamsTable(entries: TournamentEntry[]) {
  const teams = teamStandings(entries, new Map(entries.filter(entry => entry.team !== undefined).map(entry => [entry.id, entry.team!])));
  return `<div class="standings-heading"><span>CLASSEMENT DES ÉQUIPES · 4 CONTRE 4</span><span>POINTS</span></div>${teams.map(team => `<div class="standing-row"><b>${team.rank}</b><i style="background:${team.color}"></i><span>${team.name}</span><strong>${team.points}<small> pts</small></strong></div>`).join('')}<p class="score-note">Les points des quatre équipiers s’additionnent sur toutes les courses. Les objets offensifs épargnent les alliés.</p>`;
}

export const configurationMarkup = `<details id="race-configuration" class="race-configuration"><summary>Choisir l’aventure <span id="configuration-summary">Une course</span></summary><div id="configuration-controls"></div><p id="configuration-note" class="configuration-note" aria-live="polite"></p></details><div id="schedule-list" class="schedule-list" aria-label="Programme des courses"></div><div id="lobby-cup-score" class="lobby-cup-score hidden"></div>`;

type Draft = { mode: 'single' | 'tournament'; selection: 'manual' | 'random'; trackId: string; raceCount: number; schedule: string[]; trackPool: string[] };
function programKey(draft: Draft): string {
  if (draft.mode === 'single') return JSON.stringify(['single', draft.trackId]);
  return JSON.stringify(['tournament', draft.selection, draft.raceCount,
    draft.selection === 'manual' ? draft.schedule.slice(0, draft.raceCount) : [...draft.trackPool].sort()]);
}
export class TournamentControls {
  private draft: Draft = { mode: 'single', selection: 'manual', trackId: 'lagon', raceCount: 4, schedule: getAvailableTracks().map(track => track.id), trackPool: getAvailableTracks().map(track => track.id) };
  private signature = '';
  private allowed = false;
  private teamMode = false;
  private cpuCount = 0;
  private eventLevel = 3;
  private championshipId = '';
  private sessionId = '';
  private appliedProgram = '';
  private appliedRaceCount = 1;
  get hasPendingChanges() { return this.allowed && programKey(this.draft) !== this.appliedProgram; }
  get pendingMessage() {
    const count = this.draft.mode === 'single' ? 1 : this.draft.raceCount;
    const courses = (value: number) => `${value} course${value > 1 ? 's' : ''}`;
    if (count === this.appliedRaceCount) return `Le choix des circuits a été modifié. Appliquez ce programme de ${courses(count)} avant de vous déclarer prêt ou de lancer la course.`;
    return `Programme choisi : ${courses(count)} ; programme appliqué : ${courses(this.appliedRaceCount)}. Appliquez votre choix avant de vous déclarer prêt ou de lancer la course.`;
  }
  constructor(private readonly send: (type: string, payload: unknown) => void) {
    element('configuration-controls').addEventListener('change', event => {
      const input = event.target;
      if (!this.allowed || !(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) return;
      if (input.id === 'teams-select') { this.send('configure', { teamMode: input.value === 'teams' }); return; }
      if (input.id === 'cpu-select') { this.send('configure', { cpuCount: Number(input.value) }); return; }
      if (input.id === 'events-select') { this.send('configure', { eventLevel: Number(input.value) }); return; }
      if (input.id === 'mode-select') this.draft.mode = input.value as Draft['mode'];
      else if (input.id === 'selection-select') this.draft.selection = input.value as Draft['selection'];
      else if (input.id === 'track-select') this.draft.trackId = input.value;
      else if (input.id === 'count-select') {
        this.draft.raceCount = Number(input.value);
        while (this.draft.schedule.length < this.draft.raceCount) this.draft.schedule.push(getAvailableTracks()[this.draft.schedule.length % getAvailableTracks().length].id);
      } else if (input.dataset.scheduleIndex !== undefined) this.draft.schedule[Number(input.dataset.scheduleIndex)] = input.value;
      else if (input instanceof HTMLInputElement && input.dataset.poolTrack) {
        this.draft.trackPool = input.checked ? [...this.draft.trackPool, input.dataset.poolTrack] : this.draft.trackPool.filter(id => id !== input.dataset.poolTrack);
      }
      this.render();
    });
    element('configuration-controls').addEventListener('click', event => {
      if (!(event.target instanceof Element) || !event.target.closest('#configure-button') || !this.allowed) return;
      const draft = this.draft;
      if (draft.mode === 'single') this.send('configure', { mode: 'single', selection: 'manual', trackId: draft.trackId, raceCount: 1 });
      else if (draft.selection === 'manual') this.send('configure', { mode: 'tournament', selection: 'manual', raceCount: draft.raceCount, schedule: draft.schedule.slice(0, draft.raceCount) });
      else this.send('configure', { mode: 'tournament', selection: 'random', raceCount: draft.raceCount, trackPool: draft.trackPool });
    });
  }

  update(world: World, sessionId: string) {
    const cup = world.tournament;
    const editable = world.phase === 'lobby' && cup.raceIndex === 0 && cup.rounds.length === 0;
    const allowed = editable && world.hostId === sessionId && !world.ranked;
    const pending = this.hasPendingChanges;
    const nextDraft: Draft = { mode: cup.mode, selection: cup.selection, trackId: world.trackId,
      raceCount: cup.mode === 'tournament' ? cup.raceCount : 4,
      schedule: cup.mode === 'tournament' ? [...cup.schedule] : getAvailableTracks().map(track => track.id),
      trackPool: cup.mode === 'tournament' ? [...cup.trackPool] : getAvailableTracks().map(track => track.id) };
    const appliedProgram = programKey(nextDraft);
    this.teamMode = world.teamMode; this.cpuCount = world.players.filter(kart => kart.cpu).length;
    this.eventLevel = world.eventLevel; this.championshipId = world.championshipId;
    const signature = JSON.stringify([cup.mode, cup.selection, cup.trackPool, cup.schedule, cup.raceCount, world.trackId, this.teamMode, this.cpuCount, this.eventLevel, this.championshipId, getAvailableTracks().map(track => track.id)]);
    if (signature !== this.signature || sessionId !== this.sessionId || allowed !== this.allowed) {
      this.signature = signature;
      // CPU, weather and team updates are immediate; the programme has its own
      // Apply action. In particular, enabling teams can create a default two-
      // race cup on the server without replacing the host's longer draft.
      if (sessionId !== this.sessionId || !allowed || !pending || programKey(this.draft) === appliedProgram) this.draft = nextDraft;
      this.sessionId = sessionId; this.appliedProgram = appliedProgram; this.appliedRaceCount = cup.raceCount;
      this.allowed = allowed; this.render();
    }
    element('configuration-summary').textContent = cup.mode === 'single' ? 'Une course' : `${cup.raceCount} courses · ${cup.selection === 'random' ? 'Au hasard' : 'À la carte'}`;
    element('configuration-controls').classList.toggle('hidden', !allowed);
    element('configuration-note').textContent = !editable ? 'Le programme reste le même jusqu’à la fin du tournoi.' : allowed ? this.hasPendingChanges ? this.pendingMessage : 'Appliquez votre choix avant que les pilotes se déclarent prêts.' : 'Le créateur du salon choisit le circuit et la formule.';
    element('schedule-list').innerHTML = cup.schedule.map((id, index) => `<div class="schedule-stop ${index === cup.raceIndex ? 'current' : ''} ${index < cup.raceIndex ? 'done' : ''}" style="--track-accent:${getTrack(id).palette.accent}"><b>${index < cup.raceIndex ? '✓' : index + 1}</b><span>${escape(getTrack(id).name)}</span>${index === cup.raceIndex ? '<small>À SUIVRE</small>' : ''}</div>`).join('');
    const score = element('lobby-cup-score');
    score.classList.toggle('hidden', cup.mode !== 'tournament' || cup.rounds.length === 0);
    if (cup.mode === 'tournament' && cup.rounds.length > 0) score.innerHTML = (world.teamMode ? teamsTable(cup.standings) : '') + standingsTable(cup.standings, sessionId);
  }

  private render() {
    const draft = this.draft;
    const tracks = [...getAvailableTracks()];
    for (const id of [draft.trackId, ...draft.schedule, ...draft.trackPool]) if (!tracks.some(track => track.id === id)) tracks.push(getTrack(id));
    const options = (selected: string) => tracks.map(track => `<option value="${track.id}" ${selected === track.id ? 'selected' : ''}>${escape(track.name)}</option>`).join('');
    const select = (id: string, label: string, values: string) => `<label class="config-field" for="${id}"><span>${label}</span><select id="${id}">${values}</select></label>`;
    let controls = select('mode-select', 'La formule', `<option value="single" ${draft.mode === 'single' ? 'selected' : ''}>Une course</option><option value="tournament" ${draft.mode === 'tournament' ? 'selected' : ''}>Un tournoi</option>`);
    if (draft.mode === 'single') controls += select('track-select', 'Le circuit', options(draft.trackId));
    else {
      controls += `<div class="config-columns">${select('count-select', 'Nombre de courses', Array.from({ length: 7 }, (_, i) => `<option value="${i + 2}" ${draft.raceCount === i + 2 ? 'selected' : ''}>${i + 2} courses</option>`).join(''))}${select('selection-select', 'Choix des circuits', `<option value="manual" ${draft.selection === 'manual' ? 'selected' : ''}>À la carte</option><option value="random" ${draft.selection === 'random' ? 'selected' : ''}>Au hasard</option>`)}</div>`;
      if (draft.selection === 'manual') controls += `<div class="schedule-editor">${Array.from({ length: draft.raceCount }, (_, i) => `<label class="config-field"><span>Course ${i + 1}</span><select data-schedule-index="${i}" aria-label="Circuit de la course ${i + 1}">${options(draft.schedule[i])}</select></label>`).join('')}</div>`;
      else controls += `<fieldset class="pool-editor"><legend>Les circuits possibles</legend>${getAvailableTracks().map(track => `<label><input type="checkbox" data-pool-track="${track.id}" ${draft.trackPool.includes(track.id) ? 'checked' : ''}/><span>${escape(track.name)}</span></label>`).join('')}<p>Le programme sera tiré au sort pour tout le salon.</p></fieldset>`;
    }
    controls += `<button id="configure-button" class="secondary wide" ${draft.mode === 'tournament' && draft.selection === 'random' && draft.trackPool.length === 0 ? 'disabled' : ''}>${draft.mode === 'tournament' && draft.selection === 'random' ? 'Tirer le programme au sort' : 'Appliquer ce choix'} <span>✓</span></button>`;
    controls += `<div class="config-columns">${select('teams-select', 'Participants', `<option value="solo" ${!this.teamMode ? 'selected' : ''}>Individuel</option><option value="teams" ${this.teamMode ? 'selected' : ''}>Équipes 4 contre 4</option>`)}${this.teamMode ? '<p class="garage-hint">Les places libres sont occupées par des CPU.</p>' : select('cpu-select', 'Adversaires CPU', Array.from({ length: 8 }, (_, index) => `<option value="${index}" ${this.cpuCount === index ? 'selected' : ''}>${index} CPU</option>`).join(''))}</div>`;
    if (!this.championshipId && !draft.trackId.startsWith('custom-')) controls += select('events-select', 'Évolution du circuit', ['Classique', 'Routes alternatives', 'Météo et obstacles', 'Tous les événements'].map((name, level) => `<option value="${level}" ${this.eventLevel === level ? 'selected' : ''}>${name}</option>`).join(''));
    element('configuration-controls').innerHTML = controls;
    if (this.allowed) element('configuration-note').textContent = this.hasPendingChanges ? this.pendingMessage : 'Appliquez votre choix avant que les pilotes se déclarent prêts.';
  }
}
