/** Touch input stays separate from keyboard keys: lifting one finger must never
 * release a key or a second finger which is still holding the same action. */
export type TouchAction = 'steer' | 'accelerate' | 'brake' | 'drift' | 'item' | 'reset';
export type TouchSample = { steer: number; forward: boolean; backward: boolean; drift: boolean; use: boolean; reset: boolean };
export class TouchDriveState {
  readonly pointers = new Map<number, TouchAction>();
  active = false;
  suspended = false;
  autoAccelerate = true;
  private steering = 0;
  private throttle = 0;
  private usePressed = false;
  private resetPressed = false;
  private has(action: TouchAction) { return [...this.pointers.values()].includes(action); }
  press(id: number, action: TouchAction) {
    if (!this.active || this.pointers.has(id) || (action === 'steer' && this.has('steer'))) return false;
    this.suspended = false;
    const alreadyHeld = this.has(action);
    this.pointers.set(id, action);
    if (!alreadyHeld && action === 'item') this.usePressed = true;
    if (!alreadyHeld && action === 'reset') this.resetPressed = true;
    return true;
  }
  move(id: number, horizontal: number, vertical = 0) {
    if (this.pointers.get(id) !== 'steer') return;
    const value = Number.isFinite(horizontal) ? Math.max(-1, Math.min(1, horizontal)) : 0;
    // A small dead zone prevents thumb tremor; the remainder is continuous.
    this.steering = Math.abs(value) < 0.1 ? 0 : Math.sign(value) * (Math.abs(value) - 0.1) / 0.9;
    // Throttle is digital, like the keyboard. Its wider dead zone lets a thumb
    // steer horizontally without accidentally braking while AUTO is enabled.
    const longitudinal = Number.isFinite(vertical) ? Math.max(-1, Math.min(1, vertical)) : 0;
    this.throttle = Math.abs(longitudinal) <= 0.18 ? 0 : Math.sign(longitudinal);
  }
  release(id: number) {
    if (this.pointers.get(id) === 'steer') { this.steering = 0; this.throttle = 0; }
    this.pointers.delete(id);
  }
  clear(suspend = false) {
    this.pointers.clear(); this.steering = 0; this.throttle = 0; this.usePressed = false; this.resetPressed = false;
    this.suspended = suspend;
  }
  sample(racing: boolean): TouchSample {
    const enabled = this.active && !this.suspended;
    const backward = enabled && (this.has('brake') || this.throttle < 0);
    const sample = { steer: enabled ? this.steering : 0,
      forward: enabled && !backward && (this.throttle > 0 || this.has('accelerate') || (racing && this.autoAccelerate)),
      backward, drift: enabled && this.has('drift'),
      use: enabled && racing && this.usePressed, reset: enabled && racing && this.resetPressed };
    // Countdown taps must not fire an item/reset when the race starts.
    this.usePressed = false; this.resetPressed = false;
    return sample;
  }
}

export const mobileControlsMarkup = `
  <section class="touch-controls hidden" id="touch-controls" aria-label="Commandes tactiles de course">
    <div class="touch-settings">
      <button class="touch-auto" id="touch-auto" type="button" aria-pressed="true" aria-label="Accélération automatique. Appuyer pour passer en conduite manuelle."><span>Accélération</span><strong>automatique</strong></button>
      <button class="touch-resume hidden" id="touch-resume" type="button">Reprendre</button>
      <button class="touch-reset" data-touch="reset" type="button" aria-label="Replacer le kart sur la piste">↺ <span>REPLACER</span></button>
    </div>
    <div class="touch-steering"><span class="touch-caption">↑ AVANCE · ↓ FREIN / RECUL</span><button id="touch-steer" data-touch="steer" type="button" aria-label="Joystick : haut pour accélérer, bas pour freiner et reculer, gauche et droite pour tourner"><span class="touch-steer-arrows" aria-hidden="true"><span class="touch-steer-up">↑</span><span class="touch-steer-left">←</span><span class="touch-steer-right">→</span><span class="touch-steer-down">↓</span></span><span class="touch-knob" aria-hidden="true">✥</span></button></div>
    <div class="touch-actions">
      <button class="touch-drift" data-touch="drift" type="button" aria-label="Maintenir pour déraper"><b aria-hidden="true">⌁</b><span>DRIFT</span></button>
      <button class="touch-item" data-touch="item" id="touch-item" type="button" aria-label="Utiliser l’objet"><b id="touch-item-icon" aria-hidden="true">?</b><span>OBJET</span></button>
      <button class="touch-brake" data-touch="brake" type="button" aria-label="Freiner, puis reculer en maintenant"><b aria-hidden="true">Ⅱ</b><span>FREIN / RECUL</span></button>
      <button class="touch-gas" data-touch="accelerate" type="button" aria-label="Accélérer, maintenir à la dernière seconde pour le départ turbo"><b aria-hidden="true">↑</b><span>ACCÉLÉRER</span></button>
    </div>
  </section>
  <button id="driving-help" class="driving-help hidden" type="button" aria-label="Aide : commandes de conduite" title="Commandes">?</button>`;

