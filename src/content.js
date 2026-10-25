// ---------------------------------------------------------------------------
// Content packs.
//
// In live mode every pack lives in the database at content/{pack}, keyed by a
// hash of the item, each item carrying `enabled` and `source`. That is where
// the editor writes, and it means the card text never has to sit in the
// public repository. In local mode (no Firebase) the bundled JSON files are
// used directly.
//
// Pack shapes are normalised to { items: [...] } here so engines don't care
// whether a pack was "questions", "prompts", "pairs" or "categories".
// ---------------------------------------------------------------------------

import { getTransport } from './transport.js';
import { hashKey, loadJSON, contentURL } from './util.js';

/** Which top-level key in each JSON file holds the items. */
const SHAPES = {
  trivia:    { file: 'trivia.json',    key: 'questions',  idOf: q => q.q },
  liars:     { file: 'liars.json',     key: 'questions',  idOf: q => q.q },
  fillblank: { file: 'fillblank.json', key: 'prompts',    idOf: p => p.text },
  answers:   { file: 'fillblank.json', key: 'answers',    idOf: a => a },
  quiplash:  { file: 'quiplash.json',  key: 'prompts',    idOf: p => p },
  wyr:       { file: 'wyr.json',       key: 'pairs',      idOf: p => p.a + '|' + p.b },
  likely:    { file: 'likely.json',    key: 'prompts',    idOf: p => p },
  charades:  { file: 'charades.json',  key: 'categories', idOf: c => c.name }
};

export const PACKS = Object.keys(SHAPES);

const cache = new Map();

/** Load one pack's enabled items. */
export async function loadPack(pack) {
  if (cache.has(pack)) return cache.get(pack);
  const t = await getTransport();
  let items = null;

  if (t.mode === 'firebase') {
    const raw = await t.get(`content/${pack}`);
    if (raw && typeof raw === 'object' && Object.keys(raw).length) {
      items = Object.values(raw).filter(x => x && x.enabled !== false).map(x => x.data);
    }
  }
  if (!items) {
    // Local mode, or live mode before the first seed.
    const shape = SHAPES[pack];
    const json = await loadJSON(contentURL(shape.file));
    items = json[shape.key] || [];
  }
  cache.set(pack, items);
  return items;
}

export function clearContentCache() { cache.clear(); }

/* ------------------------------- editing -------------------------------- */

function rowFor(pack, data, source = 'custom') {
  return { data, enabled: true, source, addedAt: Date.now() };
}

/** Push the bundled JSON into the database. Safe to run again: it only adds. */
/** Full packs if present (content-private/, not published), else the sample. */
async function loadSeedFile(file) {
  try {
    const priv = new URL(`../content-private/${file}`, import.meta.url).href;
    const r = await fetch(priv, { cache: 'no-cache' });
    if (r.ok) return r.json();
  } catch {}
  return loadJSON(contentURL(file));
}

export async function seedFromBundle(onProgress = () => {}) {
  const t = await getTransport();
  if (t.mode !== 'firebase') throw new Error('Seeding needs Firebase.');
  let added = 0, kept = 0;
  for (const pack of PACKS) {
    const shape = SHAPES[pack];
    const json = await loadSeedFile(shape.file);
    const items = json[shape.key] || [];
    const existing = (await t.get(`content/${pack}`)) || {};
    const batch = {};
    for (const item of items) {
      const k = hashKey(shape.idOf(item));
      if (existing[k]) { kept++; continue; }
      batch[k] = rowFor(pack, item, 'seed');
      added++;
    }
    if (Object.keys(batch).length) await t.update(`content/${pack}`, batch);
    onProgress(pack, added, kept);
  }
  clearContentCache();
  return { added, kept };
}

/**
 * Replace the bundled content: delete every row that came from a seed, keep
 * anything people added by hand, then seed fresh. For swapping in a new deck.
 */
export async function reseedReplacing(onProgress = () => {}) {
  const t = await getTransport();
  if (t.mode !== 'firebase') throw new Error('Needs Firebase.');
  let removed = 0, keptCustom = 0;
  for (const pack of PACKS) {
    const existing = (await t.get(`content/${pack}`)) || {};
    const patch = {};
    for (const [k, row] of Object.entries(existing)) {
      if (row && row.source === 'custom') { keptCustom++; continue; }
      patch[k] = null; removed++;
    }
    if (Object.keys(patch).length) await t.update(`content/${pack}`, patch);
    onProgress(pack, removed, keptCustom);
  }
  clearContentCache();
  const r = await seedFromBundle(onProgress);
  return { removed, keptCustom, added: r.added };
}

export async function listPack(pack) {
  const t = await getTransport();
  const raw = (await t.get(`content/${pack}`)) || {};
  return Object.entries(raw).map(([key, row]) => ({ key, ...row }))
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

export async function addItem(pack, data) {
  const t = await getTransport();
  const k = hashKey(SHAPES[pack].idOf(data));
  await t.set(`content/${pack}/${k}`, rowFor(pack, data));
  clearContentCache();
  return k;
}

export async function setEnabled(pack, key, enabled) {
  const t = await getTransport();
  await t.update(`content/${pack}/${key}`, { enabled: Boolean(enabled) });
  clearContentCache();
}

export async function removeItem(pack, key) {
  const t = await getTransport();
  await t.remove(`content/${pack}/${key}`);
  clearContentCache();
}

export async function packCounts() {
  const t = await getTransport();
  const out = {};
  for (const pack of PACKS) {
    const raw = (await t.get(`content/${pack}`)) || {};
    const rows = Object.values(raw);
    out[pack] = { total: rows.length, enabled: rows.filter(r => r.enabled !== false).length };
  }
  return out;
}
