import './track-editor.css';
import { CUSTOM_TRACK_EVENT_KINDS, CUSTOM_TRACK_LIMITS, CUSTOM_TRACK_THEMES, CUSTOM_TRACK_TEMPLATES, sampleCustomTrackAnchors, validateCustomTrackDraft, type CustomTrackDraft, type StoredCustomTrack, type TrackWorkshopSelection } from '../shared/custom-tracks';
import type { Vec2 } from '../shared/track';
import {customTrackModule,moveCustomTrackModule,projectCustomTrackPoint,type TrackModuleSelection} from '../shared/custom-track-editing';

export interface TrackEditorOptions {
  list: () => Promise<StoredCustomTrack[]>;
  save: (draft: CustomTrackDraft, previous?: { id: string; revision: number }) => Promise<StoredCustomTrack>;
  onSaved: (record: StoredCustomTrack) => void;
  onTry: (draft: CustomTrackDraft, selection?: TrackWorkshopSelection) => void | Promise<void>;
  onClose?: () => void;
  storageKey?: string;
  getPlayerId?: () => string;
  canModerateTracks?: () => boolean;
  remove?: (record: { id: string; revision: number }) => Promise<void>;
  onDeleted?: (id: string) => void;
}
type EditorMode = 'move' | 'add';
type FeatureGroup = 'elevations' | 'events' | 'interactions';
type PendingAction = { text: string; proceed: () => void; close: boolean };
const copy = <T>(value: T): T => structuredClone(value);
const escape = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const ZONE_NAMES = { boost: 'Turbo', ice: 'Glace', mud: 'Boue' };
const ZONE_COLORS = { boost: '#ffc951', ice: '#73e4f5', mud: '#b78966' };
const THEME_COLORS: Record<CustomTrackDraft['theme'], [string, string]> = {
  tropical: ['#bed6a0', '#637973'], canyon: ['#e4af7f', '#806354'], ice: ['#d4eaf0', '#85b6c9'], neon: ['#29334d', '#64618c'],
  volcano: ['#977660', '#635858'], forest: ['#97b686', '#64795e'], harbor: ['#adcbc5', '#647c87'], sky: ['#d2def0', '#899ab3'],
  foundry: ['#b6a18c', '#776957'], castle: ['#c7c0a4', '#86837b'],
};

/** A DOM/SVG editor; the shared compiler supplies the exact route used by the race. */
export class TrackEditor {
  private readonly dialog = document.createElement('dialog');
  private draft = copy(CUSTOM_TRACK_TEMPLATES[0]!.draft);
  private previous?: { id: string; revision: number };
  private baseline = JSON.stringify(this.draft);
  private selected = 0;
  private selectedModule?:TrackModuleSelection;
  private mode: EditorMode = 'move';
  private undoStack: CustomTrackDraft[] = [];
  private redoStack: CustomTrackDraft[] = [];
  private records: StoredCustomTrack[] = [];
  private busy = false;
  private loading = false;
  private notice = '';
  private noticeKind: 'success' | 'error' | 'info' = 'info';
  private libraryError = '';
  private localStorageFailed = false;
  private view = { x: -200, z: -160, width: 400, height: 320 };
  private validation = validateCustomTrackDraft(this.draft);
  private validationTimer?: number;
  private drag?: { pointer: number; index: number; before: CustomTrackDraft; moved: boolean;module?:TrackModuleSelection;grabFraction?:number;grabOffset?:number;initialFraction?:number;initialOffset?:number };
  private pending?: PendingAction;
  private deletion?: { record: StoredCustomTrack; error?: string };
  private libraryRequest = 0;
  private confirmationFocus?: HTMLElement;
  private returnFocus?: HTMLElement;
  private readonly storagePrefix: string;
  private storageOwner = '';
  private moderator = false;
  private get storageKey(): string { return `${this.storagePrefix}:${this.storageOwner || 'local'}`; }

