import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS, getTrack } from '../shared/track.js';
import { compileCustomTrack, CUSTOM_TRACK_TEMPLATES, type CustomTrackDraft } from '../shared/custom-tracks.js';
import { filterTrackCatalog, isCommunityTrack, trackCatalogPageSize, trackHighlights, trackLapLabel, trackThemeLabel } from '../client/track-catalog.js';

function custom(id: string, changes: Partial<CustomTrackDraft> = {}, template = 0) {
  return compileCustomTrack({ id: `custom-catalog-${id}`, revision: 1,
    draft: { ...structuredClone(CUSTOM_TRACK_TEMPLATES[template]!.draft), ...changes },
    createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' });
}

test('catalog search matches accented names, themes and real features without changing track order or definitions', () => {
  const before = JSON.stringify(TRACKS);
  assert.deepEqual(filterTrackCatalog(TRACKS, '  ILE   ALIZES  ', 'all').map(track => track.id), ['lagon']);
  assert.deepEqual(filterTrackCatalog(TRACKS, 'foret sauts', 'all').map(track => track.id), ['forest']);
  assert.deepEqual(filterTrackCatalog(TRACKS, 'ne\u0301on', 'all').map(track => track.id), ['neon']);
  assert.deepEqual(filterTrackCatalog(TRACKS, 'looping', 'all'), [], 'loopings were retired from every circuit');
  assert.deepEqual(filterTrackCatalog(TRACKS, 'un nom de circuit inexistant', 'all'), []);
  assert.deepEqual(filterTrackCatalog(TRACKS, ' ', 'all'), TRACKS);
  assert.equal(JSON.stringify(TRACKS), before);
});

test('source filters preserve all community creations in a large catalogue including legal long names', () => {
  const creations = Array.from({ length: 32 }, (_, index) => custom(String(index), {
    name: `${String(index).padStart(2, '0')} Circuit de la communauté très spectaculaire`.slice(0, 48),
  }));
  const catalogue = [...TRACKS, ...creations];
  assert.deepEqual(filterTrackCatalog(catalogue, '', 'official'), TRACKS);
  assert.deepEqual(filterTrackCatalog(catalogue, '', 'community'), creations);
  assert.equal(filterTrackCatalog(catalogue, 'communaute', 'community').length, 32);
  assert.equal(filterTrackCatalog(catalogue, 'communaute', 'official').length, 0);
  assert.equal(filterTrackCatalog(catalogue, '', 'all').length, TRACKS.length + 32);
  assert.ok(creations.every(isCommunityTrack));
  assert.ok(TRACKS.every(track => !isCommunityTrack(track)));
});

test('details describe actual custom modules and laps, including layered roads and triggered features', () => {
  const plainSky = custom('plain-sky', { theme: 'sky', zones: [], lapCount: 1 });
  assert.equal(trackThemeLabel(plainSky), 'Ciel');
  assert.deepEqual(trackHighlights(plainSky), [], 'a sky palette alone must not promise a bridge or looping');
  assert.equal(trackLapLabel(plainSky), '1 tour');
  assert.equal(trackLapLabel(getTrack('lagon')), '3 tours');
  const crossing = custom('layered', { lapCount: 12 }, 2);
  assert.ok(crossing.crossings!.length > 0);
  assert.ok(trackHighlights(crossing).includes('Ponts et tunnels'));
  assert.equal(trackLapLabel(crossing), '12 tours');
  const interactive = custom('interactive', { zones: [],
    interactions: [{ kind: 'boost', trigger: .1, start: .2, end: .23, duration: 8, width: 8, offset: 0 },
      { kind: 'jump', trigger: .3, start: .4, end: .43, duration: 8, width: 8, offset: 0, height: 3, launchSpeed: 9 }],
    events: [{ lap: 2, kind: 'ice', start: .5, end: .6 }],
  });
  assert.deepEqual(trackHighlights(interactive), ['Sauts', 'Turbos', 'Glace', 'Événements par tour']);
  assert.deepEqual(filterTrackCatalog([interactive, plainSky], 'glace sauts', 'community'), [interactive]);
});

test('pagination uses bounded pages on small phones and short landscape viewports', () => {
  for (const [width, height] of [[320, 568], [390, 844], [568, 320], [844, 390], [1280, 480]])
    assert.equal(trackCatalogPageSize(width!, height!), 2, `${width} × ${height}`);
  assert.equal(trackCatalogPageSize(820, 1180), 4);
  assert.equal(trackCatalogPageSize(1366, 768), 6);
  const catalogue = Array.from({ length: 44 }, (_, index) => index);
  for (const [width, height] of [[320, 568], [820, 1180], [1366, 768]]) {
    const size = trackCatalogPageSize(width!, height!);
    const pages = Array.from({ length: Math.ceil(catalogue.length / size) }, (_, index) => catalogue.slice(index * size, (index + 1) * size));
    assert.deepEqual(pages.flat(), catalogue, 'every track remains reachable without omissions or duplicates');
    assert.ok(pages.every(page => page.length <= size));
  }
});
