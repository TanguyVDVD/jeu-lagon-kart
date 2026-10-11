import { COLORS, TOTAL_LAPS, BASE_RACE_SECONDS, getTrackLapCount, getTrackRaceTimeLimit, getTrack, nearestTrack, spawnPoint, trackPoint, trackSurface, trackElevation, reliefElevation, reliefSlope, trackJumpAt, type Surface } from './track.js';
import { createTournament, type TournamentState } from './tournament.js';
import { DEFAULT_KART_MODEL, normalizeKartModelId, type KartModelId } from './kart-catalog.js';
import { DEFAULT_CHARACTER, normalizeCharacterId, type CharacterId } from './characters.js';
import { DEFAULT_BUILD, normalizeBuild, getKartStats, type KartBuild } from './garage.js';
import { nearestDriveableTrack, dynamicSurface, constrainTrackEvent, trackEventPickups, eventRoutePoint, eventCheckpointGates, getTrackEvent, trackBoundaryGap, pointOnBranch } from './track-events.js';
import { TRACK_SHOULDER, KART_COLLISION_HEIGHT, trackBoundaryHeight, trackBoundaryShoulder, driveableGroundHeight } from './obstacle-heights.js';
import { freshRaceFun, railResponse, captureFunMovement, updateRaceFun, recoveryItemWeights, noteItemDraw,
  armTeamRelay, resolveTeamRelays, resetWorldFun, resetRaceFun, interruptRaceFun, type RaceFunFeedback } from './race-fun.js';
import { startCrown, beforeCrownStep, stepCrown, crownProtected, onCrownAttack, type CrownState } from './crown.js';
import type { PartyState, RaceHighlight } from './party.js';
import type { TrackWorkshopSelection } from './custom-tracks.js';
import { automaticTrackElevation } from './track-crossings.js';
import { resetTrackInteractions, triggerTrackInteractions, applyInteractionSurface, interactionLaunchSpeed,
  type TrackInteractionState } from './track-interactions.js';
export { CHECKPOINTS, COLORS, ROAD_WIDTH, TOTAL_LAPS, TRACK, TRACK_LENGTH, TRACKS, TRACK_IDS,
  getTrack, isTrackId, nearestTrack, spawnPoint, trackPoint, trackSurface } from './track.js';
export type { Vec2, TrackDefinition, TrackId, TrackZone, Surface } from './track.js';

export const ITEMS = ['turbo', 'tripleTurbo', 'trap', 'projectile', 'seeker', 'leaderBolt', 'star', 'shield'] as const;
export type Item = '' | typeof ITEMS[number];
export interface Input {
  seq: number; epoch: number; throttle: number; steer: number;
  brake: boolean; drift: boolean; use: boolean; reset: boolean;
}
export interface Kart {
  id: string; name: string; color: string; x: number; z: number; angle: number; speed: number;
  modelId: KartModelId; characterId: CharacterId; build: KartBuild; playerId: string; careerLevel: number;
  eventStage: number; eventLevel: number; team: 0 | 1; cpu: boolean;
  elevation: number; verticalVelocity: number; airborne: boolean;
  trackId: string; surface: Surface; turnVelocity: number; padCooldown: number; padZone: string;
  padLaps: Record<string, number>; launchCharge: number; launchArmed: boolean; launchPressed: boolean;
  launchFault: boolean; draftCharge: number; draftCooldown: number;
  driftCharge: number; boost: number; stun: number; lap: number; nextCheckpoint: number;
  progress: number; finished: boolean; finishTime: number; rank: number; item: Item;
  /** Surface coordinate for prediction and stacked crossings, independent of validated race progress. */
  routeProgress?: number; respawnProgress?: number;
  itemCharges: number; invincible: number; shield: number; hitGrace: number;
  ready: boolean; connected: boolean; spectator: boolean; abandoned: boolean; lastSeq: number; epoch: number;
  driftDirection: number; lateralVelocity: number; respawnX: number; respawnZ: number;
  respawnAngle: number; resetCooldown: number; itemLatch: boolean; resetLatch: boolean;
  fun?: RaceFunFeedback; crownMode?: boolean;
  interactions?: TrackInteractionState[]; interactionTime?: number;
}
export interface WorldObject {
  id: string; kind: 'trap' | 'projectile' | 'seeker' | 'leaderBolt';
  x: number; z: number; angle: number; owner: string; ttl: number; targetId?: string;
  progress?: number; elevation?: number;
}
export interface Pickup { id: string; x: number; z: number; cooldown: number; progress?: number; elevation?: number }
export interface World {
  phase: 'lobby' | 'countdown' | 'racing' | 'finished'; players: Kart[];
  objects: WorldObject[]; pickups: Pickup[]; hostId: string; practice: boolean;
  round: number; time: number; countdown: number; raceTime: number; finishTimeout: number; seed: number;
  trackId: string; tournament: TournamentState;
  eventStage: number; eventLevel: number; teamMode: boolean; ranked: boolean; championshipId: string;
  crown?: CrownState; party?: PartyState; highlights?: RaceHighlight[]; replayId?: string;
  interactions?: TrackInteractionState[];
  workshop?: { selection: TrackWorkshopSelection; label: string; startProgress: number; endProgress: number; eventStage?: number };
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const MAX_RACE_SECONDS = BASE_RACE_SECONDS;
export const FINISH_GRACE_SECONDS = 25;
export const MAX_WORLD_OBJECTS = 32;
export const STAR_SECONDS = 5.5;
export const SHIELD_SECONDS = 8;
export const PROJECTILE_TTL = 5;
/** The grid is still bunched on the first cubes: nobody draws a weapon yet. */
export const START_GRACE_SECONDS = 6;
/** Short enough for the karts following a group to find cubes again. */
export const PICKUP_RESPAWN_SECONDS = 4;
// The checkpoint corridor must match the shoulder that movement really allows.
// A smaller gate silently loses an otherwise legal lap at an outside corner.

export function neutralInput(seq = 0, epoch = 0): Input {
  return { seq, epoch, throttle: 0, steer: 0, brake: false, drift: false, use: false, reset: false };
}

export function validateInput(data: unknown): Input | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const input = data as Record<string, unknown>;
  const keys = ['seq', 'epoch', 'throttle', 'steer', 'brake', 'drift', 'use', 'reset'];
  if (Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key))) return null;
  if (!Number.isSafeInteger(input.seq) || (input.seq as number) < 0 ||
      !Number.isSafeInteger(input.epoch) || (input.epoch as number) < 0) return null;
  if (typeof input.throttle !== 'number' || !Number.isFinite(input.throttle) || Math.abs(input.throttle) > 1 ||
      typeof input.steer !== 'number' || !Number.isFinite(input.steer) || Math.abs(input.steer) > 1) return null;
  if (['brake', 'drift', 'use', 'reset'].some(key => typeof input[key] !== 'boolean')) return null;
  return { seq: input.seq as number, epoch: input.epoch as number,
    throttle: input.throttle, steer: input.steer, brake: input.brake as boolean,
    drift: input.drift as boolean, use: input.use as boolean, reset: input.reset as boolean };
}