  constructor(private readonly options: TrackEditorOptions) {
    this.storagePrefix = options.storageKey ?? 'lagon-track-editor-draft-v1';
    this.storageOwner = options.getPlayerId?.() || '';
    this.moderator = options.canModerateTracks?.() === true;
    this.restoreDraft();
    this.dialog.id = 'track-editor-dialog';
    this.dialog.className = 'track-editor-dialog';
    this.dialog.setAttribute('aria-labelledby', 'track-editor-title');
    document.body.append(this.dialog);
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); if (this.busy) return; if (this.pending || this.deletion) this.cancelConfirmation(); else this.close(); });
    this.dialog.addEventListener('click', event => this.click(event));
    this.dialog.addEventListener('change', event => this.change(event));
    this.dialog.addEventListener('input', event => this.input(event));
    this.dialog.addEventListener('keydown', event => this.keydown(event));
    this.dialog.addEventListener('pointerdown', event => this.pointerDown(event));
    this.dialog.addEventListener('pointermove', event => this.pointerMove(event));
    this.dialog.addEventListener('pointerup', event => this.pointerEnd(event));
    this.dialog.addEventListener('pointercancel', event => this.pointerEnd(event));
    window.addEventListener('resize', () => { if (this.dialog.open && !this.drag) this.renderDrawing(); });
    window.addEventListener('beforeunload', event => {
      if (!this.dialog.open || !this.dirty || !this.localStorageFailed) return;
      event.preventDefault(); event.returnValue = '';
    });
  }

  get isOpen(): boolean { return this.dialog.open; }
  private get dirty(): boolean { return JSON.stringify(this.draft) !== this.baseline; }

  /** A different account must not inherit the previous account's draft or actions. */
  identityChanged() {
    const owner = this.options.getPlayerId?.() || '';
    const moderator = this.options.canModerateTracks?.() === true;
    if (owner === this.storageOwner && moderator === this.moderator) return;
    this.moderator = moderator;
    if (owner !== this.storageOwner) {
      this.persistDraft();
      this.storageOwner = owner; this.draft = copy(CUSTOM_TRACK_TEMPLATES[0]!.draft); this.previous = undefined;
      this.baseline = JSON.stringify(this.draft); this.notice = ''; this.undoStack = []; this.redoStack = []; this.selected = 0;
      this.selectedModule = undefined; this.pending = undefined; this.deletion = undefined; this.restoreDraft();
      if (this.dialog.open) { this.validate(); this.fit(); this.render(); }
    }
    if (this.deletion && !this.canDelete(this.deletion.record)) this.cancelConfirmation();
    this.renderLibrary(); this.renderConfirmation();
  }

  open() {
    if (this.dialog.open) return;
    this.identityChanged();
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.validate(); this.fit(); this.render(); this.dialog.showModal(); this.renderDrawing();
    this.dialog.querySelector<HTMLButtonElement>('#editor-mode-move')?.focus();
    void this.refreshLibrary();
  }

  close() {
    if (this.busy) return;
    if (this.dirty && this.localStorageFailed) {
      this.pending = { text: this.localStorageFailed
        ? 'Ce navigateur ne peut pas garder votre brouillon. Sauvegardez le circuit avant de fermer pour le retrouver.'
        : 'Le circuit n’est pas encore sauvegardé pour les autres joueurs. Votre brouillon reste sur ce navigateur.',
      close: true, proceed: () => this.finishClose() };
      this.renderConfirmation();
      return;
    }
    this.finishClose();
  }

  private finishClose() {
    this.persistDraft(); this.pending = undefined; this.deletion = undefined; this.dialog.close(); this.options.onClose?.();
    this.returnFocus?.focus();
  }

  private restoreDraft() {
    try {
      const stored = JSON.parse(localStorage.getItem(this.storageKey) ?? 'null');
      const candidate = stored?.draft as CustomTrackDraft | undefined;
      if (!candidate || typeof candidate.name !== 'string' || !CUSTOM_TRACK_THEMES.some(theme => theme.id === candidate.theme)
        || !Number.isFinite(candidate.width) || candidate.width < CUSTOM_TRACK_LIMITS.minWidth || candidate.width > CUSTOM_TRACK_LIMITS.maxWidth
        || !Array.isArray(candidate.anchors) || candidate.anchors.length < CUSTOM_TRACK_LIMITS.minAnchors || candidate.anchors.length > CUSTOM_TRACK_LIMITS.maxAnchors
        || !candidate.anchors.every(point => Number.isFinite(point?.x) && Number.isFinite(point?.z) && Math.abs(point.x) <= CUSTOM_TRACK_LIMITS.coordinate && Math.abs(point.z) <= CUSTOM_TRACK_LIMITS.coordinate)
        || !Array.isArray(candidate.zones) || candidate.zones.length > CUSTOM_TRACK_LIMITS.maxZones
        || !candidate.zones.every(zone => ['boost', 'ice', 'mud'].includes(zone?.kind) && [zone.start, zone.end, zone.offset, zone.width].every(Number.isFinite))) return;
      if (candidate.lapCount !== undefined && !Number.isFinite(candidate.lapCount)) return;
      for (const group of ['elevations', 'events', 'interactions'] as const) {
        const features = candidate[group];
        if (features !== undefined && (!Array.isArray(features) || features.length > 64 || features.some(feature => !feature || !Number.isFinite(feature.start) || !Number.isFinite(feature.end)))) return;
      }
      if (candidate.elevations?.some(feature => !['bridge', 'jump'].includes(feature.kind) || !Number.isFinite(feature.height) || !Number.isFinite(feature.approach) || feature.launchSpeed !== undefined && !Number.isFinite(feature.launchSpeed))) return;
      // Loopings were retired; a draft saved with them keeps the rest of its road.
      delete (candidate as { loops?: unknown }).loops;
      if (candidate.events?.some(feature => !CUSTOM_TRACK_EVENT_KINDS.some(kind => kind.id === feature.kind) || !Number.isFinite(feature.lap))) return;
      if (candidate.interactions?.some(feature=>!['boost','jump'].includes(feature.kind)||![feature.trigger,feature.width,feature.offset,feature.duration].every(Number.isFinite))) return;
      this.draft = copy(candidate);
      if (typeof stored.previous?.id === 'string' && Number.isInteger(stored.previous?.revision)) this.previous = stored.previous;
      this.baseline = typeof stored.baseline === 'string' ? stored.baseline : JSON.stringify(candidate);
      if (this.dirty) this.notice = 'Votre brouillon a été retrouvé. Reprenez votre circuit là où vous l’aviez laissé.';
    } catch { /* A malformed local draft does not prevent creating a fresh circuit. */ }
  }

  private persistDraft() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({ draft: this.draft, previous: this.previous, baseline: this.baseline }));
      this.localStorageFailed = false;
    } catch { this.localStorageFailed = true; }
  }

  private remember(before = this.draft) {
    this.undoStack.push(copy(before));
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
  }

  private changed(immediate = true) {
    this.persistDraft();
    if (immediate) {
      window.clearTimeout(this.validationTimer); this.validationTimer = undefined; this.validate();
    } else if (this.validationTimer === undefined) {
      // Keep moving the points smoothly while recomputing the automatic floors
      // regularly, even when a pointer gesture has not ended yet.
      this.validationTimer = window.setTimeout(() => {
        this.validationTimer = undefined; this.validate(); this.renderDrawing(); this.renderFeedback(); this.renderToolbar();
      }, 140);
    }
    this.renderDrawing(); this.renderFeedback(); this.renderToolbar();
  }

  private validate() { this.validation = validateCustomTrackDraft(this.draft); }

  private async refreshLibrary() {
    const request = ++this.libraryRequest;
    this.loading = true; this.libraryError = ''; this.renderLibrary();
    try {
      const records = await this.options.list();
      if (request !== this.libraryRequest) return;
      this.records = records;
      if (this.previous && !records.some(record => record.id === this.previous!.id)) {
        this.detachDeletedDraft(this.previous.id);
        this.notice = 'Ce circuit a été retiré de la bibliothèque. Votre dessin reste un brouillon privé.'; this.noticeKind = 'info'; this.renderFeedback();
      }
    }
    catch (error) { if (request === this.libraryRequest) this.libraryError = error instanceof Error ? error.message : 'La bibliothèque est indisponible. Votre brouillon reste ici.'; }
    finally { if (request === this.libraryRequest) { this.loading = false; this.renderLibrary(); } }
  }

  private canDelete(record: StoredCustomTrack): boolean {
    return !!this.options.remove && !!this.options.getPlayerId?.()
      && (record.authorId === this.options.getPlayerId() || this.options.canModerateTracks?.() === true);
  }

  private detachDeletedDraft(id: string) {
    if (this.previous?.id !== id) return;
    this.previous = undefined; this.baseline = ''; this.persistDraft();
  }

  private cancelConfirmation() {
    const deletedId = this.deletion?.record.id;
    this.pending = undefined; this.deletion = undefined; this.renderConfirmation();
    if (this.confirmationFocus?.isConnected) this.confirmationFocus.focus({ preventScroll: true });
    else if (deletedId && this.dialog.querySelector<HTMLButtonElement>(`[data-action="delete-track"][data-id="${CSS.escape(deletedId)}"]`))
      this.dialog.querySelector<HTMLButtonElement>(`[data-action="delete-track"][data-id="${CSS.escape(deletedId)}"]`)!.focus({ preventScroll: true });
    else this.dialog.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.focus({ preventScroll: true });
    this.confirmationFocus = undefined;
  }

  private async deleteTrack() {
    const deletion = this.deletion;
    if (this.busy || !deletion || !this.canDelete(deletion.record)) return;
    this.busy = true; deletion.error = undefined; this.renderToolbar(); this.renderLibrary(); this.renderConfirmation();
    try {
      await this.options.remove!({ id: deletion.record.id, revision: deletion.record.revision });
      // Discard an older library request that may still contain the deleted track.
      ++this.libraryRequest; this.loading = false;
      this.records = this.records.filter(record => record.id !== deletion.record.id);
      this.detachDeletedDraft(deletion.record.id); this.options.onDeleted?.(deletion.record.id);
      this.deletion = undefined; this.confirmationFocus = undefined; this.libraryError = '';
      this.notice = `« ${deletion.record.draft.name} » a été supprimé des circuits partagés. Votre brouillon est conservé.`; this.noticeKind = 'success';
    } catch (error) {
      deletion.error = error instanceof Error ? error.message : 'Suppression impossible. Votre circuit et votre brouillon sont conservés.';
    } finally {
      this.busy = false; this.renderToolbar(); this.renderLibrary(); this.renderFeedback(); this.renderConfirmation();
      if (!this.deletion) this.dialog.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.focus({ preventScroll: true });
    }
  }

  private async save() {
    if (this.busy) return;
    this.validate(); this.renderFeedback();
    if (!this.validation.ok) {
      this.dialog.querySelector<HTMLElement>('#editor-validation')?.focus(); return;
    }
    this.busy = true; this.notice = 'Publication du circuit pour la classe…'; this.noticeKind = 'info'; this.renderFeedback(); this.renderToolbar(); this.renderLibrary();
    try {
      const existing = !this.dirty && this.previous ? this.records.find(record => record.id === this.previous!.id && record.revision === this.previous!.revision) : undefined;
      const record = existing ?? await this.options.save(copy(this.draft), this.previous ? { ...this.previous } : undefined);
      this.previous = { id: record.id, revision: record.revision }; this.draft = copy(record.draft);
      this.baseline = JSON.stringify(this.draft); this.persistDraft(); this.options.onSaved(record);
      this.records = [record, ...this.records.filter(item => item.id !== record.id)];
      this.notice = 'Circuit publié ! Il est disponible dans les circuits de la classe.'; this.noticeKind = 'success';
    } catch (error) {
      if (this.previous && typeof error === 'object' && error !== null && 'status' in error && error.status === 404) {
        this.detachDeletedDraft(this.previous.id);
        this.notice = 'Ce circuit a été supprimé de la bibliothèque. Votre dessin reste ici ; publiez-le à nouveau pour créer un nouveau circuit.';
        this.noticeKind = 'error';
        return;
      }
      this.notice = error instanceof Error ? error.message : 'Publication impossible. Votre brouillon reste ouvert : réessayez dans un instant.';
      this.noticeKind = 'error';
    } finally { this.busy = false; this.validate(); this.renderFeedback(); this.renderToolbar(); this.renderLibrary(); }
  }

  private async tryDraft(selection?:TrackWorkshopSelection){
    if(this.busy)return;this.validate();this.renderFeedback();
    if(!this.validation.ok){this.dialog.querySelector<HTMLElement>('#editor-validation')?.focus();return;}
    this.busy=true;this.persistDraft();this.notice='Ouverture d’un essai privé…';this.noticeKind='info';this.renderToolbar();
    this.finishClose();
    try{await this.options.onTry(copy(this.draft),selection);this.persistDraft();this.notice='Brouillon gardé ici. L’essai n’a rien publié.';this.noticeKind='info';}
    catch(error){this.dialog.showModal();this.notice=`L’essai n’a pas démarré. ${error instanceof Error?error.message:'Réessayez.'}`;this.noticeKind='error';}
    finally{this.busy=false;this.renderFeedback();this.renderToolbar();this.renderLibrary();}
  }

  private confirmReplace(action: () => void) {
    if (!this.dirty) { action(); return; }
    this.pending = { text: 'Vous avez un brouillon local non publié. En ouvrant un autre circuit, vous remplacerez ce brouillon.', close: false, proceed: action };
    this.renderConfirmation();
  }

  private load(draft: CustomTrackDraft, record?: StoredCustomTrack) {
    this.draft = copy(draft); this.previous = record ? { id: record.id, revision: record.revision } : undefined;
    if (!record) this.draft.name = draft.name;
    this.baseline = record ? JSON.stringify(draft) : '';
    this.selected = 0; this.selectedModule=undefined; this.mode = 'move'; this.undoStack = []; this.redoStack = [];
    this.notice = record ? 'Circuit ouvert. Vos modifications restent privées jusqu’à la publication.' : 'Brouillon privé : créez et essayez avant de publier pour la classe.';
    this.noticeKind = 'info'; this.persistDraft(); this.validate(); this.fit(); this.render();
  }

  private click(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!target || this.busy) return;
    const action = target.dataset.action;
    if (action === 'close') this.close();
    if (action === 'save') void this.save();
    if (action === 'try') void this.tryDraft();
    if (action === 'try-feature') void this.tryDraft({group:target.dataset.group as TrackWorkshopSelection['group'],index:Number(target.dataset.index)});
    if(action==='module-settings')this.showModuleSettings();
    if (action === 'refresh') void this.refreshLibrary();
    if (action === 'mode') { this.mode = target.dataset.mode as EditorMode; this.renderToolbar(); }
    if (action === 'fit') { this.fit(); this.renderDrawing(); }
    if (action === 'zoom') {
      const factor = target.dataset.direction === 'in' ? .8 : 1.25;
      const width = Math.max(20, Math.min(CUSTOM_TRACK_LIMITS.coordinate * 2.5, this.view.width * factor));
      const height = this.view.height * width / this.view.width;
      this.view = { x: this.view.x + (this.view.width - width) / 2, z: this.view.z + (this.view.height - height) / 2, width, height };
      this.renderDrawing();
    }
    if (action === 'undo' || action === 'redo') {
      const from = action === 'undo' ? this.undoStack : this.redoStack;
      const to = action === 'undo' ? this.redoStack : this.undoStack;
      const next = from.pop();
      if (next) { to.push(copy(this.draft)); this.draft = next; this.selected = Math.min(this.selected, this.draft.anchors.length - 1); this.changed(); this.renderFields(); this.renderZones(); this.renderFeatures(); }
    }
    if (action === 'delete-point' && this.draft.anchors.length > CUSTOM_TRACK_LIMITS.minAnchors) {
      this.remember(); this.draft.anchors.splice(this.selected, 1); this.selected = Math.max(0, this.selected - 1); this.changed();
    }
    if (action === 'start' && this.selected !== 0) {
      this.remember(); this.draft.anchors = [...this.draft.anchors.slice(this.selected), ...this.draft.anchors.slice(0, this.selected)]; this.selected = 0;
      this.notice = 'Départ déplacé. L’ordre des ponts automatiques, les zones, les reliefs et les événements se recalculent depuis ce départ.'; this.noticeKind = 'info'; this.changed();
    }
    if (action === 'new') {
      const template = CUSTOM_TRACK_TEMPLATES.find(item => item.id === this.dialog.querySelector<HTMLSelectElement>('#editor-template')?.value) ?? CUSTOM_TRACK_TEMPLATES[0]!;
      this.confirmReplace(() => this.load(template.draft));
    }
    if (action === 'open' || action === 'copy') {
      const record = this.records.find(item => item.id === target.dataset.id);
      const owned = record?.authorId === this.options.getPlayerId?.();
      if (record) this.confirmReplace(() => this.load(action === 'copy' || !owned ? { ...record.draft, name: `${record.draft.name.slice(0, 35)} — copie` } : record.draft, action === 'open' && owned ? record : undefined));
    }
    if (action === 'delete-track') {
      const record = this.records.find(item => item.id === target.dataset.id);
      if (record && this.canDelete(record)) {
        this.confirmationFocus = target; this.deletion = { record }; this.renderConfirmation();
      }
    }
    if (action === 'delete-cancel') this.cancelConfirmation();
    if (action === 'delete-confirm') void this.deleteTrack();
    if (action === 'add-zone' && this.draft.zones.length < CUSTOM_TRACK_LIMITS.maxZones) {
      let start = .25;
      for (let candidate = .08; candidate <= .88; candidate += .06) {
        if (!this.draft.zones.some(zone => candidate < zone.end + .015 && candidate + .04 > zone.start - .015)) { start = Math.round(candidate * 100) / 100; break; }
      }
      this.remember(); this.draft.zones.push({ kind: 'boost', start, end: start + .04, offset: 0, width: Math.min(8, this.draft.width) }); this.changed(); this.renderZones();
      this.dialog.querySelector<HTMLElement>(`.editor-zone:last-child select`)?.focus();
    }
    if (action === 'remove-zone') {
      this.remember(); this.draft.zones.splice(Number(target.dataset.zone), 1); this.changed(); this.renderZones();
    }
    if (action === 'add-feature') {
      const kind = target.dataset.kind;
      if (kind === 'bridge' || kind === 'jump') {
        if ((this.draft.elevations?.length ?? 0) >= CUSTOM_TRACK_LIMITS.maxElevations) return;
        this.remember();
        const start = Math.min(.8, (kind === 'bridge' ? .1 : .4) + (this.draft.elevations?.filter(item => item.kind === kind).length ?? 0) * .16);
        (this.draft.elevations ??= []).push(kind === 'bridge' ? { kind, start, end: start + .14, height: 7, approach: 25 } : { kind, start, end: start + .02, height: 2, approach: 0, launchSpeed: 7 });
      } else if (kind === 'event') {
        if ((this.draft.events?.length ?? 0) >= CUSTOM_TRACK_LIMITS.maxEvents) return;
        this.remember(); (this.draft.events ??= []).push({ lap: Math.min(2, this.draft.lapCount ?? 3), kind: 'rain', start: .5, end: .6 });
      } else if (kind === 'switch-boost' || kind === 'switch-jump') {
        if ((this.draft.interactions?.length??0)>=CUSTOM_TRACK_LIMITS.maxInteractions) return;
        this.remember(); const jump=kind==='switch-jump';
        (this.draft.interactions??=[]).push({kind:jump?'jump':'boost',trigger:.27,start:.33,end:jump ? .35 : .38,duration:10,offset:0,width:Math.min(8,this.draft.width),...(jump?{height:2,launchSpeed:9}:{})});
      } else return;
      this.changed(); this.renderFeatures();
    }
    if (action === 'remove-feature') {
      const group = target.dataset.group as FeatureGroup;
      if (!['elevations', 'events', 'interactions'].includes(group) || !this.draft[group]?.[Number(target.dataset.index)]) return;
      this.remember(); this.draft[group]!.splice(Number(target.dataset.index), 1); this.changed(); this.renderFeatures();
    }
    if (action === 'pending-cancel') this.cancelConfirmation();
    if (action === 'pending-confirm') { const next = this.pending; this.pending = undefined; this.renderConfirmation(); next?.proceed(); }
    if (action === 'pending-save') {
      const next = this.pending; this.pending = undefined; this.renderConfirmation();
      void this.save().then(() => { if (!this.dirty) next?.proceed(); });
    }
  }

  private input(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || this.busy) return;
    if (target.id === 'editor-name') {
      if (!target.dataset.history) { this.remember(); target.dataset.history = 'true'; }
      this.draft.name = target.value; this.changed(false);
    }
    if (target.id === 'editor-width') {
      if (!target.dataset.history) { this.remember(); target.dataset.history = 'true'; }
      this.draft.width = Number(target.value);
      for (const zone of this.draft.zones) { zone.width = Math.min(zone.width, this.draft.width); zone.offset = Math.max(-(this.draft.width - zone.width) / 2, Math.min((this.draft.width - zone.width) / 2, zone.offset)); }
      for (const module of this.draft.interactions??[]) {module.width=Math.min(module.width,this.draft.width);module.offset=Math.max(-(this.draft.width-module.width)/2,Math.min((this.draft.width-module.width)/2,module.offset));}
      this.changed(false);
      const output = this.dialog.querySelector<HTMLOutputElement>('#editor-width-value'); if (output) output.value = `${this.draft.width} m`;
    }
  }

  private change(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement || target instanceof HTMLInputElement) || this.busy) return;
    if (target.id === 'editor-name' || target.id === 'editor-width') { delete target.dataset.history; this.changed(); if (target.id === 'editor-width') { this.renderZones(); this.renderFeatures(); } }
    if (target.id === 'editor-theme') { this.remember(); this.draft.theme = target.value as CustomTrackDraft['theme']; this.changed(); }
    if (target.id === 'editor-laps') {
      this.remember(); this.draft.lapCount = Math.max(1, Math.min(CUSTOM_TRACK_LIMITS.maxLaps, Math.round(Number(target.value)) || 1));
      target.value = String(this.draft.lapCount); this.changed();
      for (const input of this.dialog.querySelectorAll<HTMLInputElement>('[data-group="events"][data-feature-field="lap"]')) input.max = String(this.draft.lapCount);
    }
    if (target.dataset.group && target.dataset.featureField) {
      const group = target.dataset.group as FeatureGroup; const field = target.dataset.featureField;
      if (!['elevations', 'events', 'interactions'].includes(group)) return;
      const index = Number(target.dataset.index); const feature = this.draft[group]?.[index]; if (!feature) return;
      this.remember();
      if (field === 'start') {
        const duration = feature.end - feature.start; feature.start = Math.max(0, Math.min(1-duration, Number(target.value) / 100)); feature.end = feature.start + duration;
      } else if (field === 'duration') feature.end = Math.min(1, feature.start + Math.max(.001, Number(target.value) / 100));
      else if (group === 'events' && field === 'kind') this.draft.events![index]!.kind = target.value as NonNullable<CustomTrackDraft['events']>[number]['kind'];
      else if (group === 'events' && field === 'lap') this.draft.events![index]!.lap = Math.round(Number(target.value));

      else if (group === 'elevations' && ['height', 'approach', 'launchSpeed'].includes(field)) Object.assign(feature, { [field]: Number(target.value) });
      else if (group === 'interactions') {
        const module=this.draft.interactions![index]!;
        if (field==='trigger') module.trigger=Math.max(0,Math.min(.999,Number(target.value)/100));
        else if (field==='activeSeconds') module.duration=Number(target.value);
        else if (['width','offset','height','launchSpeed'].includes(field)) Object.assign(module,{[field]:Number(target.value)});
      }
      this.changed();
      for (const [name, value] of [['start', feature.start * 100], ['duration', (feature.end - feature.start) * 100]] as const) {
        const input = this.dialog.querySelector<HTMLInputElement>(`[data-group="${group}"][data-index="${index}"][data-feature-field="${name}"]`); if (input) input.value = String(Math.round(value * 10) / 10);
      }
    }
    if (target.dataset.zone !== undefined && target.dataset.field) {
      const index = Number(target.dataset.zone); const zone = this.draft.zones[index]; if (!zone) return;
      this.remember();
      if (target.dataset.field === 'kind') zone.kind = target.value as typeof zone.kind;
      if (target.dataset.field === 'start') {
        const duration = zone.end - zone.start; zone.start = Math.max(0, Math.min(1-duration, Number(target.value) / 100)); zone.end = zone.start + duration;
      }
      if (target.dataset.field === 'duration') zone.end = Math.min(1, zone.start + Math.max(.001, Math.min(1, Number(target.value) / 100)));
      if (target.dataset.field === 'lane') {
        zone.width = Math.min(8, this.draft.width * .6);
        zone.offset = Number(target.value) * (this.draft.width - zone.width) / 2;
        if (target.value === 'full') { zone.offset = 0; zone.width = this.draft.width; }
      }
      this.changed();
      const position = this.dialog.querySelector<HTMLInputElement>(`[data-zone="${index}"][data-field="start"]`);
      const duration = this.dialog.querySelector<HTMLInputElement>(`[data-zone="${index}"][data-field="duration"]`);
      if (position) position.value = String(Math.round(zone.start * 1000) / 10);
      if (duration) duration.value = String(Math.round((zone.end - zone.start) * 1000) / 10);
    }
  }

  private keydown(event: KeyboardEvent) {
    if (this.pending || this.deletion) {
      if (event.key === 'Escape') { event.preventDefault(); if (!this.busy) this.cancelConfirmation(); return; }
      if (event.key === 'Tab') {
        const buttons = [...this.dialog.querySelectorAll<HTMLButtonElement>('.editor-confirm button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        event.preventDefault(); buttons[next]?.focus();
      }
      return;
    }
    if (this.busy) return;
    const editing = event.target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName);
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); this.persistDraft(); this.notice='Brouillon gardé sur cet appareil.'; this.noticeKind='success'; this.renderFeedback(); }
    if (editing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); this.dialog.querySelector<HTMLButtonElement>(event.shiftKey ? '#editor-redo' : '#editor-undo')?.click();
    }
    const moduleTarget=event.target instanceof Element?event.target.closest<SVGElement>('[data-module-group]'):null;
    if(moduleTarget){
      const selection=this.moduleSelection(moduleTarget);if(!selection)return;this.selectedModule=selection;
      if(event.key==='Enter'||event.key===' '){event.preventDefault();this.showModuleSettings();return;}
      const step=event.shiftKey ? .001 : .005,direction=['ArrowRight','ArrowUp'].includes(event.key)?1:['ArrowLeft','ArrowDown'].includes(event.key)?-1:0;
      const feature=customTrackModule(this.draft,selection);if(!direction||!feature)return;
      event.preventDefault();const before=copy(this.draft),at=selection.handle==='trigger'&&'trigger'in feature?feature.trigger:feature.start;
      if(moveCustomTrackModule(this.draft,selection,at+direction*step)){this.remember(before);this.changed();this.renderZones();this.renderFeatures();}
      this.focusModule(selection);return;
    }
    const point = event.target instanceof Element ? event.target.closest<SVGElement>('[data-point]') : null;
    if (!point) return;
    this.selected = Number(point.dataset.point);
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); this.dialog.querySelector<HTMLButtonElement>('#editor-delete-point')?.click(); }
    const directions: Record<string, Vec2> = { ArrowUp: { x: 0, z: -1 }, ArrowDown: { x: 0, z: 1 }, ArrowLeft: { x: -1, z: 0 }, ArrowRight: { x: 1, z: 0 } };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault(); this.selected = Number(point.dataset.point); this.remember();
    const anchor = this.draft.anchors[this.selected]!; const step = event.shiftKey ? 1 : 5;
    anchor.x = Math.max(-CUSTOM_TRACK_LIMITS.coordinate, Math.min(CUSTOM_TRACK_LIMITS.coordinate, anchor.x + direction.x * step)); anchor.z = Math.max(-CUSTOM_TRACK_LIMITS.coordinate, Math.min(CUSTOM_TRACK_LIMITS.coordinate, anchor.z + direction.z * step));
    this.changed(); this.dialog.querySelector<SVGElement>(`[data-point="${this.selected}"]`)?.focus();
  }

  private moduleSelection(target:SVGElement):TrackModuleSelection|undefined {
    const selection={group:target.dataset.moduleGroup as TrackWorkshopSelection['group'],index:Number(target.dataset.moduleIndex),handle:target.dataset.moduleHandle==='trigger'?'trigger':'target'} as TrackModuleSelection;
    return ['zones','elevations','events','interactions'].includes(selection.group)&&customTrackModule(this.draft,selection)?selection:undefined;
  }
  private focusModule(selection:TrackModuleSelection){
    this.dialog.querySelector<SVGElement>(`[data-module-group="${selection.group}"][data-module-index="${selection.index}"][data-module-handle="${selection.handle??'target'}"]`)?.focus({preventScroll:true});
  }
  private showModuleSettings(){
    const selected=this.selectedModule;if(!selected)return;
    const card=this.dialog.querySelector<HTMLElement>(selected.group==='zones'?`[data-zone-card="${selected.index}"]`:`[data-feature-card="${selected.group}-${selected.index}"]`);if(!card)return;
    const details=card.closest('details');if(details)details.open=true;
    this.dialog.querySelectorAll('.editor-selected-feature').forEach(node=>node.classList.remove('editor-selected-feature'));card.classList.add('editor-selected-feature');
    card.scrollIntoView({block:'nearest'});card.querySelector<HTMLElement>('input,select')?.focus({preventScroll:true});
  }

  private worldPoint(event: PointerEvent): Vec2 | undefined {
    const svg = this.dialog.querySelector<SVGSVGElement>('#editor-canvas'); const matrix = svg?.getScreenCTM(); if (!svg || !matrix) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: Math.round(Math.max(-CUSTOM_TRACK_LIMITS.coordinate, Math.min(CUSTOM_TRACK_LIMITS.coordinate, point.x)) * 2) / 2, z: Math.round(Math.max(-CUSTOM_TRACK_LIMITS.coordinate, Math.min(CUSTOM_TRACK_LIMITS.coordinate, point.y)) * 2) / 2 };
  }

  private pointerDown(event: PointerEvent) {
    if (this.busy || this.pending || event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null; const svg = target?.closest<SVGSVGElement>('#editor-canvas'); if (!svg) return;
    const point = target?.closest<SVGElement>('[data-point]'); const world = this.worldPoint(event); if (!world) return;
    const moduleTarget=target?.closest<SVGElement>('[data-module-group]'),selection=moduleTarget?this.moduleSelection(moduleTarget):undefined;
    if(selection){
      const feature=customTrackModule(this.draft,selection)!;
      const at=selection.handle==='trigger'&&'trigger'in feature?feature.trigger:feature.start,projection=projectCustomTrackPoint(this.draft,world,at);if(!projection)return;
      this.selectedModule=selection;this.mode='move';
      this.drag={pointer:event.pointerId,index:0,before:copy(this.draft),moved:false,module:selection,grabFraction:projection.fraction,grabOffset:projection.offset,initialFraction:at,initialOffset:'offset'in feature?feature.offset:0};
      svg.setPointerCapture(event.pointerId);event.preventDefault();this.renderDrawing();this.renderToolbar();this.focusModule(selection);
    }else if (point) {
      this.selectedModule=undefined;
      this.selected = Number(point.dataset.point); this.mode = 'move';
      this.drag = { pointer: event.pointerId, index: this.selected, before: copy(this.draft), moved: false };
      svg.setPointerCapture(event.pointerId); event.preventDefault(); this.renderDrawing(); this.renderToolbar();
      this.dialog.querySelector<SVGElement>(`[data-point="${this.selected}"]`)?.focus();
    } else if (this.mode === 'add') {
      if (this.draft.anchors.length >= CUSTOM_TRACK_LIMITS.maxAnchors) { this.notice = `Votre circuit atteint la capacité de ${CUSTOM_TRACK_LIMITS.maxAnchors} points. Déplacez les points existants pour affiner son tracé.`; this.noticeKind = 'info'; this.renderFeedback(); return; }
      const points = sampleCustomTrackAnchors(this.draft.anchors);
      let nearest = 0; let distance = Infinity;
      points.forEach((sample, index) => { const next = Math.hypot(sample.x - world.x, sample.z - world.z); if (next < distance) { distance = next; nearest = index; } });
      const index = Math.min(this.draft.anchors.length, Math.floor(nearest / (points.length / this.draft.anchors.length)) + 1);
      this.remember(); this.draft.anchors.splice(index, 0, world); this.selected = index; this.mode = 'move'; this.changed();
      this.notice = 'Point ajouté. Faites-le glisser pour ajuster la courbe.'; this.noticeKind = 'info'; this.renderFeedback();
    }
  }

  private pointerMove(event: PointerEvent) {
    if (!this.drag || this.drag.pointer !== event.pointerId) return;
    const point = this.worldPoint(event); if (!point) return;
    if(this.drag.module){
      const projection=projectCustomTrackPoint(this.draft,point,this.drag.initialFraction);if(!projection)return;
      let delta=projection.fraction-this.drag.grabFraction!;if(delta>.5)delta-=1;if(delta<-.5)delta+=1;
      if(moveCustomTrackModule(this.draft,this.drag.module,this.drag.initialFraction!+delta,this.drag.initialOffset!+projection.offset-this.drag.grabOffset!)){
        this.drag.moved=true;this.changed(false);
      }event.preventDefault();return;
    }
    const previous = this.draft.anchors[this.drag.index]!;
    if (previous.x === point.x && previous.z === point.z) return;
    this.draft.anchors[this.drag.index] = point; this.drag.moved = true; this.changed(false); event.preventDefault();
  }

  private pointerEnd(event: PointerEvent) {
    if (!this.drag || this.drag.pointer !== event.pointerId) return;
    const selection=this.drag.module,moved=this.drag.moved;
    if(event.type==='pointercancel')this.draft=this.drag.before;
    else if (this.drag.moved) this.remember(this.drag.before);
    const svg = this.dialog.querySelector<SVGSVGElement>('#editor-canvas');
    if (svg?.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    this.drag = undefined; this.changed();
    if(selection){this.renderZones();this.renderFeatures();this.focusModule(selection);if(!moved&&event.type!=='pointercancel')this.showModuleSettings();}
    else this.dialog.querySelector<SVGElement>(`[data-point="${this.selected}"]`)?.focus();
  }

  private fit() {
    const points = sampleCustomTrackAnchors(this.draft.anchors); const margin = this.draft.width + 28;
    const minX = Math.min(...points.map(point => point.x)) - margin; const maxX = Math.max(...points.map(point => point.x)) + margin;
    const minZ = Math.min(...points.map(point => point.z)) - margin; const maxZ = Math.max(...points.map(point => point.z)) + margin;
    this.view = { x: minX, z: minZ, width: maxX - minX, height: maxZ - minZ };
  }

  private render() {
    this.dialog.innerHTML = `<header class="editor-header"><div><span class="editor-eyebrow">ATELIER DES CIRCUITS</span><h2 id="track-editor-title">Votre prochaine piste</h2><p>Créez et essayez en privé. Publiez quand votre circuit est prêt.</p></div><button type="button" data-action="close" id="editor-close" class="editor-button" aria-label="Fermer l’éditeur">Fermer ✕</button></header>
      <div class="editor-layout"><section class="editor-workspace" aria-label="Dessin du circuit"><div class="editor-tools" id="editor-toolbar"></div>
      <p class="editor-canvas-hint" id="editor-canvas-hint"></p><div class="editor-canvas-frame"><svg id="editor-canvas" role="group" aria-label="Plan du circuit. Faites glisser les points pour modifier la route. Les ponts dorés passent au-dessus des portions en pointillés." xmlns="http://www.w3.org/2000/svg"></svg></div><div class="editor-feature-legend"><span class="editor-legend-crossing">Pont auto · N = niveau</span><span class="editor-legend-tunnel">Tunnel dessous</span><span class="editor-legend-relief">Pont / tremplin</span><span class="editor-legend-event">Événement · T = tour</span><span class="editor-legend-interaction">Plaque / cible · I</span><span class="editor-legend-zone">Zone · Z</span></div>
      <div id="editor-crossings" class="editor-crossings" aria-live="polite"></div>
      <div id="editor-module-selection" class="editor-module-selection" hidden></div><div class="editor-point-tools"><span id="editor-selection"></span><button type="button" data-action="start" id="editor-set-start" class="editor-button">Départ ici</button><button type="button" data-action="delete-point" id="editor-delete-point" class="editor-button">Supprimer le point</button></div>
      <div class="editor-route-stats" id="editor-route-stats"></div><div id="editor-validation" class="editor-validation" tabindex="-1" aria-live="polite"></div>
      <details class="editor-help"><summary>Comment créer un circuit agréable ?</summary><ol><li>Partez d’un modèle, puis faites glisser les points blancs. Virages serrés, points collés et croisements sont autorisés.</li><li>Quand deux portions se croisent, celle parcourue le plus tard depuis le départ monte automatiquement sur un pont. Le passage dessous reste ouvert en tunnel. D’autres croisements peuvent créer des niveaux supplémentaires.</li><li>Les repères dorés montrent le niveau du pont : N1 au-dessus du sol, N2 au-dessus de N1. Déplacez les points pour ajuster les passages ; ponts et tunnels se recalculent.</li><li>Pour allonger la route, choisissez « Ajouter un point » puis touchez le tracé.</li><li>Le drapeau marque le départ. Sélectionnez un point puis « Départ ici » pour le déplacer. Cela peut changer l’ordre des ponts.</li><li>Les zones turbo, glace ou boue sont facultatives. Le pourcentage indique leur position dans le tour.</li><li>Le brouillon reste sur cet appareil. « Essayer en privé » ouvre un atelier sans publication ; « Publier pour la classe » partage le circuit.</li></ol><p>Clavier : tabulation pour choisir un point, flèches pour le déplacer, Maj pour affiner. Touchez un module pour ses réglages, glissez-le pour le déplacer. Flèches sur un module : avancer/reculer ; Maj affine. Ctrl/Cmd + Z annule, Ctrl/Cmd + S garde le brouillon local.</p></details></section>
      <aside class="editor-settings"><section class="editor-card"><h3>1. Donnez-lui un style</h3><div id="editor-fields"></div></section>
      <section class="editor-card"><div class="editor-section-heading"><h3>2. Pimentez le tour</h3><button type="button" class="editor-button" data-action="add-zone" id="editor-add-zone">+ Zone</button></div><p class="editor-muted">Facultatif : des bandes colorées sur la route. En cas de superposition, la première zone de la liste agit.</p><div id="editor-zones"></div></section>
      <details class="editor-card editor-feature-section" id="editor-race-options" open><summary>3. Durée de la course</summary><div id="editor-lap-fields"></div></details>
      <details class="editor-card editor-feature-section" id="editor-relief-options"><summary>4. Ponts et sauts</summary><p class="editor-muted">Placez un module sur une portion du tour. Position et longueur sont mesurées depuis le départ. Les marques orange repèrent leur emplacement. L’essai montre leur forme en 3D.</p><div class="editor-module-actions"><button type="button" class="editor-button" data-action="add-feature" data-kind="bridge" id="editor-add-bridge">+ Pont</button><button type="button" class="editor-button" data-action="add-feature" data-kind="jump" id="editor-add-jump">+ Tremplin</button></div><div id="editor-elevations"></div><p class="editor-muted editor-feature-note">Un pont monte puis redescend. Un tremplin fait décoller le kart. Essayez pour ajuster vitesse et réception. En cas de superposition, le premier relief de la liste s’applique.</p></details>
      <details class="editor-card editor-feature-section" id="editor-interaction-options"><summary>5. Interrupteurs et effets partagés</summary><p class="editor-muted">Roulez sur une plaque pour annoncer un effet à tous les pilotes. Après une seconde, sa cible s’active temporairement. La route reste toujours praticable.</p><div class="editor-module-actions"><button type="button" class="editor-button" data-action="add-feature" data-kind="switch-boost" id="editor-add-switch-boost">+ Plaque → turbo</button><button type="button" class="editor-button" data-action="add-feature" data-kind="switch-jump" id="editor-add-switch-jump">+ Plaque → tremplin</button></div><div id="editor-interactions"></div><p class="editor-muted">Le tremplin garde sa forme : seule son impulsion s’active. Laissez assez de distance après la plaque pour l’annonce. Deux secondes de repos suivent l’effet ; les passages pendant l’activation ne prolongent pas sa durée.</p></details>
      <details class="editor-card editor-feature-section" id="editor-event-options"><summary>6. Événements par tour</summary><p class="editor-muted">L’événement commence quand le pilote en tête atteint le tour choisi et dure ce tour, pour tous les joueurs. La météo concerne le circuit ; la zone choisie reçoit son effet sur la route.</p><button type="button" class="editor-button" data-action="add-feature" data-kind="event" id="editor-add-event">+ Événement</button><div id="editor-events"></div><p class="editor-muted editor-feature-note">Pluie, cendres et tempête : une bande boueuse. Neige : verglas. Éclaircie : météo calme sans bande. Turbo, glace et boue : une bande temporaire. En cas de superposition, la première bande de la liste agit. Si plusieurs météos arrivent au même tour, la dernière de la liste est retenue.</p></details>
      <details class="editor-card editor-library" open><summary>Vos circuits et ceux de la classe</summary><div class="editor-new"><label for="editor-template">Partir d’un modèle</label><select id="editor-template">${CUSTOM_TRACK_TEMPLATES.map(template => `<option value="${escape(template.id)}">${escape(template.name)}</option>`).join('')}</select><button type="button" class="editor-button" data-action="new" id="editor-new">Nouveau circuit</button></div><div id="editor-library"></div></details></aside></div>
      <footer class="editor-footer"><div><strong id="editor-save-state"></strong><p id="editor-status" role="status"></p></div><div class="editor-footer-actions"><button type="button" class="editor-button" data-action="save" id="editor-save">Publier pour la classe</button><button type="button" class="editor-button editor-primary" data-action="try" id="editor-try">Essayer en privé →</button></div></footer><div id="editor-confirmation"></div>`;
    this.renderFields(); this.renderZones(); this.renderFeatures(); this.renderToolbar(); this.renderDrawing(); this.renderFeedback(); this.renderLibrary();
  }

  private renderFields() {
    const target = this.dialog.querySelector('#editor-fields'); if (!target) return;
    target.innerHTML = `<label class="editor-field" for="editor-name">Nom du circuit<input id="editor-name" maxlength="48" autocomplete="off" value="${escape(this.draft.name)}" placeholder="Ex. La grande boucle de la classe"></label><label class="editor-field" for="editor-theme">Ambiance<select id="editor-theme">${CUSTOM_TRACK_THEMES.map(theme => `<option value="${theme.id}" ${theme.id === this.draft.theme ? 'selected' : ''}>${escape(theme.label)}</option>`).join('')}</select></label><label class="editor-field" for="editor-width"><span>Largeur de la route <output id="editor-width-value" for="editor-width">${this.draft.width} m</output></span><input type="range" id="editor-width" min="${CUSTOM_TRACK_LIMITS.minWidth}" max="${CUSTOM_TRACK_LIMITS.maxWidth}" step="1" value="${this.draft.width}"><small>Une route large facilite les dépassements.</small></label>`;
  }

  private renderToolbar() {
    const target = this.dialog.querySelector('#editor-toolbar'); if (!target) return;
    if (!target.childElementCount) target.innerHTML = `<div class="editor-tool-group"><button type="button" id="editor-mode-move" class="editor-button ${this.mode === 'move' ? 'is-active' : ''}" data-action="mode" data-mode="move" aria-pressed="${this.mode === 'move'}">↔ Déplacer</button><button type="button" id="editor-mode-add" class="editor-button ${this.mode === 'add' ? 'is-active' : ''}" data-action="mode" data-mode="add" aria-pressed="${this.mode === 'add'}" ${this.draft.anchors.length >= CUSTOM_TRACK_LIMITS.maxAnchors ? 'disabled' : ''}>+ Ajouter un point</button></div><div class="editor-tool-group"><button type="button" class="editor-button" data-action="undo" id="editor-undo" ${!this.undoStack.length ? 'disabled' : ''} aria-label="Annuler la dernière modification"><span aria-hidden="true">↶</span><span>Annuler</span></button><button type="button" class="editor-button" data-action="redo" id="editor-redo" ${!this.redoStack.length ? 'disabled' : ''} aria-label="Rétablir la modification"><span aria-hidden="true">↷</span><span>Rétablir</span></button></div><div class="editor-tool-group"><button type="button" class="editor-button editor-square" data-action="zoom" data-direction="in" aria-label="Agrandir le plan">＋</button><button type="button" class="editor-button editor-square" data-action="zoom" data-direction="out" aria-label="Réduire le plan">−</button><button type="button" class="editor-button" data-action="fit" id="editor-fit">Tout voir</button></div>`;
    for (const value of ['move', 'add'] as const) {
      const button = this.dialog.querySelector<HTMLButtonElement>(`#editor-mode-${value}`);
      if (button) { button.classList.toggle('is-active', this.mode === value); button.setAttribute('aria-pressed', String(this.mode === value)); button.disabled = this.busy || (value === 'add' && this.draft.anchors.length >= CUSTOM_TRACK_LIMITS.maxAnchors); }
    }
    const undo = this.dialog.querySelector<HTMLButtonElement>('#editor-undo'); if (undo) undo.disabled = this.busy || !this.undoStack.length;
    const redo = this.dialog.querySelector<HTMLButtonElement>('#editor-redo'); if (redo) redo.disabled = this.busy || !this.redoStack.length;
    const hint = this.dialog.querySelector('#editor-canvas-hint'); if (hint) hint.textContent = this.mode === 'add' ? 'Touchez la route à l’endroit où vous voulez ajouter un point.' : 'Glissez un point blanc ou un module coloré. Touchez un module pour ses réglages.';
    const selection = this.dialog.querySelector('#editor-selection'); if (selection) selection.textContent = `Point ${this.selected + 1} / ${this.draft.anchors.length}${this.selected === 0 ? ' · Départ' : ''}`;
    const start = this.dialog.querySelector<HTMLButtonElement>('#editor-set-start'); if (start) start.disabled = this.selected === 0 || this.busy;
    const remove = this.dialog.querySelector<HTMLButtonElement>('#editor-delete-point'); if (remove) { remove.disabled = this.draft.anchors.length <= CUSTOM_TRACK_LIMITS.minAnchors || this.busy; remove.title = this.draft.anchors.length <= CUSTOM_TRACK_LIMITS.minAnchors ? `Gardez au moins ${CUSTOM_TRACK_LIMITS.minAnchors} points pour définir une boucle.` : ''; }
    for (const id of ['editor-save', 'editor-try']) { const button = this.dialog.querySelector<HTMLButtonElement>(`#${id}`); if (button) button.disabled = this.busy || !this.validation.ok; }
    for (const button of this.dialog.querySelectorAll<HTMLButtonElement>('[data-action="try-feature"]')) button.disabled=this.busy||!this.validation.ok;
    for (const id of ['editor-add-switch-boost','editor-add-switch-jump']) {const button=this.dialog.querySelector<HTMLButtonElement>(`#${id}`);if(button)button.disabled=this.busy||(this.draft.interactions?.length??0)>=CUSTOM_TRACK_LIMITS.maxInteractions;}
    const close = this.dialog.querySelector<HTMLButtonElement>('#editor-close'); if (close) close.disabled = this.busy;
    const zone = this.dialog.querySelector<HTMLButtonElement>('#editor-add-zone'); if (zone) zone.disabled = this.draft.zones.length >= CUSTOM_TRACK_LIMITS.maxZones || this.busy;
    for (const [id, count, limit] of [['editor-add-bridge', this.draft.elevations?.length ?? 0, CUSTOM_TRACK_LIMITS.maxElevations], ['editor-add-jump', this.draft.elevations?.length ?? 0, CUSTOM_TRACK_LIMITS.maxElevations], ['editor-add-event', this.draft.events?.length ?? 0, CUSTOM_TRACK_LIMITS.maxEvents]] as const) {
      const button = this.dialog.querySelector<HTMLButtonElement>(`#${id}`); if (button) button.disabled = this.busy || count >= limit;
    }
    for (const input of this.dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.editor-settings input, .editor-settings select')) input.disabled = this.busy;
    const panel=this.dialog.querySelector<HTMLElement>('#editor-module-selection');
    if(panel){
      const selected=this.selectedModule,feature=selected?customTrackModule(this.draft,selected):undefined;
      panel.hidden=!feature;
      if(selected&&feature){
        const names={track:'Circuit',zones:'Zone',elevations:'Relief',events:'Événement',interactions:selected.handle==='trigger'?'Plaque':'Cible'};
        const at=selected.handle==='trigger'&&'trigger'in feature?feature.trigger:feature.start;
        panel.innerHTML=`<div><strong>${names[selected.group]} ${selected.index+1} · ${Math.round(at*1000)/10} %</strong><small>Glissez sur la route · flèches pour affiner</small></div><button type="button" class="editor-button" data-action="module-settings">Réglages</button><button type="button" class="editor-button" data-action="try-feature" data-group="${selected.group}" data-index="${selected.index}" ${this.busy||!this.validation.ok?'disabled':''}>Essayer en privé</button>`;
      }else this.selectedModule=undefined;
    }
  }

  private renderDrawing() {
    const svg = this.dialog.querySelector<SVGSVGElement>('#editor-canvas'); if (!svg) return;
    const points = sampleCustomTrackAnchors(this.draft.anchors); if (!points.length) return;
    const path = (values: Vec2[], closed = false) => values.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.z.toFixed(2)}`).join(' ') + (closed ? ' Z' : '');
    const route = path(points, true); const [ground, road] = THEME_COLORS[this.draft.theme];
    const lengths = [0]; points.forEach((point, index) => { const next = points[(index + 1) % points.length]!; lengths.push(lengths[index]! + Math.hypot(next.x - point.x, next.z - point.z)); });
    const length = lengths[lengths.length - 1]!;
    const atDistance = (distance: number, offset: number): Vec2 => {
      distance = length > 0 ? ((distance % length) + length) % length : 0;
      const segment = Math.max(0, Math.min(points.length - 1, lengths.findIndex((value, index) => index > 0 && value >= distance) - 1));
      const point = points[segment]!, next = points[(segment + 1) % points.length]!;
      const dx = next.x - point.x, dz = next.z - point.z, norm = Math.hypot(dx, dz) || 1;
      const t = Math.max(0, Math.min(1, (distance - lengths[segment]!) / norm));
      return { x: point.x + dx * t + dz / norm * offset, z: point.z + dz * t - dx / norm * offset };
    };
    const between = (begin: number, end: number, offset = 0): string => {
      if (!(length > 0)) return '';
      const samples = [atDistance(begin, offset)];
      for (let lap = Math.floor(begin / length); lap <= Math.floor(end / length); lap++) {
        for (const distance of lengths.slice(0, -1)) {
          const at = distance + lap * length;
          if (at > begin && at < end) samples.push(atDistance(at, offset));
        }
      }
      samples.push(atDistance(end, offset)); return path(samples);
    };
    const zones = [...this.draft.zones].reverse().map(zone => {
      const start = zone.start * length, end = zone.end * length;
      const subset = [atDistance(start, zone.offset), ...lengths.slice(0, -1)
        .filter(distance => distance > start && distance < end).map(distance => atDistance(distance, zone.offset)), atDistance(end, zone.offset)];
      return `<path d="${path(subset)}" fill="none" stroke="${ZONE_COLORS[zone.kind]}" stroke-width="${zone.width}" opacity=".95"/>`;
    }).join('');

    const start = points[0]!; const next = points[1]!; const angle = Math.atan2(next.z - start.z, next.x - start.x) * 180 / Math.PI;
    svg.setAttribute('viewBox', `${this.view.x} ${this.view.z} ${this.view.width} ${this.view.height}`);
    const scale = 1 / (svg.getScreenCTM()?.a || 1);
    const radius = Math.max(5, 9 * scale); const hitRadius = 22 * scale; const flag = this.draft.width * .5 + 8;
    const crossings = this.validation.track?.crossings ?? [];
    // A dense doodle can produce thousands of contacts. Keep the plan responsive;
    // the compiler and the playable circuit still retain every crossing.
    const detailedCrossings = crossings.slice(0, 48), labelledCrossings = crossings.slice(0, 24);
    // Reuse the shared compiler's crossing order; drawing never guesses a floor.
    // During a drag the length ratio follows the live route between compilations.
    const crossingRatio = length / (this.validation.track?.length || length || 1);
    const crossingPercent = (distance: number) => Math.round(((distance * crossingRatio / (length || 1)) % 1 + 1) % 1 * 100);
    const tunnels = detailedCrossings.map(crossing => `<path data-tunnel="${escape(crossing.id)}" d="${between(crossing.lowerStart * crossingRatio - this.draft.width * .45, crossing.lowerEnd * crossingRatio + this.draft.width * .45)}" fill="none" stroke="#183c49" stroke-width="${2 * scale}" stroke-dasharray="${4 * scale} ${3 * scale}" pointer-events="none"/>`).join('');
    const bridges = detailedCrossings.map((crossing, index) => ({ crossing, index })).sort((a, b) => a.crossing.layer - b.crossing.layer || a.crossing.upperProgress - b.crossing.upperProgress).map(({ crossing, index }) => {
      const begin = crossing.upperStart * crossingRatio, end = crossing.upperEnd * crossingRatio;
      const deck = between(begin, end), approach = Math.min(crossing.approach * crossingRatio, length / 4);
      const upperZones = [...this.draft.zones].reverse().flatMap(zone => [-1, 0, 1].map(lap => {
        const from = Math.max(begin, (zone.start + lap) * length), to = Math.min(end, (zone.end + lap) * length);
        return to > from ? `<path d="${between(from, to, zone.offset)}" fill="none" stroke="${ZONE_COLORS[zone.kind]}" stroke-width="${zone.width}"/>` : '';
      })).join('');
      const label = `Pont ${index + 1}, niveau ${crossing.layer}. Dessus à ${crossingPercent(crossing.upperProgress)} % du tour, tunnel dessous à ${crossingPercent(crossing.lowerProgress)} %. Hauteur libre minimale ${crossing.clearance} mètres.`;
      return `<g data-crossing="${escape(crossing.id)}" data-level="${crossing.layer}" role="img" aria-label="${escape(label)}" pointer-events="none"><title>${escape(label)}</title><path d="${between(begin - approach, end + approach)}" fill="none" stroke="#ffd879" stroke-width="${this.draft.width + 2}" stroke-dasharray="${3 * scale} ${4 * scale}" opacity=".6"/><path d="${deck}" fill="none" stroke="#163c495c" stroke-width="${this.draft.width + 7 * scale}"/><path d="${deck}" fill="none" stroke="#ffe2a0" stroke-width="${this.draft.width + 2.5 * scale}"/><path d="${deck}" fill="none" stroke="${road}" stroke-width="${this.draft.width}"/>${upperZones}<path d="${deck}" fill="none" stroke="#fff5d5" stroke-width="${.9 * scale}" stroke-dasharray="${4 * scale} ${4 * scale}"/></g>`;
    }).join('');
    const crossingBadges = labelledCrossings.map((crossing, index) => {
      const centre = atDistance(crossing.upperProgress * crossingRatio, 0);
      const badge = atDistance(crossing.upperProgress * crossingRatio, this.draft.width / 2 + 15 * scale);
      const text = `P${index + 1} · N${crossing.layer}`, width = (text.length * 5.5 + 12) * scale;
      return `<g data-crossing-badge="${index}" pointer-events="none"><path d="M${centre.x} ${centre.z}L${badge.x} ${badge.z}" stroke="#805421" stroke-width="${scale}"/><rect x="${badge.x - width / 2}" y="${badge.z - 9 * scale}" width="${width}" height="${18 * scale}" rx="${5 * scale}" fill="#ffe2a0" stroke="#805421" stroke-width="${scale}"/><text x="${badge.x}" y="${badge.z + 3 * scale}" text-anchor="middle" fill="#49341d" font-weight="800" font-size="${9 * scale}">${text}</text></g>`;
    }).join('');
    const plates=(this.draft.interactions??[]).map((module,index)=>{
      const a=atDistance(module.trigger*length,module.offset),b=atDistance(module.start*length,module.offset),selected=this.selectedModule?.group==='interactions'&&this.selectedModule.index===index&&this.selectedModule.handle==='trigger';
      return `<path data-interaction-link="${index}" d="M${a.x} ${a.z}L${b.x} ${b.z}" stroke="#218b7a" stroke-width="${1.5*scale}" stroke-dasharray="${4*scale} ${4*scale}" pointer-events="none"/><g class="editor-map-module" data-module-group="interactions" data-module-index="${index}" data-module-handle="trigger" tabindex="0" role="button" aria-label="Plaque ${index+1}. Glissez pour déplacer ; entrée pour les réglages." aria-pressed="${selected}"><circle cx="${a.x}" cy="${a.z}" r="${22*scale}" fill="transparent"/><circle cx="${a.x}" cy="${a.z}" r="${(selected?9:7)*scale}" fill="${selected?'#ffcc6b':'#8ff4d4'}" stroke="#15594e" stroke-width="${2*scale}"/><text x="${a.x}" y="${a.z+3*scale}" text-anchor="middle" font-size="${8*scale}" fill="#15594e" pointer-events="none">${index+1}</text></g>`;
    }).join('');
    const features = [
      ...this.draft.zones.map((feature,index)=>({...feature,group:'zones',index,color:ZONE_COLORS[feature.kind],badge:`Z${index+1}`,label:`Zone ${index+1} : ${ZONE_NAMES[feature.kind]}`})),
      ...(this.draft.elevations ?? []).map((feature, index) => ({ ...feature, group: 'elevations', index, color: '#d77924', badge: `${feature.kind === 'bridge' ? 'P' : 'S'}${index + 1}`, label: `${feature.kind === 'bridge' ? 'Pont' : 'Tremplin'} ${index + 1}, hauteur ${feature.height} m` })),

      ...(this.draft.interactions ?? []).map((feature,index)=>({...feature,group:'interactions',index,color:'#218b7a',badge:`I${index+1}`,label:`Plaque ${index+1} → ${feature.kind==='boost'?'turbo':'tremplin'}`})),
      ...(this.draft.events ?? []).map((feature, index) => ({ ...feature, group: 'events', index, color: '#2f86b0', badge: `T${feature.lap}`, label: `Tour ${feature.lap} : ${CUSTOM_TRACK_EVENT_KINDS.find(kind => kind.id === feature.kind)?.label ?? feature.kind}` })),
    ].map(feature => {
      const begin = feature.start * length, end = feature.end * length;
      const selected=this.selectedModule?.group===feature.group&&this.selectedModule.index===feature.index&&this.selectedModule.handle!=='trigger';
      const offset = (feature.group === 'events' ? -1 : 1) * (this.draft.width / 2 + 3 * scale);
      const subset = [atDistance(begin, offset), ...lengths.slice(0, -1).filter(distance => distance > begin && distance < end).map(distance => atDistance(distance, offset)), atDistance(end, offset)];
      const badge = atDistance((begin + end) / 2, offset + (feature.group === 'events' ? -1 : 1) * 10 * scale);
      const sameZoneLaps = feature.group === 'events' ? [...new Set((this.draft.events ?? []).filter(event => Math.abs(event.start - feature.start) < .0001 && Math.abs(event.end - feature.end) < .0001).map(event => event.lap))].sort((a, b) => a - b) : [];
      const badgeText = sameZoneLaps.length > 1 ? sameZoneLaps.slice(0, 3).map(lap => `T${lap}`).join('/') + (sameZoneLaps.length > 3 ? ` +${sameZoneLaps.length - 3}` : '') : feature.badge;
      const badgeWidth = Math.max(24, badgeText.length * 6 + 8);
      return `<g data-feature-marker="${feature.group}-${feature.index}" class="editor-map-module" data-module-group="${feature.group}" data-module-index="${feature.index}" data-module-handle="target" tabindex="0" role="button" aria-label="${escape(feature.label)}. Glissez pour déplacer ; entrée pour les réglages." aria-pressed="${selected}"><title>${escape(feature.label)}</title><rect x="${badge.x-22*scale}" y="${badge.z-22*scale}" width="${44*scale}" height="${44*scale}" fill="transparent"/><path d="${path(subset)}" fill="none" stroke="${feature.color}" stroke-width="${3 * scale}" stroke-dasharray="${feature.group === 'events' ? `${5 * scale} ${3 * scale}` : 'none'}"/><rect x="${badge.x - badgeWidth / 2 * scale}" y="${badge.z - 8 * scale}" width="${badgeWidth * scale}" height="${16 * scale}" rx="${5 * scale}" fill="${selected?'#c36d36':feature.color}" stroke="${selected?'#fff6d8':'none'}" stroke-width="${2*scale}"/><text x="${badge.x}" y="${badge.z + 3 * scale}" fill="white" font-size="${9 * scale}" font-weight="800" text-anchor="middle">${badgeText}</text></g>`;
    }).join('');
    svg.setAttribute('viewBox', `${this.view.x} ${this.view.z} ${this.view.width} ${this.view.height}`);
    svg.style.backgroundColor = ground;
    svg.innerHTML = `<defs><pattern id="editor-grid" width="25" height="25" patternUnits="userSpaceOnUse"><path d="M25 0H0V25" fill="none" stroke="#213f4030" stroke-width=".5"/></pattern></defs><rect x="${this.view.x}" y="${this.view.z}" width="${this.view.width}" height="${this.view.height}" fill="url(#editor-grid)"/><path d="${route}" fill="none" stroke="#e9ead5" stroke-width="${this.draft.width + 3}" stroke-linejoin="round"/><path d="${route}" fill="none" stroke="${road}" stroke-width="${this.draft.width}" stroke-linejoin="round"/>${zones}<path d="${route}" fill="none" stroke="#ffffff65" stroke-width=".7" stroke-dasharray="4 5"/>${tunnels}${bridges}
      <g transform="translate(${start.x} ${start.z}) rotate(${angle})"><path d="M0 ${-this.draft.width / 2}V${this.draft.width / 2}" stroke="#ffffff" stroke-width="3"/><path d="M0 ${-this.draft.width / 2}V${this.draft.width / 2}" stroke="#263c42" stroke-width="3" stroke-dasharray="2 2"/><path d="M${flag} -3 L${flag + 6} 0 L${flag} 3" fill="none" stroke="#fff7dd" stroke-width="2"/></g>
      ${this.draft.anchors.map((point, index) => `<g data-point="${index}" tabindex="0" role="button" aria-label="Point ${index + 1}${index === 0 ? ', départ' : ''}. Flèches pour déplacer." aria-pressed="${index === this.selected}"><circle cx="${point.x}" cy="${point.z}" r="${hitRadius}" fill="transparent"/><circle cx="${point.x}" cy="${point.z}" r="${radius}" fill="${index === this.selected ? '#ffcc6b' : '#fff8e8'}" stroke="${index === this.selected ? '#8e4b1e' : '#324e51'}" stroke-width="${1.5 * scale}"/><text x="${point.x}" y="${point.z + 3 * scale}" text-anchor="middle" font-size="${8 * scale}" font-weight="800" fill="#213f40" pointer-events="none">${index === 0 ? '⚑' : index + 1}</text></g>`).join('')}`;
    svg.insertAdjacentHTML('beforeend',features+plates+crossingBadges);
    const stats = this.dialog.querySelector('#editor-route-stats');
    if (stats) stats.innerHTML = `<span><strong>${Math.round(length)} m</strong> par tour</span><span><strong>${this.draft.lapCount ?? 3}</strong> tours</span><span><strong>${this.draft.width} m</strong> de large</span><span><strong>${this.draft.anchors.length}</strong> points</span><span><strong>${this.draft.zones.length}</strong> zones</span><span><strong>${this.draft.elevations?.length ?? 0}</strong> reliefs</span><span><strong>${this.draft.events?.length ?? 0}</strong> événements</span>${crossings.length ? `<span><strong>${Math.max(...crossings.map(crossing => crossing.layer)) + 1}</strong> niveaux</span>` : ''}`;
    const crossingSummary = this.dialog.querySelector('#editor-crossings');
    if (crossingSummary) {
      const next = crossings.length ? `<strong>${crossings.length} ${crossings.length === 1 ? 'pont automatique' : 'ponts automatiques'} · passages dessous dégagés</strong><p>La portion parcourue le plus tard passe au-dessus. Les pointillés repèrent le tunnel ; les bords dorés montrent le pont et ses montées.</p><ul>${labelledCrossings.map((crossing, index) => `<li><b>P${index + 1} · Niveau ${crossing.layer}</b><span>Dessus ${crossingPercent(crossing.upperProgress)} % · dessous ${crossingPercent(crossing.lowerProgress)} % · ${crossing.clearance} m libres</span></li>`).join('')}</ul>${crossings.length > labelledCrossings.length ? `<p>Les ${labelledCrossings.length} premiers passages sont nommés ici${crossings.length > detailedCrossings.length ? `, les ${detailedCrossings.length} premiers sont détaillés sur le plan` : ''}. Les ${crossings.length} passages sont présents dans l’essai en 3D.</p>` : ''}` : '<strong>Croisements automatiques</strong><p>Faites passer deux portions l’une sur l’autre : un pont et un tunnel se créent seuls. Essayez le modèle « Huit superposé » pour commencer.</p>';
      if (crossingSummary.innerHTML !== next) crossingSummary.innerHTML = next;
    }
  }

  private renderFeedback() {
    const validation = this.dialog.querySelector<HTMLElement>('#editor-validation');
    if (validation) {
      validation.classList.toggle('is-invalid', !this.validation.ok);
      validation.innerHTML = this.validation.ok ? '<strong>✓ La piste est prête à rouler</strong><span>Tracé libre : virages serrés, points collés et croisements autorisés. Essayez la piste pour ajuster la conduite.</span>' : `<strong>Encore quelques ajustements</strong><ul>${this.validation.errors.map(error => `<li>${escape(error)}</li>`).join('')}</ul>`;
    }
    const status = this.dialog.querySelector<HTMLElement>('#editor-status');
    if (status) {
      status.textContent = !this.validation.ok && !this.busy ? this.validation.errors[0]! : this.notice || (this.localStorageFailed ? 'Le brouillon ne peut pas être conservé dans ce navigateur. Sauvegardez avant de partir.' : 'Le brouillon est gardé automatiquement sur ce navigateur.');
      status.dataset.kind = !this.validation.ok && !this.busy ? 'error' : this.noticeKind;
    }
    const state = this.dialog.querySelector('#editor-save-state'); if (state) state.textContent = this.busy ? 'Préparation en cours…' : this.previous && !this.dirty ? `Version ${this.previous.revision} publiée · brouillon gardé ici` : 'Brouillon local · non publié';
  }

  private renderZones() {
    const target = this.dialog.querySelector('#editor-zones'); if (!target) return;
    target.innerHTML = this.draft.zones.length ? this.draft.zones.map((zone, index) => {
      const lane = zone.width >= this.draft.width - .1 ? 'full' : zone.offset < -1 ? '-1' : zone.offset > 1 ? '1' : '0';
      return `<div class="editor-zone" data-zone-card="${index}"><div class="editor-zone-top"><label>Zone ${index + 1}<select data-zone="${index}" data-field="kind" aria-label="Type de la zone ${index + 1}">${Object.entries(ZONE_NAMES).map(([kind, name]) => `<option value="${kind}" ${zone.kind === kind ? 'selected' : ''}>${name}</option>`).join('')}</select></label><button type="button" class="editor-button editor-square" data-action="remove-zone" data-zone="${index}" aria-label="Supprimer la zone ${index + 1}">✕</button></div><div class="editor-zone-fields"><label>Position (%)<input type="number" min="0" max="99.9" step="0.1" value="${Math.round(zone.start * 1000) / 10}" data-zone="${index}" data-field="start" aria-label="Position de la zone ${index + 1} en pourcentage du tour"></label><label>Longueur (%)<input type="number" min="0.1" max="100" step="0.1" value="${Math.round((zone.end - zone.start) * 1000) / 10}" data-zone="${index}" data-field="duration" aria-label="Longueur de la zone ${index + 1} en pourcentage du tour"></label></div><label>Placement<select data-zone="${index}" data-field="lane" aria-label="Placement de la zone ${index + 1}"><option value="0" ${lane === '0' ? 'selected' : ''}>Au centre</option><option value="-1" ${lane === '-1' ? 'selected' : ''}>Côté droit</option><option value="1" ${lane === '1' ? 'selected' : ''}>Côté gauche</option><option value="full" ${lane === 'full' ? 'selected' : ''}>Toute la largeur</option></select></label><button type="button" class="editor-button editor-test-passage" data-action="try-feature" data-group="zones" data-index="${index}">Essayer ce passage</button></div>`;
    }).join('') : '<p class="editor-empty">Un tracé simple, c’est déjà un circuit. Ajoutez une zone quand vous le souhaitez.</p>';
  }

  private renderFeatures() {
    const laps = this.dialog.querySelector('#editor-lap-fields');
    if (laps) laps.innerHTML = `<label class="editor-field" for="editor-laps">Nombre de tours<input id="editor-laps" type="number" min="1" max="${CUSTOM_TRACK_LIMITS.maxLaps}" step="1" value="${this.draft.lapCount ?? 3}"><small>De 1 à ${CUSTOM_TRACK_LIMITS.maxLaps} tours. Ce nombre est conservé pour les courses et les manches de tournoi sur ce circuit.</small></label>`;
    const percent = (value: number) => Math.round(value * 1000) / 10;
    const number = (group: FeatureGroup, index: number, field: string, label: string, value: number, min: number, max: number, step = .1) => `<label>${label}<input type="number" data-group="${group}" data-index="${index}" data-feature-field="${field}" aria-label="${label}, ${group === 'events' ? 'événement' : 'module'} ${index + 1}" min="${min}" max="${max}" step="${step}" value="${value}"></label>`;
    const interval = (group: FeatureGroup, index: number, feature: { start: number; end: number }) => number(group, index, 'start', 'Position (%)', percent(feature.start), 0, 99.9) + number(group, index, 'duration', 'Longueur (%)', percent(feature.end - feature.start), .1, 100);
    const tryPassage = (group: TrackWorkshopSelection['group'],index:number)=>`<button type="button" class="editor-button editor-test-passage" data-action="try-feature" data-group="${group}" data-index="${index}">Essayer ce passage</button>`;
    const remove = (group: FeatureGroup, index: number, label: string) => `${tryPassage(group,index)}<button type="button" class="editor-button editor-square" data-action="remove-feature" data-group="${group}" data-index="${index}" aria-label="Supprimer ${label} ${index + 1}">✕</button>`;
    const elevations = this.dialog.querySelector('#editor-elevations');
    if (elevations) elevations.innerHTML = (this.draft.elevations ?? []).map((feature, index) => `<article class="editor-feature" data-feature-card="elevations-${index}"><div class="editor-section-heading"><strong>${feature.kind === 'bridge' ? '↗ Pont' : '↗ Tremplin'} ${index + 1}</strong>${remove('elevations', index, feature.kind === 'bridge' ? 'le pont' : 'le tremplin')}</div><div class="editor-zone-fields">${interval('elevations', index, feature)}${number('elevations', index, 'height', 'Hauteur (m)', feature.height, .1, CUSTOM_TRACK_LIMITS.maxHeight)}${number('elevations', index, 'approach', 'Approche (m)', feature.approach, feature.kind === 'bridge' ? .1 : 0, 2000, 1)}${feature.kind === 'jump' ? number('elevations', index, 'launchSpeed', 'Impulsion (m/s)', feature.launchSpeed ?? 6, 0, 25, .5) : ''}</div><p class="editor-muted">${feature.kind === 'bridge' ? 'Une approche longue donne une montée plus douce.' : 'L’impulsion règle la hauteur du saut. Prévoyez une réception dégagée.'}</p></article>`).join('');


    const events = this.dialog.querySelector('#editor-events');
    if (events) events.innerHTML = (this.draft.events ?? []).length ? this.draft.events!.map((feature, index) => `<article class="editor-feature" data-feature-card="events-${index}"><div class="editor-section-heading"><strong>Événement ${index + 1}</strong>${remove('events', index, 'l’événement')}</div><label class="editor-field">Effet<select data-group="events" data-index="${index}" data-feature-field="kind" aria-label="Effet de l’événement ${index + 1}">${CUSTOM_TRACK_EVENT_KINDS.map(kind => `<option value="${kind.id}" ${feature.kind === kind.id ? 'selected' : ''}>${escape(kind.label)}</option>`).join('')}</select></label><div class="editor-zone-fields">${number('events', index, 'lap', 'Tour du leader', feature.lap, 1, this.draft.lapCount ?? 3, 1)}${interval('events', index, feature)}</div></article>`).join('') : '<p class="editor-empty">Exemple : de la pluie au tour 2, puis une bande turbo au tour 4. Choisissez davantage de tours dans « Durée de la course ».</p>';
    const interactions=this.dialog.querySelector('#editor-interactions');
    if (interactions) interactions.innerHTML=(this.draft.interactions??[]).map((feature,index)=>`<article class="editor-feature" data-feature-card="interactions-${index}"><div class="editor-section-heading"><strong>▣ Plaque ${index+1} → ${feature.kind==='boost'?'turbo':'tremplin'}</strong>${remove('interactions',index,'la plaque')}</div><div class="editor-zone-fields">${number('interactions',index,'trigger','Plaque (%)',percent(feature.trigger),0,99.9)}${interval('interactions',index,feature)}${number('interactions',index,'activeSeconds','Durée active (s)',feature.duration,3,30,1)}${number('interactions',index,'width','Largeur plaque / turbo (m)',feature.width,.1,this.draft.width)}${number('interactions',index,'offset','Décalage plaque / turbo (m)',feature.offset,-this.draft.width/2,this.draft.width/2)}${feature.kind==='jump'?number('interactions',index,'height','Hauteur fixe (m)',feature.height??2,.1,80)+number('interactions',index,'launchSpeed','Impulsion active (m/s)',feature.launchSpeed??9,0,25):''}</div><p class="editor-muted">Position et longueur définissent la cible. La plaque déclenche en roulant vers l’avant. ${feature.kind==='jump'?'Le tremplin prend toute la largeur ; hors activation, il reste franchissable sans impulsion supplémentaire.':'Le turbo profite à tous les pilotes qui le traversent pendant son activation.'}</p></article>`).join('')||'<p class="editor-empty">Ajoutez une plaque et sa cible, puis essayez le passage pour régler leur distance.</p>';
    this.renderToolbar();
  }

  private renderLibrary() {
    const target = this.dialog.querySelector('#editor-library'); if (!target) return;
    const disabled = this.busy ? 'disabled' : '';
    const entries = this.records.map(record => {
      const own = !!this.options.getPlayerId?.() && record.authorId === this.options.getPlayerId();
      const name = escape(record.draft.name), id = escape(record.id);
      return `<article class="editor-saved-track" data-record-id="${id}"><div><strong>${name}</strong><small>${escape(CUSTOM_TRACK_THEMES.find(theme => theme.id === record.draft.theme)?.label ?? record.draft.theme)} · ${record.draft.anchors.length} points · version ${record.revision}${record.authorName ? ` · ${escape(record.authorName)}` : ''}</small></div><div>${own ? `<button type="button" class="editor-button" data-action="open" data-id="${id}" aria-label="Modifier ${name}" ${disabled}>Modifier</button>` : ''}<button type="button" class="editor-button" data-action="copy" data-id="${id}" aria-label="Copier ${name}" ${disabled}>Dupliquer</button>${this.canDelete(record) ? `<button type="button" class="editor-button editor-danger" data-action="delete-track" data-id="${id}" aria-label="Supprimer ${name}" ${disabled}>Supprimer</button>` : ''}</div></article>`;
    }).join('');
    target.innerHTML = `<div class="editor-section-heading"><strong>${this.records.length} circuit${this.records.length > 1 ? 's' : ''} partagé${this.records.length > 1 ? 's' : ''}</strong><button type="button" class="editor-button" data-action="refresh" ${this.loading || this.busy ? 'disabled' : ''}>${this.loading ? 'Chargement…' : 'Actualiser'}</button></div>${this.options.canModerateTracks?.() ? '<p class="editor-moderation-note">Modération Admin · vous pouvez supprimer les circuits de tous les pilotes.</p>' : ''}${this.libraryError ? `<p class="editor-library-error" role="alert">${escape(this.libraryError)}</p>` : ''}${!this.loading && !this.records.length && !this.libraryError ? '<p class="editor-empty">Votre classe n’a pas encore publié de circuit. Le vôtre sera le premier !</p>' : ''}<div class="editor-library-list">${entries}</div>`;
  }

  private renderConfirmation() {
    const target = this.dialog.querySelector<HTMLElement>('#editor-confirmation'); if (!target) return;
    for (const area of this.dialog.querySelectorAll<HTMLElement>('.editor-header,.editor-layout,.editor-footer')) area.inert = !!(this.pending || this.deletion);
    if (this.deletion) {
      const { record, error } = this.deletion;
      const moderation = record.authorId !== this.options.getPlayerId?.();
      const text = `Supprimer « ${record.draft.name} »${record.authorName ? `, créé par ${record.authorName}` : ''} des circuits partagés ? ${moderation ? 'Vous agissez en tant qu’Admin. ' : ''}Il ne sera plus proposé pour de nouvelles courses. Les courses en cours et les replays sont conservés. Votre brouillon reste privé sur cet appareil.`;
      target.innerHTML = `<div class="editor-confirm-backdrop"><section class="editor-confirm" role="alertdialog" aria-modal="true" aria-labelledby="editor-confirm-title" aria-describedby="editor-confirm-text" aria-busy="${this.busy}" tabindex="-1"><h3 id="editor-confirm-title">${moderation ? 'Modérer ce circuit' : 'Supprimer ce circuit'}</h3><p id="editor-confirm-text">${escape(text)}</p>${error ? `<p class="editor-library-error" id="editor-delete-error" role="alert">${escape(error)} Annulez puis actualisez la bibliothèque si le circuit a changé.</p>` : ''}<div><button type="button" class="editor-button" id="editor-delete-cancel" data-action="delete-cancel" ${this.busy ? 'disabled' : ''}>Annuler</button><button type="button" class="editor-button editor-danger" id="editor-delete-confirm" data-action="delete-confirm" ${this.busy ? 'disabled' : ''}>${this.busy ? 'Suppression…' : 'Supprimer le circuit'}</button></div></section></div>`;
      (this.busy ? target.querySelector<HTMLElement>('.editor-confirm') : target.querySelector<HTMLElement>('#editor-delete-cancel'))?.focus({ preventScroll: true });
      return;
    }
    if (!this.pending) { target.innerHTML = ''; return; }
    target.innerHTML = `<div class="editor-confirm-backdrop"><section class="editor-confirm" role="alertdialog" aria-modal="true" aria-labelledby="editor-confirm-title" aria-describedby="editor-confirm-text"><h3 id="editor-confirm-title">Votre brouillon compte</h3><p id="editor-confirm-text">${escape(this.pending.text)}</p><div><button type="button" class="editor-button editor-primary" data-action="pending-save">Publier et continuer</button><button type="button" class="editor-button" data-action="pending-confirm">${this.pending.close ? (this.localStorageFailed ? 'Fermer sans conserver' : 'Garder le brouillon et fermer') : 'Remplacer le brouillon'}</button><button type="button" class="editor-button" data-action="pending-cancel">Continuer à créer</button></div></section></div>`;
    target.querySelector<HTMLButtonElement>('[data-action="pending-cancel"]')?.focus();
  }
}
