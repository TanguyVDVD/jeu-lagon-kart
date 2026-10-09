import { randomInt, randomUUID } from 'node:crypto';
import { Room, ServerError, type Client } from '@colyseus/core';
import { createKart, createWorld, neutralInput, startRace, stepWorld, validateInput,
  type Input, type Kart, type World } from '../shared/game.js';
import { isTrackId, getTrack, trackPoint, trackElevation } from '../shared/track.js';
import { isCustomTrackRuntimeId, customTrackRuntimeId, getTrackWorkshopStart, registerCustomTrackPreview, releaseCustomTrackPreview, validateCustomTrackDraft, type CustomTrackPreview, type TrackWorkshopSelection, type StoredCustomTrack } from '../shared/custom-tracks.js';
import { customTrackStore, type CustomTrackStore } from './custom-track-store.js';
import { DEFAULT_KART_MODEL, isKartModelId } from '../shared/kart-catalog.js';
import { DEFAULT_CHARACTER, isCharacterId } from '../shared/characters.js';
import { normalizeBuild } from '../shared/garage.js';
import { applyConfiguration, recordRound, registerTournamentDriver, restartTournament,
  type TournamentState } from '../shared/tournament.js';
import { config } from './config.js';
import { playerStore, INTERNAL_ROOM_KEY, rankedQueue, activeRankedPlayers } from './career.js';
import { ReplayRecorder } from './competitive.js';
import { championshipById, type PlayerProfile } from '../shared/progression.js';
import { getCpuInput } from '../shared/cpu.js';
import { assignTeam } from '../shared/teams.js';
import { COLORS } from '../shared/track.js';
import { createCrownState } from '../shared/crown.js';
import { createPartyState, startPartyVote, castPartyVote, resolvePartyVote, RaceHighlights } from '../shared/party.js';

const activeRoomIds = new Set<string>();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const colors = ['#ff6b6b', '#45d9b0', '#60a5fa', '#ffcf5c', '#bb8cff', '#ff9bc9', '#ff9a52', '#eef4ff'];
type Incoming = { input: Input; receivedAt: number; acceptedSeq: number };
type Rate = { startedAt: number; messages: number; violations: number };

function profile(options: unknown, index: number, previous?: Kart, careerLevel = 0) {
  const value = options && typeof options === 'object' ? options as Record<string, unknown> : {};
  const name = typeof value.name === 'string'
    ? value.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 18) : '';
  return {
    name: name || previous?.name || `Pilote ${index + 1}`,
    color: typeof value.color === 'string' && /^#[\da-f]{6}$/i.test(value.color)
      ? value.color.toLowerCase() : previous?.color || colors[index % colors.length]!,
    modelId: isKartModelId(value.modelId) ? value.modelId : previous?.modelId ?? DEFAULT_KART_MODEL,
    characterId: isCharacterId(value.characterId) ? value.characterId : previous?.characterId ?? DEFAULT_CHARACTER,
    build: normalizeBuild(value.build ?? previous?.build, careerLevel),
  };
}

/** Only this room owns authority over world state. Clients submit controls. */
export class RaceRoom extends Room {
  world!: World;
  private readonly inputs = new Map<string, Incoming>();
  private readonly rates = new Map<string, Rate>();
  private tick = 0;
  private accumulator = 0;
  private snapshotInterval?: NodeJS.Timeout;
  private counted = false;
  private rankedPlayers: string[] = [];
  private rankedMatchId = '';
  private championshipId = '';
  private recorder?: ReplayRecorder;
  private highlights = new RaceHighlights();
  private recordedRound = -1;
  private customStore!: CustomTrackStore;
  private readonly knownTracks = new Map<string, Set<string>>();
  private trackPayloadKey = '';
  private trackPayload: StoredCustomTrack[] = [];
  private previewTrack?:CustomTrackPreview;

  static get roomCount() { return activeRoomIds.size; }