export function createKart(id: string, name: string, color: string, index: number, trackId = 'lagon', modelId: string = DEFAULT_KART_MODEL, build: KartBuild = DEFAULT_BUILD, characterId: string = DEFAULT_CHARACTER): Kart {
  trackId = getTrack(trackId).id;
  const spawn = spawnPoint(index, trackId);
  const spawnProgress = -6 - Math.floor(index / 2) * 5;
  return { id, name, color: COLORS.includes(color) ? color : COLORS[index % COLORS.length]!,
    modelId: normalizeKartModelId(modelId), characterId: normalizeCharacterId(characterId), build: normalizeBuild(build, 3), playerId: '', careerLevel: 0,
    eventStage: 0, eventLevel: 0, team: index % 2 as 0 | 1, cpu: false,
    ...spawn, elevation: trackElevation(spawnProgress, trackId), verticalVelocity: 0, airborne: false,
    speed: 0, driftCharge: 0, boost: 0, stun: 0, lap: 0, nextCheckpoint: 1,
    progress: spawnProgress, routeProgress: spawnProgress, respawnProgress: spawnProgress, finished: false, finishTime: 0, rank: index + 1,
    item: '', itemCharges: 0, invincible: 0, shield: 0, hitGrace: 0,
    ready: false, connected: true, spectator: false, abandoned: false, lastSeq: -1, epoch: 0,
    driftDirection: 0, lateralVelocity: 0, respawnX: spawn.x, respawnZ: spawn.z,
    respawnAngle: spawn.angle, resetCooldown: 0, itemLatch: false, resetLatch: false,
    trackId, surface: 'road', turnVelocity: 0, padCooldown: 0, padZone: '', padLaps: {},
    launchCharge: 0, launchArmed: false, launchPressed: false, launchFault: false, draftCharge: 0, draftCooldown: 0,
    fun: freshRaceFun(), crownMode: false };
}

/** Mutable prediction owns its small nested state; authoritative snapshots stay intact. */
export function cloneKartForPrediction(kart: Kart): Kart {
  return { ...kart, build: { ...kart.build }, padLaps: { ...kart.padLaps },
    ...(kart.fun ? { fun: { ...kart.fun } } : {}),
    ...(kart.interactions ? { interactions: kart.interactions.map(state => ({ ...state })) } : {}) };
}

export function createWorld(practice = false, trackId = 'lagon'): World {
  trackId = getTrack(trackId).id;
  return { phase: 'lobby', players: [], objects: [], pickups: makePickups(trackId), hostId: '',
    practice, round: 0, time: 0, countdown: 0, raceTime: 0, finishTimeout: 0, seed: 0x12345678,
    trackId, tournament: createTournament(trackId), eventStage: 0, eventLevel: 0, teamMode: false, ranked: false, championshipId: '' };
}

const PICKUP_ROWS = [0.12, 0.36, 0.62, 0.84], PICKUP_OFFSETS = [-3.6, 0, 3.6];
/** A cube row follows the road that is really open: clear of a jump's flight
 * path, and moved onto the detour while its stretch of main road is barred. */
function pickupPlacement(trackId: string, row: number, column: number, stage = 0, level = 0): Pick<Pickup, 'x' | 'z' | 'progress' | 'elevation'> {
  const track = getTrack(trackId), offset = PICKUP_OFFSETS[column]!;
  let progress = PICKUP_ROWS[row]! * track.length;
  const jump = track.elevations.find(feature => feature.kind === 'jump' && progress >= feature.start - 2 && progress <= feature.end + 45);
  if (jump) progress = Math.min(jump.end + 45, track.length - 20);
  const event = getTrackEvent(track.id, stage, level);
  const detour = event.blockers.length ? event.branches.find(route => route.kind === 'detour' && route.open) : undefined;
  if (detour && progress > detour.start && progress < detour.end) {
    const metres = (detour.end - detour.start) / detour.length;
    // Keep clear of the junctions and of the detour's own two cubes.
    progress = clamp(progress, detour.start + 45 * metres, detour.end - 45 * metres);
    for (const fraction of [.36, .76]) {
      const own = detour.start + (detour.end - detour.start) * fraction;
      if (Math.abs(progress - own) < 9 * metres) progress = own + 9 * metres;
    }
    const point = pointOnBranch(detour, progress), across = offset * Math.min(1, (detour.width / 2 - 2.2) / 3.6);
    return { x: point.x + Math.cos(point.angle) * across, z: point.z - Math.sin(point.angle) * across,
      progress, elevation: trackElevation(progress, track.id) };
  }
  const point = trackPoint(progress, track.id);
  return { x: point.x + Math.cos(point.angle) * offset, z: point.z - Math.sin(point.angle) * offset,
    progress, elevation: trackElevation(progress, track.id) };
}

function makePickups(trackId: string): Pickup[] {
  return PICKUP_ROWS.flatMap((_, row) => PICKUP_OFFSETS.map((_, column) => ({ id: `pickup-${row}-${column}`,
    ...pickupPlacement(trackId, row, column), cooldown: 0 })));
}

/** The shared phase can bar a road: its standard cubes move, keeping their cooldowns. */
function relocatePickups(world: World): void {
  for (const pickup of world.pickups) {
    const match = /^pickup-(\d)-(\d)$/.exec(pickup.id);
    if (match && Number(match[1]) < PICKUP_ROWS.length && Number(match[2]) < PICKUP_OFFSETS.length)
      Object.assign(pickup, pickupPlacement(world.trackId, Number(match[1]), Number(match[2]), world.eventStage, world.eventLevel));
  }
}

export function startRace(world: World): void {
  world.phase = 'countdown';
  world.countdown = 3;
  world.round++;
  world.raceTime = 0;
  world.finishTimeout = 0;
  world.objects = [];
  world.eventStage = 0;
  world.trackId = getTrack(world.trackId).id;
  world.pickups = [...makePickups(world.trackId), ...trackEventPickups(world.trackId, 0, world.eventLevel)];
  relocatePickups(world);
  resetWorldFun(world); resetTrackInteractions(world);
  let index = 0;
  for (const kart of world.players) {
    if (kart.spectator || kart.abandoned) continue;
    const { ready, connected, lastSeq, epoch, playerId, careerLevel, team, cpu } = kart;
    Object.assign(kart, createKart(kart.id, kart.name, kart.color, index++, world.trackId, kart.modelId, kart.build, kart.characterId), { ready, connected, lastSeq, epoch, playerId, careerLevel, team, cpu, eventStage: 0, eventLevel: world.eventLevel });
    resetRaceFun(kart);
  }
  if (world.crown) startCrown(world);
}

