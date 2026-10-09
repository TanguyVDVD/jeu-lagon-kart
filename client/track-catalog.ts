import { TOTAL_LAPS, type TrackDefinition } from '../shared/track';

export type TrackSource = 'all' | 'official' | 'community';
const themes: Record<TrackDefinition['theme'], string> = {
  tropical: 'Tropical', canyon: 'Canyon', ice: 'Banquise', neon: 'Néon', volcano: 'Volcan',
  forest: 'Forêt', harbor: 'Port', sky: 'Ciel', foundry: 'Fonderie', castle: 'Château',
};
const searchable = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('fr');
export const isCommunityTrack = (track: TrackDefinition) => track.id.startsWith('custom-');
export const trackThemeLabel = (track: TrackDefinition) => themes[track.theme];
export const trackLapLabel = (track: TrackDefinition) => `${track.lapCount ?? TOTAL_LAPS} tour${(track.lapCount ?? TOTAL_LAPS) > 1 ? 's' : ''}`;

/** Describe actual modules, including player-created circuits, rather than inferring from the theme. */
export function trackHighlights(track: TrackDefinition): string[] {
  const features: string[] = [];
  if (track.crossings?.length) features.push('Ponts et tunnels');
  else if (track.elevations.some(feature => feature.kind === 'bridge')) features.push('Ponts');
  if (track.elevations.some(feature => feature.kind === 'jump') || track.interactions?.some(feature => feature.kind === 'jump')) features.push('Sauts');
  if (track.zones.some(zone => zone.kind === 'boost') || track.interactions?.some(feature => feature.kind === 'boost') || track.lapEvents?.some(event => event.kind === 'boost')) features.push('Turbos');
  if (track.zones.some(zone => zone.kind === 'ice') || track.lapEvents?.some(event => event.kind === 'ice')) features.push('Glace');
  if (track.zones.some(zone => zone.kind === 'mud') || track.lapEvents?.some(event => event.kind === 'mud')) features.push('Boue');
  if (track.lapEvents?.length) features.push('Événements par tour');
  return features;
}

export function filterTrackCatalog(tracks: TrackDefinition[], query: string, source: TrackSource): TrackDefinition[] {
  const words = searchable(query.trim()).split(/\s+/).filter(Boolean);
  return tracks.filter(track => {
    if (source === 'official' && isCommunityTrack(track) || source === 'community' && !isCommunityTrack(track)) return false;
    const haystack = searchable([track.name, trackThemeLabel(track), track.difficulty, ...trackHighlights(track)].join(' '));
    return words.every(word => haystack.includes(word));
  });
}

export function trackCatalogPageSize(width: number, height: number): number {
  if (width >= 980 && height >= 720) return 6;
  if (width > 760 && height >= 600) return 4;
  return 2;
}