  async onCreate(options: { practice?: boolean; trackId?: string; internalKey?: string; rankedPlayers?: string[]; rankedMatchId?: string; workshop?: TrackWorkshopSelection; previewDraft?:unknown } = {}) {
    this.customStore = await customTrackStore();
    if (activeRoomIds.size >= config.maxRooms) {
      throw new ServerError(4210, 'Le serveur a atteint sa limite de salons. Réessayez plus tard.');
    }
    let trackId=options.trackId??'lagon';
    let selection=options.workshop;
    if(options.previewDraft!==undefined){
      if(options.practice!==true||options.rankedPlayers?.length||options.rankedMatchId)throw new ServerError(4216,'Un brouillon se teste uniquement dans un atelier solo privé.');
      if(Buffer.byteLength(JSON.stringify(options.previewDraft),'utf8')>32*1024)throw new ServerError(4216,'Le brouillon dépasse 32 Kio.');
      const validation=validateCustomTrackDraft(options.previewDraft);
      if(!validation.ok||!validation.draft)throw new ServerError(4216,validation.errors.join(' '));
      this.previewTrack={id:`custom-private-${randomUUID()}-v1`,draft:validation.draft};
      trackId=this.previewTrack.id;
      registerCustomTrackPreview(this.previewTrack);
      selection??={group:'track',index:0};
    }else if(!isTrackId(trackId)||isCustomTrackRuntimeId(trackId)&&!this.customStore.isAvailable(trackId))throw new ServerError(4216,'Ce circuit est inconnu ou supprimé.');
    const workshop=selection===undefined?undefined:getTrackWorkshopStart(trackId,selection);
    if(selection!==undefined&&(!workshop||options.practice!==true||options.rankedPlayers?.length)){
      if(this.previewTrack){releaseCustomTrackPreview(this.previewTrack.id);this.previewTrack=undefined;}
      throw new ServerError(4216,'Choisissez un module existant pour un essai solo.');
    }
    let code: string;
    do {
      code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
    } while (activeRoomIds.has(code));
    this.roomId = code;
    activeRoomIds.add(code);
    this.counted = true;
    this.world = createWorld(options.practice === true, trackId);
    this.world.eventLevel = 3;
    if (workshop && selection) this.world.workshop = { selection: structuredClone(selection), label: workshop.label, startProgress: workshop.progress, endProgress: workshop.end, eventStage: workshop.eventStage };
    if (options.internalKey === INTERNAL_ROOM_KEY && options.rankedPlayers?.length) {
      this.rankedPlayers = [...options.rankedPlayers];
      this.rankedMatchId = options.rankedMatchId ?? '';
      this.world.ranked = true;
      this.world.practice = false;
      this.world.tournament = applyConfiguration(this.world.tournament, { mode: 'tournament', selection: 'random', raceCount: 2,
        trackPool: [trackId, trackId === 'neon' ? 'mangrove' : 'neon'] }, trackId).tournament;
      this.world.trackId = this.world.tournament.schedule[0]!;
    }
    this.maxClients = this.world.practice ? 1 : config.maxPlayers;
    this.autoDispose = this.rankedPlayers.length === 0;
    if (this.rankedPlayers.length) this.clock.setTimeout(() => {
      if (this.world.phase === 'lobby' && this.world.players.filter(player => player.connected).length < this.rankedPlayers.length) void this.cancelRankedLobby();
    }, 90_000);
    this.setSeatReservationTime(10);
    this.setPatchRate(0); // snapshots are explicit; no duplicate Schema payloads.

    this.onMessage('input', (client, data) => this.onInput(client, data));
    this.onMessage('tracksReady', (client, data) => {
      if (!this.authorize(client) || !Array.isArray(data?.ids) || data.ids.length > 16) return;
      const known = this.knownTracks.get(client.sessionId) ?? new Set<string>();
      for (const id of data.ids) if (typeof id === 'string' && (this.customStore.get(id)||id===this.previewTrack?.id)) known.add(id);
      this.knownTracks.set(client.sessionId, known);
    });
    this.onMessage('ready', (client, data) => {
      const kart = this.authorize(client);
      if (!kart || this.world.phase !== 'lobby' || typeof data?.ready !== 'boolean') return;
      kart.ready = data.ready;
      this.sendSnapshot();
      if (this.rankedPlayers.length && this.rankedPlayers.every(id => this.world.players.some(player => player.playerId === id && player.connected && player.ready))) {
        const host = this.clients.find(candidate => candidate.sessionId === this.world.hostId);
        if (host) this.beginRace(host);
      }
    });
    this.onMessage('profile', (client, data) => {
      const kart = this.authorize(client);
      if (!kart || this.world.phase !== 'lobby') return;
      Object.assign(kart, profile(data, this.world.players.indexOf(kart), kart, kart.careerLevel));
      kart.ready = false;
      registerTournamentDriver(this.world.tournament, kart);
      this.sendSnapshot();
    });
    this.onMessage('configure', (client, data) => this.configure(client, data));
    this.onMessage('funConfigure', (client, data) => this.configureFun(client, data));
    this.onMessage('partyVote', (client, data) => {
      const kart = this.authorize(client);
      if (!kart || kart.spectator || !this.world.party || typeof data?.trackId !== 'string' || !castPartyVote(this.world.party, kart.id, data.trackId, Date.now())) return;
      this.sendSnapshot();
    });
    this.onMessage('workshop-restart', client => {
      const kart = this.authorize(client);
      if (!kart || kart.id !== this.world.hostId || !this.world.workshop) return;
      this.resetLobby(this.world.trackId, restartTournament(this.world.tournament, this.world.trackId));
      for (const player of this.world.players) player.ready = true;
      this.beginRace(client);
    });
    this.onMessage('start', client => this.beginRace(client));
    this.onMessage('nextRace', client => this.nextRace(client));
    this.onMessage('rematch', client => this.rematch(client));
    this.onMessage('*', (client) => {
      if (this.authorize(client)) this.notice(client, 'Commande inconnue : seuls les contrôles de conduite sont acceptés.');
    });
    this.setSimulationInterval(deltaMs => this.update(deltaMs), 1000 / config.simHz);
    this.snapshotInterval = setInterval(() => this.sendSnapshot(), 1000 / config.snapshotHz);
  }