export function resetKart(kart: Kart): void {
  const track = getTrack(kart.trackId), event = getTrackEvent(kart.trackId, kart.eventStage, kart.eventLevel);
  if (event.blockers.length) {
    const previousCheckpoint = (kart.nextCheckpoint + track.checkpoints.length - 1) % track.checkpoints.length;
    const gates = eventCheckpointGates(track.id, previousCheckpoint, kart.eventStage, kart.eventLevel);
    const detour = event.branches.find(branch => branch.kind === 'detour' && branch.open);
    const replacement = detour && gates.find(gate => gate.branchId === detour.id);
    const respawn = nearestDriveableTrack(kart.respawnX, kart.respawnZ, track.id, kart.eventStage, kart.eventLevel,
      { progress: kart.respawnProgress });
    const alreadyOnBranch = Boolean(respawn.branchId) || gates.some(gate => gate.branchId &&
      Math.hypot(kart.respawnX - gate.x - Math.sin(gate.angle) * 2, kart.respawnZ - gate.z - Math.cos(gate.angle) * 2) < 3);
    if (replacement && detour && !alreadyOnBranch && respawn.progress > detour.start && respawn.progress < detour.end) {
      // The shared phase may have closed the old road after this gate was
      // validated. Move only its respawn to the equivalent open detour gate;
      // never change lap, checkpoint, ranking progress or item-pad credits.
      kart.respawnX = replacement.x + Math.sin(replacement.angle) * 2;
      kart.respawnZ = replacement.z + Math.cos(replacement.angle) * 2;
      kart.respawnAngle = replacement.angle;
      kart.respawnProgress = replacement.progress + 2;
    }
  }
  kart.x = kart.respawnX;
  kart.z = kart.respawnZ;
  kart.angle = kart.respawnAngle;
  const ground = nearestDriveableTrack(kart.x, kart.z, kart.trackId, kart.eventStage, kart.eventLevel,
    { progress: kart.respawnProgress });
  kart.routeProgress = ground.progress;
  kart.elevation = trackElevation(ground.progress, kart.trackId);
  kart.verticalVelocity = 0;
  kart.airborne = false;
  kart.speed = 0;
  kart.lateralVelocity = 0;
  kart.driftCharge = 0;
  kart.driftDirection = 0;
  kart.boost = 0;
  kart.stun = 0;
  kart.resetCooldown = 1.5;
  kart.turnVelocity = 0;
  kart.draftCharge = 0;
  interruptRaceFun(kart);
  kart.surface = dynamicSurface(kart.x, kart.z, kart.trackId, kart.eventStage, kart.eventLevel, ground).surface;
  // Keep padLaps and its cooldown: a reset never renews the same pad's reward.
}

function driveableKartPosition(kart: Kart): ReturnType<typeof nearestDriveableTrack> {
  return nearestDriveableTrack(kart.x, kart.z, kart.trackId, kart.eventStage, kart.eventLevel, routeHint(kart));
}

function routeHint(kart: Kart): { progress?: number; elevation: number } {
  return { progress: kart.routeProgress ?? kart.progress, elevation: kart.elevation };
}

// Only deterministic movement belongs here, so clients can replay acknowledged
// input frames. Progression, other karts and all item effects stay in stepWorld.
export function stepKart(kart: Kart, input: Input, dt: number): void {
  if (!Number.isFinite(dt) || dt <= 0 || kart.spectator || kart.abandoned) return;
  // A finisher brakes to a stop past the line instead of freezing on it: the
  // prediction, still a few frames ahead, is no longer pulled backwards.
  if (kart.finished) {
    if (kart.speed === 0 && !kart.airborne) return;
    input = { ...neutralInput(input.seq, input.epoch), brake: true };
  }
  dt = Math.min(dt, 0.1);
  kart.fun = { ...(kart.fun ?? freshRaceFun()), wallSeconds: Math.max(0, (kart.fun?.wallSeconds ?? 0) - dt * .6) };
  kart.interactionTime = (kart.interactionTime ?? 0) + dt;
  const stats = getKartStats(kart.build);
  kart.resetCooldown = Math.max(0, kart.resetCooldown - dt);
  if (input.reset && !kart.resetLatch && kart.resetCooldown === 0) resetKart(kart);
  kart.resetLatch = input.reset;
  const previousX = kart.x, previousZ = kart.z, previousElevation = kart.elevation;
  kart.boost = Math.max(0, kart.boost - dt);
  kart.stun = Math.max(0, kart.stun - dt);
  kart.invincible = Math.max(0, kart.invincible - dt);
  kart.shield = Math.max(0, kart.shield - dt);
  kart.hitGrace = Math.max(0, kart.hitGrace - dt);
  const track = getTrack(kart.trackId);
  const position = driveableKartPosition(kart);
  const contact = applyInteractionSurface(dynamicSurface(kart.x, kart.z, track.id, kart.eventStage, kart.eventLevel, position),
    position, kart.x, kart.z, track.id, kart.interactions, kart.interactionTime ?? 0);
  kart.surface = contact.surface;
  const offroad = kart.surface === 'offroad';
  const mud = kart.surface === 'mud';
  const ice = kart.surface === 'ice';
  kart.padCooldown = Math.max(0, kart.padCooldown - dt);
  const pad = contact.zone?.kind === 'boost' ? contact.zone : undefined;
  if (pad && !kart.airborne && kart.padZone !== pad.id && kart.padCooldown === 0 && kart.padLaps[pad.id] !== kart.lap &&
      kart.speed > 5 && Math.cos(kart.angle - position.angle) > 0.3 && kart.stun === 0) {
    kart.boost = Math.max(kart.boost, 1.05);
    kart.padCooldown = 2.5;
    kart.padLaps = { ...kart.padLaps, [pad.id]: kart.lap };
  }
  kart.padZone = pad?.id ?? '';
  const throttle = kart.stun > 0 ? 0 : input.throttle;
  const steer = kart.stun > 0 ? 0 : input.steer;
  const drifting = input.drift && Math.abs(steer) > 0.12 && kart.speed > 10 && !offroad && kart.stun === 0;
  if (drifting) {
    kart.driftDirection = Math.sign(steer);
    kart.driftCharge = Math.min(2, kart.driftCharge + dt);
  } else {
    if (kart.driftCharge >= 0.65 && kart.stun === 0 && !offroad)
      kart.boost = Math.max(kart.boost, (0.55 + kart.driftCharge * 0.4) * stats.turbo);
    kart.driftCharge = 0;
    kart.driftDirection = 0;
  }
  // Hills are felt, never decisive: a climb trims a little top speed and a
  // descent returns it. Boosts, mud and the shoulder keep their own limits.
  const grade = track.relief && !kart.airborne ? clamp(reliefSlope(position.progress, track) * Math.cos(kart.angle - position.angle), -.1, .1) : 0;
  const maximumSpeed = offroad ? stats.offroad : mud ? stats.mud : kart.boost > 0 ? 46 : stats.speed * (1 - grade * .6);
  if (input.brake) {
    kart.speed = Math.sign(kart.speed) * Math.max(0, Math.abs(kart.speed) - 42 * dt);
  } else if (throttle !== 0) {
    kart.speed += throttle * (mud ? stats.acceleration * 13 / 22 : kart.boost > 0 ? stats.acceleration + 16 : stats.acceleration) * dt;
  } else {
    kart.speed *= Math.exp(-(kart.stun > 0 ? 4.5 : ice ? 0.38 : 1.25) * dt);
  }
  if (kart.boost > 0 && !offroad && !mud && !input.brake && kart.stun === 0) kart.speed += 30 * dt;
  if (grade && kart.speed > 1) kart.speed -= grade * 10 * dt;
  if (kart.speed > maximumSpeed) kart.speed = Math.max(maximumSpeed, kart.speed - (mud || offroad ? 55 : 28) * dt);
  kart.speed = clamp(kart.speed, -9, 46);
  if (Math.abs(kart.speed) < 0.025) kart.speed = 0;
  const steerPower = Math.min(Math.abs(kart.speed) / 12, 1);
  const grip = track.grip * stats.grip * (ice ? 0.38 : mud ? 0.85 : 1);
  const turn = steer * stats.handling * steerPower * (drifting ? 1.35 : 1) * Math.sign(kart.speed);
  kart.turnVelocity += (turn - kart.turnVelocity) * Math.min(1, dt * 11 * grip);
  kart.angle += kart.turnVelocity * dt;
  kart.angle = Math.atan2(Math.sin(kart.angle), Math.cos(kart.angle));
  const sideways = (drifting ? -steer * Math.min(kart.speed * 0.24, 7) : ice ? -steer * Math.min(kart.speed * 0.1, 4) : 0) / stats.stability;
  kart.lateralVelocity += (sideways - kart.lateralVelocity) * Math.min(1, dt * 5 * grip);
  kart.x += (Math.sin(kart.angle) * kart.speed + Math.cos(kart.angle) * kart.lateralVelocity) * dt;
  kart.z += (Math.cos(kart.angle) * kart.speed - Math.sin(kart.angle) * kart.lateralVelocity) * dt;
  const next = driveableKartPosition(kart);
  kart.routeProgress = next.progress;
  const ground = driveableGroundHeight(next, track.id, kart.elevation);
  const ramp = trackJumpAt(position.progress, track.id);
  const forward = (next.progress - position.progress + track.length) % track.length;
  // Launch only when physically crossing the lip in the forward direction.
  // Prediction and the server share this deterministic vertical motion; X/Z
  // steering and ordered checkpoint validation keep their existing rules.
  if (!kart.airborne && ramp && next.progress > ramp.end && forward < 15 &&
      kart.speed > 8 && position.distance <= position.width / 2 + TRACK_SHOULDER) {
    kart.airborne = true; kart.elevation = ramp.height + reliefElevation(ramp.end, track) + automaticTrackElevation(ramp.end, track);
    kart.verticalVelocity = interactionLaunchSpeed(ramp.id, track.id, kart.interactions, kart.interactionTime ?? 0) ?? ramp.launchSpeed ?? 6;
  } else if (!kart.airborne && kart.elevation > ground + .5) {
    kart.airborne = true; kart.verticalVelocity = 0;
  }
  if (kart.airborne) {
    kart.elevation += kart.verticalVelocity * dt - 10 * dt * dt;
    kart.verticalVelocity -= 20 * dt;
    if (kart.elevation <= ground) { kart.elevation = ground; kart.verticalVelocity = 0; kart.airborne = false; }
  } else { kart.elevation = ground; kart.verticalVelocity = 0; }
  constrainCrossingCeiling(kart, previousElevation);
  constrainToTrack(kart, { x: previousX, z: previousZ, elevation: previousElevation }, dt);
  const constrained = constrainTrackEvent(kart.x, kart.z, previousX, previousZ, kart.speed, kart.trackId, kart.eventStage, kart.eventLevel,
    { previous: previousElevation, current: kart.elevation });
  kart.x = constrained.x; kart.z = constrained.z; kart.speed = constrained.speed;
  const correctedRoad = driveableKartPosition(kart);
  kart.routeProgress = correctedRoad.progress;
  const correctedGround = driveableGroundHeight(correctedRoad, track.id, kart.elevation);
  if (kart.elevation <= correctedGround) { kart.elevation = correctedGround; kart.verticalVelocity = 0; kart.airborne = false; }
}

