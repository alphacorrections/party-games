// ---------------------------------------------------------------------------
// BODY COUNT — horror trivia.
//
//   question  -> reveal -> (doom -> trial -> trialEnd)? -> next question ...
//   ... -> escapeIntro -> (escape -> escapeReveal)* -> final
//
// Get a question wrong while alive and you go to the Basement: a short trial
// on your phone. Lose it and you die. The dead keep playing as ghosts (they
// still answer, for smaller payouts) and get a shot at the Escape, the final
// race to the exit with a killer closing in from behind. First one out wins
// the big bonus; a ghost that gets out comes back to life.
//
// Trials that need speed or timing are measured on each phone locally, so
// network lag never decides who lives.
// ---------------------------------------------------------------------------

import { shuffle, esc, playerList, sortedPlayers, timerHTML, finalScoreboard,
         isPresent, sampleUnseen, highlight } from '../util.js';
import { loadPack } from '../content.js';

export const meta = {
  id: 'bodycount',
  name: 'Body Count',
  blurb: 'Trivia where wrong answers go to the Basement. The dead still play.',
  minPlayers: 1,
  defaultRounds: 8
};

/* ------------------------------- tuning -------------------------------- */
const Q_MS        = 20000;
const REVEAL_MS   = 5500;
const DOOM_MS     = 6500;
const TRIAL_END_MS= 7000;
const ESC_INTRO_MS= 9000;
const ESC_Q_MS    = 15000;
const ESC_REV_MS  = 5000;
const ALIVE_PTS   = 1000;
const GHOST_PTS   = 300;
const ESCAPE_LEN  = 7;          // steps from 0 to the exit
const ESCAPE_MAX  = 12;         // finale questions before the furthest wins
const ESCAPE_BONUS= 5000;

/* ------------------------------- trials -------------------------------- */
// Each trial: title, how it reads on the TV, what victims see, its length.
export const TRIALS = {
  door:     { title: 'Pick a Door',     ms: 15000, rules: 'One door has something behind it. Pick one. Nobody picks, you die anyway.' },
  math:     { title: 'Quick Math',      ms: 16000, rules: 'Three problems. Get all three right or die.' },
  clock:    { title: 'Stop the Clock',  ms: 18000, rules: 'Start the clock, then stop it at exactly 5.00 seconds. It goes dark after 1.5.' },
  mash:     { title: 'Mash',            ms: 16000, rules: 'Start, then tap as fast as you can for 5 seconds.' },
  memory:   { title: 'Memory',          ms: 18000, rules: 'Five symbols flash for 3 seconds. Tap them back in order.' },
  lastword: { title: 'Last Word',       ms: 22000, rules: 'Name something in the category. Blank or the same answer as someone else, you die.' },
  vote:     { title: 'The Vote',        ms: 20000, rules: 'Everyone else decides.' }
};
const TRIAL_KEYS = Object.keys(TRIALS);
const MASH_SOLO_MIN  = 32;     // taps in 5s to survive alone
const CLOCK_TARGET   = 5000;
const CLOCK_SOLO_TOL = 450;    // ms off 5.00 allowed when alone
const MEM_SYMBOLS    = ['💀', '🩸', '🕯️', '🔪', '👁️', '🪦'];

const LAST_WORD_CATS = [
  'Things in a medicine cabinet', 'Things you find under a bar', 'Reasons to call 911',
  'Things in a coroner\'s office', 'Ways to get fired', 'Things a cop says',
  'Things in a gas station bathroom', 'Words for being drunk', 'Things at a funeral',
  'Bad tattoo ideas', 'Things you shouldn\'t mix', 'Things in a hospital',
  'Excuses for being late', 'Things in a junk drawer', 'Things that smell bad',
  'Horror movie villains', 'Ways to die in a horror movie', 'Things in a basement',
  'Things you say to a judge', 'Cheap beers', 'Things in a dive bar', 'Fast food chains',
  'Breakfast cereals', 'Things that are sticky', 'Things a dentist uses', 'Pizza toppings',
  'Things at a gas station', 'Car brands', 'Things in a first aid kit', 'Kinds of knives',
  'Things you can catch', 'Things that crawl', 'Places to hide a body (fictional)',
  'Things in a motel room', 'Hangover cures', 'Things on a rap sheet',
  'Last words before something stupid', 'Things that go in a blender', 'Body parts',
  'Things that come in a six-pack', 'Phobias', 'Things in a casket'
];

/* --------------------------------- doom lines --------------------------- */
const DOOM_LINES = [
  'Wrong. Downstairs.', 'The Basement is hungry.', 'Bad answer. Worse night.',
  'Someone left the cellar door open.', 'You hear footsteps. They are yours.',
  'Down you go.'
];
const DEATH_LINES = [
  'didn\'t make it', 'is part of the house now', 'stopped screaming', 'is a ghost now',
  'has been dealt with', 'won\'t be at brunch'
];
const LIVE_LINES = ['crawled back upstairs', 'lived, somehow', 'survived. For now', 'got lucky'];

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

/* --------------------------------- host --------------------------------- */
export class Host {
  constructor(room, opts = {}) {
    this.room = room;
    this.rounds = opts.rounds || meta.defaultRounds;
    this.timer = null;
    this.deck = [];
    this._busy = false;
  }
  get base() { return this.room.base; }

  async load() {
    const all = await loadPack('trivia');
    const want = this.rounds + ESCAPE_MAX;
    this.deck = await sampleUnseen(this.room, 'bodycount', all, want, q => q.q);
    if (!this.deck.length) this.deck = all.slice();
    return this;
  }
  q(i) { return this.deck[i % Math.max(1, this.deck.length)]; }

  async round() { return this.room.t.get(`${this.base}/round`); }
  async patch(p) { return this.room.patchRound(p); }
  after(ms, fn) { clearTimeout(this.timer); this.timer = setTimeout(() => fn.call(this), ms); }

  async begin() {
    await this.room.setGame('bodycount');
    await this.room.setPhase('playing');
    await this.ask(0, { dead: {}, used: [] });
  }