  async onAuth(_client: Client, options: { token?: unknown } = {}) {
    if (!options.token) {
      if (this.rankedPlayers.length) throw new ServerError(4220, 'Un profil est nécessaire en course classée.');
      return { profile: null };
    }
    const profile = (await playerStore()).authenticate(options.token);
    if (!profile) throw new ServerError(4220, 'Profil invalide. Rechargez la page.');
    if (this.world.players.some(kart => kart.playerId === profile.id)) throw new ServerError(4221, 'Ce profil est déjà dans ce salon.');
    if (this.rankedPlayers.length && !this.rankedPlayers.includes(profile.id)) throw new ServerError(4222, 'Ce salon est réservé aux joueurs du matchmaking.');
    if (this.rankedPlayers.length) {
      const reservation = rankedQueue.poll(profile.id);
      if (reservation.state !== 'matched' || reservation.roomId !== this.roomId) throw new ServerError(4222, 'La réservation classée a expiré ou a été annulée.');
    }
    return { profile };
  }

  onJoin(client: Client, options: unknown, auth?: { profile?: PlayerProfile | null }) {
    if (this.world.phase === 'lobby' && this.world.tournament.raceIndex === 0) {
      const replaceable = this.world.players.find(kart => kart.cpu);
      if (replaceable) { this.world.players = this.world.players.filter(kart => kart !== replaceable); this.inputs.delete(replaceable.id); this.rates.delete(replaceable.id); }
      this.world.tournament.standings = this.world.tournament.standings.filter(entry => this.world.players.some(kart => kart.id === entry.id));
    }
    if (this.world.players.filter(player => !player.abandoned).length >= this.maxClients) {
      throw new ServerError(4211, 'Ce salon est complet, y compris les places réservées aux reconnexions.');
    }
    this.knownTracks.delete(client.sessionId);
    const index = this.world.players.length;
    const saved = auth?.profile;
    const identity = profile(options, index, undefined, saved?.careerLevel ?? 0);
    const kart = createKart(client.sessionId, identity.name, identity.color, index, this.world.trackId, identity.modelId, identity.build, identity.characterId);
    kart.playerId = saved?.id ?? ''; kart.careerLevel = saved?.careerLevel ?? 0;
    kart.team = assignTeam(this.world.players, index);
    if (saved && this.rankedPlayers.length) {
      if (!rankedQueue.consume(saved.id, this.roomId)) throw new ServerError(4222, 'La réservation classée a expiré ou a été annulée.');
      activeRankedPlayers.add(saved.id);
    }
    kart.connected = true;
    kart.spectator = this.world.phase !== 'lobby';
    kart.ready = false;
    kart.lastSeq = -1;
    kart.epoch = 1;
    this.world.players.push(kart);
    this.autoDispose = true;
    registerTournamentDriver(this.world.tournament, kart);
    if (!this.world.hostId) this.world.hostId = kart.id;
    this.initializeInputs(kart);
    if (kart.spectator) this.notice(client, 'Course en cours : vous participerez à la prochaine manche.');
    this.sendSnapshot();
  }

  async onLeave(client: Client, consented: boolean) {
    const kart = this.findKart(client.sessionId);
    if (!kart) return;
    this.knownTracks.delete(client.sessionId);
    kart.connected = false;
    if (this.world.party) delete this.world.party.votes[kart.id];
    kart.ready = false;
    kart.epoch += 1;
    kart.lastSeq = -1;
    this.inputs.delete(kart.id);
    this.rates.delete(kart.id);
    this.transferHost();
    this.sendSnapshot();
    if (!consented) {
      try {
        const reconnected = await this.allowReconnection(client, config.reconnectSeconds);
        const resumed = this.findKart(client.sessionId);
        if (!resumed) return;
        resumed.connected = true;
        if (this.world.phase === 'lobby') resumed.spectator = false;
        // Colyseus preserves sessionId and rotates its reconnectionToken.
        this.initializeInputs(resumed);
        if (!this.world.hostId) this.world.hostId = resumed.id;
        this.notice(reconnected, 'Connexion rétablie. Votre progression a été conservée.');
        this.sendSnapshot();
        return;
      } catch {
        // The reserved seat expires after the configured reconnection window.
      }
    }
    const departing = this.findKart(kart.id);
    if (departing && !departing.spectator && this.world.phase !== 'lobby') {
      // Retain the result until rematch; an unfinished departure becomes a DNF.
      // A driver who already crossed the finish keeps their finishTime and rank.
      departing.abandoned = true;
      departing.speed = 0;
      departing.item = '';
      departing.itemCharges = 0;
      departing.invincible = 0;
      departing.shield = 0;
    } else {
      this.world.players = this.world.players.filter(player => player.id !== kart.id);
    }
    this.inputs.delete(kart.id);
    this.rates.delete(kart.id);
    this.transferHost();
    this.sendSnapshot();
  }