/** A jump under an automatic overpass meets the underside of its real deck. */
function constrainCrossingCeiling(kart: Kart, previousElevation: number): void {
  const track = getTrack(kart.trackId);
  if (!kart.airborne || !track.crossings?.length) return;
  for (const crossing of track.crossings) {
    const radius = Math.max(crossing.upperProgress - crossing.upperStart, crossing.upperEnd - crossing.upperProgress) + track.width / 2 + TRACK_SHOULDER;
    if ((kart.x - crossing.x) ** 2 + (kart.z - crossing.z) ** 2 > radius * radius) continue;
    const road = nearestTrack(kart.x, kart.z, track.id,
      { progress: crossing.upperProgress, elevation: trackElevation(crossing.upperProgress, track.id) });
    const delta = ((road.progress - crossing.upperProgress + track.length / 2) % track.length + track.length) % track.length - track.length / 2;
    if (delta < crossing.upperStart - crossing.upperProgress || delta > crossing.upperEnd - crossing.upperProgress ||
        road.distance > track.width / 2 + trackBoundaryShoulder(road.progress, track.id)) continue;
    const ceiling = trackElevation(road.progress, track.id) - crossing.deckThickness;
    if (previousElevation < ceiling && kart.elevation < ceiling + crossing.deckThickness && kart.elevation + KART_COLLISION_HEIGHT > ceiling) {
      kart.elevation = ceiling - KART_COLLISION_HEIGHT;
      kart.verticalVelocity = Math.min(0, kart.verticalVelocity);
    }
  }
}

function constrainToTrack(kart: Kart, before: { x: number; z: number; elevation: number }, dt = 1 / 30): void {
  const at = (fraction: number) => {
    const x = before.x + (kart.x - before.x) * fraction, z = before.z + (kart.z - before.z) * fraction;
    const near = nearestDriveableTrack(x, z, kart.trackId, kart.eventStage, kart.eventLevel, routeHint(kart));
    const distance = near.distance - near.width / 2 - trackBoundaryShoulder(near.progress, kart.trackId, near.branchId);
    return { x, z, near, distance };
  };
  const start = at(0), end = at(1), leaving = start.distance <= 1e-7 && end.distance > 1e-7;
  const entering = start.distance > 1e-7 && end.distance <= 1e-7;
  // Once a jump has cleared the rail, being outside does not teleport the kart
  // back. It may land on the terrain and return through a gap, jump, or reset.
  if (!leaving && !entering) return;
  let low = 0, high = 1;
  for (let iteration = 0; iteration < 14; iteration++) {
    const middle = (low + high) / 2;
    if ((at(middle).distance <= 0) === leaving) low = middle; else high = middle;
  }
  const fraction = (low + high) / 2, contact = at(fraction);
  if (!contact.near.branchId && trackBoundaryGap(contact.x, contact.z, kart.trackId, kart.eventStage, kart.eventLevel)) return;
  const base = trackElevation(contact.near.progress, kart.trackId);
  const foot = before.elevation + (kart.elevation - before.elevation) * fraction;
  if (foot >= base + trackBoundaryHeight(contact.near.progress, kart.trackId, contact.near.branchId) || foot + KART_COLLISION_HEIGHT <= base) return;
  // Keep the tangential part of the motion: a kart pressing against a rail
  // still slides along it instead of becoming pinned at the first contact.
  const boundary = end.near.width / 2 + trackBoundaryShoulder(end.near.progress, kart.trackId, end.near.branchId);
  if (end.near.distance > 1e-7) {
    const radius = boundary + (leaving ? -.001 : .001);
    kart.x = end.near.x + (end.x - end.near.x) / end.near.distance * radius;
    kart.z = end.near.z + (end.z - end.near.z) / end.near.distance * radius;
  } else {
    const stopped = at(Math.max(0, low - .002)); kart.x = stopped.x; kart.z = stopped.z;
  }
  const difference = kart.angle - contact.near.angle;
  const acrossSpeed = Math.sin(difference) * kart.speed + Math.cos(difference) * kart.lateralVelocity;
  const incidence = Math.abs(acrossSpeed) / Math.max(.01, Math.hypot(kart.speed, kart.lateralVelocity));
  const seconds = Math.min(2, (kart.fun?.wallSeconds ?? 0) + dt * 1.6);
  kart.fun = { ...(kart.fun ?? freshRaceFun()), wallSeconds: seconds };
  kart.speed = railResponse(kart.speed, incidence, seconds, getKartStats(kart.build).speed);
  if (seconds > .22 || incidence > .55) { kart.boost = 0; kart.driftCharge = 0; }
  kart.lateralVelocity *= .5;
}