  /** Carry-over state lives on every round so a resumed director has it. */
  carry(r) { return { dead: (r && r.dead) || {}, used: (r && r.used) || [] }; }

  /* ------------------------------ questions ----------------------------- */

  async ask(index, carry) {
    clearTimeout(this.timer);
    if (index >= this.rounds) return this.escapeIntro(carry);
    const q = this.q(index);
    const tagged = shuffle(q.options.map((text, i) => ({ text, ok: i === q.answer })));
    await this.room.clearRoundData();
    await this.room.setRound({
      phase: 'question', index, total: this.rounds,
      q: q.q, cat: q.cat || null, note: q.note || '',
      options: tagged.map(o => o.text), answer: tagged.findIndex(o => o.ok),
      startedAt: Date.now(), deadline: Date.now() + Q_MS,
      ...carry
    });
    this.after(Q_MS, this.reveal);
  }

  /** Everyone present answers: alive and dead. */
  answerers(players) { return playerList(players).filter(isPresent); }

  async onSubmissions(subs, players) {
    const r = await this.round(); if (!r) return;
    const n = Object.keys(subs || {}).length;
    if (r.phase === 'question' || r.phase === 'escape') {
      const need = this.answerers(players).length;
      if (need && n >= need) { clearTimeout(this.timer); return r.phase === 'question' ? this.reveal() : this.escapeReveal(); }
    }
    if (r.phase === 'trial' && r.trial && r.trial.id !== 'vote') {
      const live = (r.victims || []).filter(id => isPresent(players[id]));
      if (live.length && live.every(id => subs && subs[id])) { clearTimeout(this.timer); return this.resolveTrial(); }
    }
  }

  async onVotes(votes, players) {
    const r = await this.round(); if (!r || r.phase !== 'trial' || !r.trial || r.trial.id !== 'vote') return;
    const voters = this.voters(r, players);
    if (voters.length && voters.every(id => votes && votes[id] !== undefined)) { clearTimeout(this.timer); return this.resolveTrial(); }
  }

  voters(r, players) {
    const v = new Set(r.victims || []);
    return playerList(players).filter(isPresent).map(p => p.id).filter(id => !v.has(id));
  }

  async reveal() {
    if (this._busy) return; this._busy = true;
    try {
      const r = await this.round(); if (!r || r.phase !== 'question') return;
      const subs = (await this.room.t.get(`${this.base}/submissions`)) || {};
      const players = await this.room.players();
      const dead = r.dead || {};
      const gained = {}, doomed = [];
      for (const p of playerList(players)) {
        const s = subs[p.id];
        const right = s && Number(s.choice) === r.answer;
        if (dead[p.id]) {
          if (right) { gained[p.id] = GHOST_PTS; await this.room.addScore(p.id, GHOST_PTS); }
          continue;
        }
        if (right) { gained[p.id] = ALIVE_PTS; await this.room.addScore(p.id, ALIVE_PTS); }
        else if (isPresent(p)) doomed.push(p.id);
      }
      await this.patch({ phase: 'reveal', gained, doomed, deadline: Date.now() + REVEAL_MS });
      this.after(REVEAL_MS, this.afterReveal);
    } finally { this._busy = false; }
  }

  async afterReveal() {
    const r = await this.round(); if (!r) return;
    const doomed = r.doomed || [];
    if (!doomed.length) return this.ask(r.index + 1, this.carry(r));
    const players = await this.room.players();
    // Pick a trial we haven't used lately. The Vote needs someone to vote.
    let used = r.used || [];
    const voters = playerList(players).filter(isPresent).filter(p => !doomed.includes(p.id));
    let pool = TRIAL_KEYS.filter(k => !used.includes(k) && (k !== 'vote' || voters.length));
    if (!pool.length) { used = []; pool = TRIAL_KEYS.filter(k => k !== 'vote' || voters.length); }
    const id = pick(pool);
    used = [...used, id].slice(-4);
    const trial = { id, ...this.trialData(id, doomed.length) };
    await this.room.clearRoundData();
    await this.patch({ phase: 'doom', victims: doomed, trial, used, line: pick(DOOM_LINES), deadline: Date.now() + DOOM_MS });
    this.after(DOOM_MS, this.startTrial);
  }

  trialData(id, nVictims) {
    if (id === 'door') return { doors: Math.max(3, nVictims + 1) };
    if (id === 'math') {
      const probs = [];
      for (let i = 0; i < 3; i++) {
        let a, b, op, ans;
        const kind = Math.floor(Math.random() * 3);
        if (kind === 0) { a = 12 + Math.floor(Math.random() * 60); b = 7 + Math.floor(Math.random() * 40); op = '+'; ans = a + b; }
        else if (kind === 1) { a = 40 + Math.floor(Math.random() * 60); b = 6 + Math.floor(Math.random() * 35); op = '−'; ans = a - b; }
        else { a = 3 + Math.floor(Math.random() * 9); b = 3 + Math.floor(Math.random() * 9); op = '×'; ans = a * b; }
        const wrong = new Set();
        while (wrong.size < 2) { const d = (Math.floor(Math.random() * 9) + 1) * (Math.random() < .5 ? -1 : 1); if (ans + d !== ans && ans + d >= 0) wrong.add(ans + d); }
        const choices = shuffle([ans, ...wrong]);
        probs.push({ text: `${a} ${op} ${b}`, choices, answer: choices.indexOf(ans) });
      }
      return { probs };
    }
    if (id === 'memory') {
      const seq = []; for (let i = 0; i < 5; i++) seq.push(Math.floor(Math.random() * MEM_SYMBOLS.length));
      return { seq };
    }
    if (id === 'lastword') return { cat: pick(LAST_WORD_CATS), solo: nVictims === 1 };
    return {};
  }

  async startTrial() {
    const r = await this.round(); if (!r || r.phase !== 'doom') return;
    const ms = TRIALS[r.trial.id].ms;
    await this.room.clearRoundData();
    await this.patch({ phase: 'trial', startedAt: Date.now(), deadline: Date.now() + ms });
    this.after(ms + 1200, this.resolveTrial);      // a little grace for phones finishing locally
  }