  onDispose() {
    if(this.previewTrack){releaseCustomTrackPreview(this.previewTrack.id);this.previewTrack=undefined;}
    if (this.rankedMatchId) rankedQueue.releaseMatch(this.rankedMatchId);
    for (const id of this.rankedPlayers) activeRankedPlayers.delete(id);
    if (this.counted) activeRoomIds.delete(this.roomId);
    if (this.snapshotInterval) clearInterval(this.snapshotInterval);
    this.inputs.clear();
    this.rates.clear();
    this.knownTracks.clear();
  }

  async cancelRankedLobby() {
    if (!this.rankedPlayers.length || (this.world.phase !== 'lobby' && this.world.phase !== 'countdown')) return;
    this.broadcast('notice', { message: 'Une réservation classée a été annulée. Relancez la recherche depuis l’accueil.' });
    await this.disconnect(4000);
  }

  private findKart(id: string) { return this.world.players.find(player => player.id === id); }

  private initializeInputs(kart: Kart) {
    this.inputs.set(kart.id, {
      input: neutralInput(kart.lastSeq, kart.epoch), receivedAt: 0, acceptedSeq: kart.lastSeq,
    });
    this.rates.set(kart.id, { startedAt: Date.now(), messages: 0, violations: 0 });
  }

  private authorize(client: Client): Kart | undefined {
    const kart = this.findKart(client.sessionId);
    if (!kart?.connected) return;
    const now = Date.now();
    const rate = this.rates.get(kart.id)!;
    if (now - rate.startedAt >= 1000) {
      rate.startedAt = now;
      rate.messages = 0;
      rate.violations = Math.max(0, rate.violations - 1);
    }
    rate.messages += 1;
    if (rate.messages > 90) {
      rate.violations += 1;
      if (rate.violations > 30) client.leave(4008, 'Trop de commandes.');
      return;
    }
    return kart;
  }

  private onInput(client: Client, data: unknown) {
    const kart = this.authorize(client);
    if (!kart) return;
    const input = validateInput(data);
    const previous = this.inputs.get(kart.id)!;
    // Epoch invalidates every command from the previous transport connection.
    // Keep only the newest command: no queued burst can advance the simulation.
    if (!input || input.epoch !== kart.epoch || input.seq <= previous.acceptedSeq) return;
    // A one-frame item/reset press must survive two packets arriving in one tick.
    // The movement command still collapses to the latest sample, never a queue.
    if (previous.acceptedSeq > kart.lastSeq) {
      input.use ||= previous.input.use;
      input.reset ||= previous.input.reset;
    }
    this.inputs.set(kart.id, { input, acceptedSeq: input.seq, receivedAt: Date.now() });
  }

  private beginRace(client: Client) {
    const host = this.authorize(client);
    if (!host) return;
    if (host.id !== this.world.hostId) return this.notice(client, 'Seul le créateur du salon peut lancer la course.');
    if (this.world.phase !== 'lobby') return this.notice(client, 'Une manche est déjà en cours.');
    if (!this.previewTrack && this.world.tournament.rounds.length === 0 &&
      [this.world.trackId, ...this.world.tournament.schedule, ...(this.world.party?.choices ?? [])]
        .some(id => isCustomTrackRuntimeId(id) && !this.customStore.isAvailable(id)))
      return this.notice(client, 'Un circuit du programme a été supprimé. Choisissez un autre circuit avant le départ.');
    if (this.rankedPlayers.length && !this.rankedPlayers.every(id => this.world.players.some(player => player.playerId === id && player.connected && !player.spectator)))
      return this.notice(client, 'Attendez tous les pilotes réservés par le matchmaking.');
    const participants = this.world.players.filter(player => player.connected && !player.spectator);
    if (participants.length < (this.world.practice ? 1 : 2)) {
      return this.notice(client, 'Il faut au moins deux pilotes. Le mode entraînement permet de jouer seul.');
    }
    if (participants.some(player => !player.ready)) return this.notice(client, 'Tous les pilotes doivent être prêts.');
    // A temporarily disconnected lobby member waits for the next round.
    for (const player of this.world.players) if (!player.connected) player.spectator = true;
    for (const player of participants) registerTournamentDriver(this.world.tournament, player);
    startRace(this.world);
    this.highlights = new RaceHighlights(); this.world.highlights = []; delete this.world.replayId;
    if (this.world.party) { this.world.party.phase = 'idle'; this.world.party.votes = {}; this.world.party.endsAt = 0; }
    this.prepareWorkshop();
    this.recorder = this.world.workshop ? undefined : new ReplayRecorder({ id: randomUUID(), trackId: this.world.trackId, ranked: this.rankedPlayers.length > 0, eventLevel: this.world.eventLevel, ...(this.world.crown ? { mode: 'crown' } : {}) });
    this.sendSnapshot();
  }