function random(world: World): number {
  world.seed = (Math.imul(world.seed, 1664525) + 1013904223) >>> 0;
  return world.seed / 0x100000000;
}

function advanceCheckpoint(kart: Kart, before: { x: number; z: number; elevation: number }, world: World): void {
  const track = getTrack(world.trackId);
  const checkpoints = track.checkpoints;
  const epsilon = 1e-7;
  let lastCrossing = -1;
  // A compressed branch can place two ordered gates in a single movement
  // segment. Process only physical intersections, in increasing segment order.
  for (let visited = 0; visited < checkpoints.length && !kart.finished; visited++) {
    const gates = eventCheckpointGates(track.id, kart.nextCheckpoint, kart.eventStage, kart.eventLevel);
    let crossing: { gate: typeof gates[number]; fraction: number } | undefined;
    for (const gate of gates) {
      const dx = Math.sin(gate.angle), dz = Math.cos(gate.angle);
      const previousSide = (before.x - gate.x) * dx + (before.z - gate.z) * dz;
      const currentSide = (kart.x - gate.x) * dx + (kart.z - gate.z) * dz;
      const forwardMotion = currentSide - previousSide;
      // Starting on the plane is valid when moving forward. A stationary kart,
      // reverse crossing or a gate already behind this segment never qualifies.
      if (previousSide > epsilon || currentSide < -epsilon || forwardMotion <= epsilon) continue;
      const fraction = clamp(-previousSide / forwardMotion, 0, 1);
      if (fraction <= lastCrossing + epsilon) continue;
      const crossX = before.x + (kart.x - before.x) * fraction;
      const crossZ = before.z + (kart.z - before.z) * fraction;
      const across = (crossX - gate.x) * dz - (crossZ - gate.z) * dx;
      if (Math.abs(across) > gate.width / 2 + TRACK_SHOULDER + epsilon) continue;
      if (track.crossings?.length) {
        const elevation = before.elevation + (kart.elevation - before.elevation) * fraction;
        const road = nearestDriveableTrack(crossX, crossZ, track.id, kart.eventStage, kart.eventLevel,
          { progress: kart.routeProgress ?? kart.progress, elevation });
        const delta = Math.abs(road.progress - gate.progress);
        // Gates are attached to their road, not an infinite vertical plane.
        // Continuity still permits an ordinary jump over this same gate.
        if (Math.min(delta, track.length - delta) > gate.width / 2 + 10) continue;
        if (!kart.airborne && Math.abs(elevation - trackElevation(gate.progress, track.id)) > KART_COLLISION_HEIGHT) continue;
      }
      if (!crossing || fraction < crossing.fraction) crossing = { gate, fraction };
    }
    if (!crossing) break;
    const { gate, fraction } = crossing;
    lastCrossing = fraction;
    kart.respawnX = gate.x + Math.sin(gate.angle) * 2;
    kart.respawnZ = gate.z + Math.cos(gate.angle) * 2;
    kart.respawnAngle = gate.angle;
    kart.respawnProgress = gate.progress + 2;
    if (kart.nextCheckpoint === 0) {
      kart.lap++;
      if (!kart.crownMode && kart.lap >= getTrackLapCount(track.id)) {
        kart.finished = true;
        kart.finishTime = world.raceTime;
        kart.progress = getTrackLapCount(track.id) * track.length;
        kart.boost = 0; kart.driftCharge = 0; kart.driftDirection = 0;
        if (world.finishTimeout === 0) world.finishTimeout = FINISH_GRACE_SECONDS;
      }
    }
    kart.nextCheckpoint = (kart.nextCheckpoint + 1) % checkpoints.length;
  }
  if (!kart.finished) {
    const near = nearestDriveableTrack(kart.x, kart.z, track.id, kart.eventStage, kart.eventLevel, routeHint(kart));
    // Bound ranking to the checkpoint interval already validated. Driving back
    // over the finish, skipping a gate or resetting cannot manufacture a lap.
    const last = kart.nextCheckpoint === 0 ? checkpoints.length - 1 : kart.nextCheckpoint - 1;
    const minimum = checkpoints[last]!.progress;
    const maximum = kart.nextCheckpoint === 0 ? track.length : checkpoints[kart.nextCheckpoint]!.progress;
    let localProgress = near.progress;
    if (kart.nextCheckpoint === 1 && localProgress > track.length * 0.9) localProgress -= track.length;
    kart.progress = kart.lap * track.length + clamp(localProgress, minimum - 15, maximum);
  }
}

function activeOpponent(kart: Kart, ownerId: string, world?: World): boolean {
  const owner = world?.teamMode ? world.players.find(player => player.id === ownerId) : undefined;
  return kart.id !== ownerId && (!owner || owner.team !== kart.team) && kart.connected && !kart.finished && !kart.spectator && !kart.abandoned;
}

/** Uses checkpoint-validated progress (including laps), never a client rank. */
function itemTarget(world: World, owner: Kart, leader: boolean): Kart | undefined {
  return world.players.filter(kart => activeOpponent(kart, owner.id, world) && kart.progress > owner.progress + 0.1)
    .sort((a, b) => (leader ? b.progress - a.progress : a.progress - b.progress) || a.id.localeCompare(b.id))[0];
}

function awardItem(world: World, kart: Kart): void {
  const active = world.players.filter(player => !player.spectator && !player.finished && !player.abandoned && player.connected);
  const ahead = active.filter(player => player.progress > kart.progress + 0.1).length;
  // Front runners get defensive tools; trailing drivers have more recovery tools.
  // A solo driver never receives a projectile that requires another racer.
  const trailing = ahead > 0 && ahead >= (active.length - 1) / 2;
  const base = ahead === 0 ? [35, 10, 20, 20, 0, 0, 3, 12]
    : trailing ? [12, 25, 5, 8, 18, 12, 14, 6] : [22, 18, 12, 15, 18, 5, 5, 5];
  const { weights, seconds } = world.raceTime < START_GRACE_SECONDS && !world.crown ? { weights: [60, 0, 0, 0, 0, 0, 0, 40], seconds: 0 }
    : ahead === 0 || world.crown ? { weights: base, seconds: 0 } : recoveryItemWeights(world, kart, base);
  let roll = random(world) * 100;
  let item: typeof ITEMS[number] = 'turbo';
  for (let i = 0; i < ITEMS.length; i++) { roll -= weights[i]!; if (roll < 0) { item = ITEMS[i]!; break; } }
  kart.item = item;
  kart.itemCharges = item === 'tripleTurbo' ? 3 : 1;
  noteItemDraw(world, kart, seconds);
}

