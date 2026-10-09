import { getAvailableTracks, getTrack, type TrackDefinition } from '../shared/track';
import { trackOutline } from './tournament-ui';
import { filterTrackCatalog, isCommunityTrack, trackCatalogPageSize, trackHighlights, trackLapLabel, trackThemeLabel, type TrackSource } from './track-catalog';
import './track-picker.css';

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
interface TrackPickerOptions {
  getSelected: () => string;
  onSelect: (id: string) => void;
  onRefresh: () => Promise<unknown>;
  onCreate: () => void;
}

/** A local preview is committed only by the explicit Choose button. */
export class TrackPicker {
  readonly dialog = document.createElement('dialog');
  private draft = '';
  private query = '';
  private source: TrackSource = 'all';
  private page = 0;
  private pageSize = this.viewportPageSize();
  private loading = false;
  private error = '';
  private opener: HTMLElement | null = null;

  constructor(private readonly options: TrackPickerOptions) {
    this.dialog.id = 'track-picker';
    this.dialog.className = 'track-picker';
    this.dialog.setAttribute('aria-labelledby', 'track-picker-title');
    this.dialog.innerHTML = `<div class="track-picker-layout">
      <header class="track-picker-heading"><div><span class="track-picker-kicker">VOTRE PROCHAIN DÉPART</span><h2 id="track-picker-title">Choisir un circuit</h2></div><button type="button" id="track-picker-close" class="picker-icon-button" aria-label="Fermer les circuits">✕</button></header>
      <div class="track-picker-tools"><label class="track-picker-search"><span class="picker-sr-only">Rechercher un circuit, un thème ou une particularité</span><input id="track-picker-search" type="search" placeholder="Nom, thème, pont…" autocomplete="off" spellcheck="false"></label><label><span class="picker-sr-only">Type de circuit</span><select id="track-picker-source"><option value="all">Tous</option><option value="official">Officiels</option><option value="community">Créations</option></select></label><button id="track-refresh-button" type="button" class="picker-icon-button" aria-label="Actualiser les circuits" title="Actualiser les circuits">↻</button></div>
      <p id="track-picker-status" class="track-picker-status" role="status" aria-live="polite"></p>
      <div class="track-picker-body"><section id="track-picker-catalog" class="track-picker-catalog" aria-label="Catalogue des circuits"><div id="track-picker-cards" class="track-picker-cards"></div><nav class="track-picker-pagination" aria-label="Pages de circuits"><button id="track-picker-previous" type="button" class="picker-icon-button" aria-label="Page précédente">←</button><span id="track-picker-page" role="status" aria-live="polite"></span><button id="track-picker-next" type="button" class="picker-icon-button" aria-label="Page suivante">→</button></nav></section><section id="track-picker-detail" class="track-picker-detail" aria-label="Aperçu du circuit"></section></div>
      <footer class="track-picker-footer"><button id="track-picker-create" type="button" class="picker-secondary">Créer un circuit</button><button id="track-picker-confirm" type="button" class="picker-primary">Choisir ce circuit <span aria-hidden="true">→</span></button></footer>
    </div>`;
    document.body.append(this.dialog);
    this.element('track-picker-close').addEventListener('click', () => this.close());
    this.element('track-picker-search').addEventListener('input', event => {
      this.query = (event.target as HTMLInputElement).value; this.page = 0; this.render();
    });
    this.element('track-picker-source').addEventListener('change', event => {
      this.source = (event.target as HTMLSelectElement).value as TrackSource; this.page = 0; this.render();
    });
    this.element('track-picker-previous').addEventListener('click', () => { this.page--; this.render(); });
    this.element('track-picker-next').addEventListener('click', () => { this.page++; this.render(); });
    this.element('track-picker-cards').addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-track]') : null;
      if (target?.dataset.track && this.available(target.dataset.track)) { this.draft = target.dataset.track; this.render(); }
      if (event.target instanceof Element && event.target.closest('[data-clear-search]')) this.resetFilters();
    });
    this.element('track-picker-confirm').addEventListener('click', () => {
      if (!this.available(this.draft) || this.loading && this.draft.startsWith('custom-')) return;
      this.options.onSelect(this.draft); this.close();
    });
    this.element('track-picker-create').addEventListener('click', () => { this.close(); this.options.onCreate(); });
    this.element('track-refresh-button').addEventListener('click', () => void this.reload());
    this.dialog.addEventListener('close', () => {
      if (this.opener?.isConnected && !document.querySelector('dialog[open]')) this.opener.focus({ preventScroll: true });
    });
    // Escape is handled by the native dialog; it deliberately does not commit a preview.
    const resize = () => {
      const size = this.viewportPageSize();
      if (size !== this.pageSize) { const first = this.page * this.pageSize; this.pageSize = size; this.page = Math.floor(first / size); if (this.dialog.open) this.render(); }
    };
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
  }

  private element<T extends HTMLElement = HTMLElement>(id: string): T { return this.dialog.querySelector<T>(`#${id}`)!; }
  private available(id: string) { return getAvailableTracks().some(track => track.id === id); }
  private viewportPageSize() {
    const viewport = window.visualViewport;
    const height = viewport && Math.abs(viewport.scale - 1) < .02 ? viewport.height : window.innerHeight;
    return trackCatalogPageSize(window.innerWidth, height);
  }
  open() {
    if (this.dialog.open) return;
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.draft = this.options.getSelected();
    this.query = ''; this.source = 'all';
    this.element<HTMLInputElement>('track-picker-search').value = '';
    this.element<HTMLSelectElement>('track-picker-source').value = 'all';
    this.pageSize = this.viewportPageSize();
    this.page = Math.floor(Math.max(0, getAvailableTracks().findIndex(track => track.id === this.draft)) / this.pageSize);
    this.render(); this.dialog.showModal();
    // Opening on a phone should not summon the keyboard and obscure the catalogue.
    this.element<HTMLButtonElement>('track-picker-close').focus({ preventScroll: true });
    void this.reload();
  }
  close() { this.dialog.close(); }
  refresh() { if (this.dialog.open) this.render(); }
  setLoading(loading: boolean) { this.loading = loading; this.renderStatus(); }
  setError(message: string) { this.error = message; this.renderStatus(); }

  private resetFilters() {
    this.query = ''; this.source = 'all'; this.page = 0;
    this.element<HTMLInputElement>('track-picker-search').value = '';
    this.element<HTMLSelectElement>('track-picker-source').value = 'all'; this.render();
    this.element<HTMLInputElement>('track-picker-search').focus();
  }
  private async reload() {
    if (this.loading) return;
    this.setError(''); this.setLoading(true);
    try { await this.options.onRefresh(); this.refresh(); }
    catch { this.setError('Créations indisponibles. Réessayez avec ↻ ; les circuits déjà chargés restent jouables.'); }
    finally { this.setLoading(false); }
  }
  private renderStatus() {
    const status = this.element('track-picker-status');
    status.textContent = this.loading ? 'Actualisation des créations…' : this.error;
    status.classList.toggle('has-message', Boolean(this.loading || this.error));
    status.classList.toggle('is-error', Boolean(this.error && !this.loading));
    this.element<HTMLButtonElement>('track-refresh-button').disabled = this.loading;
    this.element('track-picker-catalog')?.setAttribute('aria-busy', String(this.loading));
    this.element<HTMLButtonElement>('track-picker-confirm').disabled = !this.available(this.draft) || this.loading && this.draft.startsWith('custom-');
  }
  private render() {
    if (!this.available(this.draft)) this.draft = this.available(this.options.getSelected()) ? this.options.getSelected() : 'lagon';
    const focused = document.activeElement instanceof HTMLElement && this.dialog.contains(document.activeElement) ? document.activeElement.dataset.track : undefined;
    const tracks = filterTrackCatalog(getAvailableTracks(), this.query, this.source);
    const pages = Math.max(1, Math.ceil(tracks.length / this.pageSize));
    this.page = Math.max(0, Math.min(this.page, pages - 1));
    const visible = tracks.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize);
    this.element('track-picker-cards').innerHTML = visible.length ? visible.map(track => this.card(track)).join('')
      : `<div class="track-picker-empty"><strong>Aucun circuit trouvé</strong><span>${this.query ? 'Essayez un autre nom ou un autre thème.' : 'Aucune création chargée pour le moment.'}</span><button class="picker-secondary" type="button" data-clear-search>Voir tous les circuits</button></div>`;
    this.element('track-picker-page').innerHTML = `<b>${this.page + 1} / ${pages}</b><small>${tracks.length} circuit${tracks.length > 1 ? 's' : ''}</small>`;
    this.element<HTMLButtonElement>('track-picker-previous').disabled = this.page === 0;
    this.element<HTMLButtonElement>('track-picker-next').disabled = this.page + 1 === pages;
    if (this.available(this.draft)) this.renderDetail(getTrack(this.draft));
    this.element<HTMLButtonElement>('track-picker-confirm').disabled = !this.available(this.draft);
    this.renderStatus();
    if (focused) this.dialog.querySelector<HTMLButtonElement>(`[data-track="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }
  private card(track: TrackDefinition): string {
    const selected = track.id === this.draft;
    const current = track.id === this.options.getSelected();
    return `<button type="button" class="picker-track-card${selected ? ' is-preview' : ''}" data-track="${escape(track.id)}" aria-pressed="${selected}" style="--picker-accent:${escape(track.palette.accent)}"><span class="picker-track-outline">${trackOutline(track)}</span><span class="picker-track-copy"><strong>${escape(track.name)}</strong><small>${escape(trackThemeLabel(track))} · ${trackLapLabel(track)}</small><span class="picker-track-origin">${current ? 'Circuit actuel' : isCommunityTrack(track) ? 'Création des joueurs' : track.difficulty}</span></span><span class="picker-track-check" aria-hidden="true">${selected ? '✓' : ''}</span></button>`;
  }
  private renderDetail(track: TrackDefinition) {
    const current = track.id === this.options.getSelected();
    const highlights = trackHighlights(track);
    this.element('track-picker-detail').innerHTML = `<div class="picker-detail-outline" style="--picker-accent:${escape(track.palette.accent)}">${trackOutline(track)}</div><div class="picker-detail-copy"><span class="picker-detail-status">${current ? 'VOTRE CIRCUIT ACTUEL' : 'APERÇU · À CONFIRMER'}</span><h3>${escape(track.name)}</h3><div class="picker-detail-tags"><span>${escape(trackThemeLabel(track))}</span><span>${escape(track.difficulty)}</span><span>${trackLapLabel(track)}</span></div><p class="picker-detail-description">${escape(track.description)}</p><p class="picker-detail-features">${escape(highlights.length ? highlights.join(' · ') : 'Un tracé à découvrir')}</p></div>`;
  }
}