  private configure(client: Client, data: unknown) {
    const host = this.authorize(client);
    if (!host) return;
    if (host.id !== this.world.hostId) return this.notice(client, 'Seul le créateur du salon peut changer les réglages.');
    if (this.rankedPlayers.length) return this.notice(client, 'Le programme classé est fixé par le serveur.');
    if (this.world.phase !== 'lobby' || this.world.tournament.raceIndex !== 0 || this.world.tournament.rounds.length > 0) {
      return this.notice(client, 'Les réglages sont verrouillés jusqu’à la fin du tournoi.');
    }
    try {
      if (this.world.workshop) throw new Error('L’atelier garde ce module. Revenez à l’éditeur pour changer le circuit.');
      if (data && typeof data === 'object' && 'eventLevel' in data) {
        const level = (data as { eventLevel: unknown }).eventLevel;
        if (!Number.isInteger(level) || Number(level) < 0 || Number(level) > 3 || this.championshipId) throw new Error('Le niveau des événements est fixé par le championnat ou doit être compris entre 0 et 3.');
        this.world.eventLevel = Number(level); this.sendSnapshot(); return;
      }
      if (data && typeof data === 'object' && ('teamMode' in data || 'cpuCount' in data)) {
        const options = data as { teamMode?: unknown; cpuCount?: unknown };
        if (options.teamMode !== undefined && typeof options.teamMode !== 'boolean') throw new Error('Mode équipes invalide.');
        if (options.teamMode === true && this.world.crown) throw new Error('Désactivez Couronne avant de choisir les équipes.');
        if (options.cpuCount !== undefined && (!Number.isInteger(options.cpuCount) || Number(options.cpuCount) < 0 || Number(options.cpuCount) > 7)) throw new Error('Choisissez de 0 à 7 CPU.');
        this.world.players = this.world.players.filter(kart => !kart.cpu);
        if (options.teamMode !== undefined) this.world.teamMode = options.teamMode;
        if (this.world.teamMode) {
          this.championshipId = ''; this.world.championshipId = ''; this.world.practice = false; this.maxClients = config.maxPlayers;
          if (this.world.tournament.mode === 'single') this.world.tournament = applyConfiguration(this.world.tournament,
            { mode: 'tournament', selection: 'manual', raceCount: 2, schedule: [this.world.trackId, 'neon'] }, this.world.trackId).tournament;
          this.world.players.forEach((kart, index) => { kart.team = index % 2 as 0 | 1; });
        }
        this.fillCpu(this.world.teamMode ? 8 : Math.min(8, this.world.players.length + Number(options.cpuCount ?? 0)));
        this.world.tournament.standings = this.world.tournament.standings.filter(entry => this.world.players.some(kart => kart.id === entry.id));
        this.sendSnapshot(); return;
      }
      if (data && typeof data === 'object' && 'championshipId' in data) {
        if (this.world.crown || this.world.party) throw new Error('Désactivez Soirée et Couronne avant de choisir un championnat.');
        const cup = championshipById(String((data as { championshipId: unknown }).championshipId));
        if (!cup || !host.playerId || cup.unlockLevel > host.careerLevel) throw new Error('Ce championnat est encore verrouillé.');
        this.championshipId = cup.id;
        this.world.teamMode = false; this.world.practice = false; this.maxClients = config.maxPlayers;
        this.world.eventLevel = ({ discovery: 0, terrain: 1, weather: 2, precision: 2, metamorphosis: 3, masters: 3 } as Record<string, number>)[cup.id] ?? 0;
        const configured = applyConfiguration(this.world.tournament, { mode: 'tournament', selection: 'manual', raceCount: cup.tracks.length, schedule: [...cup.tracks] }, this.world.trackId);
        this.resetLobby(configured.trackId, configured.tournament); this.fillCpu(4); this.sendSnapshot(); return;
      }
      const configured = applyConfiguration(this.world.tournament, data, this.world.trackId, () => randomInt(0x1000000) / 0x1000000);
      if (this.world.party && configured.tournament.mode !== 'tournament') throw new Error('Désactivez Soirée avant de choisir une course simple.');
      if ([...configured.tournament.schedule, ...configured.tournament.trackPool].some(id => isCustomTrackRuntimeId(id) && !this.customStore.isAvailable(id))) throw new Error('Un circuit du programme est indisponible. Actualisez la bibliothèque.');
      this.championshipId = '';
      this.resetLobby(configured.trackId, configured.tournament);
      this.sendSnapshot();
    } catch (error) {
      this.notice(client, error instanceof Error ? error.message : 'Réglages du salon invalides.');
    }
  }

