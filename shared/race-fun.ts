import type { Input, Kart, World } from './game.js';
import { getTrack, trackJumpAt } from './track.js';
import { nearestDriveableTrack } from './track-events.js';

export type RaceFeedbackKind = '' | 'graze' | 'combo' | 'relay' | 'recovery';
/** Small public HUD state. All anti-farming history stays on the server. */
export interface RaceFunFeedback {
  wallSeconds: number; chain: number; chainTime: number;
  feedbackSeq: number; feedbackKind: RaceFeedbackKind; feedbackValue: number;
}
export const COMBO_WINDOW = 8;
export const COMBO_LAP_BUDGET = .9;
export const RELAY_BONUS = .35;
export const RELAY_LAP_LIMIT = 2;
export const freshRaceFun = (): RaceFunFeedback => ({ wallSeconds: 0, chain: 0, chainTime: 0,
  feedbackSeq: 0, feedbackKind: '', feedbackValue: 0 });

type Trick = 'drift' | 'jump' | 'landing';
const mask: Record<Trick, number> = { drift: 1, jump: 2, landing: 8 };
type Flow = { mask: number; left: number; lap: number; spent: number; credited: Map<string, number>;
  jump: string; airTime: number; airClean: boolean;
  moving: number; stopped: number; blockedUntil: number; bestProgress: number; lastBoxProgress: number; assistedLap: number };
const flows = new WeakMap<Kart, Flow>();
type Relay = { target: string; expires: number; progress: number };
type Relays = { pending: Map<string, Relay>; used: Map<string, number>; pilots: Map<string, { lap: number; count: number; nextAt: number }> };
const relays = new WeakMap<World, Relays>();
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
function flow(kart: Kart): Flow {
  let state = flows.get(kart);
  if (!state) { state = { mask: 0, left: 0, lap: kart.lap, spent: 0, credited: new Map(), jump: '', airTime: 0,
    airClean: true, moving: 0, stopped: 0, blockedUntil: 0,
    bestProgress: kart.progress, lastBoxProgress: -Infinity, assistedLap: -1 }; flows.set(kart, state); }
  if (state.lap !== kart.lap) { state.lap = kart.lap; state.spent = 0; }
  return state;
}
function relayState(world: World): Relays {
  let state = relays.get(world);
  if (!state) { state = { pending: new Map(), used: new Map(), pilots: new Map() }; relays.set(world, state); }
  return state;
}
export function resetWorldFun(world: World) { relays.delete(world); }
export function resetRaceFun(kart: Kart) { flows.delete(kart); kart.fun = freshRaceFun(); }
export function interruptRaceFun(kart: Kart) {
  const state = flow(kart); state.mask = 0; state.left = 0; state.jump = ''; state.airClean = false;
  kart.fun = { ...(kart.fun ?? freshRaceFun()), chain: 0, chainTime: 0 };
}
export function raceFeedback(kart: Kart, kind: RaceFeedbackKind, value: number) {
  const old = kart.fun ?? freshRaceFun();
  kart.fun = { ...old, feedbackSeq: old.feedbackSeq + 1, feedbackKind: kind, feedbackValue: value };
}

/** Brief shallow contact keeps momentum; sustained rail pressure has a speed ceiling. */
export function railResponse(speed: number, incidence: number, seconds: number, normalSpeed: number): number {
  const frontal = clamp(Math.abs(incidence), 0, 1);
  const retained = .98 - .78 * frontal * frontal;
  const value = Math.abs(speed) * retained;
  return Math.sign(speed) * Math.min(value, seconds > .22 ? normalSpeed * .72 : Infinity);
}