  async resolveTrial() {
    if (this._busy) return; this._busy = true;
    try {
      const r = await this.round(); if (!r || r.phase !== 'trial') return;
      const subs = (await this.room.t.get(`${this.base}/submissions`)) || {};
      const votes = (await this.room.t.get(`${this.base}/votes`)) || {};
      const players = await this.room.players();
      const victims = r.victims || [];
      const { die, detail, extra } = judge(r.trial, victims, subs, votes, this.voters(r, players));
      const dead = { ...(r.dead || {}) };
      const outcome = {};
      for (const id of victims) {
        outcome[id] = die.includes(id) ? 'die' : 'live';
        if (die.includes(id)) dead[id] = true;
      }
      for (const id of victims) {
        if (outcome[id] === 'live' && victims.length >= 3) await highlight(this.room, id, `survived ${TRIALS[r.trial.id].title} in the Basement`, 2);
      }
      const lines = {};
      for (const id of victims) lines[id] = outcome[id] === 'die' ? pick(DEATH_LINES) : pick(LIVE_LINES);
      await this.patch({ phase: 'trialEnd', outcome, detail, extra: extra || null, lines, dead, deadline: Date.now() + TRIAL_END_MS });
      this.after(TRIAL_END_MS, async function () { const r2 = await this.round(); if (r2) return this.ask(r2.index + 1, this.carry(r2)); });
    } finally { this._busy = false; }
  }

  /* ------------------------------- escape ------------------------------- */

  async escapeIntro(carry) {
    const players = await this.room.players();
    const dead = carry.dead || {};
    // Living players start ahead, ranked by cash; the dead start at the back.
    const alive = sortedPlayers(players).filter(p => !dead[p.id]);
    const pos = {};
    alive.forEach((p, i) => { pos[p.id] = i === 0 ? 3 : 2; });
    for (const p of playerList(players)) if (dead[p.id]) pos[p.id] = 0;
    await this.room.clearRoundData();
    await this.room.setRound({
      phase: 'escapeIntro', index: this.rounds, total: this.rounds, ...carry,
      escape: { pos, killer: -1, len: ESCAPE_LEN, n: 0 },
      deadline: Date.now() + ESC_INTRO_MS
    });
    this.after(ESC_INTRO_MS, this.escapeAsk);
  }

  async escapeAsk() {
    const r = await this.round(); if (!r || !r.escape) return;
    const esc0 = r.escape;
    if (esc0.n >= ESCAPE_MAX) return this.finishEscape(r, null);
    const q = this.q(this.rounds + esc0.n);
    const tagged = shuffle(q.options.map((text, i) => ({ text, ok: i === q.answer })));
    await this.room.clearRoundData();
    await this.patch({
      phase: 'escape', q: q.q, cat: q.cat || null, note: q.note || '',
      options: tagged.map(o => o.text), answer: tagged.findIndex(o => o.ok),
      moved: null, caught: null, startedAt: Date.now(), deadline: Date.now() + ESC_Q_MS
    });
    this.after(ESC_Q_MS, this.escapeReveal);
  }

  async escapeReveal() {
    if (this._busy) return; this._busy = true;
    try {
      const r = await this.round(); if (!r || r.phase !== 'escape') return;
      const subs = (await this.room.t.get(`${this.base}/submissions`)) || {};
      const pos = { ...r.escape.pos };
      const dead = { ...(r.dead || {}) };
      const moved = {};
      let fastest = null;
      for (const [pid, s] of Object.entries(subs)) {
        if (Number(s.choice) !== r.answer || !(pid in pos)) continue;
        moved[pid] = 1;
        if (!fastest || (s.at || 0) < fastest.at) fastest = { pid, at: s.at || 0 };
      }
      if (fastest) moved[fastest.pid] = 2;
      for (const [pid, n] of Object.entries(moved)) pos[pid] = Math.min(ESCAPE_LEN, (pos[pid] || 0) + n);
      // The killer moves after everyone else.
      const killer = r.escape.killer + 1;
      const caught = [];
      for (const pid of Object.keys(pos)) {
        if (!dead[pid] && pos[pid] < ESCAPE_LEN && pos[pid] <= killer) { dead[pid] = true; caught.push(pid); }
      }
      const out = Object.keys(pos).filter(pid => pos[pid] >= ESCAPE_LEN);
      const escape = { ...r.escape, pos, killer, n: r.escape.n + 1 };
      await this.patch({ phase: 'escapeReveal', escape, dead, moved, caught, fastest: fastest ? fastest.pid : null, deadline: Date.now() + ESC_REV_MS });
      if (out.length) {
        // Tie at the door: the one who answered fastest this question.
        const winner = out.sort((a, b) => ((subs[a] || {}).at || 0) - ((subs[b] || {}).at || 0))[0];
        this.after(ESC_REV_MS, async function () { const r2 = await this.round(); if (r2) return this.finishEscape(r2, winner); });
      } else {
        this.after(ESC_REV_MS, this.escapeAsk);
      }
    } finally { this._busy = false; }
  }

  async finishEscape(r, winner) {
    const pos = r.escape.pos || {};
    if (!winner) {
      const ids = Object.keys(pos).sort((a, b) => pos[b] - pos[a]);
      winner = ids[0] || null;
    }
    const players = await this.room.players();
    const wasDead = winner && (r.dead || {})[winner];
    if (winner) {
      await this.room.addScore(winner, ESCAPE_BONUS);
      await highlight(this.room, winner, wasDead ? 'came back from the dead and escaped' : 'escaped the house', 5);
    }
    const dead = { ...(r.dead || {}) };
    if (winner) delete dead[winner];                 // a ghost that gets out lives again
    await this.patch({ phase: 'escaped', winner, revived: Boolean(wasDead), dead, deadline: Date.now() + 7000 });
    this.after(7000, this.finish);
    return players;
  }