  private fillCpu(total: number) {
    while (this.world.players.length < total) {
      const index = this.world.players.length;
      const kart = createKart(`cpu-${randomUUID()}`, `CPU ${index + 1}`, COLORS[index % COLORS.length]!, index, this.world.trackId, ['zsky', 'sprint', 'retro'][index % 3]);
      kart.cpu = true; kart.connected = true; kart.ready = true; kart.team = assignTeam(this.world.players, index);
      kart.eventLevel = this.world.eventLevel;
      this.world.players.push(kart); this.initializeInputs(kart); registerTournamentDriver(this.world.tournament, kart);
    }
  }

  private configureFun(client: Client, payload: unknown) {
    const host = this.authorize(client); if (!host) return;
    if (host.id !== this.world.hostId || this.rankedPlayers.length || this.championshipId || this.world.practice || this.world.workshop || this.world.phase !== 'lobby' || this.world.tournament.rounds.length) {
      return this.notice(client, 'Le créateur choisit ces modes dans un salon libre, avant la première manche.');
    }
    try {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Modes du salon invalides.');
      const data = payload as Record<string, unknown>;
      if (Object.keys(data).some(key => !['crown', 'party', 'choices'].includes(key)) || typeof data.crown !== 'boolean' || typeof data.party !== 'boolean') throw new Error('Modes du salon invalides.');
      if (data.crown && this.world.teamMode) throw new Error('Désactivez les équipes avant de choisir Couronne.');
      let choices: string[] = [];
      if (data.party) {
        if (!Array.isArray(data.choices) || data.choices.length !== 3 || new Set(data.choices).size !== 3 || data.choices.some(id => typeof id !== 'string' || !isTrackId(id) || isCustomTrackRuntimeId(id) && !this.customStore.isAvailable(id))) throw new Error('Choisissez trois circuits différents et disponibles.');
        choices = data.choices as string[];
      }
      const tournament = data.party && this.world.tournament.mode === 'single' ? applyConfiguration(this.world.tournament,
        { mode: 'tournament', selection: 'manual', raceCount: 4, schedule: [this.world.trackId, choices[0], choices[1], choices[2]] }, this.world.trackId).tournament : this.world.tournament;
      this.world.crown = data.crown ? createCrownState() : undefined;
      this.world.party = data.party ? createPartyState(choices) : undefined;
      this.resetLobby(this.world.trackId, tournament); this.sendSnapshot();
    } catch (error) { this.notice(client, error instanceof Error ? error.message : 'Modes du salon invalides.'); }
  }

  private prepareWorkshop() {
    const workshop = this.world.workshop; if (!workshop) return;
    const source = getTrackWorkshopStart(this.world.trackId, workshop.selection);
    if (!source) return;
    const track = getTrack(this.world.trackId), point = trackPoint(source.progress, track.id);
    this.world.phase = 'racing'; this.world.countdown = 0;
    this.world.eventStage = source.eventStage ?? 0;
    for (const kart of this.world.players) {
      kart.x = point.x; kart.z = point.z; kart.angle = point.angle;
      kart.elevation = trackElevation(source.progress, track.id); kart.verticalVelocity = 0; kart.airborne = false;
      kart.speed = 0; kart.progress = source.progress; kart.routeProgress = source.progress; kart.respawnProgress = source.progress;
      kart.nextCheckpoint = track.checkpoints.findIndex(checkpoint => checkpoint.progress > source.progress);
      if (kart.nextCheckpoint < 0) kart.nextCheckpoint = 0;
      kart.respawnX = point.x; kart.respawnZ = point.z; kart.respawnAngle = point.angle;
      kart.eventStage = this.world.eventStage; kart.eventLevel = this.world.eventLevel;
      kart.lastSeq = -1; this.initializeInputs(kart);
    }
  }

  private advancePartyVote(now: number) {
    const party = this.world.party;
    if (!party || party.phase !== 'voting' || now < party.endsAt || this.world.phase !== 'finished' || this.world.tournament.completed) return;
    const tournament = this.world.tournament;
    const winner = resolvePartyVote(party, this.world.players.filter(kart => kart.connected && !kart.spectator && !kart.cpu).map(kart => kart.id), tournament.raceIndex + 1);
    tournament.raceIndex++; tournament.schedule[tournament.raceIndex] = winner;
    tournament.trackPool = [...new Set([...tournament.trackPool, winner])];
    this.resetLobby(winner, tournament);
    this.broadcast('notice', { message: `${getTrack(winner).name} choisi. Confirmez que vous êtes prêt pour le prochain départ.` });
    this.sendSnapshot();
  }

