// ---------------------------------------------------------------------------
// Tilt gestures for Heads Up. Phone held to the forehead, screen facing out.
//
//   tilt DOWN (screen toward floor)  -> "got it"
//   tilt UP   (screen toward ceiling) -> "skip"
//
// Uses DeviceOrientation beta (front/back tilt). Held upright at the forehead
// beta is ~90. We fire on crossing thresholds, then require a return to
// neutral before firing again, so one tilt is one answer.
//
// iOS 13+ needs an explicit permission request from a user gesture;
// startTilt.requestPermission() handles that. Where motion is unavailable
// the buttons still work.
// ---------------------------------------------------------------------------

const NEUTRAL_LO = 60;    // beta range that counts as "upright"
const NEUTRAL_HI = 120;
const DOWN_AT    = 35;    // beta below this = tilted toward the floor
const UP_AT      = 145;   // beta above this = tilted toward the ceiling
const COOLDOWN   = 650;   // ms before another gesture may fire

export function startTilt({ onDown, onUp, onState } = {}) {
  let armed = true;
  let lastFire = 0;
  let active = true;

  const handler = e => {
    if (!active) return;
    let beta = e.beta;
    if (beta === null || beta === undefined) return;
    // Landscape orientations shift the axis; normalise so "toward the floor"
    // is always low beta.
    const angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    if (angle === 90)  beta = e.gamma !== null ? 90 - e.gamma : beta;
    if (angle === -90 || angle === 270) beta = e.gamma !== null ? 90 + e.gamma : beta;

    const now = Date.now();
    if (beta >= NEUTRAL_LO && beta <= NEUTRAL_HI) {
      if (!armed) onState?.('ready');
      armed = true;
      return;
    }
    if (!armed || now - lastFire < COOLDOWN) return;
    if (beta < DOWN_AT) { armed = false; lastFire = now; onState?.('got'); onDown?.(); }
    else if (beta > UP_AT) { armed = false; lastFire = now; onState?.('skip'); onUp?.(); }
  };

  window.addEventListener('deviceorientation', handler, true);
  onState?.('ready');

  return {
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

/** Has the user already granted motion in this session? Remembered so the
 *  prompt only shows once per phone. */
startTilt.remember = granted => { try { sessionStorage.setItem('pg_tilt', granted ? '1' : '0'); } catch {} };
startTilt.remembered = () => { try { return sessionStorage.getItem('pg_tilt') === '1'; } catch { return false; } };