  async finish() {
    clearTimeout(this.timer);
    if (this.onFinish) return this.onFinish();
    await this.room.patchRound({ phase: 'final' });
    await this.room.setPhase('scoreboard');
  }

  /* ----------------------------- plumbing ------------------------------- */

  async nudge(kind, pid) {
    const r = await this.round(); if (!r) return;
    if (kind === 'next') {
      if (r.phase === 'reveal') return this.afterReveal();
      if (r.phase === 'doom') return this.startTrial();
      if (r.phase === 'trialEnd') return this.ask(r.index + 1, this.carry(r));
      if (r.phase === 'escapeIntro') return this.escapeAsk();
      if (r.phase === 'escapeReveal') { const r2 = await this.round(); const out = Object.keys(r2.escape.pos).filter(p => r2.escape.pos[p] >= ESCAPE_LEN); return out.length ? this.finishEscape(r2, out[0]) : this.escapeAsk(); }
    }
    if (kind === 'skip' && pid && (r.phase === 'question' || r.phase === 'escape')) {
      await this.room.submit(pid, { choice: -1, at: Date.now(), skipped: true });
    }
  }

  async resume() {
    const r = await this.round(); if (!r || !r.phase) return;
    const left = Math.max(800, (r.deadline || Date.now()) - Date.now());
    const map = {
      question: this.reveal, reveal: this.afterReveal, doom: this.startTrial, trial: this.resolveTrial,
      trialEnd: async function () { return this.ask(r.index + 1, this.carry(r)); },
      escapeIntro: this.escapeAsk, escape: this.escapeReveal,
      escapeReveal: async function () { const out = Object.keys(r.escape.pos).filter(p => r.escape.pos[p] >= ESCAPE_LEN); return out.length ? this.finishEscape(r, out[0]) : this.escapeAsk(); },
      escaped: this.finish
    };
    if (map[r.phase]) this.after(left, map[r.phase]);
  }

  stop() { clearTimeout(this.timer); }
}

/* ------------------------------ judging -------------------------------- */
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().replace(/(es|s)$/, '');

/**
 * Decide who dies. Returns { die: [ids], detail: {id: text}, extra }.
 * Missing submission = froze = dies (except where noted).
 */
export function judge(trial, victims, subs, votes, voters) {
  const die = [], detail = {};
  const got = id => subs[id];
  const solo = victims.length === 1;

  if (trial.id === 'door') {
    const bad = 1 + Math.floor(Math.random() * trial.doors);
    for (const id of victims) {
      const s = got(id);
      if (!s) { die.push(id); detail[id] = 'froze'; continue; }
      detail[id] = `door ${s.door}`;
      if (Number(s.door) === bad) die.push(id);
    }
    return { die, detail, extra: { bad } };
  }

  if (trial.id === 'math') {
    for (const id of victims) {
      const s = got(id); const n = s ? Number(s.correct) || 0 : 0;
      detail[id] = s ? `${n}/3` : 'froze';
      if (n < 3) die.push(id);
    }
    return { die, detail };
  }

  if (trial.id === 'clock') {
    const err = {};
    for (const id of victims) {
      const s = got(id);
      if (!s || !s.ms) { err[id] = Infinity; detail[id] = 'never stopped it'; continue; }
      err[id] = Math.abs(Number(s.ms) - CLOCK_TARGET);
      detail[id] = `${(Number(s.ms) / 1000).toFixed(2)}s`;
    }
    if (solo) { if (err[victims[0]] > CLOCK_SOLO_TOL) die.push(victims[0]); }
    else {
      const worst = Math.max(...victims.map(id => err[id]));
      for (const id of victims) if (err[id] === worst || err[id] === Infinity) die.push(id);
    }
    return { die, detail };
  }

  if (trial.id === 'mash') {
    const taps = {};
    for (const id of victims) { const s = got(id); taps[id] = s ? Number(s.taps) || 0 : 0; detail[id] = `${taps[id]} taps`; }
    if (solo) { if (taps[victims[0]] < MASH_SOLO_MIN) die.push(victims[0]); }
    else {
      const low = Math.min(...victims.map(id => taps[id]));
      for (const id of victims) if (taps[id] === low) die.push(id);
    }
    return { die, detail, extra: solo ? { need: MASH_SOLO_MIN } : null };
  }

  if (trial.id === 'memory') {
    for (const id of victims) {
      const s = got(id);
      const ok = s && s.ok === true;
      detail[id] = s ? (ok ? 'perfect' : 'wrong order') : 'froze';
      if (!ok) die.push(id);
    }
    return { die, detail };
  }

  if (trial.id === 'lastword') {
    if (trial.solo) {
      const id = victims[0], s = got(id);
      const parts = s ? String(s.text || '').split(/[,\n]+/).map(norm).filter(Boolean) : [];
      const uniq = [...new Set(parts)];
      detail[id] = s ? String(s.text || '').slice(0, 80) : 'nothing';
      if (uniq.length < 3) die.push(id);
      return { die, detail, extra: { need: 3 } };
    }
    const seen = {};
    for (const id of victims) { const s = got(id); const k = s ? norm(s.text) : ''; detail[id] = s ? String(s.text || '').slice(0, 40) : 'nothing'; if (k) (seen[k] = seen[k] || []).push(id); else die.push(id); }
    for (const ids of Object.values(seen)) if (ids.length > 1) die.push(...ids);
    return { die: [...new Set(die)], detail };
  }

  if (trial.id === 'vote') {
    const v = votes || {};
    if (solo) {
      const id = victims[0];
      let kill = 0, spare = 0;
      for (const vid of voters) { if (v[vid] === 'kill') kill++; else if (v[vid] === 'spare') spare++; }
      detail[id] = `${kill} kill · ${spare} spare`;
      if (kill > spare) die.push(id);
      return { die, detail, extra: { kill, spare } };
    }
    const tally = {}; for (const id of victims) tally[id] = 0;
    for (const vid of voters) if (v[vid] in tally) tally[v[vid]]++;
    const top = Math.max(...Object.values(tally));
    const tied = victims.filter(id => tally[id] === top);
    const loser = tied[Math.floor(Math.random() * tied.length)];
    for (const id of victims) detail[id] = `${tally[id]} vote${tally[id] === 1 ? '' : 's'}`;
    if (top > 0 || voters.length) die.push(loser);
    return { die, detail, extra: { tally } };
  }

  return { die, detail };
}