function useItem(world: World, kart: Kart): void {
  if (!kart.item) return;
  if (kart.item === 'turbo' || kart.item === 'tripleTurbo') {
    kart.boost = Math.max(kart.boost, kart.item === 'turbo' ? 2.2 : 1.65);
    if (kart.item === 'tripleTurbo') {
      kart.itemCharges = Math.max(0, kart.itemCharges - 1);
      if (kart.itemCharges > 0) return;
    }
  } else if (kart.item === 'star') {
    kart.invincible = STAR_SECONDS; kart.stun = 0; kart.hitGrace = 0;
    kart.boost = Math.max(kart.boost, STAR_SECONDS);
  } else if (kart.item === 'shield') kart.shield = SHIELD_SECONDS;
  else {
    const forward = kart.item !== 'trap';
    const target = kart.item === 'seeker' || kart.item === 'leaderBolt'
      ? itemTarget(world, kart, kart.item === 'leaderBolt') : undefined;
    if ((kart.item === 'seeker' || kart.item === 'leaderBolt') && !target) {
      // The opponent may have finished or disconnected while this item was held.
      kart.boost = Math.max(kart.boost, 1.2);
    } else {
      // Bounded server state even when all eight drivers save traps for one area.
      const ownObjects = world.objects.filter(object => object.owner === kart.id);
      if (ownObjects.length >= 4) world.objects = world.objects.filter(object => object !== ownObjects[0]);
      if (world.objects.length >= MAX_WORLD_OBJECTS) world.objects.shift();
      const distance = forward ? 3 : -3;
      world.objects.push({ id: `${world.round}-${kart.id}-${Math.floor(world.time * 1000)}-${world.seed}`,
        kind: kart.item, x: kart.x + Math.sin(kart.angle) * distance,
        z: kart.z + Math.cos(kart.angle) * distance, angle: kart.angle, owner: kart.id,
        progress: kart.routeProgress ?? kart.progress, elevation: kart.elevation,
        ttl: kart.item === 'projectile' ? PROJECTILE_TTL : kart.item === 'seeker' ? 9 : 18,
        ...(target ? { targetId: target.id } : {}) });
    }
  }
  kart.item = ''; kart.itemCharges = 0;
}

function hitKart(kart: Kart, world?: World, attackerId?: string): boolean {
  if (kart.invincible > 0 || kart.hitGrace > 0 || world && crownProtected(world, kart.id)) return false;
  if (kart.shield > 0) { kart.shield = 0; kart.hitGrace = 0.6; return false; }
  kart.stun = 1.05; kart.hitGrace = 1.7;
  kart.speed *= 0.2; kart.boost = 0; kart.driftCharge = 0;
  interruptRaceFun(kart);
  if (world && attackerId) onCrownAttack(world, attackerId, kart.id);
  return true;
}

function collideKarts(players: Kart[], world: World): void {
  const teamMode = world.teamMode;
  for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
    const a = players[i]!;
    const b = players[j]!;
    const beforeA = { x: a.x, z: a.z, elevation: a.elevation }, beforeB = { x: b.x, z: b.z, elevation: b.elevation };
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const distance = Math.hypot(dx, dz);
    if (distance >= 2.5 || Math.abs(a.elevation - b.elevation) > 1.8) continue;
    if (a.invincible > 0 || b.invincible > 0) {
      if (a.invincible > 0 && b.invincible === 0 && (!teamMode || a.team !== b.team)) hitKart(b, world, a.id);
      if (b.invincible > 0 && a.invincible === 0 && (!teamMode || a.team !== b.team)) hitKart(a, world, b.id);
      // Energy lets the protected kart pass through traffic without changing
      // its trajectory; ordinary karts keep the existing collision response.
      continue;
    }
    const nx = distance < 0.001 ? 1 : dx / distance;
    const nz = distance < 0.001 ? 0 : dz / distance;
    const massA = getKartStats(a.build).mass, massB = getKartStats(b.build).mass;
    const shareA = massB / (massA + massB), shareB = 1 - shareA;
    const push = 2.5 - distance;
    a.x -= nx * push * shareA; a.z -= nz * push * shareA;
    b.x += nx * push * shareB; b.z += nz * push * shareB;
    const aNormal = Math.sin(a.angle) * nx + Math.cos(a.angle) * nz;
    const bNormal = Math.sin(b.angle) * nx + Math.cos(b.angle) * nz;
    const closingSpeed = a.speed * aNormal - b.speed * bNormal;
    // Equal-speed neighbours retain momentum. Only approaching karts exchange
    // an impulse, preventing traffic jams caused by damping on every tick.
    if (closingSpeed > 0) {
      a.speed = clamp(a.speed - closingSpeed * shareA * aNormal, -9, 46);
      b.speed = clamp(b.speed + closingSpeed * shareB * bNormal, -9, 46);
    }
    constrainToTrack(a, beforeA); constrainToTrack(b, beforeB);
    for (const [kart, before] of [[a, beforeA], [b, beforeB]] as const) {
      const constrained = constrainTrackEvent(kart.x, kart.z, before.x, before.z, kart.speed, kart.trackId, kart.eventStage, kart.eventLevel,
        { previous: before.elevation, current: kart.elevation });
      kart.x = constrained.x; kart.z = constrained.z; kart.speed = constrained.speed;
    }
  }
}

function objectPose(object: { x: number; z: number; progress?: number; elevation?: number }, world: World): { x: number; y: number; z: number } {
  const { x, z } = object;
  return { x, y: (object.elevation ?? trackElevation(nearestDriveableTrack(x, z, world.trackId, world.eventStage, world.eventLevel, object).progress, world.trackId)) + .7, z };
}

