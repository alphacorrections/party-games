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

  /* ---- building blocks ------------------------------------------------ */

  /** One voice: oscillator -> optional lowpass -> ADSR gain. */
  _voice(freq, { type = 'sine', gain = 0.16, a = 0.005, d = 0.08, sus = 0.0, r = 0.12,
                 dur = 0.2, delay = 0, slide = 0, lp = 0, detune = 0 } = {}) {
    if (!enabled) return;
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, t0); o.detune.value = detune;
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
    let node = o;
    if (lp) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; f.Q.value = .7; o.connect(f); node = f; }
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain * sus), t0 + a + d);
    g.gain.setValueAtTime(Math.max(0.0001, gain * sus), t0 + Math.max(a + d, dur - r));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    node.connect(g).connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  },

  /** A burst of filtered noise: clicks, thuds, dice. */
  _noise({ gain = 0.12, dur = 0.08, delay = 0, hp = 800, lp = 6000, decay = 0.06 } = {}) {
    if (!enabled) return;
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + delay;
    const len = Math.ceil(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (c.sampleRate * decay));
    const src = c.createBufferSource(); src.buffer = buf;
    const h = c.createBiquadFilter(); h.type = 'highpass'; h.frequency.value = hp;
    const l = c.createBiquadFilter(); l.type = 'lowpass'; l.frequency.value = lp;
    const g = c.createGain(); g.gain.value = gain;
    src.connect(h).connect(l).connect(g).connect(c.destination);
    src.start(t0);
  },

  /** A chord: several voices at once, slightly detuned for width. */
  _chord(freqs, opts = {}) {
    freqs.forEach((f, i) => {
      this._voice(f, { ...opts, detune: (i % 2 ? 4 : -4) });
      this._voice(f, { ...opts, gain: (opts.gain || 0.16) * 0.35, type: 'triangle', detune: (i % 2 ? -7 : 7) });
    });
  },

  /* ---- cues ----------------------------------------------------------- */

  // UI
  tap()    { this._noise({ gain: 0.08, dur: 0.03, hp: 1500, lp: 7000, decay: 0.015 }); this._voice(900, { type: 'triangle', gain: 0.05, dur: 0.05, d: 0.03 }); },
  lock()   { this._noise({ gain: 0.1, dur: 0.04, hp: 1200, decay: 0.02 });
             this._voice(523, { type: 'triangle', gain: 0.12, dur: 0.09, d: 0.05 });
             this._voice(784, { type: 'triangle', gain: 0.12, dur: 0.14, d: 0.07, delay: 0.06 }); },
  tick()   { this._voice(1800, { type: 'square', gain: 0.035, dur: 0.035, a: 0.002, d: 0.02 }); this._noise({ gain: 0.04, dur: 0.02, hp: 3000, decay: 0.01 }); },
  timeup() { [0, 0.16, 0.32].forEach((d, i) => this._voice(i < 2 ? 880 : 440, { type: 'square', gain: 0.09, dur: i < 2 ? 0.1 : 0.4, lp: 2500, delay: d })); },

  // Outcomes
  correct() { this._chord([523, 659, 784], { gain: 0.13, dur: 0.35, d: 0.15, sus: 0.3, r: 0.18 });
              this._voice(1047, { type: 'triangle', gain: 0.1, dur: 0.45, delay: 0.09, d: 0.2, sus: 0.25 }); },
  wrong()   { this._voice(220, { type: 'sawtooth', gain: 0.07, dur: 0.28, slide: -90, lp: 900, d: 0.1, sus: 0.5 });
              this._voice(165, { type: 'sawtooth', gain: 0.05, dur: 0.3, slide: -60, lp: 700, delay: 0.02, d: 0.1, sus: 0.5 }); },

  // Reveal: a rising two-note sting with a soft shimmer on top.
  reveal()  { this._voice(392, { type: 'triangle', gain: 0.1, dur: 0.18, d: 0.1 });
              this._chord([587, 740], { gain: 0.1, dur: 0.5, delay: 0.1, d: 0.2, sus: 0.3, r: 0.25 });
              this._voice(1175, { type: 'sine', gain: 0.04, dur: 0.6, delay: 0.14, d: 0.3, sus: 0.2 }); },

  // Board
  dice()    { for (let i = 0; i < 9; i++) this._noise({ gain: 0.1 - i * 0.006, dur: 0.05, delay: i * 0.085 + Math.random() * 0.02, hp: 600, lp: 3500, decay: 0.025 }); },
  land()    { this._noise({ gain: 0.18, dur: 0.12, hp: 60, lp: 500, decay: 0.05 }); this._voice(110, { type: 'sine', gain: 0.22, dur: 0.22, slide: -50, d: 0.12 }); },
  coin()    { this._voice(1319, { type: 'square', gain: 0.07, dur: 0.07, lp: 4000, d: 0.04 });
              this._voice(1760, { type: 'square', gain: 0.07, dur: 0.22, lp: 4000, delay: 0.07, d: 0.1, sus: 0.3 }); },
  loss()    { this._voice(330, { type: 'sawtooth', gain: 0.07, dur: 0.14, lp: 1200, d: 0.08 });
              this._voice(247, { type: 'sawtooth', gain: 0.07, dur: 0.16, lp: 1000, delay: 0.13, d: 0.08 });
              this._voice(185, { type: 'sawtooth', gain: 0.08, dur: 0.4, lp: 800, delay: 0.26, slide: -40, d: 0.1, sus: 0.5 }); },

  // Win: fanfare arpeggio into a held chord, with a cymbal-ish wash.
  win()     { [523, 659, 784, 1047].forEach((f, i) => this._voice(f, { type: 'triangle', gain: 0.14, dur: 0.22, delay: i * 0.1, d: 0.1 }));
              this._chord([523, 659, 784, 1047], { gain: 0.11, dur: 1.4, delay: 0.42, d: 0.3, sus: 0.5, r: 0.6 });
              this._noise({ gain: 0.06, dur: 0.9, delay: 0.42, hp: 4000, lp: 12000, decay: 0.35 }); },

  // Horror: a dissonant low cluster with a scrape on top (Body Count's Basement).
  sting()   { this._noise({ gain: 0.16, dur: 0.5, hp: 2000, lp: 9000, decay: 0.2 });
              [55, 58.3, 82.4, 87.3].forEach((f, i) => this._voice(f, { type: 'sawtooth', gain: 0.09, dur: 1.6, lp: 600, delay: i * 0.02, d: 0.4, sus: 0.6, r: 0.8 }));
              this._voice(1244, { type: 'sine', gain: 0.03, dur: 1.2, slide: -300, delay: 0.1, d: 0.6, sus: 0.3 }); },
  // A body hitting the floor.
  die()     { this._noise({ gain: 0.25, dur: 0.25, hp: 40, lp: 400, decay: 0.09 });
              this._voice(98, { type: 'sine', gain: 0.25, dur: 0.6, slide: -60, d: 0.3, sus: 0.2 });
              this._voice(146, { type: 'sawtooth', gain: 0.05, dur: 0.9, slide: -100, lp: 500, delay: 0.15, d: 0.4, sus: 0.4 }); },

  // Intro sting for the title card.
  intro()   { this._noise({ gain: 0.12, dur: 0.15, hp: 80, lp: 700, decay: 0.07 });
              this._chord([262, 392, 523], { gain: 0.1, dur: 0.9, d: 0.25, sus: 0.4, r: 0.4 }); }
};