/* -------------------------------- views -------------------------------- */

let subsCache = {}, votesCache = {};
export function setSubmissions(s) { subsCache = s || {}; }
export function setVotes(v) { votesCache = v || {}; }

const letters = ['A', 'B', 'C', 'D'];
const nameOf = (players, id) => (players[id] || {}).name || '?';
const emojiOf = (players, id) => (players[id] || {}).emoji || '💀';
function who(players, id, dead) {
  return `<span class="bc-who ${dead ? 'ghost' : ''}">${dead ? '👻' : emojiOf(players, id)} ${esc(nameOf(players, id))}</span>`;
}

function rosterHTML(players, r) {
  const dead = r.dead || {};
  const list = sortedPlayers(players);
  return `<div class="bc-roster">${list.map(p => `
    <div class="bc-tag ${dead[p.id] ? 'dead' : ''}">${dead[p.id] ? '👻' : (p.emoji || '🎲')}<b>${esc(p.name)}</b><i>${(p.score || 0).toLocaleString()}</i></div>`).join('')}</div>`;
}

function trackHTML(players, r, big = true) {
  const e = r.escape; if (!e) return '';
  const dead = r.dead || {};
  const cells = []; for (let i = 0; i <= e.len; i++) cells.push(`<div class="bc-cell ${i === e.len ? 'exit' : ''} ${i <= e.killer ? 'gone' : ''}">${i === e.len ? '🚪' : ''}</div>`);
  const byPos = {};
  for (const [pid, p] of Object.entries(e.pos || {})) (byPos[p] = byPos[p] || []).push(pid);
  const tokens = Object.entries(e.pos || {}).map(([pid, p]) => {
    const stack = byPos[p].indexOf(pid);
    const pct = (p / e.len) * 100;
    return `<div class="bc-tok ${dead[pid] ? 'ghost' : ''} ${(r.moved || {})[pid] ? 'moved' : ''} ${(r.caught || []).includes(pid) ? 'caught' : ''}"
      style="--x:${pct}%;--s:${stack}">${dead[pid] ? '👻' : emojiOf(players, pid)}<span>${esc(nameOf(players, pid))}</span></div>`;
  }).join('');
  const kpct = Math.max(-8, (e.killer / e.len) * 100);
  return `<div class="bc-track ${big ? 'big' : ''}">
    <div class="bc-cells">${cells.join('')}</div>
    <div class="bc-fog" style="--k:${Math.max(0, kpct)}%"></div>
    <div class="bc-killer" style="--x:${kpct}%">🔪</div>
    ${tokens}
  </div>`;
}

function optionsHTML(r, reveal) {
  return (r.options || []).map((o, i) =>
    `<div class="opt ${reveal ? (i === r.answer ? 'correct' : 'dim') : ''}"><span class="letter">${letters[i]}</span>${esc(o)}</div>`).join('');
}

function waitingChips(players, r, done) {
  const ids = playerList(players).filter(isPresent).map(p => p.id).filter(id => !(done || {})[id]);
  if (!ids.length) return '<div class="waiting done">Everyone\'s in</div>';
  return `<div class="waiting"><span class="wlabel">Waiting on</span>${ids.map(id =>
    `<button class="wchip" data-skip="${id}">${(r.dead || {})[id] ? '👻' : emojiOf(players, id)} ${esc(nameOf(players, id))}</button>`).join('')}</div>`;
}

