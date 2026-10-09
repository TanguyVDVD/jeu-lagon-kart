import test from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOM_TRACK_TEMPLATES, compileCustomTrack, registerCustomTrack, validateCustomTrackDraft, type CustomTrackDraft, type StoredCustomTrack } from '../shared/custom-tracks.js';
import { TRACKS, baseTrackElevation, nearestTrack, trackElevation, trackPoint, trackSlope, type TrackDefinition } from '../shared/track.js';
import { isBridgeProgress, trackBoundaryShoulder } from '../shared/obstacle-heights.js';
import { automaticTrackElevation, CROSSING_CLEARANCE, CROSSING_DECK_THICKNESS } from '../shared/track-crossings.js';

function record(name: string, draft = structuredClone(CUSTOM_TRACK_TEMPLATES.find(t => t.id === 'figure-eight')!.draft)): StoredCustomTrack {
  return { id: `custom-crossings-${name}`, revision: 1, draft, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' };
}
function assertClearance(track: TrackDefinition) {
  for (const crossing of track.crossings!) {
    let lowerMax = -Infinity, upperMin = Infinity;
    for (let i = 0; i <= 32; i++) {
      const lower = crossing.lowerStart + (crossing.lowerEnd - crossing.lowerStart) * i / 32;
      const upper = crossing.upperStart + (crossing.upperEnd - crossing.upperStart) * i / 32;
      lowerMax = Math.max(lowerMax, baseTrackElevation(lower, track) + automaticTrackElevation(lower, track));
      upperMin = Math.min(upperMin, baseTrackElevation(upper, track) + automaticTrackElevation(upper, track));
    }
    assert.ok(upperMin - lowerMax >= CROSSING_CLEARANCE + CROSSING_DECK_THICKNESS - 1e-8, `${crossing.id}: ${upperMin - lowerMax}m`);
  }
}

test('figure eight derives a real bridge with full road-width clearance and smooth, closed approaches', () => {
  const track = registerCustomTrack(record('eight'));
  assert.equal(track.crossings?.length, 1);
  const crossing = track.crossings![0]!;
  assert.ok(crossing.upperProgress > crossing.lowerProgress);
  assert.ok(crossing.upperEnd - crossing.upperStart > track.width);
  assert.equal(crossing.layer, 1); assertClearance(track);
  assert.equal(trackElevation(crossing.lowerProgress, track.id), 0);
  assert.equal(trackElevation(crossing.upperProgress, track.id), 5.7);
  for (let p = 0; p <= track.length; p += .5) {
    assert.ok(Number.isFinite(trackSlope(p, track.id)));
    assert.ok(Math.abs(trackSlope(p, track.id)) <= .151, 'ordinary approach remains below a 15% gradient');
    assert.ok(Math.abs(trackElevation(p, track.id) - trackElevation(p + track.length, track.id)) < 1e-9);
  }
  assert.ok(Math.abs(trackElevation(-.001, track.id) - trackElevation(.001, track.id)) < .001);
});

test('three intersecting routes stack cumulatively, retaining clearance above an already elevated floor', () => {
  const draft = structuredClone(CUSTOM_TRACK_TEMPLATES[0]!.draft);
  draft.width = 12; draft.zones = [];
  draft.anchors = [[-130,0],[-65,0],[0,0],[65,0],[130,0],[130,100],[0,130],[0,65],[0,0],[0,-65],[0,-130],[-130,-130],[-100,-100],[-50,-50],[0,0],[50,50],[100,100],[150,150],[170,-160],[-160,-160]].map(([x,z]) => ({ x:x!, z:z! }));
  const track = registerCustomTrack(record('triple', draft));
  const centre = track.crossings!.filter(crossing => Math.hypot(crossing.x, crossing.z) < .001);
  assert.equal(centre.length, 3); assert.equal(Math.max(...centre.map(crossing => crossing.layer)), 2);
  const heights = [...new Set(centre.flatMap(c => [trackElevation(c.lowerProgress, track.id), trackElevation(c.upperProgress, track.id)]))].sort((a,b) => a-b);
  assert.deepEqual(heights.map(h => Math.round(h * 10)), [0,57,114]); assertClearance(track);
});

test('authored bridges and jump ramps compose with the automatic floors', () => {
  for (const kind of ['bridge', 'jump'] as const) {
    const source = record(`relief-${kind}`), flat = compileCustomTrack(source), crossing = flat.crossings![0]!;
    const start = (crossing.lowerStart - 30) / flat.length, end = (crossing.lowerEnd + 30) / flat.length;
    source.draft.elevations = [{ kind, start, end, height: 12, approach: 15 }];
    const track = registerCustomTrack(source);
    assertClearance(track); assert.ok(track.crossings![0]!.height > 5.7);
    assert.ok(baseTrackElevation(crossing.lowerProgress, track) > 0, 'authored relief has not been removed');
  }
});

test('a high authored ramp keeps bridge boundaries when no additional crossing height is needed', () => {
  const source=record('manual-clearance'),flat=compileCustomTrack(source),crossing=flat.crossings![0]!;
  source.draft.elevations=[{kind:'jump',start:(crossing.upperProgress-100)/flat.length,end:(crossing.upperProgress+100)/flat.length,height:40,approach:0}];
  const track=registerCustomTrack(source);
  assert.equal(track.crossings![0]!.height,0);
  assert.equal(isBridgeProgress(crossing.upperProgress,track.id),true);
  assert.equal(trackBoundaryShoulder(crossing.upperProgress,track.id),1.5);
});

test('width and crossing angle determine the tunnel span', () => {
  const narrow = record('narrow'), wide = record('wide'); narrow.draft.width = 10; wide.draft.width = 40;
  narrow.draft.zones = []; wide.draft.zones = [];
  const a = compileCustomTrack(narrow), b = compileCustomTrack(wide);
  assert.ok(b.crossings![0]!.upperEnd - b.crossings![0]!.upperStart > (a.crossings![0]!.upperEnd - a.crossings![0]!.upperStart) * 2);
  assertClearance(a); assertClearance(b);
});

test('layer hints choose the right floor even when the other route is closer in plan view', () => {
  for (const width of [18,80]) {
  const source = record(`selection-${width}`); source.draft.width=width;
  const track = registerCustomTrack(source), crossing = track.crossings![0]!;
  for (const progress of [crossing.lowerProgress, crossing.upperProgress]) {
    const point = trackPoint(progress, track.id);
    const x = point.x + Math.cos(point.angle) * track.width * .4, z = point.z - Math.sin(point.angle) * track.width * .4;
    const near = nearestTrack(x, z, track.id, { progress: progress - .5, elevation: trackElevation(progress, track.id) });
    assert.ok(Math.abs(near.progress - progress) < 3, `selected ${near.progress} instead of ${progress}`);
  }
  const ceilingContact = nearestTrack(crossing.x, crossing.z, track.id, {progress:crossing.lowerProgress,elevation:3.2});
  assert.ok(Math.abs(ceilingContact.progress-crossing.lowerProgress)<1, 'a jump into the tunnel ceiling keeps the lower route');
  }
});

test('saved sources and JSON imports reproduce the same floors without mutating the draft', () => {
  const source = record('reload'), before = JSON.stringify(source);
  const track = compileCustomTrack(source), imported = compileCustomTrack(JSON.parse(JSON.stringify(source)));
  assert.deepEqual(imported, track); assert.equal(JSON.stringify(source), before);
  const serialized = JSON.parse(JSON.stringify(track)) as TrackDefinition;
  for (let p = 0; p < track.length; p += 3) assert.equal(automaticTrackElevation(p, serialized), automaticTrackElevation(p, track));
  assert.equal(validateCustomTrackDraft(source.draft).ok, true);
  assert.ok(TRACKS.every(track => !track.crossings), 'builtin tracks remain unchanged');
});

test('128 points and coincident creative anchors stay finite and do not manufacture bridges on an oval', () => {
  const draft: CustomTrackDraft = {name:'Grand dessin',theme:'tropical',width:18,zones:[],anchors:Array.from({length:128},(_,i) => ({x:600*Math.sin(i*Math.PI/64),z:400*Math.cos(i*Math.PI/64)}))};
  const track = compileCustomTrack(record('capacity', draft));
  assert.equal(track.points.length, 3072); assert.equal(track.crossings, undefined);
  draft.anchors.splice(2, 3, {...draft.anchors[0]!}, {...draft.anchors[0]!}, {...draft.anchors[0]!});
  const creative = compileCustomTrack(record('coincident', draft));
  for (let p = 0; p < creative.length; p += 3) assert.ok(Number.isFinite(automaticTrackElevation(p, creative)));
});
