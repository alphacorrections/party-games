// ---------------------------------------------------------------------------
// Manage content: seed from the bundle, add, disable, delete.
// ---------------------------------------------------------------------------

import { getTransport } from './transport.js';
import { PACKS, seedFromBundle, reseedReplacing, listPack, addItem, setEnabled, removeItem, packCounts } from './content.js';
import { esc } from './util.js';

const LABELS = {
  trivia: 'Trivia', liars: "Liar's Trivia", fillblank: 'Fill-in prompts', answers: 'Answer cards',
  quiplash: 'Open prompts', wyr: 'Would You Rather', likely: 'Most Likely To', charades: 'Charades'
};

const HELP = {
  trivia:    'Question, four options, which is correct (A–D), and a snarky reveal line.',
  liars:     'A real fact with ____ where the answer goes. The answer must be TRUE and verifiable.',
  fillblank: 'A prompt with ____ for each blank.',
  answers:   'A noun phrase that stays funny in many prompts. Lowercase, no period.',
  quiplash:  'An open prompt people type an answer to.',
  wyr:       'Two options, both bad.',
  likely:    'Completes "Who\'s most likely to…". Lowercase, no period.',
  charades:  'Charades is edited per category below.'
};

const el = id => document.getElementById(id);
let pack = 'trivia';

async function init() {
  const t = await getTransport();
  if (t.mode !== 'firebase') {
    el('status').innerHTML = `<p><b>Local mode.</b> Content editing needs Firebase. The bundled packs are in use.</p>`;
    el('packtabs').hidden = true;
    return;
  }
  await renderStatus();
  renderTabs();
  await renderEditor();
}

async function renderStatus() {
  const counts = await packCounts();
  const total = Object.values(counts).reduce((n, c) => n + c.total, 0);
  if (!total) {
    el('status').innerHTML = `
      <p><b>Nothing in the database yet.</b> Games are using the bundled JSON files. Seed them in
         so you can edit here and remove the text from the repo.</p>
      <button id="seed" class="pbtn primary">Seed all packs into Firebase</button>`;
    el('seed').addEventListener('click', async () => {
      el('seed').disabled = true; el('seed').textContent = 'Seeding…';
      const r = await seedFromBundle((p, a) => { el('seed').textContent = `Seeding… ${p} (${a})`; });
      await renderStatus(); await renderEditor();
    });
  } else {
    const parts = PACKS.map(p => `${LABELS[p]} <b>${counts[p].enabled}</b>${counts[p].total !== counts[p].enabled ? ` <span class="muted">/ ${counts[p].total}</span>` : ''}`);
    el('status').innerHTML = `<p>${parts.join(' &nbsp;·&nbsp; ')}</p>
      <p class="meta">Disabled items stay here but never get dealt. Delete is permanent.
         <button id="seed2" class="linkbtn">Add missing items from bundle</button> &nbsp;
         <button id="seed3" class="linkbtn">Replace bundled deck</button></p>`;
    el('seed2').addEventListener('click', async () => {
      el('seed2').textContent = 'Seeding…';
      const r = await seedFromBundle();
      el('seed2').textContent = `Added ${r.added}, kept ${r.kept}`;
      await renderStatus(); await renderEditor();
    });
    el('seed3').addEventListener('click', async () => {
      if (!confirm('Replace every bundled card with the current deck files? Cards people added by hand are kept.')) return;
      el('seed3').textContent = 'Replacing…';
      const r = await reseedReplacing((p, a) => { el('seed3').textContent = `Replacing… ${p}`; });
      el('seed3').textContent = `Removed ${r.removed}, kept ${r.keptCustom} custom, added ${r.added}`;
      await renderStatus(); await renderEditor();
    });
  }
}

function renderTabs() {
  el('packtabs').innerHTML = PACKS.map(p =>
    `<button class="tab ${p === pack ? 'on' : ''}" data-pack="${p}">${LABELS[p]}</button>`).join('');
}

