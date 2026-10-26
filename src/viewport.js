// ---------------------------------------------------------------------------
// Viewport fitting for screens that lie about their size.
//
// Smart-TV browsers and Fire Stick's Silk don't support 100dvh, report odd
// innerHeights, and the TV itself crops a few percent off every edge
// (overscan). This module:
//
//   1. Publishes --vh (1% of the real visible height) so CSS can use
//      calc(var(--vh) * 100) where dvh would otherwise be used.
//   2. Detects TV-class user agents and applies a default overscan inset,
//      which the person can adjust with the arrow keys on a remote and is
//      remembered per device.
//   3. Scales the whole stage down if its content is taller than the
//      viewport, so nothing scrolls on a short, wide screen.
// ---------------------------------------------------------------------------

const TV_UA = /\b(SMART-TV|SmartTV|Tizen|Web0S|WebOS|NetCast|BRAVIA|Silk|AFT[A-Z]|Roku|VIDAA|HbbTV|Viera|GoogleTV|CrKey|Android TV)\b/i;

export const isTV = TV_UA.test(navigator.userAgent);

function setVH() {
  const h = window.innerHeight || document.documentElement.clientHeight;
  document.documentElement.style.setProperty('--vh', `${h * 0.01}px`);
}

/* ------------------------------ overscan -------------------------------- */

const KEY = 'pg_overscan';
function loadInset() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw !== null) {                      // Number(null) is 0, so check first
      const v = Number(raw);
      if (!Number.isNaN(v) && v >= 0 && v <= 12) return v;
    }
  } catch {}
  return isTV ? 4 : 0;     // TVs usually crop 3–5%
}
let inset = loadInset();

function applyInset() {
  document.documentElement.style.setProperty('--overscan', `${inset}%`);
  try { localStorage.setItem(KEY, String(inset)); } catch {}
}

export function setOverscan(pct) {
  inset = Math.max(0, Math.min(12, pct));
  applyInset();
  showHint(`Screen inset ${inset}%`);
}

let hintTimer = null;
function showHint(text) {
  let n = document.getElementById('vp-hint');
  if (!n) {
    n = document.createElement('div');
    n.id = 'vp-hint';
    document.body.appendChild(n);
  }
  n.textContent = text;
  n.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => n.classList.remove('show'), 1600);
}

/* -------------------------------- fit ----------------------------------- */

/**
 * Scale a stage element down so it never exceeds the available height.
 * Called after each render; cheap enough to run on resize too.
 */
export function fitStage(stage) {
  if (!stage) return;
  stage.style.transform = '';
  stage.style.transformOrigin = '';
  // Scale-to-fit is for wide screens (TVs, laptops) where scrolling is wrong.
  // A portrait phone should just scroll.
  if (window.innerHeight > window.innerWidth) { document.documentElement.classList.add('portrait'); return; }
  document.documentElement.classList.remove('portrait');
  const par = stage.parentElement;
  let avail = window.innerHeight;
  if (par) {
    const cs = getComputedStyle(par);
    avail = par.clientHeight - parseFloat(cs.paddingTop || 0) - parseFloat(cs.paddingBottom || 0);
  }
  const need = Math.max(stage.scrollHeight, stage.getBoundingClientRect().height);
  if (need > avail + 1 && avail > 0) {
    let k = Math.max(0.45, (avail - 4) / need);
    stage.style.transformOrigin = '50% 0';
    stage.style.transform = `scale(${k})`;
    // Check the real result against the container's content box and correct.
    if (par) {
      const pr = par.getBoundingClientRect(), cs = getComputedStyle(par);
      const limit = pr.bottom - parseFloat(cs.paddingBottom || 0) - 2;
      const over = stage.getBoundingClientRect().bottom - limit;
      if (over > 0) {
        k = Math.max(0.45, k * (1 - over / stage.getBoundingClientRect().height));
        stage.style.transform = `scale(${k})`;
      }
    }
  }
}

/* ------------------------------- install -------------------------------- */

export function installViewport({ stageId = 'stage', remoteKeys = true } = {}) {
  setVH();
  applyInset();
  document.documentElement.classList.toggle('tv', isTV);

  let raf = null;
  const refit = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      setVH();
      fitStage(document.getElementById(stageId));
      fitStage(document.getElementById('lobby'));
    });
  };
  window.addEventListener('resize', refit);
  // Content grows after a render too (fonts, QR, late data): refit on size change.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(refit);
    for (const id of [stageId, 'lobby']) { const n = document.getElementById(id); if (n) ro.observe(n); }
  }
  window.addEventListener('orientationchange', refit);

  // Remote-control / keyboard adjustment of the inset. Arrow keys are what
  // every TV remote sends; +/- for a keyboard.
  if (remoteKeys) {
    window.addEventListener('keydown', e => {
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      if (e.key === 'ArrowUp' || e.key === '+' || e.key === '=') { setOverscan(inset + 1); e.preventDefault(); }
      if (e.key === 'ArrowDown' || e.key === '-')                 { setOverscan(inset - 1); e.preventDefault(); }
    });
  }

  // Re-fit whenever the stage's content changes.
  for (const id of [stageId, 'lobby']) {
    const n = document.getElementById(id);
    if (n && 'MutationObserver' in window) {
      new MutationObserver(refit).observe(n, { childList: true, subtree: true });
    }
  }
  refit();
  return { refit, isTV };
}