export function hostView(r, players) {
  players = players || {};
  if (!r) return '<div class="big">…</div>';
  if (r.phase === 'final') return finalScoreboard(players, 'Final scores');
  const dead = r.dead || {};
  const header = `<div class="qmeta bc-kick">Body Count · ${r.phase.startsWith('escape') || r.phase === 'escaped' ? 'The Escape' : `Question ${Math.min(r.index + 1, r.total)} of ${r.total}`}</div>`;

  if (r.phase === 'question' || r.phase === 'reveal') {
    const reveal = r.phase === 'reveal';
    const doomed = r.doomed || [];
    return `<div class="bc">${header}
      ${reveal ? '' : timerHTML(r.deadline, Q_MS)}
      <h1 class="question bc-q">${esc(r.q)}</h1>
      <div class="opts">${optionsHTML(r, reveal)}</div>
      ${reveal ? (doomed.length
        ? `<div class="bc-doomline">To the Basement: ${doomed.map(id => who(players, id)).join(' ')}</div>`
        : '<div class="bc-safe">Nobody goes downstairs. This time.</div>')
        : waitingChips(players, r, subsCache)}
      ${rosterHTML(players, r)}
      ${reveal ? '<button class="nextbtn" data-next="1">Next</button>' : ''}
    </div>`;
  }

  if (r.phase === 'doom') {
    const t = TRIALS[r.trial.id];
    return `<div class="bc bc-doom">
      <div class="bc-line flicker">${esc(r.line || '')}</div>
      <div class="bc-victims">${(r.victims || []).map(id => who(players, id)).join('')}</div>
      <div class="bc-trial-title">${esc(t.title)}</div>
      <p class="bc-rules">${esc(trialRules(r.trial, (r.victims || []).length))}</p>
      ${timerHTML(r.deadline, DOOM_MS)}
    </div>`;
  }

  if (r.phase === 'trial') {
    const t = TRIALS[r.trial.id];
    const victims = r.victims || [];
    let body = '';
    if (r.trial.id === 'vote') {
      const nv = Object.keys(votesCache || {}).length;
      body = `<p class="bc-rules">${victims.length === 1 ? `Kill or spare ${esc(nameOf(players, victims[0]))}? Vote on your phones.` : 'Everyone else: vote on your phones for who dies.'}</p>
        <div class="bc-count">${nv} vote${nv === 1 ? '' : 's'} in</div>`;
    } else if (r.trial.id === 'lastword') {
      body = `<div class="bc-cat">${esc(r.trial.cat)}</div><p class="bc-rules">${r.trial.solo ? 'Three answers. No repeats.' : 'One answer each. Match anyone and you both die.'}</p>`;
    } else body = `<p class="bc-rules">${esc(trialRules(r.trial, victims.length))}</p>`;
    return `<div class="bc bc-doom">
      <div class="bc-trial-title">${esc(t.title)}</div>
      ${timerHTML(r.deadline, t.ms, true)}
      ${body}
      <div class="bc-victims">${victims.map(id => `<div class="bc-v ${subsCache[id] ? 'done' : ''}">${who(players, id)}<i>${subsCache[id] ? 'done' : '…'}</i></div>`).join('')}</div>
    </div>`;
  }

  if (r.phase === 'trialEnd') {
    const t = TRIALS[r.trial.id];
    const rows = (r.victims || []).map(id => {
      const died = r.outcome[id] === 'die';
      return `<div class="bc-res ${died ? 'died' : 'lived'}">
        <div class="bc-res-who">${died ? '💀' : emojiOf(players, id)} ${esc(nameOf(players, id))}</div>
        <div class="bc-res-detail">${esc((r.detail || {})[id] || '')}</div>
        <div class="bc-res-line">${esc((r.lines || {})[id] || '')}</div></div>`;
    }).join('');
    const extra = r.trial.id === 'door' && r.extra ? `<p class="bc-rules">It was behind door ${r.extra.bad}.</p>`
      : r.trial.id === 'mash' && r.extra && r.extra.need ? `<p class="bc-rules">Needed ${r.extra.need}.</p>` : '';
    return `<div class="bc bc-doom">
      <div class="bc-trial-title small">${esc(t.title)}</div>
      ${extra}
      <div class="bc-results">${rows}</div>
      ${rosterHTML(players, r)}
      <button class="nextbtn" data-next="1">Next</button>
    </div>`;
  }

  if (r.phase === 'escapeIntro') {
    return `<div class="bc bc-escape">
      <div class="bc-trial-title flicker">The Escape</div>
      <p class="bc-rules">Right answers move you toward the door. Fastest right answer moves two. The killer moves every question. If it reaches you, you die. First one out wins ${ESCAPE_BONUS.toLocaleString()}. The dead can get out too.</p>
      ${trackHTML(players, r)}
      <button class="nextbtn" data-next="1">Start</button>
    </div>`;
  }

  if (r.phase === 'escape' || r.phase === 'escapeReveal') {
    const reveal = r.phase === 'escapeReveal';
    const caught = r.caught || [];
    return `<div class="bc bc-escape">${header}
      ${trackHTML(players, r)}
      ${reveal ? '' : timerHTML(r.deadline, ESC_Q_MS)}
      <h1 class="question bc-q small">${esc(r.q || '')}</h1>
      <div class="opts">${optionsHTML(r, reveal)}</div>
      ${reveal && caught.length ? `<div class="bc-doomline">Caught: ${caught.map(id => who(players, id)).join(' ')}</div>` : ''}
      ${reveal && r.fastest ? `<div class="bc-safe">Fastest: ${who(players, r.fastest, dead[r.fastest])} moves two</div>` : ''}
      ${reveal ? '' : waitingChips(players, r, subsCache)}
      ${reveal ? '<button class="nextbtn" data-next="1">Next</button>' : ''}
    </div>`;
  }

  if (r.phase === 'escaped') {
    return `<div class="bc bc-escape">
      <div class="bc-trial-title">${r.winner ? `${esc(nameOf(players, r.winner))} got out` : 'Nobody got out'}</div>
      <p class="bc-rules">${r.revived ? 'Back from the dead. ' : ''}+${ESCAPE_BONUS.toLocaleString()}</p>
      ${trackHTML(players, r)}
    </div>`;
  }
  return '';
}

function trialRules(trial, n) {
  if (trial.id === 'door') return `${trial.doors} doors. One of them is wrong. Pick fast.`;
  if (trial.id === 'clock') return n === 1 ? `Stop it within ${(CLOCK_SOLO_TOL / 1000).toFixed(2)}s of 5.00 or die.` : 'Furthest from 5.00 dies.';
  if (trial.id === 'mash') return n === 1 ? `Hit ${MASH_SOLO_MIN} taps in 5 seconds or die.` : 'Fewest taps dies.';
  if (trial.id === 'vote') return n === 1 ? 'Everyone else votes: kill or spare.' : 'Everyone else votes. Most votes dies.';
  if (trial.id === 'lastword') return trial.solo ? `Name three things: ${trial.cat}.` : `One answer: ${trial.cat}. Match someone and you both die.`;
  return TRIALS[trial.id].rules;
}

/* ------------------------------ phone views ---------------------------- */

