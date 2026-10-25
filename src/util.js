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
