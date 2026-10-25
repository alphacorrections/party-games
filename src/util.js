// Shared helpers.

export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function sample(arr, n) {
  return shuffle(arr).slice(0, n);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function sortedPlayers(players) {
  return Object.entries(players || {})
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}

export function playerList(players) {
  return Object.entries(players || {}).map(([id, p]) => ({ id, ...p }));
}

export function countdown(deadline) {
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

/** Fill "____" placeholders in a prompt with answers, bolding the inserts. */
export function fillBlanks(text, answers) {
  let i = 0;
  const filled = String(text).replace(/_{2,}/g, () => {
    const a = answers[i++];
    return a ? `<b class="fill">${esc(a)}</b>` : '<b class="fill">____</b>';
  });
  // If the prompt had no blank, append the answer instead.
  if (i === 0 && answers[0]) return `${esc(text)} <b class="fill">${esc(answers[0])}</b>`;
  return filled;
}

export async function loadJSON(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
  return res.json();
}

/** Resolve content paths relative to the site root, works on project Pages. */
export function contentURL(file) {
  return new URL(`../content/${file}`, import.meta.url).href;
}

/**
 * Countdown timer markup: a ring that drains plus the number. host.js's tick
 * loop drives both via data attributes. `totalMs` sizes the ring.
 */
export function timerHTML(deadline, totalMs, big = false) {
  const left = countdown(deadline);
  return `<div class="timer ${big ? 'big' : ''}" data-deadline="${deadline}" data-total="${Math.round(totalMs / 1000)}">
    <svg class="tring" viewBox="0 0 36 36" aria-hidden="true">
      <circle class="track" cx="18" cy="18" r="15.9"></circle>
      <circle class="prog"  cx="18" cy="18" r="15.9" pathLength="100"></circle>
    </svg>
    <span class="tnum">${left}</span>
  </div>`;
}

/** Final-scores screen. First place is the hero; the rest are the list. */
export function finalScoreboard(players, title = 'Final scores') {
  const ranked = sortedPlayers(players);
  if (!ranked.length) return `<h1 class="question">${esc(title)}</h1>`;
  const [w, ...rest] = ranked;
  const tie = rest.length && (rest[0].score || 0) === (w.score || 0);
  const rows = rest.map((p, i) => `
    <div class="srow">
      <span class="rank">${i + 2}</span>
      <span class="emoji">${p.emoji || '🎲'}</span>
      <span class="sname">${esc(p.name)}</span>
      <span class="spts">${p.score || 0}</span>
    </div>`).join('');
  return `
    <div class="podium">
      <div class="crown">👑</div>
      <div class="wemoji">${w.emoji || '🎲'}</div>
      <div class="wname">${esc(w.name)}</div>
      <div class="wpts"><span class="spts">${w.score || 0}</span></div>
      <div class="wsub">${tie ? 'Tied, but listed first. Settle it yourselves.' : 'Winner'}</div>
    </div>
    <div class="scores rest">${rows}</div>`;
}