export function playerView(r, me, submitted, voted, players, extra = {}) {
  players = players || {};
  const mirror = extra.mirror;
  if (!r) return '<div class="pcard">…</div>';
  const dead = (r.dead || {})[me.id];
  const wrap = (inner, cls = '') => `<div class="pcard bc-p ${dead ? 'ghostmode' : ''} ${cls}">${dead ? '<div class="bc-ghostbadge">👻 You\'re dead. Keep answering.</div>' : ''}${inner}</div>`;

  if (r.phase === 'question' || r.phase === 'escape') {
    const pos = r.escape ? (r.escape.pos || {})[me.id] : null;
    const status = r.escape ? `<p class="phint bc-status">${pos >= r.escape.len ? 'You\'re out.' : `${r.escape.len - pos} to the door · killer ${Math.max(0, pos - r.escape.killer)} behind`}</p>` : '';
    if (submitted) return wrap(`<h2>Locked in</h2>${status}${mirror ? timerHTML(r.deadline, r.phase === 'escape' ? ESC_Q_MS : Q_MS) : ''}`);
    const btns = (r.options || []).map((o, i) =>
      `<button class="pbtn" data-action="choose" data-choice="${i}"><span class="letter">${letters[i]}</span>${esc(o)}</button>`).join('');
    return wrap(`${mirror ? `${timerHTML(r.deadline, r.phase === 'escape' ? ESC_Q_MS : Q_MS)}<h2 class="small-h">${esc(r.q)}</h2>` : `<p class="phint">${dead ? `Ghosts score ${GHOST_PTS}.` : 'Wrong goes downstairs.'}</p>`}${status}${btns}`);
  }

  if (r.phase === 'reveal') {
    const g = (r.gained || {})[me.id] || 0;
    const doomed = (r.doomed || []).includes(me.id);
    const right = mirror ? `<p class="phint">Answer: <b>${esc((r.options || [])[r.answer] || '')}</b></p>` : '';
    if (doomed) return wrap(`<h2 class="losec flicker">Wrong.</h2><p>You're going to the Basement.</p>${right}`, 'bc-doomed');
    return wrap(`<h2 class="${g ? 'winc' : ''}">${g ? `+${g}` : dead ? 'Nope' : 'Safe'}</h2>${right}`);
  }

  if (r.phase === 'doom') {
    const mine = (r.victims || []).includes(me.id);
    const t = TRIALS[r.trial.id];
    if (mine) return wrap(`<div class="bc-trial-title small">${esc(t.title)}</div><p>${esc(trialRules(r.trial, r.victims.length))}</p><p class="phint">Get ready.</p>${timerHTML(r.deadline, DOOM_MS)}`, 'bc-doomed');
    return wrap(`<h2>The Basement</h2><p>${(r.victims || []).map(id => esc(nameOf(players, id))).join(', ')} ${r.victims.length === 1 ? 'is' : 'are'} going down for ${esc(t.title)}.</p>`);
  }

  if (r.phase === 'trial') return trialPhone(r, me, submitted, voted, players, wrap);

  if (r.phase === 'trialEnd') {
    const mine = (r.victims || []).includes(me.id);
    if (mine) {
      const died = r.outcome[me.id] === 'die';
      return wrap(died ? `<h2 class="losec">You died.</h2><p>${esc((r.detail || {})[me.id] || '')}</p><p class="phint">Ghosts still answer and still score. And the dead can still win the Escape.</p>`
                       : `<h2 class="winc">You lived.</h2><p>${esc((r.detail || {})[me.id] || '')}</p>`, died ? 'bc-doomed' : '');
    }
    const deaths = (r.victims || []).filter(id => r.outcome[id] === 'die');
    return wrap(`<h2>${deaths.length ? `${deaths.length} dead` : 'Everyone lived'}</h2><p>${deaths.map(id => esc(nameOf(players, id))).join(', ')}</p>`);
  }

  if (r.phase === 'escapeIntro') return wrap(`<h2 class="flicker">The Escape</h2><p>Right answers move you toward the door. Fastest moves two. The killer moves every question. First one out wins.</p>${mirror ? trackHTML(players, r, false) : ''}`);
  if (r.phase === 'escapeReveal') {
    const pos = (r.escape.pos || {})[me.id] || 0;
    const caught = (r.caught || []).includes(me.id);
    return wrap(`<h2 class="${caught ? 'losec' : ''}">${caught ? 'It got you.' : (r.moved || {})[me.id] ? `+${r.moved[me.id]}` : 'No move'}</h2>
      <p>${pos >= r.escape.len ? 'You made it out.' : `${r.escape.len - pos} to the door.`}</p>${mirror ? trackHTML(players, r, false) : ''}`);
  }
  if (r.phase === 'escaped') return wrap(`<h2>${r.winner === me.id ? 'You got out.' : `${esc(nameOf(players, r.winner))} got out.`}</h2>`);
  return wrap('<p>…</p>');
}

function trialPhone(r, me, submitted, voted, players, wrap) {
  const t = r.trial;
  const victims = r.victims || [];
  const mine = victims.includes(me.id);
  const timer = timerHTML(r.deadline, TRIALS[t.id].ms);

  if (t.id === 'vote') {
    if (mine) return wrap(`<div class="bc-trial-title small">The Vote</div><p>Everyone else is deciding.</p><p class="phint">Plead your case. Out loud.</p>${timer}`, 'bc-doomed');
    if (voted) return wrap(`<h2>Voted</h2>${timer}`);
    const btns = victims.length === 1
      ? `<p>${esc(nameOf(players, victims[0]))}: kill or spare?</p>
         <button class="pbtn bc-kill" data-action="vote" data-slot="kill">🔪 Kill</button>
         <button class="pbtn" data-action="vote" data-slot="spare">🙏 Spare</button>`
      : `<p>Who dies?</p>${victims.map(id => `<button class="pbtn bc-kill" data-action="vote" data-slot="${id}">${emojiOf(players, id)} ${esc(nameOf(players, id))}</button>`).join('')}`;
    return wrap(`<div class="bc-trial-title small">The Vote</div>${timer}${btns}`);
  }

  if (!mine) return wrap(`<h2>${esc(TRIALS[t.id].title)}</h2><p>${victims.map(id => esc(nameOf(players, id))).join(', ')} ${victims.length === 1 ? 'is' : 'are'} in the Basement. Enjoy it.</p>${timer}`);
  if (submitted) return wrap(`<h2>Done</h2><p>Waiting to find out.</p>${timer}`, 'bc-doomed');

  const head = `<div class="bc-trial-title small">${esc(TRIALS[t.id].title)}</div>`;
  if (t.id === 'door') {
    const doors = []; for (let i = 1; i <= t.doors; i++) doors.push(`<button class="bc-door" data-action="door" data-door="${i}">🚪<b>${i}</b></button>`);
    return wrap(`${head}${timer}<div class="bc-doors">${doors.join('')}</div>`, 'bc-doomed');
  }
  if (t.id === 'lastword') {
    return wrap(`${head}${timer}<div class="bc-cat">${esc(t.cat)}</div>
      <textarea class="ptext" data-role="answer" maxlength="200" placeholder="${t.solo ? 'Three answers, separated by commas' : 'One answer'}"></textarea>
      <button class="pbtn primary" data-action="lastword">Lock it in</button>`, 'bc-doomed');
  }
  // Live widgets: math, clock, mash, memory. Mounted by mountPlayer().
  return wrap(`${head}${timer}<div class="bc-live" data-live="${t.id}" data-key="${r.index}-${t.id}"></div>`, 'bc-doomed');
}