export interface FunMovementBefore {
  progress: number; localProgress: number; speed: number; airborne: boolean;
  driftCharge: number; wallSeconds: number; resetCooldown: number; x: number; z: number;
}
export function captureFunMovement(kart: Kart): FunMovementBefore {
  return { progress: kart.progress, localProgress: nearestDriveableTrack(kart.x, kart.z, kart.trackId, kart.eventStage, kart.eventLevel, { progress: kart.routeProgress ?? kart.progress, elevation: kart.elevation }).progress,
    speed: kart.speed, airborne: kart.airborne, driftCharge: kart.driftCharge,
    wallSeconds: kart.fun?.wallSeconds ?? 0, resetCooldown: kart.resetCooldown, x: kart.x, z: kart.z };
}
function trick(kart: Kart, kind: Trick, credit: string) {
  const state = flow(kart);
  if (state.credited.get(credit) === kart.lap || state.mask & mask[kind]) return;
  // The number of track features and checkpoints is bounded; one entry per
  // feature is updated across laps, never appended once per physics tick.
  if (state.credited.size >= 256 && !state.credited.has(credit)) return;
  state.credited.set(credit, kart.lap); state.mask |= mask[kind]; state.left = COMBO_WINDOW;
  const chain = Object.values(mask).filter(bit => state.mask & bit).length;
  if (chain >= 2 && state.spent < COMBO_LAP_BUDGET) {
    const requested = Math.min(.18 + .08 * (chain - 2), COMBO_LAP_BUDGET - state.spent);
    const bonus = Math.max(0, Math.min(requested, 1.8 - kart.boost));
    kart.boost += bonus; state.spent += bonus;
    raceFeedback(kart, 'combo', chain);
  }
  kart.fun = { ...(kart.fun ?? freshRaceFun()), chain, chainTime: state.left };
}

/** Called only by authoritative stepWorld, after real movement and gate checks. */
export function updateRaceFun(world: World, kart: Kart, input: Input, before: FunMovementBefore, dt: number, reset: boolean) {
  const state = flow(kart), track = getTrack(kart.trackId);
  state.left = Math.max(0, state.left - dt); if (!state.left) state.mask = 0;
  const near = nearestDriveableTrack(kart.x, kart.z, kart.trackId, kart.eventStage, kart.eventLevel, { progress: kart.routeProgress ?? kart.progress, elevation: kart.elevation });
  const forward = Math.cos(kart.angle - near.angle) > .65 && kart.speed > 8;
  const clean = kart.surface !== 'offroad' && kart.surface !== 'mud' && kart.stun === 0 && (kart.fun?.wallSeconds ?? 0) < .12;
  const actualProgress = kart.progress - before.progress;
  if (reset) { state.blockedUntil = world.raceTime + 10; state.moving = 0; interruptRaceFun(kart); }
  else if (!kart.connected || kart.abandoned || kart.finished || kart.stun > 0 || !clean) interruptRaceFun(kart);
  if (actualProgress > .02 && actualProgress < 100 && forward && (input.throttle > .4 || input.brake && kart.speed > 12) && !reset) {
    state.moving = Math.min(8, state.moving + dt); state.stopped = 0;
  } else {
    state.stopped += dt; state.moving = Math.max(0, state.moving - dt * 2);
    if (state.stopped >= 2) state.blockedUntil = Math.max(state.blockedUntil, world.raceTime + 8);
  }
  state.bestProgress = Math.max(state.bestProgress, kart.progress);
  // Rails border the shoulder, which is classified as offroad. A brief brush
  // still merits feedback there, but never counts as a clean combo action.
  if (!reset && kart.connected && !kart.finished && !kart.abandoned && kart.stun === 0 && forward &&
    (kart.fun?.wallSeconds ?? 0) > before.wallSeconds && before.wallSeconds < .01 &&
    Math.abs(Math.sin(kart.angle - near.angle)) < .28)
    raceFeedback(kart, 'graze', 1);
  if (!reset && clean && forward && !kart.finished) {
    if (!input.drift && before.driftCharge >= .65 && !kart.airborne)
      trick(kart, 'drift', `drift:${kart.nextCheckpoint}`);
    if (!before.airborne && kart.airborne && kart.verticalVelocity > 0) {
      const ramp = trackJumpAt(before.localProgress, track.id);
      if (ramp) { state.jump = ramp.id; state.airTime = 0; state.airClean = true; trick(kart, 'jump', `jump:${ramp.id}`); }
    }
    if (state.jump && kart.airborne) state.airTime += dt;
    if (before.airborne && !kart.airborne && state.jump) {
      if (state.airClean && state.airTime >= .2 && Math.cos(kart.angle - near.angle) > .85)
        trick(kart, 'landing', `landing:${state.jump}`);
      state.jump = ''; state.airTime = 0;
    }
  } else state.airClean = false;
  kart.fun = { ...(kart.fun ?? freshRaceFun()), chain: Object.values(mask).filter(bit => state.mask & bit).length, chainTime: state.left };
}