  private recordFinishedRound() {
    if (this.world.workshop) return;
    if (this.world.phase === 'finished') recordRound(this.world.tournament, this.world.trackId, this.world.players);
    if (this.world.phase !== 'finished' || this.recordedRound === this.world.round) return;
    this.recordedRound = this.world.round;
    if (this.world.party) {
      this.world.party.lastRound = this.world.round;
      this.world.party.lastHighlights = structuredClone(this.world.highlights ?? []);
      delete this.world.party.lastReplayId;
      if (!this.world.tournament.completed) startPartyVote(this.world.party, Date.now());
    }
    const world = structuredClone(this.world), cupId = this.championshipId;
    const samples = world.players.filter(kart => !kart.spectator && !kart.cpu).map(kart => ({ ...kart, playerId: kart.playerId || kart.id }));
    const replay = this.recorder?.finish(world.raceTime, samples, world.highlights);
    let profilesUpdated = false;
    void (async () => {
      const humans = world.players.filter(kart => kart.playerId && !kart.spectator);
      const store = await playerStore();
      if (humans.length && !world.crown) {
        await store.recordRace({ id: replay?.id ?? `${this.roomId}-${world.round}`, trackId: world.trackId, ranked: this.rankedPlayers.length > 0,
          finishedAt: Date.now(), entries: humans.map(kart => ({ playerId: kart.playerId, rank: kart.rank, finished: kart.finished, finishTime: kart.finished ? kart.finishTime : 0 })) });
        profilesUpdated = true;
      }
      if (replay?.drivers.length) {
        await store.saveReplay(replay);
        if (this.world.round === world.round) this.world.replayId = replay.id;
        if (this.world.party?.lastRound === world.round) this.world.party.lastReplayId = replay.id;
      }
      if (cupId && world.tournament.completed) {
        for (const kart of humans) {
          const result = world.tournament.standings.find(entry => entry.id === kart.id);
          const requiredLevel = championshipById(cupId)?.unlockLevel ?? 4;
          if (result && result.rank <= 3 && result.racesCompleted === world.tournament.raceCount && (store.getProfile(kart.playerId)?.careerLevel ?? 0) >= requiredLevel)
            await store.completeChampionship(kart.playerId, cupId, result.rank, result.racesCompleted);
        }
      }
      for (const kart of this.world.players) if (kart.playerId) kart.careerLevel = store.getProfile(kart.playerId)?.careerLevel ?? kart.careerLevel;
      this.sendSnapshot();
    })().catch(error => { console.error('Race persistence failed:', error instanceof Error ? error.message : error); this.broadcast('notice', { message: profilesUpdated
      ? 'Votre progression est sauvegardée, mais l’enregistrement complet de cette course a échoué.'
      : 'La sauvegarde de cette course a échoué. Votre profil précédent est conservé.' }); })
      .finally(() => {
        // Phase "finished" is sent before asynchronous persistence. Notify even
        // if replay saving failed after the profile itself was already saved.
        if (profilesUpdated) this.broadcast('profile-updated', { round: world.round });
      });
    if (world.tournament.completed || world.tournament.mode === 'single') for (const id of this.rankedPlayers) activeRankedPlayers.delete(id);
  }

  private nextRace(client: Client) {
    const host = this.authorize(client);
    if (!host) return;
    if (host.id !== this.world.hostId) return this.notice(client, 'Seul le créateur du salon peut préparer la course suivante.');
    if (this.world.party?.phase === 'voting') return this.notice(client, 'Le vote choisit la prochaine piste. Il se termine après huit secondes.');
    if (this.world.phase !== 'finished' || this.world.tournament.mode !== 'tournament') {
      return this.notice(client, 'Terminez la course du tournoi avant de passer à la suivante.');
    }
    this.recordFinishedRound();
    const tournament = this.world.tournament;
    if (tournament.completed) return this.notice(client, 'Le tournoi est terminé. Vous pouvez proposer une revanche.');
    tournament.raceIndex += 1;
    this.resetLobby(tournament.schedule[tournament.raceIndex]!, tournament);
    this.sendSnapshot();
  }

  private rematch(client: Client) {
    const host = this.authorize(client);
    if (!host) return;
    if (host.id !== this.world.hostId) return this.notice(client, 'Seul le créateur du salon peut préparer la revanche.');
    if (this.world.phase !== 'finished') return this.notice(client, 'La revanche sera disponible après la course.');
    this.recordFinishedRound();
    if (this.world.tournament.mode === 'tournament' && !this.world.tournament.completed) {
      return this.notice(client, 'Le tournoi continue : choisissez la course suivante.');
    }
    const tournament = restartTournament(this.world.tournament, this.world.trackId, () => randomInt(0x1000000) / 0x1000000);
    if ([...tournament.schedule, ...(this.world.party?.choices ?? [])].some(id => isCustomTrackRuntimeId(id) && !this.customStore.isAvailable(id)))
      return this.notice(client, 'Un circuit de la revanche a été supprimé. Créez un nouveau salon avec des circuits disponibles.');
    this.resetLobby(tournament.schedule[0]!, tournament);
    this.sendSnapshot();
  }

