import type { World } from './game.js';

export interface RaceHighlight { kind: 'lead' | 'jump' | 'close-finish' | 'crown'; atMs: number; label: string; playerId?: string }
export interface PartyState {
  choices: string[]; phase: 'idle' | 'voting' | 'ready'; endsAt: number;
  votes: Record<string, string>; lastWinner: string;
  lastRound?: number; lastHighlights?: RaceHighlight[]; lastReplayId?: string;
}
export function createPartyState(choices: readonly string[]): PartyState {
  return { choices: [...choices], phase: 'idle', endsAt: 0, votes: {}, lastWinner: '' };
}
export function startPartyVote(party: PartyState, now: number): void { party.phase = 'voting'; party.endsAt = now + 8000; party.votes = {}; }
export function castPartyVote(party: PartyState, playerId: string, trackId: string, now: number): boolean {
  if (party.phase !== 'voting' || now >= party.endsAt || !party.choices.includes(trackId)) return false;
  party.votes[playerId] = trackId; return true;
}
export function resolvePartyVote(party: PartyState, connectedIds: readonly string[], nextIndex: number): string {
  const counts = party.choices.map(track => Object.entries(party.votes).filter(([id, vote]) => connectedIds.includes(id) && vote === track).length);
  const maximum = Math.max(...counts), offset = nextIndex % party.choices.length;
  const winner = Array.from({ length: party.choices.length }, (_, index) => (index + offset) % party.choices.length).find(index => counts[index] === maximum)!;
  party.phase = 'ready'; party.endsAt = 0; party.lastWinner = party.choices[winner]!; return party.lastWinner;
}

/** Server observer: only events measured in authoritative snapshots are reported. */
export class RaceHighlights {
  private leader = '';
  private lastLead = -10;
  private jump = new Map<string, { at: number; time: number }>();
  private bestJump = 0;
  private crownSeq = 0;
  private closed = false;
  readonly entries: RaceHighlight[] = [];
  sample(world: World, dt: number): void {
    if (this.closed) return;
    if (world.phase !== 'racing' && world.phase !== 'finished') return;
    const players = world.players.filter(kart => !kart.spectator && !kart.abandoned);
    const leader = [...players].sort((a, b) => a.rank - b.rank)[0];
    if (leader && world.raceTime > 1 && !world.crown) {
      if (!leader.cpu && this.leader && leader.id !== this.leader && world.raceTime - this.lastLead >= 8) {
        this.add({ kind: 'lead', atMs: Math.round(world.raceTime * 1000), label: `${leader.name} prend la tête`, playerId: leader.playerId || leader.id }); this.lastLead = world.raceTime;
      }
      this.leader = leader.id;
    }
    for (const kart of players) {
      if (kart.cpu) continue;
      if (kart.airborne) {
        const jump = this.jump.get(kart.id) ?? { at: world.raceTime, time: 0 }; jump.time += dt; this.jump.set(kart.id, jump);
      } else {
        const jump = this.jump.get(kart.id); this.jump.delete(kart.id);
        if (jump && jump.time >= .7 && jump.time > this.bestJump + .1) {
          this.bestJump = jump.time;
          this.add({ kind: 'jump', atMs: Math.round(jump.at * 1000), label: `${kart.name} vole ${jump.time.toFixed(1)} s`, playerId: kart.playerId || kart.id });
        }
      }
    }
    const transfer = world.crown?.lastTransfer;
    if (transfer && transfer.seq > this.crownSeq) {
      this.crownSeq = transfer.seq; const holder = players.find(kart => kart.id === transfer.toId);
      if (holder && !holder.cpu) this.add({ kind: 'crown', atMs: Math.round(transfer.at * 1000), label: `${holder.name} récupère la couronne`, playerId: holder.playerId || holder.id });
    }
    if (world.phase === 'finished' && !this.closed) {
      this.closed = true;
      const finished = players.filter(kart => kart.finished && kart.finishTime > 0 && kart.finishTime <= world.raceTime).sort((a, b) => a.finishTime - b.finishTime);
      if (!world.crown && finished.length >= 2) {
        const gap = finished[1]!.finishTime - finished[0]!.finishTime;
        if (!finished[0]!.cpu && !finished[1]!.cpu && gap >= 0 && gap <= 1) this.add({ kind: 'close-finish', atMs: Math.round(finished[0]!.finishTime * 1000), label: `${finished[0]!.name} gagne avec ${gap.toFixed(2)} s d’avance`, playerId: finished[0]!.playerId || finished[0]!.id });
      }
    }
    world.highlights = this.entries.map(entry => ({ ...entry }));
  }
  private add(entry: RaceHighlight) { this.entries.push(entry); if (this.entries.length > 8) this.entries.shift(); }
}