/** Existing item inventory/order preserved; assistance improves one draw per lap. */
export function recoveryItemWeights(world: World, kart: Kart, base: readonly number[]): { weights: number[]; seconds: number } {
  const state = flow(kart);
  const next = world.players.filter(other => other !== kart && other.connected && !other.finished && !other.abandoned && !other.spectator && other.progress > kart.progress)
    .sort((a, b) => a.progress - b.progress)[0];
  if (!next || world.raceTime < 8 || state.moving < 3 || state.blockedUntil > world.raceTime || state.assistedLap === kart.lap ||
    kart.progress < state.bestProgress - 2 || kart.progress - state.lastBoxProgress < 20 || kart.speed < 10 || !kart.connected)
    return { weights: [...base], seconds: 0 };
  const seconds = (next.progress - kart.progress) / clamp(next.speed, 18, 35);
  const strength = clamp((seconds - 2.5) / 7.5, 0, 1);
  const recovery = [25, 45, 1, 2, 5, 2, 15, 5];
  return { weights: base.map((weight, index) => weight * (1 - strength) + recovery[index]! * strength), seconds: strength > 0 ? seconds : 0 };
}
export function noteItemDraw(world: World, kart: Kart, seconds: number) {
  const state = flow(kart); state.lastBoxProgress = kart.progress;
  if (seconds > 0) { state.assistedLap = kart.lap; raceFeedback(kart, 'recovery', Math.round(seconds)); }
}

export function armTeamRelay(world: World, follower: Kart, leader: Kart) {
  if (!world.teamMode || follower.team !== leader.team || follower.airborne || leader.airborne ||
    Math.abs(follower.elevation - leader.elevation) > 1.5) return;
  relayState(world).pending.set(follower.id, { target: leader.id, expires: world.raceTime + 4, progress: follower.progress });
}
export function resolveTeamRelays(world: World) {
  const state = relayState(world);
  if (!world.teamMode) { state.pending.clear(); return; }
  for (const [id, attempt] of state.pending) {
    const follower = world.players.find(kart => kart.id === id), leader = world.players.find(kart => kart.id === attempt.target);
    const valid = (kart: Kart | undefined): kart is Kart => !!kart && kart.connected && !kart.abandoned && !kart.finished && !kart.spectator && kart.speed > 10 && kart.stun === 0 && kart.surface !== 'offroad';
    if (!valid(follower) || !valid(leader) || follower.team !== leader.team || world.raceTime > attempt.expires) { state.pending.delete(id); continue; }
    if (follower.progress <= leader.progress + 2 || follower.progress < attempt.progress + 12) continue;
    state.pending.delete(id);
    if (Math.hypot(follower.x - leader.x, follower.z - leader.z) > 25 || Math.abs(follower.elevation - leader.elevation) > 1.5 ||
      Math.cos(follower.angle - leader.angle) < .8 || follower.airborne || leader.airborne) continue;
    const pair = [follower.id, leader.id].sort().join(':');
    const lap = Math.max(follower.lap, leader.lap);
    if (state.used.get(pair) === lap) continue;
    const usage = (kart: Kart) => {
      const old = state.pilots.get(kart.id);
      return old?.lap === kart.lap ? old : { lap: kart.lap, count: 0, nextAt: old?.nextAt ?? 0 };
    };
    const a = usage(follower), b = usage(leader);
    if (a.count >= RELAY_LAP_LIMIT || b.count >= RELAY_LAP_LIMIT || a.nextAt > world.raceTime || b.nextAt > world.raceTime) continue;
    state.used.set(pair, lap);
    for (const [kart, counter] of [[follower, a], [leader, b]] as const) {
      kart.boost = Math.max(kart.boost, Math.min(1.5, kart.boost + RELAY_BONUS));
      counter.count++; counter.nextAt = world.raceTime + 8; state.pilots.set(kart.id, counter);
      raceFeedback(kart, 'relay', 1);
    }
  }
}