  /** Reset per-race state while preserving sessions and, between rounds, points. */
  private resetLobby(trackId: string, tournament: TournamentState) {
    const old = this.world;
    const next = createWorld(old.practice, trackId);
    next.eventLevel = old.eventLevel; next.teamMode = old.teamMode;
    if (old.crown) next.crown = createCrownState();
    if (old.party) next.party = structuredClone(old.party);
    if (old.workshop) next.workshop = structuredClone(old.workshop);
    next.ranked = this.rankedPlayers.length > 0; next.championshipId = this.championshipId;
    next.tournament = tournament;
    next.hostId = old.hostId;
    next.round = old.round;
    next.time = old.time;
    next.players = old.players.filter(player => !player.abandoned).map((player, index) => {
      const kart = createKart(player.id, player.name, player.color, index, trackId, player.modelId, player.build, player.characterId);
      kart.playerId = player.playerId; kart.careerLevel = player.careerLevel;
      kart.eventLevel = next.eventLevel; kart.team = player.team; kart.cpu = player.cpu;
      kart.connected = player.connected;
      kart.spectator = !player.connected;
      kart.ready = player.cpu;
      kart.epoch = player.epoch + 1;
      kart.lastSeq = -1;
      return kart;
    });
    this.world = next;
    this.inputs.clear();
    this.rates.clear();
    this.knownTracks.clear();
    for (const player of next.players) {
      this.initializeInputs(player);
      registerTournamentDriver(tournament, player);
    }
  }

  private transferHost() {
    if (!this.world.players.some(player => player.id === this.world.hostId && player.connected && !player.cpu)) {
      this.world.hostId = this.world.players.find(player => player.connected && !player.cpu)?.id || '';
    }
  }

  private update(deltaMs: number) {
    const dt = 1 / config.simHz;
    // Catch up normal scheduler jitter, but never simulate a long stall in a burst.
    this.accumulator += Math.min(deltaMs / 1000, dt * 5);
    const now = Date.now();
    while (this.accumulator >= dt) {
      const controls = new Map<string, Input>();
      for (const kart of this.world.players) {
        const incoming = this.inputs.get(kart.id);
        controls.set(kart.id, kart.cpu ? getCpuInput(kart, kart.lastSeq + 1, this.world, this.world.eventLevel / 3) : kart.connected && incoming && now - incoming.receivedAt <= config.inputTimeoutMs
          ? incoming.input : neutralInput(kart.lastSeq, kart.epoch));
      }
      stepWorld(this.world, controls, dt);
      if (!this.world.workshop) this.highlights.sample(this.world, dt);
      if (this.world.phase === 'racing') this.recorder?.sample(this.world.raceTime,
        this.world.players.filter(kart => !kart.cpu).map(kart => ({ ...kart, playerId: kart.playerId || kart.id })));
      this.recordFinishedRound();
      for (const kart of this.world.players) {
        const consumed = controls.get(kart.id);
        if (consumed) kart.lastSeq = consumed.seq;
      }
      this.tick += 1;
      this.accumulator -= dt;
    }
    this.advancePartyVote(now);
  }

  private sendSnapshot() {
    const ids = [...new Set([this.world.trackId, ...this.world.tournament.schedule, ...(this.world.party?.choices ?? [])])].filter(isCustomTrackRuntimeId);
    const key = ids.join('|');
    if (key !== this.trackPayloadKey) {
      this.trackPayloadKey = key;
      this.trackPayload = ids.map(id => this.customStore.get(id)).filter((record): record is NonNullable<typeof record> => !!record);
    }
    const snapshot = { world: this.world, serverTime: Date.now(), tick: this.tick, simHz: config.simHz };
    for (const client of this.clients) {
      const known = this.knownTracks.get(client.sessionId);
      const tracks = this.trackPayload.filter(record => !known?.has(customTrackRuntimeId(record)));
      // Repeat definitions until acknowledged: the first message can precede the
      // client's subscription, especially when joining or restoring a session.
      const previewTrack=this.previewTrack&&!known?.has(this.previewTrack.id)?this.previewTrack:undefined;
      client.send('snapshot', { ...snapshot,...(tracks.length?{tracks}:{}),...(previewTrack?{previewTrack}:{}) });
    }
  }

  private notice(client: Client, message: string) { client.send('notice', { message }); }
}
