import { automaticTrackElevation, type TrackCrossing } from './track-crossings.js';
export const TRACK_LAYOUT_REVISION = 3;
export type TrackLapEventKind = 'clear' | 'rain' | 'snow' | 'ash' | 'storm' | 'boost' | 'ice' | 'mud';
export interface TrackLapEvent {
  id: string; lap: number; kind: TrackLapEventKind;
  /** Metres from the start; weather is global and its affected road uses this interval. */
  start: number; end: number;
}
export interface Vec2 { x: number; z: number }
export const TRACK_IDS = ['lagon', 'canyon', 'glacier', 'neon', 'mangrove', 'dunes', 'volcan', 'forest', 'harbor', 'sky', 'foundry', 'castle'] as const;
export type BuiltinTrackId = typeof TRACK_IDS[number];
export type TrackId = BuiltinTrackId | `custom-${string}-v${number}`;
export interface TrackZone {
  id: string; kind: 'boost' | 'ice' | 'mud';
  /** Metres from start; intervals never wrap across the finish line. */
  start: number; end: number; offset: number; width: number;
}
export interface TrackElevation {
  id: string; kind: 'bridge' | 'jump';
  /** Ground profile in metres along the main route, never across the finish line. */
  start: number; end: number; height: number; approach: number;
  /** Vertical launch velocity at the end of a jump ramp, metres per second. */
  launchSpeed?: number;
}
export interface TrackInteraction {
  id: string; kind: 'boost' | 'jump';
  /** Trigger and target in metres. The plate covers the selected lane. */
  trigger: number; start: number; end: number; offset: number; width: number;
  duration: number; height?: number; launchSpeed?: number; elevationId?: string;
}
/** A summit, hollow or plateau of the rolling ground under the road. */
export interface TrackReliefPoint { /** Metres from the start. */ at: number; /** Metres above the island floor. */ height: number }
export interface TrackDefinition {
  id: TrackId; name: string; description: string;
  difficulty: 'Facile' | 'Intermédiaire' | 'Technique';
  theme: 'tropical' | 'canyon' | 'ice' | 'neon' | 'volcano' | 'forest' | 'harbor' | 'sky' | 'foundry' | 'castle';
  points: Vec2[]; length: number; width: number;
  checkpoints: Array<Vec2 & { angle: number; progress: number }>;
  zones: TrackZone[];
  elevations: TrackElevation[];
  /** Hills of the official circuits. Bridges, jumps and crossings are added on top. */
  relief?: TrackReliefPoint[];
  /** Derived layered intersections for user-created roads; absent on ordinary tracks. */
  crossings?: TrackCrossing[];
  /** Omitted by historical tracks; three laps remain the default. */
  lapCount?: number;
  lapEvents?: TrackLapEvent[];
  interactions?: TrackInteraction[];
  palette: { sky: string; water: string; ground: string; road: string; accent: string };
  grip: number;
}
export type Surface = 'road' | 'offroad' | TrackZone['kind'];
export const TOTAL_LAPS = 3;
export const MAX_CUSTOM_TRACK_LAPS = 20;
export const BASE_RACE_SECONDS = 300;
export const MAX_CUSTOM_REPLAY_SECONDS = BASE_RACE_SECONDS * MAX_CUSTOM_TRACK_LAPS / TOTAL_LAPS + 60;
export function getTrackLapCount(trackId = 'lagon'): number { return getTrack(trackId).lapCount ?? TOTAL_LAPS; }
export function getTrackRaceTimeLimit(trackId = 'lagon'): number { return BASE_RACE_SECONDS * Math.max(1, getTrackLapCount(trackId) / TOTAL_LAPS); }
export function getTrackReplayTimeLimit(trackId = 'lagon'): number { return getTrackRaceTimeLimit(trackId) + 60; }
export const COLORS = ['#fc735d', '#69cbd0', '#fed36a', '#bca4ef', '#92cf84', '#fa9ac4', '#638ce6', '#f4f1de'];
interface ArcTable { lengths: number[]; cumulative: number[]; grid?: SegmentGrid }
/** Road segments binned on the ground, so a position only meets the few around it. */
interface SegmentGrid { x: number; z: number; columns: number; rows: number; cells: number[][] }
const GRID_CELL = 16;
function segmentGrid(track: TrackDefinition, table: ArcTable): SegmentGrid {
  if (table.grid) return table.grid;
  const xs = track.points.map(point => point.x), zs = track.points.map(point => point.z);
  const x = Math.min(...xs), z = Math.min(...zs);
  const columns = Math.floor((Math.max(...xs) - x) / GRID_CELL) + 1, rows = Math.floor((Math.max(...zs) - z) / GRID_CELL) + 1;
  const cells: number[][] = Array.from({ length: columns * rows }, () => []);
  track.points.forEach((a, index) => {
    const b = track.points[(index + 1) % track.points.length]!;
    const fromX = Math.floor((Math.min(a.x, b.x) - x) / GRID_CELL), toX = Math.floor((Math.max(a.x, b.x) - x) / GRID_CELL);
    const fromZ = Math.floor((Math.min(a.z, b.z) - z) / GRID_CELL), toZ = Math.floor((Math.max(a.z, b.z) - z) / GRID_CELL);
    for (let column = fromX; column <= toX; column++) for (let row = fromZ; row <= toZ; row++) cells[row * columns + column]!.push(index);
  });
  return table.grid = { x, z, columns, rows, cells };
}
const arcTables = new WeakMap<TrackDefinition, ArcTable>();
function spline(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return 0.5 * ((2 * p1) + (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}
export type TrackSeed = Omit<TrackDefinition, 'points' | 'length' | 'checkpoints' | 'zones' | 'elevations' | 'relief'> & {
  anchors: [number, number][];
  zones: Array<Omit<TrackZone, 'id'>>;
  elevations?: Array<Omit<TrackElevation, 'id'>>;
  /** [fraction of the lap, height in metres]. The ground is level at each point and eases between them. */
  relief?: Array<[number, number]>;
};
export function sampleTrackAnchors(anchors: readonly Vec2[]): Vec2[] {
  return anchors.flatMap((point, i) => {
    const previous = anchors[(i + anchors.length - 1) % anchors.length]!;
    const next = anchors[(i + 1) % anchors.length]!;
    const after = anchors[(i + 2) % anchors.length]!;
    return Array.from({ length: 24 }, (_, j) => ({
      x: spline(previous.x, point.x, next.x, after.x, j / 24),
      z: spline(previous.z, point.z, next.z, after.z, j / 24),
    }));
  });
}
export function makeTrack(seed: TrackSeed): TrackDefinition {
  const points = sampleTrackAnchors(seed.anchors.map(([x, z]) => ({ x, z })));
  const lengths = points.map((point, i) => Math.hypot(
    points[(i + 1) % points.length]!.x - point.x, points[(i + 1) % points.length]!.z - point.z));
  const cumulative = [0];
  for (const length of lengths) cumulative.push(cumulative[cumulative.length - 1]! + length);
  const length = cumulative[cumulative.length - 1]!;
  const track: TrackDefinition = { id: seed.id, name: seed.name, description: seed.description,
    difficulty: seed.difficulty, theme: seed.theme, width: seed.width, palette: seed.palette, grip: seed.grip,
    points, length, checkpoints: [], elevations: (seed.elevations ?? []).map((feature, index) => ({ ...feature,
      id: `${seed.id}-${feature.kind}-${index}`, start: feature.start * length, end: feature.end * length })),
    zones: seed.zones.map((zone, index) => ({ ...zone,
      id: seed.id + '-' + zone.kind + '-' + index, start: zone.start * length, end: zone.end * length })) };
  if (seed.relief?.length) track.relief = seed.relief.map(([at, height]) => ({ at: at * length, height })).sort((a, b) => a.at - b.at);
  arcTables.set(track, { lengths, cumulative });
  track.checkpoints = Array.from({ length: 12 }, (_, i) => ({
    ...pointOnTrack(i * length / 12, track), progress: i * length / 12,
  }));
  return track;
}
// Closed circuits. The final sampled point connects to the first.
export const TRACKS: TrackDefinition[] = [
  makeTrack({ id: 'lagon', name: 'Île des Alizés', theme: 'tropical', difficulty: 'Facile', width: 16, grip: 1,
    description: 'Une grande courbe en bord de plage, un S entre les palmiers et une épingle large pour apprendre le drift. Visez les bandes turbo et évitez les flaques de boue.',
    palette: { sky: '#cbe8df', water: '#56b8b0', ground: '#c8dca1', road: '#667976', accent: '#f5bd62' },
    anchors: [[0,-110],[70,-110],[125,-80],[140,-20],[105,30],[45,45],[20,100],[-45,120],[-100,85],[-95,20],[-125,-30],[-120,-85],[-60,-110]],
    zones: [ { kind: 'boost', start: .04, end: .06, offset: 0, width: 7 },
      { kind: 'mud', start: .35, end: .39, offset: 4.8, width: 5.5 },
      { kind: 'boost', start: .68, end: .70, offset: -3, width: 6 } ],
    relief: [[.97, 0], [.05, 0], [.2, 5], [.38, 1.5], [.55, 6], [.8, 2]],
  }),
  makeTrack({ id: 'canyon', name: 'Canyon solaire', theme: 'canyon', difficulty: 'Intermédiaire', width: 15, grip: 1.08,
    description: 'Deux lacets accrochés à la falaise, une montée vers le plateau et une longue descente. Évitez la boue et préparez vos mini-turbos avant les lignes droites.',
    palette: { sky: '#f5d7b6', water: '#bc8261', ground: '#d99b67', road: '#795f56', accent: '#ffb342' },
    anchors: [[0,-130],[75,-130],[135,-105],[150,-45],[110,-5],[40,-10],[-10,20],[5,70],[70,82],[130,100],[135,145],[90,170],[20,165],[-45,155],[-100,115],[-140,60],[-120,0],[-150,-60],[-110,-115],[-55,-130]],
    zones: [ { kind: 'boost', start: .03, end: .05, offset: 0, width: 6 },
      { kind: 'mud', start: .29, end: .33, offset: -3.5, width: 7 },
      { kind: 'mud', start: .60, end: .64, offset: 3.5, width: 7 },
      { kind: 'boost', start: .87, end: .89, offset: 0, width: 7 } ],
    relief: [[.96, 0], [.05, 0], [.22, 6], [.36, 12], [.5, 12], [.66, 5], [.84, 2]],
  }),
  makeTrack({ id: 'glacier', name: 'Banquise boréale', theme: 'ice', difficulty: 'Technique', width: 18, grip: .86,
    description: 'De longues courbes rapides, une chicane sur la crête et une descente glacée. La glace conserve votre élan : anticipez les virages et freinez avant les plaques bleues.',
    palette: { sky: '#c5dced', water: '#538faa', ground: '#e7f3ed', road: '#9dc9d3', accent: '#76eeeb' },
    anchors: [[0,-140],[80,-140],[150,-110],[170,-40],[130,20],[150,80],[110,135],[35,150],[-30,120],[-60,60],[-120,40],[-165,-10],[-150,-80],[-90,-130]],
    zones: [ { kind: 'ice', start: .14, end: .22, offset: 0, width: 18 },
      { kind: 'boost', start: .36, end: .38, offset: -4, width: 6 },
      { kind: 'ice', start: .58, end: .66, offset: 0, width: 18 },
      { kind: 'ice', start: .79, end: .85, offset: 3, width: 9 } ],
    relief: [[.96, 2], [.05, 2], [.2, 8], [.34, 9], [.5, 3], [.66, 0], [.82, 4]],
  }),
  makeTrack({ id: 'neon', name: 'Métropole néon', theme: 'neon', difficulty: 'Intermédiaire', width: 17, grip: 1.03,
    description: 'De grands boulevards, des angles droits et un crochet entre les tours. Changez de ligne pour enchaîner les trois bandes turbo et profiter de l’aspiration.',
    palette: { sky: '#1b2547', water: '#293153', ground: '#454f72', road: '#303549', accent: '#ef71d8' },
    anchors: [[0,-120],[90,-120],[150,-100],[165,-40],[165,25],[125,65],[65,65],[30,105],[25,150],[-15,180],[-90,170],[-150,125],[-165,50],[-160,-30],[-140,-95],[-80,-120]],
    zones: [ { kind: 'boost', start: .04, end: .06, offset: -3.5, width: 6 },
      { kind: 'boost', start: .53, end: .555, offset: 3.5, width: 6 },
      { kind: 'boost', start: .80, end: .825, offset: 0, width: 7 } ],
    relief: [[.95, 0], [.06, 0], [.22, 4], [.4, 1], [.62, 5], [.8, 1.5]],
  }),
  makeTrack({ id: 'mangrove', name: 'Mangrove sinueuse', theme: 'tropical', difficulty: 'Technique', width: 16, grip: .98,
    description: 'Un serpent de virages entre les marais et un grand méandre autour du village sur pilotis. La boue alterne d’un bord à l’autre : gardez une ligne propre pour rejoindre les deux turbos.',
    palette: { sky: '#bed0bd', water: '#427c70', ground: '#749666', road: '#556660', accent: '#e2c674' },
    anchors: [[0,-135],[75,-125],[130,-80],[150,-15],[130,50],[80,95],[20,100],[-25,65],[-75,65],[-105,105],[-100,160],[-135,195],[-185,170],[-200,110],[-170,45],[-175,-20],[-140,-80],[-80,-120]],
    zones: [ { kind: 'mud', start: .16, end: .2, offset: 4, width: 6 },
      { kind: 'mud', start: .34, end: .38, offset: -4, width: 6 },
      { kind: 'boost', start: .46, end: .48, offset: 0, width: 6 },
      { kind: 'mud', start: .61, end: .65, offset: 4, width: 6 },
      { kind: 'mud', start: .84, end: .88, offset: -4, width: 6 },
      { kind: 'boost', start: .96, end: .98, offset: 0, width: 6 } ],
    relief: [[.95, 1], [.05, 1], [.2, 3.5], [.4, 0], [.58, 3], [.78, .5]],
  }),
  makeTrack({ id: 'dunes', name: 'Dunes de cuivre', theme: 'canyon', difficulty: 'Facile', width: 15, grip: 1.04,
    description: 'Deux longues lignes droites qui ondulent sur les dunes et quatre bandes turbo pour jouer l’aspiration. Les flaques de boue à la sortie des courbes punissent les trajectoires trop larges.',
    palette: { sky: '#efc7a8', water: '#c38b68', ground: '#e3b87e', road: '#876b58', accent: '#f1d082' },
    anchors: [[0,-70],[90,-70],[170,-60],[215,-15],[200,45],[140,75],[60,85],[-20,90],[-100,85],[-170,90],[-225,55],[-230,-10],[-185,-50],[-115,-45],[-60,-70]],
    zones: [ { kind: 'boost', start: .04, end: .06, offset: -3.5, width: 6 },
      { kind: 'mud', start: .20, end: .235, offset: 4, width: 6 },
      { kind: 'boost', start: .34, end: .36, offset: 3.5, width: 6 },
      { kind: 'boost', start: .53, end: .55, offset: -3.5, width: 6 },
      { kind: 'mud', start: .70, end: .745, offset: 4, width: 6 },
      { kind: 'boost', start: .84, end: .86, offset: 3.5, width: 6 } ],
    relief: [[.96, 3], [.04, 3], [.13, 8], [.24, 2], [.36, 7], [.46, 1], [.56, 8], [.7, 2], [.84, 6]],
  }),
  makeTrack({ id: 'volcan', name: 'Caldeira ardente', theme: 'volcano', difficulty: 'Intermédiaire', width: 22, grip: 1.04,
    description: 'Une montée autour du cratère, un viaduc au-dessus de la lave, un tremplin de basalte et une épingle dans la descente. Gardez votre vitesse sur les larges courbes.',
    palette: { sky: '#e5a985', water: '#cd633d', ground: '#6f665c', road: '#5b5554', accent: '#ffb15d' },
    anchors: [[0,-190],[110,-180],[190,-120],[205,-30],[160,45],[80,62],[38,115],[70,170],[70,215],[20,240],[-60,210],[-120,145],[-195,100],[-215,15],[-170,-55],[-185,-130],[-110,-180]],
    zones: [{ kind: 'boost', start: .04, end: .06, offset: 0, width: 10 },
      { kind: 'mud', start: .4, end: .44, offset: 6.5, width: 8 },
      { kind: 'boost', start: .61, end: .63, offset: 0, width: 10 },
      { kind: 'boost', start: .86, end: .88, offset: -4, width: 8 }],
    elevations: [{ kind: 'bridge', start: .48, end: .58, height: 5, approach: 50 },
      { kind: 'jump', start: .93, end: .945, height: 2.1, approach: 0, launchSpeed: 7.2 }],
    relief: [[0.96,2],[0.05,2],[0.2,8],[0.36,13],[0.48,16],[0.58,16],[0.7,8],[0.84,3]],
  }),
  makeTrack({ id: 'forest', name: 'Forêt des géants', theme: 'forest', difficulty: 'Intermédiaire', width: 22, grip: .99,
    description: 'Des courbes vallonnées entre les séquoias, un pont de bois au-dessus du ruisseau et un saut de racines. Les bandes boueuses laissent une trajectoire sèche.',
    palette: { sky: '#cbdcc2', water: '#7dada4', ground: '#80a070', road: '#697463', accent: '#dec77c' },
    anchors: [[0,-200],[100,-190],[180,-140],[205,-55],[180,30],[115,80],[85,145],[120,205],[90,265],[15,285],[-55,245],[-75,180],[-135,150],[-195,110],[-205,35],[-155,-15],[-150,-80],[-165,-135],[-125,-180],[-60,-198]],
    zones: [{ kind: 'mud', start: .13, end: .17, offset: 6.5, width: 8 },
      { kind: 'boost', start: .32, end: .34, offset: -3, width: 9 },
      { kind: 'mud', start: .69, end: .73, offset: -6.5, width: 8 },
      { kind: 'boost', start: .79, end: .81, offset: 0, width: 9 }],
    elevations: [{ kind: 'bridge', start: .46, end: .56, height: 4.5, approach: 45 },
      { kind: 'jump', start: .93, end: .945, height: 1.6, approach: 0, launchSpeed: 6.3 }],
    relief: [[.96, 4], [.05, 4], [.18, 9], [.32, 3], [.46, 6], [.56, 6], [.7, 11], [.86, 5]],
  }),
  makeTrack({ id: 'harbor', name: 'Port des cargos', theme: 'harbor', difficulty: 'Facile', width: 24, grip: 1.05,
    description: 'Les grands quais offrent de l’espace pour dépasser. Traversez le pont métallique, contournez le bassin et sautez le tremplin de chargement.',
    palette: { sky: '#c8e3e8', water: '#458b9d', ground: '#b8b9a3', road: '#667b85', accent: '#f2c96b' },
    anchors: [[0,-140],[130,-140],[230,-110],[250,-30],[205,40],[135,62],[85,100],[90,155],[65,205],[-10,220],[-100,195],[-185,170],[-240,110],[-245,10],[-210,-90],[-120,-140]],
    zones: [{ kind: 'boost', start: .04, end: .06, offset: -4, width: 10 },
      { kind: 'ice', start: .48, end: .52, offset: 6, width: 8 },
      { kind: 'boost', start: .64, end: .665, offset: 0, width: 10 },
      { kind: 'boost', start: .88, end: .9, offset: 4, width: 10 }],
    elevations: [{ kind: 'bridge', start: .47, end: .57, height: 6, approach: 60 },
      { kind: 'jump', start: .93, end: .945, height: 2.4, approach: 0, launchSpeed: 7.8 }],
    relief: [[0.95,0],[0.06,0],[0.2,3],[0.36,5],[0.47,2],[0.57,2],[0.7,1],[0.86,3]],
  }),
  makeTrack({ id: 'sky', name: 'Archipel céleste', theme: 'sky', difficulty: 'Technique', width: 24, grip: 1,
    description: 'Un parcours en aile entre les îlots flottants : deux ponts, un grand saut et des crêtes où la route plonge sous vos roues.',
    palette: { sky: '#c5deef', water: '#bdd9ed', ground: '#d1dfaa', road: '#9ca5b5', accent: '#c49be2' },
    anchors: [[0,-180],[125,-180],[215,-130],[215,-35],[140,25],[160,110],[90,175],[-5,165],[-70,110],[-135,125],[-215,75],[-225,-25],[-205,-115],[-125,-170]],
    zones: [{ kind: 'boost', start: .04, end: .06, offset: 0, width: 10 },
      { kind: 'boost', start: .38, end: .4, offset: 0, width: 11 },
      { kind: 'ice', start: .53, end: .565, offset: 6.5, width: 8 },
      { kind: 'boost', start: .84, end: .86, offset: -4, width: 10 }],
    elevations: [{ kind: 'bridge', start: .07, end: .16, height: 6, approach: 60 },
      { kind: 'bridge', start: .19, end: .28, height: 5.5, approach: 55 },
      { kind: 'jump', start: .93, end: .945, height: 2.3, approach: 0, launchSpeed: 8.2 }],
    relief: [[0.95,5],[0.03,5],[0.07,7],[0.16,7],[0.19,6],[0.28,6],[0.42,10],[0.56,5],[0.7,9],[0.86,10]],
  }),
  makeTrack({ id: 'foundry', name: 'Fonderie des pistons', theme: 'foundry', difficulty: 'Intermédiaire', width: 22, grip: 1.03,
    description: 'Un tracé en coudes entre les hauts-fourneaux, une passerelle industrielle et une rampe d’essai. Freinez avant les plaques de refroidissement.',
    palette: { sky: '#d6bbae', water: '#8f7f73', ground: '#a08f75', road: '#626665', accent: '#eeb04e' },
    anchors: [[0,-170],[120,-170],[195,-120],[185,-40],[115,0],[100,70],[150,125],[125,185],[45,205],[-30,185],[-95,180],[-160,140],[-185,50],[-150,-20],[-185,-90],[-140,-150],[-70,-170]],
    zones: [{ kind: 'boost', start: .04, end: .06, offset: 0, width: 10 },
      { kind: 'ice', start: .25, end: .29, offset: -6, width: 8 },
      { kind: 'mud', start: .57, end: .61, offset: 6.5, width: 8 },
      { kind: 'boost', start: .69, end: .715, offset: 0, width: 10 }],
    elevations: [{ kind: 'bridge', start: .35, end: .45, height: 5, approach: 50 },
      { kind: 'jump', start: .93, end: .945, height: 2, approach: 0, launchSpeed: 7.6 }],
    relief: [[.95, 1], [.06, 1], [.2, 6], [.35, 3], [.45, 3], [.6, 8], [.76, 2], [.88, 5]],
  }),
  makeTrack({ id: 'castle', name: 'Citadelle royale', theme: 'castle', difficulty: 'Facile', width: 24, grip: 1.02,
    description: 'Le tour des remparts monte vers le donjon, traverse un pont de pierre sur les douves et redescend par un saut de parade. Les grandes courbes invitent aux dépassements et aux mini-turbos.',
    palette: { sky: '#dbe2ee', water: '#6d9ba8', ground: '#aabd83', road: '#8d9293', accent: '#b18ac8' },
    anchors: [[0,-185],[105,-180],[180,-130],[170,-45],[205,35],[150,105],[70,90],[20,150],[-60,185],[-140,150],[-150,70],[-205,10],[-180,-70],[-125,-120],[-75,-180]],
    zones: [{ kind: 'boost', start: .04, end: .06, offset: -4, width: 10 },
      { kind: 'mud', start: .43, end: .47, offset: 7, width: 8 },
      { kind: 'boost', start: .58, end: .61, offset: 0, width: 10 },
      { kind: 'boost', start: .86, end: .885, offset: 4, width: 10 }],
    elevations: [{ kind: 'bridge', start: .14, end: .24, height: 4, approach: 40 },
      { kind: 'jump', start: .635, end: .65, height: 1.8, approach: 0, launchSpeed: 6.8 }],
    relief: [[0.95,3],[0.06,3],[0.14,8],[0.24,8],[0.48,14],[0.62,6],[0.8,1]],
  }),
];
const customTracks = new Map<string, TrackDefinition>();
const latestCustomTracks = new Map<string, { revision: number; track: TrackDefinition }>();
const retiredCustomTracks = new Set<string>();
/** Retire a catalogue entry without discarding immutable race/replay geometry. */
export function retireCustomTrackDefinition(logicalId: string): void {
  if (!/^custom-[a-z0-9-]{1,64}$/.test(logicalId)) return;
  retiredCustomTracks.add(logicalId);
  latestCustomTracks.delete(logicalId);
}
// Ephemeral definitions are usable by their owning room, never by catalogue
// selection, matchmaking or tournament validation through isTrackId().
const previewTracks = new Map<string, TrackDefinition>();
export function registerPreviewTrackDefinition(track:TrackDefinition):TrackDefinition {
  if (!/^custom-private-[a-f0-9-]{36}-v1$/.test(track.id)||!arcTables.has(track)) throw new Error('Aperçu de circuit invalide.');
  const existing=previewTracks.get(track.id);
  if(existing&&JSON.stringify(existing)!==JSON.stringify(track)) throw new Error('Cet aperçu appartient à une autre version du brouillon.');
  if(!existing)previewTracks.set(track.id,track);
  return existing??track;
}
export function isPreviewTrackId(id:unknown):id is TrackId {return typeof id==='string'&&previewTracks.has(id);}
export function releasePreviewTrackDefinition(id:string):void {previewTracks.delete(id);}
/** Retain old immutable versions for races and saved replays while advertising the latest revision. */
export function registerTrackDefinition(track: TrackDefinition, logicalId: string, revision: number): TrackDefinition {
  if (!/^custom-[a-z0-9-]{1,64}$/.test(logicalId) || logicalId.startsWith('custom-private-') || !Number.isInteger(revision) || revision < 1 || revision > 10000 ||
    track.id !== `${logicalId}-v${revision}` || !arcTables.has(track)) throw new Error('Identifiant de circuit personnalisé invalide.');
  const existing = customTracks.get(track.id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(track)) throw new Error('Cette version de circuit est déjà publiée.');
  const result = existing ?? track;
  customTracks.set(track.id, result);
  const latest = latestCustomTracks.get(logicalId);
  if (!retiredCustomTracks.has(logicalId) && (!latest || revision > latest.revision)) latestCustomTracks.set(logicalId, { revision, track: result });
  return result;
}
export function getAvailableTracks(): TrackDefinition[] {
  return [...TRACKS, ...Array.from(latestCustomTracks.values(), entry => entry.track)];
}
export function isTrackId(id: unknown): id is TrackId {
  return typeof id === 'string' && ((TRACK_IDS as readonly string[]).includes(id) || customTracks.has(id));
}
export function getTrack(id = 'lagon'): TrackDefinition { return previewTracks.get(id) ?? customTracks.get(id) ?? TRACKS.find(track => track.id === id) ?? TRACKS[0]!; }
function reliefSpan(wrapped: number, track: TrackDefinition): { from: TrackReliefPoint; to: TrackReliefPoint; span: number; t: number } {
  const relief = track.relief!;
  let index = relief.length - 1;
  for (let i = 0; i < relief.length && relief[i]!.at <= wrapped; i++) index = i;
  const from = relief[index]!, to = relief[(index + 1) % relief.length]!;
  const span = (to.at - from.at + track.length) % track.length || track.length;
  return { from, to, span, t: ((wrapped - from.at + track.length) % track.length) / span };
}
/** Height of the natural ground along the route, without bridges, ramps or crossings. */
export function reliefElevation(progress: number, track: TrackDefinition): number {
  if (!track.relief?.length) return 0;
  const { from, to, t } = reliefSpan(((progress % track.length) + track.length) % track.length, track);
  return from.height + (to.height - from.height) * t * t * (3 - 2 * t);
}
/** Rise per metre of the natural ground: positive when the route climbs. */
export function reliefSlope(progress: number, track: TrackDefinition): number {
  if (!track.relief?.length) return 0;
  const { from, to, span, t } = reliefSpan(((progress % track.length) + track.length) % track.length, track);
  return (to.height - from.height) * 6 * t * (1 - t) / span;
}
/** Original relief, before derived crossing offsets. Kept independent of registration. */
export function baseTrackElevation(progress: number, track: TrackDefinition): number {
  // Adding a whole lap before the modulo would round a ramp's exact lip past its end.
  const remainder = progress % track.length, wrapped = remainder < 0 ? remainder + track.length : remainder;
  const ground = reliefElevation(wrapped, track);
  const feature = track.elevations.find(feature => wrapped >= feature.start && wrapped <= feature.end);
  if (!feature) return ground;
  if (feature.kind === 'jump') return ground + feature.height * (wrapped - feature.start) / (feature.end - feature.start);
  const ramp = Math.min(feature.approach, (feature.end - feature.start) / 2);
  const t = Math.max(0, Math.min(1, (wrapped - feature.start) / ramp, (feature.end - wrapped) / ramp));
  return ground + feature.height * t * t * (3 - 2 * t);
}
export function trackElevation(progress: number, trackId = 'lagon'): number {
  const track = getTrack(trackId);
  return baseTrackElevation(progress, track) + automaticTrackElevation(progress, track);
}
export function trackSlope(progress: number, trackId = 'lagon'): number {
  const track = getTrack(trackId);
  const wrapped = ((progress % track.length) + track.length) % track.length;
  const feature = track.elevations.find(feature => wrapped >= feature.start && wrapped <= feature.end);
  if (!track.crossings?.length && !track.relief?.length) {
    if (!feature) return 0;
    if (feature.kind === 'jump') return feature.height / (feature.end - feature.start);
  }
  return (trackElevation(progress + .1, trackId) - trackElevation(progress - .1, trackId)) / .2;
}
/** Ramp geometry only; caller decides speed/direction and crossing of end. */
export function trackJumpAt(progress: number, trackId = 'lagon'): TrackElevation | undefined {
  const track = getTrack(trackId);
  const remainder = progress % track.length;
  const wrapped = remainder < 0 ? remainder + track.length : remainder;
  return track.elevations.find(feature => feature.kind === 'jump' && wrapped >= feature.start && wrapped <= feature.end);
}
function pointOnTrack(progress: number, track: TrackDefinition): Vec2 & { angle: number } {
  const wrapped = ((progress % track.length) + track.length) % track.length;
  const { cumulative, lengths } = arcTables.get(track)!;
  let low = 0; let high = track.points.length - 1;
  while (low < high) { const middle = (low + high) >>> 1; if (cumulative[middle + 1]! <= wrapped) low = middle + 1; else high = middle; }
  const point = track.points[low]!;
  const next = track.points[(low + 1) % track.points.length]!;
  const t = (wrapped - cumulative[low]!) / lengths[low]!;
  return { x: point.x + (next.x - point.x) * t, z: point.z + (next.z - point.z) * t,
    angle: Math.atan2(next.x - point.x, next.z - point.z) };
}
export function trackPoint(progress: number, trackId = 'lagon'): Vec2 & { angle: number } {
  return pointOnTrack(progress, getTrack(trackId));
}
const BANK_STEP = 2;
const bankTables = new WeakMap<TrackDefinition, Float32Array>();
/** Sideways tilt of the official roads in their bends: rise per metre towards the
 * right-hand edge. Rendering only; the simulation keeps a level cross-section. */
export function trackBank(progress: number, track: TrackDefinition): number {
  if (track.id.startsWith('custom-')) return 0;
  let table = bankTables.get(track);
  if (!table) {
    const count = Math.max(2, Math.ceil(track.length / BANK_STEP)), raw = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const at = i * track.length / count;
      const turn = pointOnTrack(at + 8, track).angle - pointOnTrack(at - 8, track).angle;
      // Level decks and ramps: their structures are built from straight boxes.
      const structure = Math.min(Infinity, ...track.elevations.map(feature => Math.max(feature.start - at, at - feature.end, 0)));
      const ease = Math.max(0, Math.min(1, (structure - 4) / 24));
      raw[i] = -Math.max(-.085, Math.min(.085, Math.atan2(Math.sin(turn), Math.cos(turn)) / 16 * 3.4)) * ease * ease * (3 - 2 * ease);
    }
    table = new Float32Array(count);
    for (let i = 0; i < count; i++) { let sum = 0; for (let k = -6; k <= 6; k++) sum += raw[(i + k + count) % count]!; table[i] = sum / 13; }
    bankTables.set(track, table);
  }
  const position = (((progress % track.length) + track.length) % track.length) / track.length * table.length;
  const index = Math.floor(position) % table.length, t = position - Math.floor(position);
  return table[index]! * (1 - t) + table[(index + 1) % table.length]! * t;
}
export interface TrackPositionHint { progress?: number; elevation?: number }
export function nearestTrack(x: number, z: number, trackId = 'lagon', hint?: TrackPositionHint): Vec2 & { distance: number; progress: number; index: number; angle: number } {
  const track = getTrack(trackId);
  const table = arcTables.get(track)!, { lengths, cumulative } = table;
  let result = { x: 0, z: 0, distance: Infinity, progress: 0, index: 0, angle: 0 };
  let bestSquared = Infinity;
  const layered = !!track.crossings?.length && !!hint;
  if (!layered && Number.isFinite(x) && Number.isFinite(z)) {
    // Same answer as the full scan below, lowest segment first on a tie, reached
    // by widening rings of cells until none left unvisited could be closer.
    const grid = segmentGrid(track, table), column = Math.floor((x - grid.x) / GRID_CELL), row = Math.floor((z - grid.z) / GRID_CELL);
    let best = -1, bestT = 0, bestX = 0, bestZ = 0;
    for (let ring = 0; ring <= 8; ring++) {
      for (let cellRow = row - ring; cellRow <= row + ring; cellRow++) {
        if (cellRow < 0 || cellRow >= grid.rows) continue;
        const edge = cellRow === row - ring || cellRow === row + ring;
        for (let cellColumn = column - ring; cellColumn <= column + ring; cellColumn += edge ? 1 : Math.max(1, ring * 2)) {
          if (cellColumn < 0 || cellColumn >= grid.columns) continue;
          for (const i of grid.cells[cellRow * grid.columns + cellColumn]!) {
            const a = track.points[i]!, b = track.points[(i + 1) % track.points.length]!;
            const dx = b.x - a.x, dz = b.z - a.z, segmentSquared = dx * dx + dz * dz;
            if (segmentSquared < 1e-14) continue;
            const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / segmentSquared));
            // Written exactly as in the scan: a shared vertex must round the same way.
            const px = a.x + dx * t, pz = a.z + dz * t, squared = (x - px) ** 2 + (z - pz) ** 2;
            if (squared < bestSquared || squared === bestSquared && i < best) { bestSquared = squared; best = i; bestT = t; bestX = px; bestZ = pz; }
          }
        }
      }
      if (best >= 0 && bestSquared <= (ring * GRID_CELL) ** 2) {
        const a = track.points[best]!, b = track.points[(best + 1) % track.points.length]!, dx = b.x - a.x, dz = b.z - a.z;
        return { x: bestX, z: bestZ, distance: Math.sqrt(bestSquared), progress: cumulative[best]! + lengths[best]! * bestT,
          index: best, angle: Math.atan2(dx, dz) };
      }
    }
    bestSquared = Infinity; // Far from the island: the plain scan below decides.
  }
  const wrappedHint = hint?.progress === undefined ? undefined : ((hint.progress % track.length) + track.length) % track.length;
  for (let i = 0; i < track.points.length; i++) {
    const a = track.points[i]!;
    const b = track.points[(i + 1) % track.points.length]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const segmentSquared = dx * dx + dz * dz;
    if (segmentSquared < 1e-14) continue;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / segmentSquared));
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const squared = (x - px) ** 2 + (z - pz) ** 2;
    const progress = cumulative[i]! + lengths[i]! * t;
    let score = squared;
    if (layered) {
      const height = baseTrackElevation(progress, track) + automaticTrackElevation(progress, track);
      if (hint?.elevation !== undefined) {
        // A metre of tolerance lets the kart advance up a continuous ramp
        // without selecting the previous, lower sample at every physics step.
        const difference = Math.max(0, Math.abs(height - hint.elevation) - 1);
        // A different floor must not win merely because its centreline is closer,
        // including the editor's widest roads.
        score += difference * difference * Math.max(16, track.width * track.width * .2);
      }
      if (wrappedHint !== undefined) {
        const difference = Math.abs(progress - wrappedHint);
        const travelled = Math.min(difference, track.length - difference);
        score += Math.min(travelled, 80) ** 2 * .04 * Math.max(1, track.width * track.width / 324);
      }
    }
    if (score < bestSquared) {
      bestSquared = score;
      result = { x: px, z: pz, distance: Math.sqrt(squared), progress: cumulative[i]! + lengths[i]! * t,
        index: i, angle: Math.atan2(dx, dz) };
    }
  }
  return result;
}
export function trackSurface(x: number, z: number, trackId = 'lagon', near = nearestTrack(x, z, trackId)):
  { surface: Surface; zone?: TrackZone } {
  const track = getTrack(trackId);
  if (near.distance > track.width / 2) return { surface: 'offroad' };
  const offset = (x - near.x) * Math.cos(near.angle) - (z - near.z) * Math.sin(near.angle);
  const zone = track.zones.find(candidate => near.progress >= candidate.start && near.progress <= candidate.end &&
    Math.abs(offset - candidate.offset) <= candidate.width / 2);
  return zone ? { surface: zone.kind, zone } : { surface: 'road' };
}
export function spawnPoint(index: number, trackId = 'lagon'): Vec2 & { angle: number } {
  const point = trackPoint(-6 - Math.floor(index / 2) * 5, trackId);
  const side = index % 2 === 0 ? -2.5 : 2.5;
  return { x: point.x + Math.cos(point.angle) * side,
    z: point.z - Math.sin(point.angle) * side, angle: point.angle };
}
// Legacy aliases keep existing integrations valid; new code selects a track.
export const TRACK = TRACKS[0]!.points;
export const TRACK_LENGTH = TRACKS[0]!.length;
export const ROAD_WIDTH = TRACKS[0]!.width;
export const CHECKPOINTS = TRACKS[0]!.checkpoints;