/* --------------------------- live phone widgets ------------------------ */
// Rendered once and owned by the widget until it submits. play.js leaves
// [data-live] screens alone between renders.

export function mountPlayer(stage, ctx) {
  const box = stage.querySelector('[data-live]');
  if (!box || box.dataset.mounted) return;
  box.dataset.mounted = '1';
  const r = ctx.round, t = r.trial;
  const send = payload => ctx.room.submit(ctx.me.id, payload);
  const fx = ctx.fx || {};
  const tap = () => { try { fx.sound?.tap(); fx.haptic?.tap(); } catch {} };

  if (t.id === 'math') {
    let i = 0, correct = 0;
    const show = () => {
      if (i >= t.probs.length) { box.innerHTML = `<h2>${correct}/3</h2>`; send({ correct, at: Date.now() }); return; }
      const p = t.probs[i];
      box.innerHTML = `<div class="bc-prob">${esc(p.text)} = ?</div><div class="bc-choices">${p.choices.map((c, k) => `<button class="pbtn" data-k="${k}">${c}</button>`).join('')}</div><p class="phint center">${i + 1} of 3</p>`;
      box.querySelectorAll('[data-k]').forEach(b => b.addEventListener('pointerdown', e => {
        e.preventDefault(); tap(); if (Number(b.dataset.k) === p.answer) correct++; i++; show();
      }, { once: true }));
    };
    show();
  }

  if (t.id === 'clock') {
    box.innerHTML = `<div class="bc-clock" data-c>0.00</div><button class="hugebtn got" data-go>START</button>`;
    const c = box.querySelector('[data-c]'), go = box.querySelector('[data-go]');
    let t0 = 0, raf = 0;
    const loop = () => { const el = performance.now() - t0; c.textContent = el < 1500 ? (el / 1000).toFixed(2) : '?.??'; raf = requestAnimationFrame(loop); };
    go.addEventListener('pointerdown', e => {
      e.preventDefault(); tap();
      if (!t0) { t0 = performance.now(); go.textContent = 'STOP'; go.classList.replace('got', 'skip'); loop(); return; }
      const ms = Math.round(performance.now() - t0); cancelAnimationFrame(raf);
      c.textContent = (ms / 1000).toFixed(2); go.disabled = true; send({ ms, at: Date.now() });
    });
  }

  if (t.id === 'mash') {
    box.innerHTML = `<div class="bc-clock" data-n>0</div><button class="hugebtn got bc-mash" data-go>START</button><p class="phint center" data-h>Tap START, then mash the button.</p>`;
    const n = box.querySelector('[data-n]'), go = box.querySelector('[data-go]'), h = box.querySelector('[data-h]');
    let taps = 0, started = false, done = false;
    go.addEventListener('pointerdown', e => {
      e.preventDefault(); if (done) return;
      if (!started) {
        started = true; go.textContent = 'MASH'; h.textContent = '5 seconds. Go.';
        setTimeout(() => { done = true; go.disabled = true; h.textContent = 'Time.'; send({ taps, at: Date.now() }); }, 5000);
        return;
      }
      taps++; n.textContent = taps; try { fx.haptic?.tap(); } catch {}
    });
  }

  if (t.id === 'memory') {
    box.innerHTML = `<button class="hugebtn got" data-go>I'M READY</button>`;
    box.querySelector('[data-go]').addEventListener('pointerdown', e => {
      e.preventDefault(); tap();
      box.innerHTML = `<div class="bc-seq">${t.seq.map(k => `<span>${MEM_SYMBOLS[k]}</span>`).join('')}</div>`;
      setTimeout(() => {
        const got = [];
        const paint = () => {
          box.innerHTML = `<div class="bc-seq input">${got.map(k => `<span>${MEM_SYMBOLS[k]}</span>`).join('')}${'<span class="empty">·</span>'.repeat(t.seq.length - got.length)}</div>
            <div class="bc-pad">${MEM_SYMBOLS.map((s, k) => `<button class="pbtn" data-k="${k}">${s}</button>`).join('')}</div>`;
          box.querySelectorAll('[data-k]').forEach(b => b.addEventListener('pointerdown', ev => {
            ev.preventDefault(); tap(); got.push(Number(b.dataset.k));
            const ok = got.every((k, j) => k === t.seq[j]);
            if (!ok || got.length === t.seq.length) { send({ ok, at: Date.now() }); box.innerHTML = `<h2>${ok ? 'Perfect.' : 'Wrong.'}</h2>`; return; }
            paint();
          }, { once: true }));
        };
        paint();
      }, 3000);
    }, { once: true });
  }
}

/* ------------------------------- actions ------------------------------- */

export function scoreboard(players, title = 'Scores') { return finalScoreboard(players, title); }

export async function handleAction(room, me, action, r) {
  if (!r) return;
  if (action.action === 'choose' && (r.phase === 'question' || r.phase === 'escape')) {
    await room.submit(me.id, { choice: Number(action.choice), at: Date.now() });
    return { rerender: true };
  }
  if (r.phase !== 'trial') return;
  if (action.action === 'door' && (r.victims || []).includes(me.id)) {
    await room.submit(me.id, { door: Number(action.door), at: Date.now() });
    return { rerender: true };
  }
  if (action.action === 'lastword' && (r.victims || []).includes(me.id)) {
    const ta = document.querySelector('[data-role="answer"]');
    await room.submit(me.id, { text: (ta ? ta.value : '').trim().slice(0, 200), at: Date.now() });
    return { rerender: true };
  }
  if (action.action === 'vote' && r.trial.id === 'vote' && !(r.victims || []).includes(me.id)) {
    await room.vote(me.id, action.slot);
    return { rerender: true };
  }
}