function formFor(p) {
  const f = {
    trivia: `
      <input name="q" placeholder="Question" required>
      <div class="row4">
        <input name="o0" placeholder="Option A" required><input name="o1" placeholder="Option B" required>
        <input name="o2" placeholder="Option C" required><input name="o3" placeholder="Option D" required>
      </div>
      <div class="row2">
        <select name="answer"><option value="0">A is correct</option><option value="1">B is correct</option><option value="2">C is correct</option><option value="3">D is correct</option></select>
        <input name="note" placeholder="Reveal line (optional)">
      </div>
      <select name="cat">${['Drugs & Booze','Bodies & Medicine','Crime & Law','History','Animals','Sex & Dating','Pop Culture','Grab Bag'].map(c => `<option>${c}</option>`).join('')}</select>`,
    liars: `
      <input name="q" placeholder="Fact with ____ where the answer goes" required>
      <div class="row2"><input name="answer" placeholder="The true answer (lowercase phrase)" required><input name="note" placeholder="Reveal line (optional)"></div>`,
    fillblank: `<input name="text" placeholder="Prompt with ____ for each blank" required>`,
    answers:   `<input name="text" placeholder="an answer card" required>`,
    quiplash:  `<input name="text" placeholder="An open prompt." required>`,
    wyr:       `<div class="row2"><input name="a" placeholder="option one" required><input name="b" placeholder="option two" required></div>`,
    likely:    `<input name="text" placeholder="get banned from a Costco" required>`,
    charades:  `<div class="row2"><input name="cat" placeholder="Category name (existing or new)" required><input name="word" placeholder="word or short phrase" required></div>`
  }[p];
  return `<form id="addform" class="addform">${f}<button class="pbtn primary">Add</button></form>`;
}

function dataFrom(p, fd) {
  const g = k => (fd.get(k) || '').toString().trim();
  switch (p) {
    case 'trivia': return { q: g('q'), options: [g('o0'), g('o1'), g('o2'), g('o3')], answer: Number(g('answer')), note: g('note'), cat: g('cat') || 'Grab Bag' };
    case 'liars':  return { q: g('q'), answer: g('answer').toLowerCase(), note: g('note') };
    case 'fillblank': { const t = g('text'); return { text: t, blanks: Math.max(1, (t.match(/_{2,}/g) || []).length) }; }
    case 'answers': case 'quiplash': case 'likely': return g('text');
    case 'wyr': return { a: g('a'), b: g('b') };
    case 'charades': return { cat: g('cat'), word: g('word') };
  }
}

function describe(p, d) {
  switch (p) {
    case 'trivia': return `<span class="muted">[${esc(d.cat || 'Grab Bag')}]</span> ${esc(d.q)} <span class="muted">→ ${esc(d.options[d.answer])}</span>`;
    case 'liars':  return `${esc(d.q)} <span class="muted">→ ${esc(d.answer)}</span>`;
    case 'fillblank': return esc(d.text);
    case 'wyr': return `${esc(d.a)} <span class="muted">/</span> ${esc(d.b)}`;
    case 'charades': return `<b>${esc(d.name)}</b> <span class="muted">${(d.words || []).length} words</span>`;
    default: return esc(typeof d === 'string' ? d : JSON.stringify(d));
  }
}

async function renderEditor() {
  const rows = await listPack(pack);
  const list = rows.map(r => `
    <div class="rosterrow ${r.enabled === false ? 'off' : ''}">
      <span class="rname">${describe(pack, r.data)}${r.source === 'custom' ? ' <i class="tagc">custom</i>' : ''}</span>
      <button class="linkbtn" data-toggle="${r.key}" data-on="${r.enabled === false ? 1 : 0}">${r.enabled === false ? 'Enable' : 'Disable'}</button>
      <button class="linkbtn" data-del="${r.key}">Delete</button>
    </div>`).join('') || '<p class="muted">Nothing here yet.</p>';
  el('editor').innerHTML = `
    <p class="meta">${HELP[pack]}</p>
    ${formFor(pack)}
    <p class="meta">${rows.length} item${rows.length === 1 ? '' : 's'}</p>
    <div class="list">${list}</div>`;

  el('addform').addEventListener('submit', async e => {
    e.preventDefault();
    const d = dataFrom(pack, new FormData(e.target));
    if (pack === 'charades') {
      // Add a word into an existing category row, or create the category.
      const cats = await listPack('charades');
      const hit = cats.find(c => c.data.name.toLowerCase() === d.cat.toLowerCase());
      if (hit) {
        const words = Array.from(new Set([...(hit.data.words || []), d.word]));
        const t = await getTransport();
        await t.update(`content/charades/${hit.key}`, { data: { ...hit.data, words } });
      } else {
        await addItem('charades', { name: d.cat, emoji: '🎲', blurb: 'Describe it.', words: [d.word] });
      }
    } else {
      await addItem(pack, d);
    }
    await renderStatus(); await renderEditor();
  });
}

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-pack]');
  if (t) { pack = t.dataset.pack; renderTabs(); return renderEditor(); }
  const tg = e.target.closest('[data-toggle]');
  if (tg) { await setEnabled(pack, tg.dataset.toggle, tg.dataset.on === '1'); await renderStatus(); return renderEditor(); }
  const d = e.target.closest('[data-del]');
  if (d && confirm('Delete this item for good?')) { await removeItem(pack, d.dataset.del); await renderStatus(); return renderEditor(); }
});

init().catch(e => { el('status').innerHTML = `<p class="err">${esc(e.message)}</p>`; console.error(e); });
