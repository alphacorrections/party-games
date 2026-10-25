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
export function finalScoreboard(players, title = 'Final scores', highlights = null) {
  const ranked = sortedPlayers(players);
  const moments = highlights ? bestMoments(highlights, players) : [];
  const momentsHTML = moments.length ? `<div class="moments">${moments.map(m =>
    `<div class="moment"><span>${m.emoji || ''}</span><b>${esc(m.name)}</b> ${esc(m.text)}</div>`).join('')}</div>` : '';
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
    <div class="scores rest">${rows}</div>
    ${momentsHTML}`;
}

/* ------------------------------ waiting on ------------------------------ */

/**
 * Who hasn't acted yet this phase. `done` is the submissions or votes map;
 * `exclude` is anyone who isn't expected to act (a judge, a disconnected
 * player, someone with no hand).
 */
const PRESENCE_STALE_MS = 25000;   // heartbeat is 8s; 3 missed = gone

/** True if this player looks present: flagged connected and recently seen. */
export function isPresent(p) {
  if (!p || p.connected === false) return false;
  if (p.lastSeen && Date.now() - p.lastSeen > PRESENCE_STALE_MS) return false;
  return true;
}

export function pendingPlayers(players, done, exclude = []) {
  const doneIds = new Set(Object.keys(done || {}));
  return playerList(players)
    .filter(p => isPresent(p) && !doneIds.has(p.id) && !exclude.includes(p.id));
}

/** Chips naming who we're waiting on; the host can tap one to skip them. */
export function waitingHTML(pending, { skippable = false } = {}) {
  if (!pending.length) return '<div class="waiting done">Everyone\'s in</div>';
  const chips = pending.map(p =>
    `<span class="wchip" ${skippable ? `data-skip="${p.id}" title="Skip ${esc(p.name)}"` : ''}>
       <span>${p.emoji || '🎲'}</span>${esc(p.name)}</span>`).join('');
  return `<div class="waiting"><span class="wlabel">Waiting on</span>${chips}</div>`;
}

/** Reveal pacing: a base plus a bit per thing people have to read. */
export function revealMs(items, { base = 4500, per = 1400, max = 16000 } = {}) {
  return Math.min(max, base + per * Math.max(0, items));
}

/* ------------------------------ no repeats ------------------------------ */

/**
 * Sample `n` items from `pool`, preferring ones this room hasn't seen. Seen
 * keys live at rooms/{code}/seen/{bucket} and reset when the pool is used up,
 * so a long night never runs dry — it just starts over.
 */
export async function sampleUnseen(room, bucket, pool, n, keyOf = x => JSON.stringify(x)) {
  const path = `${room.base}/seen/${bucket}`;
  let seen = (await room.t.get(path)) || {};
  let fresh = pool.filter(x => !seen[hashKey(keyOf(x))]);
  if (fresh.length < n) {              // exhausted: start the cycle again
    seen = {};
    fresh = pool.slice();
  }
  const picked = shuffle(fresh).slice(0, n);
  for (const x of picked) seen[hashKey(keyOf(x))] = true;
  await room.t.set(path, seen);
  return picked;
}

/** Short stable key safe for a Firebase path segment. */
export function hashKey(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return 'k' + (h >>> 0).toString(36);
}

/** Round header with a final-round callout. */
export function roundMeta(index, total, noun = 'Round') {
  const last = total && index === total - 1;
  return `<div class="qmeta ${last ? 'final' : ''}">${last ? 'Final round' : `${noun} ${index + 1} of ${total}`}</div>`;
}

/* ------------------------------ highlights ------------------------------ */

/**
 * Engines call this at memorable moments. The final screen shows one per
 * player, picked by `weight`. Stored at rooms/{code}/highlights/{id}.
 */
export async function highlight(room, pid, text, weight = 1) {
  if (!room || !pid || !text) return;
  try { await room.t.set(`${room.base}/highlights/${hashKey(pid + text + Date.now())}`, { pid, text, weight, at: Date.now() }); } catch {}
}

export function bestMoments(highlights, players) {
  const by = {};
  for (const h of Object.values(highlights || {})) {
    if (!by[h.pid] || h.weight > by[h.pid].weight) by[h.pid] = h;
  }
  return Object.entries(by).map(([pid, h]) => ({ pid, name: players[pid]?.name, emoji: players[pid]?.emoji, text: h.text }))
    .filter(x => x.name);
}
