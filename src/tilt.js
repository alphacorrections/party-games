// ---------------------------------------------------------------------------
// Tilt gestures for Heads Up. Phone held SIDEWAYS on the forehead, screen out.
//
//   tilt DOWN (screen toward floor)   -> "got it"
//   tilt UP   (screen toward ceiling) -> "skip"
//
// Why not raw beta/gamma: Euler angles flip and wrap when a phone is upright
// and sideways (gamma jumps from +90 to -90, beta by 180). Instead we turn the
// angles into the world's "up" direction in the phone's own frame. That
// vector is smooth in every pose and the same on iOS and Android.
//
//   up = (-cosβ·sinγ, sinβ, cosβ·cosγ)       (device x right, y top, z out of screen)
//
//   pitch = asin(up.z)    0 = screen vertical, + = facing ceiling, − = facing floor
//   side  = sign(up.x)    which long edge is on top when held sideways
//
// Calibration: during the countdown we record where "neutral" is for this
// person (nobody holds it perfectly vertical), then fire on tilts measured
// from that baseline. One tilt = one answer: after firing you must come back
// near neutral before the next one counts. The baseline drifts slowly while
// neutral so a slouch mid-turn doesn't break it.
//
// iOS 13+ needs permission from a tap; startTilt.requestPermission() does it.
// Where motion is unavailable the on-screen buttons still work.
// ---------------------------------------------------------------------------

const FIRE_DEG   = 38;    // tilt this far past neutral to answer
const REARM_DEG  = 16;    // come back within this of neutral to arm again
const HOLD_MS    = 70;    // must stay past the threshold this long (kills jitter spikes)
const COOLDOWN   = 600;   // ms minimum between answers
const SMOOTH     = 0.35;  // low-pass factor on pitch
const DRIFT      = 0.015; // how fast the baseline follows while neutral
const CAL_MS     = 600;   // window of samples used to calibrate
const MAX_BASE   = 35;    // a baseline further than this from vertical is ignored

const RAD = Math.PI / 180;

function upVector(beta, gamma) {
  const b = beta * RAD, g = gamma * RAD;
  return { x: -Math.cos(b) * Math.sin(g), y: Math.sin(b), z: Math.cos(b) * Math.cos(g) };
}

/**
 * startTilt({ onDown, onUp, onState, onPose })
 *   mode 'calibrate' (default): tracks pose and baseline, never answers.
 *   mode 'play': answers fire.
 * Returns { setMode, calibrate, stop, get mode, get calibrated }.
 */
export function startTilt({ onDown, onUp, onState, onPose } = {}) {
  let active = true, mode = 'calibrate';
  let pitch = null, base = null, armed = true, lastFire = 0, pastSince = 0, pastDir = 0;
  let side = 0, calibrated = false;
  const recent = [];                // [t, rawPitch] for calibration

  const setState = s => onState?.(s);

  function calibrate() {
    const now = Date.now();
    const win = recent.filter(([t]) => now - t <= CAL_MS).map(r => r[1]);
    if (win.length < 4) return false;
    const sorted = [...win].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const spread = sorted[sorted.length - 1] - sorted[0];
    if (Math.abs(med) > MAX_BASE || spread > 20) return false;   // not held still near vertical
    base = med; pitch = med; armed = true; calibrated = true;
    setState('ready');
    return true;
  }

  const handler = e => {
    if (!active || e.beta == null || e.gamma == null) return;
    const u = upVector(e.beta, e.gamma);
    const raw = Math.asin(Math.max(-1, Math.min(1, u.z))) / RAD;
    const now = Date.now();
    recent.push([now, raw]); while (recent.length && now - recent[0][0] > CAL_MS * 2) recent.shift();

    // Which long edge is up, with hysteresis so it doesn't flicker mid-tilt.
    if (Math.abs(u.x) > 0.55) side = u.x > 0 ? 1 : -1;

    pitch = pitch == null ? raw : pitch + (raw - pitch) * SMOOTH;
    if (base == null) {
      // Auto-calibrate as soon as the phone is held still near vertical.
      if (!calibrate()) { onPose?.({ pitch, side, delta: 0, calibrated: false }); return; }
    }
    const delta = pitch - base;
    onPose?.({ pitch, side, delta, calibrated: true });

    if (Math.abs(delta) <= REARM_DEG) {
      if (!armed) setState('ready');
      armed = true; pastDir = 0;
      base += (pitch - base) * DRIFT;
      return;
    }
    if (mode !== 'play' || !armed || now - lastFire < COOLDOWN) return;

    const dir = delta <= -FIRE_DEG ? -1 : delta >= FIRE_DEG ? 1 : 0;
    if (!dir) { pastDir = 0; return; }
    if (dir !== pastDir) { pastDir = dir; pastSince = now; return; }
    if (now - pastSince < HOLD_MS) return;

    armed = false; lastFire = now; pastDir = 0;
    if (dir < 0) { setState('got'); onDown?.(); }
    else         { setState('skip'); onUp?.(); }
  };

  window.addEventListener('deviceorientation', handler, true);
  setState('hold it on your forehead');

  return {
    get mode() { return mode; },
    get calibrated() { return calibrated; },
    setMode(m) {
      if (m === mode) return;
      // Entering play: take the baseline from how they held it during the countdown.
      if (m === 'play') { calibrate(); armed = true; lastFire = Date.now(); }
      mode = m;
    },
    calibrate,
    stop() { active = false; window.removeEventListener('deviceorientation', handler, true); }
  };
}

startTilt.supported = () => 'DeviceOrientationEvent' in window;

startTilt.needsPermission = () =>
  typeof DeviceOrientationEvent !== 'undefined' &&
  typeof DeviceOrientationEvent.requestPermission === 'function';

startTilt.requestPermission = async () => {
  if (!startTilt.needsPermission()) return 'granted';
  try { return await DeviceOrientationEvent.requestPermission(); }
  catch { return 'denied'; }
};

startTilt.remember = granted => { try { sessionStorage.setItem('pg_tilt', granted ? '1' : '0'); } catch {} };
startTilt.remembered = () => { try { return sessionStorage.getItem('pg_tilt') === '1'; } catch { return false; } };

/* ------------------------- sideways screen helpers ------------------------ */

let lockedByUs = false, wake = null;

/** Real landscape lock where the browser allows it (Android Chrome, in
 *  fullscreen). iPhones can't; the CSS rotation covers them. Needs a tap. */
export async function goSideways() {
  try {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    if (screen.orientation?.lock) { await screen.orientation.lock('landscape'); lockedByUs = true; }
  } catch { /* not supported: CSS rotation handles it */ }
  keepAwake();
}

export async function leaveSideways() {
  try { if (lockedByUs) screen.orientation?.unlock?.(); } catch {}
  try { if (lockedByUs && document.fullscreenElement) await document.exitFullscreen(); } catch {}
  lockedByUs = false;
  try { await wake?.release(); } catch {} wake = null;
}

export async function keepAwake() {
  try { if (!wake && navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch {}
}

/** Is the browser itself showing landscape? (rotation lock off, or we locked it) */
export const browserLandscape = () => window.innerWidth > window.innerHeight;