/* -------------------------------- music -------------------------------- */
// Generative horror score for Body Count. No files: a drone, a music box that
// plays stray notes, and a heartbeat whose speed follows the game.
//   calm  — questions: drone + sparse music box
//   tense — the Basement: heartbeat, darker filter, more notes
//   chase — the Escape: fast heartbeat + bass pulse
// Safe to call repeatedly; set() only changes what's different.

const SCALE = [220, 233.1, 261.6, 277.2, 311.1, 329.6, 392, 415.3, 440, 466.2, 523.3];   // A phrygian-ish, with tritones
const LEVELS = {
  calm:  { drone: 0.050, lp: 260, beat: 0,   bass: 0,    box: 0.30, pad: 0.012 },
  tense: { drone: 0.065, lp: 180, beat: 84,  bass: 0,    box: 0.45, pad: 0.020 },
  chase: { drone: 0.060, lp: 420, beat: 128, bass: 0.09, box: 0.20, pad: 0.010 },
  dead:  { drone: 0.030, lp: 140, beat: 0,   bass: 0,    box: 0.15, pad: 0.025 }
};

export const music = {
  level: null, _nodes: null, _timer: null, _next: 0, _beatAt: 0, _bassAt: 0, _step: 0,

  set(level) {
    if (!enabled || !level) return this.stop();
    const c = ac(); if (!c) return;
    if (c.state === 'suspended') c.resume().catch(() => {});
    if (!this._nodes) this._build(c);
    if (level === this.level) return;
    this.level = level;
    const L = LEVELS[level] || LEVELS.calm, t = c.currentTime;
    const n = this._nodes;
    n.droneGain.gain.setTargetAtTime(L.drone, t, 1.2);
    n.filter.frequency.setTargetAtTime(L.lp, t, 1.5);
    n.padGain.gain.setTargetAtTime(L.pad, t, 2.0);
    if (!this._timer) this._timer = setInterval(() => this._tick(), 90);
  },

  stop() {
    this.level = null;
    clearInterval(this._timer); this._timer = null;
    const n = this._nodes; if (!n) return;
    const c = ac(), t = c.currentTime;
    n.master.gain.setTargetAtTime(0.0001, t, 0.4);
    const old = n; this._nodes = null;
    setTimeout(() => { try { old.oscs.forEach(o => o.stop()); old.master.disconnect(); } catch {} }, 2500);
  },

  _build(c) {
    const master = c.createGain(); master.gain.value = 0.0001;
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -18;
    master.connect(comp).connect(c.destination);
    master.gain.setTargetAtTime(0.9, c.currentTime, 1.5);
    // Echo bus for the music box: makes it sound like an empty house.
    const delay = c.createDelay(1.5); delay.delayTime.value = 0.42;
    const fb = c.createGain(); fb.gain.value = 0.42;
    const wet = c.createGain(); wet.gain.value = 0.55;
    const damp = c.createBiquadFilter(); damp.type = 'lowpass'; damp.frequency.value = 2200;
    delay.connect(damp).connect(fb).connect(delay); damp.connect(wet).connect(master);
    // Drone: detuned saws through a slowly breathing lowpass.
    const filter = c.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 260; filter.Q.value = 6;
    const droneGain = c.createGain(); droneGain.gain.value = 0.0001;
    filter.connect(droneGain).connect(master);
    const oscs = [];
    for (const [f, type, det] of [[55, 'sawtooth', -6], [55, 'sawtooth', 7], [27.5, 'sine', 0], [82.4, 'triangle', 3]]) {
      const o = c.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = det; o.connect(filter); o.start(); oscs.push(o);
    }
    const lfo = c.createOscillator(); lfo.frequency.value = 0.06;
    const lfoAmt = c.createGain(); lfoAmt.gain.value = 90; lfo.connect(lfoAmt).connect(filter.frequency); lfo.start(); oscs.push(lfo);
    // Pad: a high tritone that wavers in and out.
    const padGain = c.createGain(); padGain.gain.value = 0.0001; padGain.connect(master);
    for (const f of [622.3, 880]) {
      const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const trem = c.createGain(); trem.gain.value = 0.5;
      const tl = c.createOscillator(); tl.frequency.value = 0.13 + Math.random() * .1;
      const ta = c.createGain(); ta.gain.value = 0.5; tl.connect(ta).connect(trem.gain);
      o.connect(trem).connect(padGain); o.start(); tl.start(); oscs.push(o, tl);
    }
    this._nodes = { master, filter, droneGain, padGain, delay, oscs };
    this._next = c.currentTime + 1.5; this._beatAt = c.currentTime + 0.5; this._bassAt = c.currentTime + 0.5;
  },

  _tick() {
    const c = ac(), n = this._nodes; if (!c || !n || !enabled) return;
    const L = LEVELS[this.level] || LEVELS.calm, now = c.currentTime, ahead = now + 0.25;
    // Music box: occasional single notes, sometimes a falling pair.
    if (this._next < ahead) {
      if (Math.random() < L.box) {
        const f = SCALE[Math.floor(Math.random() * SCALE.length)] * (Math.random() < .3 ? 2 : 1);
        this._box(c, f, this._next);
        if (Math.random() < .35) this._box(c, f * 0.749, this._next + 0.32);   // down a tritone-ish
      }
      this._next += 0.9 + Math.random() * 1.6;
    }
    // Heartbeat: lub-dub.
    if (L.beat && this._beatAt < ahead) {
      const gap = 60 / L.beat;
      this._thump(c, this._beatAt, 0.32); this._thump(c, this._beatAt + gap * 0.28, 0.22);
      this._beatAt += gap;
    } else if (!L.beat) this._beatAt = now + 0.3;
    // Chase bass: eighth notes, A then B-flat every other bar.
    if (L.bass && this._bassAt < ahead) {
      const gap = 60 / L.beat / 2;
      const f = (Math.floor(this._step / 8) % 2) ? 58.27 : 55;
      this._bass(c, f, this._bassAt, L.bass); this._step++; this._bassAt += gap;
    } else if (!L.bass) this._bassAt = now + 0.3;
  },

  _box(c, f, t) {
    const n = this._nodes; if (!n) return;
    const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
    const o2 = c.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 4.01;
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    const g2 = c.createGain(); g2.gain.value = 0.15;
    o.connect(g); o2.connect(g2).connect(g); g.connect(n.master); g.connect(n.delay);
    o.start(t); o2.start(t); o.stop(t + 1.7); o2.stop(t + 1.7);
  },
  _thump(c, t, vol) {
    const n = this._nodes; if (!n) return;
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.16);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g).connect(n.master); o.start(t); o.stop(t + 0.25);
  },
  _bass(c, f, t, vol) {
    const n = this._nodes; if (!n) return;
    const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(600, t); lp.frequency.exponentialRampToValueAtTime(120, t + 0.18);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(lp).connect(g).connect(n.master); o.start(t); o.stop(t + 0.22);
  }
};

if (typeof window !== 'undefined') window.__pgMusic = music;   // for debugging from the console

// Browsers start audio suspended after a reload even when sound is on. The
// first tap or remote press anywhere wakes it up.
if (typeof window !== 'undefined') {
  const wake = () => { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); else if (enabled) { const c = ac(); c?.resume?.().catch(() => {}); } };
  ['pointerdown', 'keydown', 'touchend'].forEach(ev => window.addEventListener(ev, wake, { passive: true }));
}

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
  b.addEventListener('click', () => {
    sound.enable(!sound.enabled);
    if (sound.enabled) sound.tap(); else music.stop();
    paint();
    window.dispatchEvent(new Event('pg-sound'));     // pages re-apply music for the current screen
  });
  paint();
  container.appendChild(b);
}
