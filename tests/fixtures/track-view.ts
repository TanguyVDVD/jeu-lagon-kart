import { GameRenderer } from '../../client/renderer';
import { createKart, createWorld, type Kart, type World } from '../../shared/game';
import { getTrack, trackElevation, trackPoint } from '../../shared/track';
import { registerCustomTrack, type StoredCustomTrack } from '../../shared/custom-tracks';

// Deterministic views of a circuit for scripts/track-view-check.ts: the real
// renderer, a fabricated world and no server.
const renderer = new GameRenderer(document.querySelector<HTMLCanvasElement>('#game')!);
let now = 1000;
async function frames(count: number, step: number, world: World | null, players: Kart[]) {
  for (let i = 0; i < count; i++) {
    now += step; renderer.render(world, players, 'me', step / 1000, now, { hidden: false });
    // Kart models arrive asynchronously; give them a turn between frames.
    if (i % 5 === 0) await new Promise(resolve => setTimeout(resolve, 20));
  }
  return renderer.viewDiagnostics;
}
Object.assign(window, { __trackView: {
  register: (record: StoredCustomTrack) => registerCustomTrack(record).id,
  /** The slow orbit of the menu, settled on the whole island. */
  overview(trackId: string) { renderer.setPreviewTrack(trackId); return frames(60, 100, null, []); },
  /** The chase camera behind a kart placed on the road. */
  chase(trackId: string, fraction: number, lateral = 0, stage = 0, level = 0) {
    const track = getTrack(trackId), progress = fraction * track.length, point = trackPoint(progress, track.id);
    const world = createWorld(true, track.id); world.phase = 'racing'; world.eventStage = stage; world.eventLevel = level;
    const kart = createKart('me', 'Pilote', '#fc735d', 0, track.id);
    Object.assign(kart, { x: point.x + Math.cos(point.angle) * lateral, z: point.z - Math.sin(point.angle) * lateral, angle: point.angle,
      elevation: trackElevation(progress, track.id), progress, routeProgress: progress, speed: 20, eventStage: stage, eventLevel: level });
    world.players = [kart];
    return frames(40, 16, world, [kart]);
  },
} });
