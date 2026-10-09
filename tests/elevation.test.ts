import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS, reliefElevation, trackElevation, trackPoint } from '../shared/track.js';
import { createKart, neutralInput, stepKart } from '../shared/game.js';
import { autopilot } from '../shared/autopilot.js';

for (const track of TRACKS.filter(track => track.elevations.length)) {
  test(`${track.id}: bridge follows the road; launch, flight and landing are deterministic`, () => {
    const bridge = track.elevations.find(feature => feature.kind === 'bridge')!;
    const bridgeProgress = (bridge.start + bridge.end) / 2;
    const kart = createKart('jump', 'Jump test', '#fc735d', 0, track.id);
    Object.assign(kart, trackPoint(bridgeProgress, track.id), { elevation: trackElevation(bridgeProgress, track.id) });
    stepKart(kart, neutralInput(), 1 / 30);
    assert.ok(Math.abs(kart.elevation - bridge.height - reliefElevation(bridgeProgress, track)) < .01);
    assert.equal(kart.airborne, false);
    const jump = track.elevations.find(feature => feature.kind === 'jump')!;
    Object.assign(kart, trackPoint(jump.end - .4, track.id), {
      elevation: trackElevation(jump.end - .4, track.id), speed: 32,
      verticalVelocity: 0, airborne: false,
    });
    const predicted = structuredClone(kart);
    let launched = false, landed = false, peak = 0, airFrames = 0;
    for (let tick = 0; tick < 120; tick++) {
      // This isolates motion: checkpoint progression belongs to stepWorld.
      const input = { ...autopilot(kart, tick, false), reset: false };
      stepKart(kart, input, 1 / 30); stepKart(predicted, input, 1 / 30);
      assert.deepEqual(predicted, kart, 'client prediction must match server motion');
      assert.ok(Number.isFinite(kart.elevation));
      if (kart.airborne) { launched = true; airFrames++; peak = Math.max(peak, kart.elevation - reliefElevation(jump.end, track)); }
      if (launched && !kart.airborne) { landed = true; break; }
    }
    assert.ok(launched, 'ramp must actually launch');
    assert.ok(peak > jump.height + .5, 'visible flight above the ramp');
    assert.ok(airFrames >= 10 && airFrames < 60, `bounded flight: ${airFrames} frames`);
    assert.ok(landed, 'the kart must land and continue driving');
    assert.equal(kart.verticalVelocity, 0);
    assert.ok(kart.speed > 15, 'landing remains forgiving');
  });
}

for (const track of TRACKS.filter(track => !track.elevations.length)) test(`${track.id}: hills keep the kart on the ground for a whole lap`, () => {
  const kart = createKart('hill', 'Colline', '#fc735d', 0, track.id);
  let highest = 0;
  for (let tick = 0; tick < 30 * 60; tick++) {
    stepKart(kart, { ...autopilot(kart, tick, false), reset: false }, 1 / 30);
    assert.equal(kart.airborne, false, 'a crest never throws the kart into the air');
    assert.equal(kart.verticalVelocity, 0);
    assert.ok(Math.abs(kart.elevation - trackElevation(kart.routeProgress!, track.id)) < 1e-9, 'the kart follows the road surface');
    highest = Math.max(highest, kart.elevation);
  }
  assert.ok(highest > 2, 'the circuit really climbs');
});