function stepObjects(world: World, racers: Kart[], dt: number): void {
  for (const object of world.objects) {
    object.ttl -= dt;
    type Position = Pick<WorldObject, 'x' | 'z' | 'progress' | 'elevation'>;
    const before: Position = { x: object.x, z: object.z, progress: object.progress, elevation: object.elevation };
    const pathSegments: Array<{ from: Position; to: Position }> = [];
    // Each part of a ricochet retains its own surface hint at stacked crossings.
    const surfacePosition = (x: number, z: number, hint: Position): Position => {
      const road = nearestDriveableTrack(x, z, world.trackId, world.eventStage, world.eventLevel, hint);
      return { x, z, progress: road.progress, elevation: trackElevation(road.progress, world.trackId) };
    };
    const stepMove = (start: Position, angle: number, dist: number): Position => {
      const road = nearestDriveableTrack(start.x, start.z, world.trackId, world.eventStage, world.eventLevel, start);
      const delta = angle - road.angle;
      const along = Math.cos(delta) * dist, across = Math.sin(delta) * dist;
      return surfacePosition(
        start.x + (Math.sin(road.angle) * along + Math.cos(road.angle) * across),
        start.z + (Math.cos(road.angle) * along - Math.sin(road.angle) * across), start);
    };

    if (object.kind === 'projectile') {
      let current = surfacePosition(object.x, object.z, before);
      let remainingDistance = 62 * dt;
      for (let bounce = 0; bounce < 2 && remainingDistance > 1e-4; bounce++) {
        const segFrom = current;
        const stepDist = remainingDistance;
        const cand = stepMove(current, object.angle, stepDist);
        const candX = cand.x, candZ = cand.z;
        const road = nearestDriveableTrack(candX, candZ, world.trackId, world.eventStage, world.eventLevel, cand);
        const boundary = road.width / 2 + trackBoundaryShoulder(road.progress, world.trackId, road.branchId);

        const blockerCheck = constrainTrackEvent(candX, candZ, current.x, current.z, 62, world.trackId, world.eventStage, world.eventLevel,
          { previous: current.elevation!, current: cand.elevation! });
        if (blockerCheck.blocked) {
          const blocker = getTrackEvent(world.trackId, world.eventStage, world.eventLevel).blockers[0];
          if (blocker) {
            const sine = Math.sin(blocker.angle), cosine = Math.cos(blocker.angle);
            const dx = blockerCheck.x - blocker.x, dz = blockerCheck.z - blocker.z;
            const along = dx * sine + dz * cosine;
            const across = dx * cosine - dz * sine;
            let nx: number, nz: number;
            if (Math.abs(along) / (blocker.halfLength + .95) >= Math.abs(across) / (blocker.halfWidth + .95)) {
              const sign = along >= 0 ? 1 : -1;
              nx = sign * sine; nz = sign * cosine;
            } else {
              const sign = across >= 0 ? 1 : -1;
              nx = sign * cosine; nz = -sign * sine;
            }
            const vx = Math.sin(object.angle), vz = Math.cos(object.angle);
            const dot = vx * nx + vz * nz;
            if (dot < 0) {
              const rx = vx - 2 * dot * nx, rz = vz - 2 * dot * nz;
              const rLen = Math.hypot(rx, rz);
              if (rLen > 1e-6) object.angle = Math.atan2(rx / rLen, rz / rLen);
            }
          }
          current = surfacePosition(blockerCheck.x, blockerCheck.z, current);
          pathSegments.push({ from: segFrom, to: current });
          const traveled = Math.hypot(current.x - segFrom.x, current.z - segFrom.z);
          remainingDistance = Math.max(0, remainingDistance - traveled);
          continue;
        }

        if (road.distance > boundary) {
          if (road.distance > boundary + 10) {
            object.ttl = 0;
            current = cand;
            pathSegments.push({ from: segFrom, to: current });
            break;
          }
          const dx = candX - road.x;
          const dz = candZ - road.z;
          const dist = road.distance || Math.hypot(dx, dz);
          const nx = dx / dist;
          const nz = dz / dist;
          const vx = Math.sin(object.angle);
          const vz = Math.cos(object.angle);
          const dot = vx * nx + vz * nz;

          if (dot > 0) {
            const rx = vx - 2 * dot * nx;
            const rz = vz - 2 * dot * nz;
            const rLen = Math.hypot(rx, rz);
            if (rLen > 1e-6) {
              object.angle = Math.atan2(rx / rLen, rz / rLen);
            }
            remainingDistance = Math.max(0, Math.min(road.distance - boundary, remainingDistance));
          } else {
            remainingDistance = 0;
          }

          const safeDist = boundary - 0.15;
          const contactX = road.x + nx * safeDist;
          const contactZ = road.z + nz * safeDist;
          current = surfacePosition(contactX, contactZ, current);
          pathSegments.push({ from: segFrom, to: current });
        } else {
          current = cand;
          pathSegments.push({ from: segFrom, to: current });
          remainingDistance = 0;
        }
      }
      Object.assign(object, current);
    } else if (object.kind === 'seeker' || object.kind === 'leaderBolt') {
      const owner = world.players.find(kart => kart.id === object.owner);
      let target = racers.find(kart => kart.id === object.targetId && activeOpponent(kart, object.owner, world));
      if (object.kind === 'leaderBolt' && owner) target = itemTarget(world, owner, true);
      if (!target) { object.ttl = 0; continue; }
      object.targetId = target.id;
      const near = nearestDriveableTrack(object.x, object.z, world.trackId, world.eventStage, world.eventLevel, object);
      const close = Math.hypot(target.x - object.x, target.z - object.z) < 22 &&
        Math.abs(target.elevation - (object.elevation ?? trackElevation(near.progress, world.trackId))) < 2.5;
      const waypoint = close ? target : eventRoutePoint(near.progress + 11, world.trackId, world.eventStage, world.eventLevel);
      const desired = Math.atan2(waypoint.x - object.x, waypoint.z - object.z);
      const turn = Math.atan2(Math.sin(desired - object.angle), Math.cos(desired - object.angle));
      object.angle += clamp(turn, -7 * dt, 7 * dt);
      const speed = object.kind === 'leaderBolt' ? 82 : 64;
      const nextPos = stepMove(before, object.angle, speed * dt);
      Object.assign(object, nextPos);
      pathSegments.push({ from: before, to: nextPos });
    } else {
      const after = surfacePosition(object.x, object.z, before);
      Object.assign(object, after);
      pathSegments.push({ from: before, to: after });
    }
    if (object.ttl <= 0) continue;
    if (pathSegments.length === 0) pathSegments.push({ from: before, to: object });
    const victim = racers.find(kart => {
      if (!activeOpponent(kart, object.owner, world) || (object.kind === 'leaderBolt' && kart.id !== object.targetId)) return false;
      const kx = kart.x, ky = kart.elevation + .7, kz = kart.z;
      return pathSegments.some(seg => {
        const from = objectPose(seg.from, world), to = objectPose(seg.to, world);
        const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
        const distanceSquared = dx * dx + dy * dy + dz * dz;
        const t = distanceSquared > 1e-7 ? clamp(((kx - from.x) * dx + (ky - from.y) * dy + (kz - from.z) * dz) / distanceSquared, 0, 1) : 0;
        return Math.hypot(kx - from.x - t * dx, ky - from.y - t * dy, kz - from.z - t * dz) < 2.5;
      });
    });
    if (victim) {
      hitKart(victim, world, object.owner);
      object.ttl = 0;
    }
  }
  world.objects = world.objects.filter(object => object.ttl > 0);
}

export function standings(world: World): Kart[] {
  if (world.crown) return world.players.filter(kart => !kart.spectator).slice().sort((a, b) =>
    (world.phase === 'finished' ? Number(a.abandoned || !a.connected) - Number(b.abandoned || !b.connected) : 0) ||
    (world.crown!.scores[b.id] ?? 0) - (world.crown!.scores[a.id] ?? 0) || b.progress - a.progress || a.id.localeCompare(b.id));
  return world.players.filter(kart => !kart.spectator).slice().sort((a, b) =>
    a.finished && b.finished ? a.finishTime - b.finishTime || a.id.localeCompare(b.id) :
    a.finished ? -1 : b.finished ? 1 : b.progress - a.progress || a.id.localeCompare(b.id));
}

