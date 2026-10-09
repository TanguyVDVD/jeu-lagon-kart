import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CUSTOM_TRACK_TEMPLATES, registerCustomTrack } from '../shared/custom-tracks.js';
import { TrackEventsView } from '../client/track-events.js';
import { trackZoneGeometry } from '../client/track-zone-geometry.js';

test('a fourth-lap surface follows a bridge and disappears next lap without rebuilding every frame', () => {
  const track = registerCustomTrack({ id: 'custom-view-lap-four', revision: 1,
    createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z',
    draft: { ...structuredClone(CUSTOM_TRACK_TEMPLATES[0]!.draft), lapCount: 5,
      elevations: [{ kind: 'bridge', start: .2, end: .3, height: 8, approach: 12 }],
      events: [{ lap: 4, kind: 'boost', start: .225, end: .275 }] } });
  const view = new TrackEventsView();
  try {
    view.update(track.id, 2); assert.equal(view.group.children.length, 0);
    view.update(track.id, 3);
    const patch = view.group.children.find(child => child.name.startsWith('event-zone-'));
    assert.ok(patch instanceof THREE.Mesh);
    assert.equal(patch.userData.kind, 'boost');
    const geometry = patch.geometry as THREE.BufferGeometry;
    const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
    assert.ok(Array.from(positions.array).every(Number.isFinite));
    assert.ok(Array.from(normals.array).every(Number.isFinite));
    geometry.computeBoundingBox();
    assert.ok(geometry.boundingBox!.max.y > 7.9, 'the patch follows the bridge instead of lying on the ground');
    let disposed = 0; geometry.addEventListener('dispose', () => disposed++);
    view.update(track.id, 3, 0, 8);
    assert.equal(view.group.children.find(child => child.name === patch.name), patch, 'same lap reuses its mesh');
    assert.equal(disposed, 0);
    view.update(track.id, 4);
    assert.equal(view.group.children.length, 0); assert.equal(disposed, 1);
  } finally { view.dispose(); }
});

test('surface overlays stay finite on authored bridges and jump ramps', () => {
  const track = registerCustomTrack({ id: 'custom-view-elevation', revision: 1,
    createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z',
    draft: { ...structuredClone(CUSTOM_TRACK_TEMPLATES[0]!.draft), elevations: [
      { kind: 'bridge', start: .2, end: .4, height: 8, approach: 24 },
      { kind: 'jump', start: .6, end: .66, height: 5, approach: 12, launchSpeed: 9 },
    ] } });
  for (const feature of track.elevations) {
    const geometry = trackZoneGeometry(track.id, { start: feature.start, end: feature.end, width: track.width, offset: 0 });
    try {
      assert.ok(Array.from(geometry.getAttribute('position').array).every(Number.isFinite));
      geometry.computeBoundingBox();
      assert.ok(geometry.boundingBox!.max.y >= feature.height, `${feature.kind}: overlay rises with the road`);
      assert.ok(geometry.getIndex()!.count > 0);
    } finally { geometry.dispose(); }
  }
});

test('a very long authored bridge keeps a bounded overlay mesh', () => {
  const draft = structuredClone(CUSTOM_TRACK_TEMPLATES[0]!.draft);
  draft.anchors = draft.anchors.map(point => ({ x: point.x * 10, z: point.z * 10 }));
  const track = registerCustomTrack({ id: 'custom-view-long-loop', revision: 1,
    createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z',
    draft: { ...draft, elevations: [{ kind: 'bridge', start: .1, end: .9, height: 40, approach: 400 }] } });
  const loop = track.elevations[0]!;
  assert.ok(loop.end - loop.start > 5000);
  const geometry = trackZoneGeometry(track.id, { start: loop.start, end: loop.end, width: track.width, offset: 0 });
  try {
    assert.ok(geometry.getAttribute('position').count < 12_000, 'authored length cannot allocate millions of vertices');
    assert.ok(Array.from(geometry.getAttribute('position').array).every(Number.isFinite));
  } finally { geometry.dispose(); }
});
