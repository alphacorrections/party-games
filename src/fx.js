// ---------------------------------------------------------------------------
// Effects layer: sound, haptics, DOM transitions, number count-ups.
//
// Everything here is optional dressing. Every function is safe to call when
// its underlying capability is missing (no AudioContext, no vibrate, reduced
// motion requested) and simply does less.
// ---------------------------------------------------------------------------

export const reducedMotion = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* -------------------------------- sound -------------------------------- */
// Synthesised, so there are no audio files to ship or load. Each cue is a
// tiny oscillator envelope. Off until the person opts in with one tap: most
// browsers refuse to start audio without a user gesture anyway.

let ctx = null;
let enabled = false;

function ac() {
  if (ctx) return ctx;
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  return ctx;
}

export const sound = {
  get enabled() { return enabled; },

  enable(on = true) {
    enabled = on;
    try { localStorage.setItem('pg_sound', on ? '1' : '0'); } catch {}
    if (on) { const c = ac(); if (c && c.state === 'suspended') c.resume(); }
  },

  restore() {
    try { enabled = localStorage.getItem('pg_sound') === '1'; } catch {}
    return enabled;
  },

  _tone(freq, dur, { type = 'sine', gain = 0.18, slide = 0, delay = 0 } = {}) {
    if (!enabled) return;
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  },

  tick()    { this._tone(1200, 0.05, { type: 'square', gain: 0.05 }); },
  tap()     { this._tone(520, 0.06, { type: 'triangle', gain: 0.12 }); },
  lock()    { this._tone(660, 0.08, { type: 'triangle' }); this._tone(990, 0.1, { type: 'triangle', delay: 0.07 }); },
  correct() { [523, 659, 784, 1047].forEach((f, i) => this._tone(f, 0.14, { delay: i * 0.07, gain: 0.16 })); },
  wrong()   { this._tone(220, 0.25, { type: 'sawtooth', gain: 0.1, slide: -120 }); },
  reveal()  { this._tone(392, 0.12, { type: 'triangle' }); this._tone(587, 0.18, { type: 'triangle', delay: 0.1 }); },
  dice()    { for (let i = 0; i < 7; i++) this._tone(180 + Math.random() * 220, 0.04, { type: 'square', gain: 0.06, delay: i * 0.075 }); },
  land()    { this._tone(140, 0.18, { type: 'sine', gain: 0.25, slide: -60 }); },
  coin()    { this._tone(1318, 0.07, { type: 'square', gain: 0.08 }); this._tone(1760, 0.16, { type: 'square', gain: 0.08, delay: 0.07 }); },
  loss()    { this._tone(300, 0.14, { type: 'sawtooth', gain: 0.09 }); this._tone(200, 0.3, { type: 'sawtooth', gain: 0.09, delay: 0.12, slide: -80 }); },
  win()     { [523, 659, 784, 1047, 1319].forEach((f, i) => this._tone(f, 0.22, { delay: i * 0.11, gain: 0.18 })); this._tone(1568, 0.6, { delay: 0.6, gain: 0.16 }); },
  timeup()  { this._tone(880, 0.1, { type: 'square', gain: 0.1 }); this._tone(880, 0.1, { type: 'square', gain: 0.1, delay: 0.15 }); this._tone(440, 0.35, { type: 'square', gain: 0.1, delay: 0.3 }); }
};

/* ------------------------------- haptics ------------------------------- */

export const haptic = {
  _v(p) { try { navigator.vibrate && navigator.vibrate(p); } catch {} },
  tap()     { this._v(12); },
  lock()    { this._v([15, 40, 25]); },
  correct() { this._v([20, 30, 20, 30, 40]); },
  wrong()   { this._v(90); },
  dice()    { this._v([10, 30, 10, 30, 10, 30, 20, 40, 30, 50, 40]); },
  land()    { this._v(60); },
  win()     { this._v([40, 50, 40, 50, 120]); }
};

/* ---------------------------- DOM transitions -------------------------- */

/**
 * Swap a container's content with a crossfade + rise. Tracks a key so a
 * re-render of the same screen state doesn't re-animate and flicker.
 */
const lastKeys = new WeakMap();

export function swapIn(el, html, key) {
  if (!el) return;
  const same = key !== undefined && lastKeys.get(el) === key;
  if (key !== undefined) lastKeys.set(el, key);

  if (same || reducedMotion()) {
    // Same screen: don't touch the DOM unless something actually changed, or
    // running animations and the timer ring restart on every event.
    if (el.innerHTML !== html) el.innerHTML = html;
    return;
  }
  el.classList.remove('fx-in');
  el.innerHTML = html;
  // Force a reflow so the class re-triggers the keyframe.
  void el.offsetWidth;
  el.classList.add('fx-in');
}

/** Stagger an entrance across children matching `selector`. */
export function stagger(root, selector, stepMs = 70) {
  if (!root || reducedMotion()) return;
  root.querySelectorAll(selector).forEach((n, i) => {
    n.style.setProperty('--d', `${i * stepMs}ms`);
    n.classList.add('fx-stagger');
  });
}

/** Animate a number from its current displayed value to `to`. */
export function countUp(el, to, ms = 700) {
  if (!el) return;
  const from = Number(String(el.textContent).replace(/[^\d-]/g, '')) || 0;
  if (reducedMotion() || from === to) { el.textContent = to; return; }
  const t0 = performance.now();
  const ease = x => 1 - Math.pow(1 - x, 3);
  function step(t) {
    const p = Math.min(1, (t - t0) / ms);
    el.textContent = Math.round(from + (to - from) * ease(p));
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/** Brief full-screen flash in a colour token: 'volt' | 'hot' */
export function flash(kind = 'volt') {
  if (reducedMotion()) return;
  const n = document.createElement('div');
  n.className = `fx-flash ${kind}`;
  document.body.appendChild(n);
  n.addEventListener('animationend', () => n.remove(), { once: true });
}

/** Confetti burst from the top for the winner moment. Pure DOM, no lib. */
export function confetti(count = 90) {
  if (reducedMotion()) return;
  const colors = ['#FF2D7A', '#D6FF3F', '#F7F3E8', '#B3144F', '#9B86B5'];
  const wrap = document.createElement('div');
  wrap.className = 'fx-confetti';
  for (let i = 0; i < count; i++) {
    const p = document.createElement('i');
    p.style.setProperty('--x', `${Math.random() * 100}vw`);
    p.style.setProperty('--r', `${Math.random() * 720 - 360}deg`);
    p.style.setProperty('--d', `${Math.random() * 0.8}s`);
    p.style.setProperty('--t', `${2.2 + Math.random() * 1.4}s`);
    p.style.setProperty('--s', `${6 + Math.random() * 8}px`);
    p.style.background = colors[i % colors.length];
    wrap.appendChild(p);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 4200);
}

/* ---------------------------- sound toggle UI -------------------------- */

export function mountSoundToggle(container) {
  if (!container || container.querySelector('.soundbtn')) return;
  sound.restore();
  const b = document.createElement('button');
  b.className = 'soundbtn';
  b.type = 'button';
  const paint = () => {
    b.textContent = sound.enabled ? '🔊' : '🔇';
    b.title = sound.enabled ? 'Sound on' : 'Sound off';
    b.setAttribute('aria-pressed', sound.enabled ? 'true' : 'false');
  };
  b.addEventListener('click', () => { sound.enable(!sound.enabled); if (sound.enabled) sound.tap(); paint(); });
  paint();
  container.appendChild(b);
}