function chargeLaunch(world: World, inputs: Map<string, Input>, dt: number): void {
  for (const kart of world.players) {
    if (kart.spectator || kart.abandoned) continue;
    const input = inputs.get(kart.id);
    const pressed = kart.connected && !!input && input.throttle > 0.5 && !input.brake;
    if (pressed && !kart.launchPressed) {
      kart.launchArmed = world.countdown <= 1 + 1e-8;
      kart.launchFault = !kart.launchArmed;
    }
    if (!pressed) { kart.launchArmed = false; kart.launchCharge = 0; kart.launchFault = false; }
    else if (kart.launchArmed) kart.launchCharge = Math.min(1, kart.launchCharge + dt);
    kart.launchPressed = pressed;
  }
}

function chargeDraft(world: World, racers: Kart[], dt: number): void {
  for (const kart of racers) {
    kart.draftCooldown = Math.max(0, kart.draftCooldown - dt);
    const eligible = kart.connected && kart.speed > 12 && kart.stun === 0 && kart.draftCooldown === 0 &&
      nearestTrack(kart.x, kart.z, kart.trackId, routeHint(kart)).distance <= getTrack(kart.trackId).width / 2;
    const leader = eligible ? racers.find(leader => {
      if (leader === kart || !leader.connected || leader.speed < 12 || leader.stun > 0 || leader.trackId !== kart.trackId ||
          Math.cos(leader.angle - kart.angle) < .9 || Math.abs(leader.elevation - kart.elevation) > KART_COLLISION_HEIGHT) return false;
      const dx = leader.x - kart.x;
      const dz = leader.z - kart.z;
      const forward = dx * Math.sin(kart.angle) + dz * Math.cos(kart.angle);
      const sideways = dx * Math.cos(kart.angle) - dz * Math.sin(kart.angle);
      return forward > 3.5 && forward < 18 && Math.abs(sideways) < 2.6;
    }) : undefined;
    const behind = !!leader;
    kart.draftCharge = behind ? Math.min(1, kart.draftCharge + dt) : Math.max(0, kart.draftCharge - 2 * dt);
    if (kart.draftCharge >= 1 - 1e-8) {
      kart.boost = Math.max(kart.boost, 1.2);
      kart.draftCooldown = 3;
      kart.draftCharge = 0;
      if (leader) armTeamRelay(world, kart, leader);
    }
  }
}

export function stepWorld(world: World, inputs: Map<string, Input>, dt: number): void {
  if (!Number.isFinite(dt) || dt <= 0) return;
  dt = Math.min(dt, 0.1);
  world.time += dt;
  if (world.phase === 'countdown') {
    chargeLaunch(world, inputs, dt);
    world.countdown = Math.max(0, world.countdown - dt);
    if (world.countdown < 1e-8) {
      world.countdown = 0;
      world.phase = 'racing';
      for (const kart of world.players) {
        if (!kart.spectator && !kart.abandoned && kart.connected && kart.launchArmed && kart.launchPressed && kart.launchCharge >= .2)
          kart.boost = 1 + kart.launchCharge * .5;
      }
    }
    return;
  }
  if (world.phase !== 'racing') return;
  const eventStage = Math.max(world.eventStage, Math.min(getTrackLapCount(world.trackId)-1, Math.max(0, ...world.players.filter(kart => !kart.spectator && !kart.abandoned).map(kart => kart.lap))));
  if (eventStage !== world.eventStage) { world.eventStage = eventStage; relocatePickups(world); }
  for (const kart of world.players) { kart.eventStage = world.eventStage; kart.eventLevel = world.eventLevel; }
  world.raceTime += dt;
  if (world.finishTimeout > 0) world.finishTimeout = Math.max(1e-8, world.finishTimeout - dt);
  const racers = world.players.filter(kart => !kart.spectator && !kart.finished && !kart.abandoned);
  chargeDraft(world, racers, dt);
  if (world.crown) beforeCrownStep(world);
  const previousPositions = new Map<string, { x: number; z: number; elevation: number }>();
  const funPositions = new Map<string, ReturnType<typeof captureFunMovement>>();
  const resets = new Set<string>();
  for (const kart of racers) {
    const input = kart.connected ? inputs.get(kart.id) ?? neutralInput() : neutralInput();
    kart.interactions = world.interactions; kart.interactionTime = world.time - dt;
    funPositions.set(kart.id, captureFunMovement(kart));
    previousPositions.set(kart.id, { x: kart.x, z: kart.z, elevation: kart.elevation });
    // A reset teleports to a validated checkpoint and must never cross a gate.
    const resetTriggered = input.reset && !kart.resetLatch && kart.resetCooldown <= dt;
    stepKart(kart, input, dt);
    if (resetTriggered) resets.add(kart.id);
    else triggerTrackInteractions(world, kart, previousPositions.get(kart.id)!.x, previousPositions.get(kart.id)!.z);
    if (resetTriggered) previousPositions.set(kart.id, { x: kart.x, z: kart.z, elevation: kart.elevation });
    if (input.use && !kart.itemLatch) useItem(world, kart);
    kart.itemLatch = input.use;
  }
  collideKarts(racers, world);
  // Earlier finishers keep rolling to their stop; they no longer race or collide.
  for (const kart of world.players) if (kart.finished && !racers.includes(kart)) stepKart(kart, neutralInput(), dt);
  for (const kart of racers) advanceCheckpoint(kart, previousPositions.get(kart.id)!, world);
  for (const kart of racers) updateRaceFun(world, kart, kart.connected ? inputs.get(kart.id) ?? neutralInput() : neutralInput(), funPositions.get(kart.id)!, dt, resets.has(kart.id));
  resolveTeamRelays(world);
  stepObjects(world, racers.filter(kart => !kart.finished), dt);
  for (const kart of world.players) { kart.interactions = world.interactions; kart.interactionTime = world.time; }
  for (const pickup of world.pickups) {
    pickup.cooldown = Math.max(0, pickup.cooldown - dt);
    if (pickup.cooldown > 0) continue;
    const kart = racers.find(player => player.connected && !player.finished && !player.item && Math.hypot(player.x - pickup.x, player.z - pickup.z) < 2.8 &&
      Math.abs(player.elevation - (pickup.elevation ?? trackElevation(pickup.progress ?? nearestTrack(pickup.x, pickup.z, world.trackId).progress, world.trackId))) < 2.8);
    if (kart) { awardItem(world, kart); pickup.cooldown = PICKUP_RESPAWN_SECONDS; }
  }
  const ordered = standings(world);
  ordered.forEach((kart, index) => { kart.rank = index + 1; });
  if (world.crown) { stepCrown(world, dt); return; }
  if (ordered.every(kart => kart.finished || kart.abandoned) || world.finishTimeout === 1e-8 || world.raceTime >= getTrackRaceTimeLimit(world.trackId)) {
    world.phase = 'finished';
    for (const kart of world.players) kart.speed = 0;
  }
}