export class MobileControls {
  readonly state = new TouchDriveState();
  available = false;
  private driving = false;
  private pointerElements = new Map<number, HTMLElement>();
  private readonly root = document.getElementById('touch-controls')!;
  private readonly steer = document.getElementById('touch-steer')!;
  private readonly auto = document.getElementById('touch-auto')!;
  private readonly resume = document.getElementById('touch-resume')!;
  private readonly help = document.getElementById('driving-help')!;
  constructor(private readonly activateAudio: () => void) {
    try { this.state.autoAccelerate = localStorage.getItem('lagon-touch-auto') !== 'false'; } catch { /* Storage may be unavailable in private browsing. */ }
    this.updatePreference();
    // A touchscreen laptop is still a keyboard PC: the touch layout is used when
    // touch is the main pointer (phone, tablet) or once the screen is really
    // touched, and a key press on such a PC returns to the desktop layout.
    const media = matchMedia('(pointer: coarse)');
    let touched = false;
    const detect = () => {
      this.available = media.matches || touched;
      document.body.classList.toggle('touch-device', this.available);
      this.setDriving(this.driving);
    };
    media.addEventListener('change', detect); detect();
    window.addEventListener('pointerdown', event => { if (event.pointerType === 'touch' && !touched) { touched = true; detect(); } }, { capture: true, passive: true });
    window.addEventListener('keydown', event => {
      if (!touched || media.matches || !event.isTrusted || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.target instanceof HTMLElement && event.target.matches('input, textarea, select')) return;
      touched = false; detect();
    });
    this.auto.addEventListener('click', () => {
      this.setAutoAcceleration(!this.state.autoAccelerate); this.activateAudio();
    });
    this.resume.addEventListener('click', () => { this.state.suspended = false; this.paint(); this.activateAudio(); });
    this.help.addEventListener('click', () => this.openHelp());
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-touch]')) {
      button.addEventListener('contextmenu', event => event.preventDefault());
      button.addEventListener('pointerdown', event => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        event.preventDefault();
        if (!this.state.press(event.pointerId, button.dataset.touch as TouchAction)) return;
        button.setPointerCapture(event.pointerId); this.pointerElements.set(event.pointerId, button);
        this.updateSteer(event); this.paint(); this.activateAudio();
      });
      button.addEventListener('pointermove', event => { this.updateSteer(event); this.paint(); });
      button.addEventListener('pointerup', event => this.release(event.pointerId));
      // OS gestures and capture loss cancel every held action, including auto
      // throttle, until the player deliberately touches a control again.
      button.addEventListener('pointercancel', () => this.clear(true));
      button.addEventListener('lostpointercapture', event => {
        if (this.pointerElements.has(event.pointerId)) this.clear(true);
      });
    }
    window.addEventListener('blur', () => this.clear(true));
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.clear(true); });
    window.addEventListener('orientationchange', () => this.clear(true));
    screen.orientation?.addEventListener('change', () => this.clear(true));
    // Also catches browsers which only signal an orientation flip via resize.
    let landscape = innerWidth > innerHeight;
    window.addEventListener('resize', () => { const next = innerWidth > innerHeight; if (next !== landscape) this.clear(true); landscape = next; });
  }
  private updatePreference() {
    const automatic = this.state.autoAccelerate;
    this.auto.setAttribute('aria-pressed', String(automatic));
    this.auto.querySelector('span')!.textContent = automatic ? 'Accélération' : 'Conduite';
    this.auto.querySelector('strong')!.textContent = automatic ? 'automatique' : 'manuelle';
    this.auto.setAttribute('aria-label', automatic ? 'Accélération automatique. Appuyer pour passer en conduite manuelle.' : 'Conduite manuelle. Appuyer pour activer l’accélération automatique.');
    this.auto.title = automatic ? 'Le kart avance seul. Joystick pour tourner, ↓ pour freiner puis reculer.' : 'Joystick ↑ pour avancer, ↓ pour freiner puis reculer. Les pédales restent disponibles.';
    this.root.querySelector('.touch-caption')!.textContent = automatic ? 'DIRIGEZ · ↓ FREIN / RECUL' : '↑ AVANCE · ↓ FREIN / RECUL';
    this.root.classList.toggle('auto-accelerate', automatic);
  }
  setAutoAcceleration(enabled: boolean) {
    // Changing mode is deliberate, but must not retain an old captured thumb
    // or queued item edge from the previous mode.
    this.clear(); this.state.autoAccelerate = enabled;
    try { localStorage.setItem('lagon-touch-auto', String(enabled)); } catch { /* Optional preference. */ }
    this.updatePreference();
  }
  private openHelp() {
    this.clear(true);
    const dialog = document.createElement('dialog'); dialog.id = 'driving-help-dialog'; dialog.className = 'garage-dialog driving-help-dialog';
    dialog.setAttribute('aria-labelledby', 'driving-help-title');
    dialog.innerHTML = `<div class="garage-heading"><h2 id="driving-help-title">Commandes</h2><button class="secondary" type="button" data-help-close>Fermer ✕</button></div>
      <p class="driving-help-warning">La course continue pendant l’aide.</p>
      <fieldset class="driving-mode-options"><legend>Votre conduite tactile</legend><button type="button" data-drive-mode="automatic">Accélération automatique</button><button type="button" data-drive-mode="manual">Conduite manuelle</button></fieldset>
      <p>En automatique, le kart avance seul. En manuel, poussez le joystick vers le haut ou maintenez Accélérer.</p>
      <dl><dt>Joystick</dt><dd>← → tourner · ↑ avancer · ↓ freiner, puis reculer. Les diagonales combinent les deux.</dd><dt>Drift + objet</dt><dd>Maintenez Drift dans un virage. Relâchez pour un mini-turbo. Touchez Objet une fois pour l’utiliser, même avec un autre doigt sur le joystick.</dd><dt>Replacer ↺</dt><dd>Revient au dernier passage validé si vous êtes bloqué.</dd><dt>Clavier</dt><dd>Flèches ou ZQSD / WASD · Espace : drift · E : objet · R : replacer.</dd></dl>
      <p class="garage-hint">Après l’aide, touchez Reprendre ou une commande pour réactiver la conduite tactile.</p>`;
    const paintModes = () => dialog.querySelectorAll<HTMLButtonElement>('[data-drive-mode]').forEach(button => button.setAttribute('aria-pressed', String((button.dataset.driveMode === 'automatic') === this.state.autoAccelerate)));
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-drive-mode]')) button.addEventListener('click', () => {
      this.setAutoAcceleration(button.dataset.driveMode === 'automatic'); this.clear(true); paintModes();
    });
    dialog.querySelector('[data-help-close]')!.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { dialog.remove(); this.clear(true); });
    document.body.append(dialog); paintModes(); dialog.showModal();
  }
  private updateSteer(event: PointerEvent) {
    if (this.state.pointers.get(event.pointerId) !== 'steer') return;
    const rect = this.steer.getBoundingClientRect();
    // Positive steer is left in the chase camera, as for ArrowLeft.
    const dx = event.clientX - rect.left - rect.width / 2;
    const dy = event.clientY - rect.top - rect.height / 2;
    this.state.move(event.pointerId, -dx / (rect.width * 0.36), -dy / (rect.height * 0.36));
    // Keep the visible thumb inside its circular pad, including diagonal drags
    // beyond the pad while pointer capture keeps the control held.
    const visualScale = Math.max(1, Math.hypot(dx / (rect.width * 0.3), dy / (rect.height * 0.3)));
    this.steer.style.setProperty('--thumb-x', `${dx / visualScale}px`);
    this.steer.style.setProperty('--thumb-y', `${dy / visualScale}px`);
  }
  private release(id: number) {
    const button = this.pointerElements.get(id);
    this.pointerElements.delete(id); this.state.release(id);
    if (button?.hasPointerCapture(id)) button.releasePointerCapture(id);
    this.paint();
  }
  private paint() {
    for (const button of this.root.querySelectorAll<HTMLElement>('[data-touch]')) {
      button.classList.toggle('is-held', [...this.state.pointers.values()].includes(button.dataset.touch as TouchAction));
    }
    if (![...this.state.pointers.values()].includes('steer')) {
      this.steer.style.setProperty('--thumb-x', '0px');
      this.steer.style.setProperty('--thumb-y', '0px');
    }
    this.resume.classList.toggle('hidden', !this.state.suspended || !this.state.active);
  }
  setDriving(driving: boolean) {
    this.driving = driving;
    const active = driving && this.available;
    if (this.state.active !== active) { this.clear(); this.state.active = active; }
    this.root.classList.toggle('hidden', !active);
    this.help.classList.toggle('hidden', !driving);
  }
  clear(suspend = false) {
    const held = [...this.pointerElements]; this.pointerElements.clear(); this.state.clear(suspend);
    for (const [id, button] of held) if (button.hasPointerCapture(id)) button.releasePointerCapture(id);
    this.paint();
  }
  sample(racing: boolean) { return this.state.sample(racing); }
  setItem(icon: string, name: string, color: string, available: boolean) {
    const button = document.getElementById('touch-item')!;
    document.getElementById('touch-item-icon')!.textContent = icon;
    button.style.setProperty('--item-color', color);
    button.classList.toggle('has-item', available);
    button.setAttribute('aria-label', available ? `Utiliser : ${name}` : 'Aucun objet, attrapez un cube sur la piste');
  }
}
