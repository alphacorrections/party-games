// ---------------------------------------------------------------------------
// DOUBLE DOWN — a quiz-show board. Solo or teams.
//
//   board -> clue (buzz) -> answer -> (rebuzz | result) -> board ...
//   hidden square: wager -> answer -> result
//   ... -> lastWager -> lastClue -> lastReveal -> final
//
// Whoever has control picks a square on their phone. Everyone can buzz; the
// first buzz to reach the director answers from four options. Right: the
// money and control. Wrong: lose it, and the clue reopens to everyone else.
// Buzz order is the order the director hears them, not phone clocks, which
// can be seconds apart.
//
// Teams: money goes to every member of the team, so team totals and personal
// totals match and the all-time leaderboard still works.
// ---------------------------------------------------------------------------

import { shuffle, esc, playerList, sortedPlayers, timerHTML, finalScoreboard,
         isPresent, sampleUnseen, highlight } from '../util.js';
import { loadPack } from '../content.js';

export const meta = {
  id: 'doubledown',
  name: 'Double Down',
  blurb: 'Pick a square. Buzz first. Wrong answers cost you.',
  minPlayers: 1,
  defaultRounds: 5          // columns on the board; rows are fixed at 5
};

const ROWS       = 5;
const VALUES     = [200, 400, 600, 800, 1000];
const READ_MS    = 2500;    // clue shows before buzzing opens
const BUZZ_MS    = 12000;
const ANSWER_MS  = 9000;
const RESULT_MS  = 4500;
const WAGER_MS   = 15000;
const LAST_Q_MS  = 25000;
const LAST_REV_MS= 9000;
const LAST_FLOOR = 500;     // Last Call: you can always wager at least this

const TEAM_SETS = {
  2: [{ id: 'A', name: 'Team Relapse', emoji: '🟥' }, { id: 'B', name: 'Team Sober', emoji: '🟦' }],
  3: [{ id: 'A', name: 'Team Relapse', emoji: '🟥' }, { id: 'B', name: 'Team Sober', emoji: '🟦' }, { id: 'C', name: 'Team Court-Ordered', emoji: '🟩' }]
};
const MODES = [
  { name: 'Solo',    emoji: '👤', blurb: 'Every player for themselves', teams: 0 },
  { name: '2 Teams', emoji: '⚔️', blurb: 'Split the room in two',        teams: 2 },
  { name: '3 Teams', emoji: '🔺', blurb: 'Three-way war',                 teams: 3 }
];

export class Host {
  constructor(room, opts = {}) {
    this.room = room;
    this.cols = Math.max(3, Math.min(6, opts.rounds || meta.defaultRounds));
    const m = MODES.find(x => x.name === opts.category) || MODES[0];
    this.nTeams = m.teams;
    this.timer = null;
    this._busy = false;
  }
  get base() { return this.room.base; }
  after(ms, fn) { clearTimeout(this.timer); this.timer = setTimeout(() => fn.call(this), ms); }
  async round() { return this.room.t.get(`${this.base}/round`); }
  async patch(p) { return this.room.patchRound(p); }

  static async listCategories() { return MODES.map(m => ({ name: m.name, emoji: m.emoji, blurb: m.blurb, count: '' })); }

  async load() {
    const all = await loadPack('trivia');
    const byCat = {};
    for (const q of all) (byCat[q.cat || 'Grab Bag'] = byCat[q.cat || 'Grab Bag'] || []).push(q);
    let cats = shuffle(Object.keys(byCat).filter(c => byCat[c].length >= ROWS));
    if (!cats.length) cats = Object.keys(byCat);
    cats = cats.slice(0, this.cols);
    this.board = [];
    for (const c of cats) {
      const qs = await sampleUnseen(this.room, `dd-${c.replace(/\W+/g, '-')}`, byCat[c], ROWS + (c === cats[0] ? 1 : 0), q => q.q);
      this.board.push({ cat: c, qs });
    }
    // Last Call comes from whichever category has a spare question.
    const spareCat = cats[0];
    this.last = (this.board[0].qs[ROWS]) || shuffle(all)[0];
    this.lastCat = spareCat;
    return this;
  }

  /* ------------------------------- setup -------------------------------- */
  async begin() {
    await this.room.setGame('doubledown');
    await this.room.setPhase('playing');
    const players = await this.room.players();
    const ids = shuffle(playerList(players).map(p => p.id));
    let teams = null, teamOf = null;
    if (this.nTeams) {
      teams = {}; teamOf = {};
      for (const t of TEAM_SETS[this.nTeams]) teams[t.id] = { ...t, members: [] };
      ids.forEach((id, i) => { const t = TEAM_SETS[this.nTeams][i % this.nTeams].id; teams[t].members.push(id); teamOf[id] = t; });
    }
    // Public board: what's left, without the answers.
    const cells = {};
    this.board.forEach((col, c) => { for (let r = 0; r < ROWS; r++) cells[`${c}_${r}`] = true; });
    const keys = Object.keys(cells).filter(k => Number(k.split('_')[1]) >= 2);   // hidden square lives in the pricier rows
    const hidden = shuffle(keys).slice(0, this.cols >= 6 ? 2 : 1);
    this.hidden = new Set(hidden);
    const control = this.nTeams ? Object.keys(teams)[0] : ids[0];
    await this.room.clearRoundData();
    await this.room.setRound({
      phase: 'board', cats: this.board.map(b => b.cat), rows: ROWS, values: VALUES,
      cells, hidden, teams, teamOf, control, index: 0, total: this.cols * ROWS,
      deadline: null
    });
  }

  /** Who a player answers for: their team id, or themselves. */
  side(r, pid) { return r.teamOf ? (r.teamOf[pid] || null) : pid; }
  sideMembers(r, side, players) {
    if (r.teams) return (r.teams[side] || {}).members || [];
    return [side];
  }
  async award(r, side, delta) {
    for (const id of this.sideMembers(r, side)) await this.room.addScore(id, delta);
  }

  async onPlayers(players) {
    const r = await this.round(); if (!r || !r.teams) return;
    const teamOf = { ...(r.teamOf || {}) }, teams = JSON.parse(JSON.stringify(r.teams));
    let changed = false;
    for (const p of playerList(players)) {
      if (teamOf[p.id]) continue;
      const smallest = Object.values(teams).sort((a, b) => (a.members || []).length - (b.members || []).length)[0];
      smallest.members = [...(smallest.members || []), p.id]; teamOf[p.id] = smallest.id; changed = true;
    }
    if (changed) await this.patch({ teams, teamOf });
  }

  /* ------------------------------- picking ------------------------------ */
  async onIntent(intent) {
    if (!intent) return;
    const r = await this.round(); if (!r) return;
    if (intent.action === 'ddpick' && r.phase === 'board') {
      if (this.side(r, intent.by) !== r.control) return;
      return this.openCell(r, intent.cell, intent.by);
    }
    if (intent.action === 'ddwager' && (r.phase === 'wager' || r.phase === 'lastWager')) {
      return this.takeWager(r, intent.by, Number(intent.amount) || 0);
    }
  }

  async openCell(r, key, by) {
    if (!r.cells || !r.cells[key]) return;
    const [c, row] = key.split('_').map(Number);
    const q = this.board[c].qs[row]; if (!q) return;
    const tagged = shuffle(q.options.map((text, i) => ({ text, ok: i === q.answer })));
    const cells = { ...r.cells, [key]: false };
    const clue = { key, cat: this.board[c].cat, value: VALUES[row], q: q.q, options: tagged.map(o => o.text), answer: tagged.findIndex(o => o.ok), note: q.note || '' };
    await this.room.clearRoundData();
    if ((r.hidden || []).includes(key)) {
      const players = await this.room.players();
      const bank = this.bankOf(r, r.control, players);
      await this.patch({ phase: 'wager', cells, clue, picker: by, wagerSide: r.control, maxWager: Math.max(1000, bank), wager: null, locked: [], buzz: null, result: null, deadline: Date.now() + WAGER_MS });
      this.after(WAGER_MS, function () { return this.takeWager(null, by, 0); });
      return;
    }
    await this.patch({ phase: 'clue', cells, clue, picker: by, locked: [], buzz: null, result: null, opensAt: Date.now() + READ_MS, deadline: Date.now() + READ_MS + BUZZ_MS });
    this.after(READ_MS + BUZZ_MS, this.noBuzz);
  }

  bankOf(r, side, players) {
    const ids = this.sideMembers(r, side);
    const p = players[ids[0]]; return p ? (p.score || 0) : 0;
  }

  /* ------------------------------ buzzing ------------------------------- */
  async onSubmissions(subs, players) {
    const r = await this.round(); if (!r) return;
    if (r.phase === 'clue') {
      // First buzz we hear wins. Among ones that arrived together, lowest phone time.
      const fresh = Object.entries(subs || {}).filter(([pid, s]) => s && s.buzz && !(r.locked || []).includes(this.side(r, pid)) && this.side(r, pid));
      if (!fresh.length) return;
      fresh.sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
      return this.takeBuzz(fresh[0][0]);
    }
    if (r.phase === 'answer' && subs && subs[r.buzz] && subs[r.buzz].choice !== undefined) { clearTimeout(this.timer); return this.judge(); }
    if (r.phase === 'wagerAnswer' && subs && subs[r.picker] && subs[r.picker].choice !== undefined) { clearTimeout(this.timer); return this.judgeWager(); }
    if (r.phase === 'lastClue') {
      const need = this.lastPlayers(r, players);
      if (need.length && need.every(id => subs && subs[id] && subs[id].choice !== undefined)) { clearTimeout(this.timer); return this.lastReveal(); }
    }
  }

  async takeBuzz(pid) {
    if (this._busy) return; this._busy = true;
    try {
      const r = await this.round(); if (!r || r.phase !== 'clue') return;
      await this.room.clearRoundData();
      await this.patch({ phase: 'answer', buzz: pid, buzzSide: this.side(r, pid), deadline: Date.now() + ANSWER_MS });
      this.after(ANSWER_MS, this.judge);
    } finally { this._busy = false; }
  }

  async judge() {
    if (this._busy) return; this._busy = true;
    try {
      const r = await this.round(); if (!r || r.phase !== 'answer') return;
      const s = ((await this.room.t.get(`${this.base}/submissions`)) || {})[r.buzz];
      const right = s && Number(s.choice) === r.clue.answer;
      const v = r.clue.value;
      if (right) {
        await this.award(r, r.buzzSide, v);
        if (v >= 800) await highlight(this.room, r.buzz, `buzzed in on a ${v} and nailed it`, 2);
        await this.patch({ phase: 'result', result: { by: r.buzz, side: r.buzzSide, right: true, delta: v }, control: r.buzzSide, deadline: Date.now() + RESULT_MS });
        this.after(RESULT_MS, this.backToBoard);
        return;
      }
      await this.award(r, r.buzzSide, -v);
      const locked = [...(r.locked || []), r.buzzSide];
      const players = await this.room.players();
      const sides = this.allSides(r, players);
      const open = sides.filter(sd => !locked.includes(sd));
      if (!open.length) {
        await this.patch({ phase: 'result', result: { by: r.buzz, side: r.buzzSide, right: false, delta: -v, reveal: true }, locked, deadline: Date.now() + RESULT_MS });
        this.after(RESULT_MS, this.backToBoard);
        return;
      }
      // Reopen for everyone else.
      await this.room.clearRoundData();
      await this.patch({ phase: 'clue', locked, lastMiss: { by: r.buzz, delta: -v }, buzz: null, opensAt: Date.now(), deadline: Date.now() + BUZZ_MS * 0.6 });
      this.after(BUZZ_MS * 0.6, this.noBuzz);
    } finally { this._busy = false; }
  }

  allSides(r, players) {
    if (r.teams) return Object.keys(r.teams).filter(t => (r.teams[t].members || []).some(id => isPresent(players[id])));
    return playerList(players).filter(isPresent).map(p => p.id);
  }

  async noBuzz() {
    const r = await this.round(); if (!r || r.phase !== 'clue') return;
    await this.patch({ phase: 'result', result: { by: null, right: false, delta: 0, reveal: true }, deadline: Date.now() + RESULT_MS });
    this.after(RESULT_MS, this.backToBoard);
  }

  async backToBoard() {
    const r = await this.round(); if (!r) return;
    const left = Object.values(r.cells || {}).filter(Boolean).length;
    if (!left) return this.lastCallIntro();
    await this.room.clearRoundData();
    await this.patch({ phase: 'board', clue: null, buzz: null, result: null, locked: [], lastMiss: null, index: (r.index || 0) + 1, deadline: null });
  }

  /* ---------------------------- hidden square --------------------------- */
  async takeWager(rIn, by, amount) {
    const r = rIn || await this.round(); if (!r) return;
    if (r.phase === 'wager') {
      if (by !== r.picker && rIn) return;
      const w = Math.max(0, Math.min(r.maxWager || 1000, Math.round(amount)));
      await this.room.clearRoundData();
      await this.patch({ phase: 'wagerAnswer', wager: w, deadline: Date.now() + ANSWER_MS + 4000 });
      this.after(ANSWER_MS + 4000, this.judgeWager);
      return;
    }
    if (r.phase === 'lastWager') {
      const side = this.side(r, by); if (!side) return;
      const players = await this.room.players();
      const bank = Math.max(LAST_FLOOR, this.bankOf(r, side, players));   // broke? you still get to bet something
      const w = Math.max(0, Math.min(bank, Math.round(amount)));
      const wagers = { ...(r.wagers || {}), [side]: w };
      await this.patch({ wagers });
      const sides = this.allSides(r, players);
      if (sides.every(sd => wagers[sd] !== undefined)) { clearTimeout(this.timer); return this.lastClue(); }
    }
  }

  async judgeWager() {
    if (this._busy) return; this._busy = true;
    try {
      const r = await this.round(); if (!r || r.phase !== 'wagerAnswer') return;
      const s = ((await this.room.t.get(`${this.base}/submissions`)) || {})[r.picker];
      const right = s && Number(s.choice) === r.clue.answer;
      const delta = right ? r.wager : -r.wager;
      await this.award(r, r.wagerSide, delta);
      if (right && r.wager >= 1000) await highlight(this.room, r.picker, `doubled down for ${r.wager} and got it`, 3);
      await this.patch({ phase: 'result', result: { by: r.picker, side: r.wagerSide, right, delta, reveal: !right, wager: true }, deadline: Date.now() + RESULT_MS + 1000 });
      this.after(RESULT_MS + 1000, this.backToBoard);
    } finally { this._busy = false; }
  }

  /* ------------------------------ last call ----------------------------- */
  lastPlayers(r, players) {
    // Solo: everyone answers. Teams: one answer per team, from whoever submits first; we wait for any member.
    return r.teams ? [] : playerList(players).filter(isPresent).map(p => p.id);
  }

  async lastCallIntro() {
    await this.room.clearRoundData();
    await this.patch({ phase: 'lastWager', lastCat: this.lastCat, wagers: {}, clue: null, result: null, deadline: Date.now() + WAGER_MS + 5000 });
    this.after(WAGER_MS + 5000, this.lastClue);
  }

  async lastClue() {
    const r = await this.round(); if (!r || r.phase !== 'lastWager') return;
    const q = this.last;
    const tagged = shuffle(q.options.map((text, i) => ({ text, ok: i === q.answer })));
    await this.room.clearRoundData();
    await this.patch({ phase: 'lastClue', clue: { cat: this.lastCat, q: q.q, options: tagged.map(o => o.text), answer: tagged.findIndex(o => o.ok), note: q.note || '' }, deadline: Date.now() + LAST_Q_MS });
    this.after(LAST_Q_MS, this.lastReveal);
  }

  async lastReveal() {
    if (this._busy) return; this._busy = true;
    try {
      const r = await this.round(); if (!r || r.phase !== 'lastClue') return;
      const subs = (await this.room.t.get(`${this.base}/submissions`)) || {};
      const players = await this.room.players();
      const sides = this.allSides(r, players);
      const out = {};
      for (const sd of sides) {
        // A team's answer is its earliest member's submission.
        const ids = this.sideMembers(r, sd).filter(id => subs[id]);
        ids.sort((a, b) => (subs[a].at || 0) - (subs[b].at || 0));
        const s = ids.length ? subs[ids[0]] : null;
        const right = s && Number(s.choice) === r.clue.answer;
        const w = (r.wagers || {})[sd] || 0;
        const delta = right ? w : -w;
        out[sd] = { right: Boolean(right), wager: w, delta, by: ids[0] || null };
        if (delta) await this.award(r, sd, delta);
      }
      await this.patch({ phase: 'lastReveal', last: out, deadline: Date.now() + LAST_REV_MS });
      this.after(LAST_REV_MS, this.finish);
    } finally { this._busy = false; }
  }

  async finish() {
    clearTimeout(this.timer);
    if (this.onFinish) return this.onFinish();
    await this.room.patchRound({ phase: 'final' });
    await this.room.setPhase('scoreboard');
  }

  async nudge(kind) {
    const r = await this.round(); if (!r) return;
    if (kind !== 'next') return;
    if (r.phase === 'result') return this.backToBoard();
    if (r.phase === 'clue') { clearTimeout(this.timer); return this.noBuzz(); }
    if (r.phase === 'lastReveal') return this.finish();
  }

  async resume() {
    const r = await this.round(); if (!r) return;
    const left = Math.max(800, (r.deadline || Date.now()) - Date.now());
    const map = { clue: this.noBuzz, answer: this.judge, result: this.backToBoard, wager: function () { return this.takeWager(null, r.picker, 0); },
                  wagerAnswer: this.judgeWager, lastWager: this.lastClue, lastClue: this.lastReveal, lastReveal: this.finish };
    if (map[r.phase]) this.after(left, map[r.phase]);
  }
  stop() { clearTimeout(this.timer); }
}

/* -------------------------------- views -------------------------------- */
let subsCache = {};
export function setSubmissions(s) { subsCache = s || {}; }

const nameOf = (players, id) => (players[id] || {}).name || '?';
const emojiOf = (players, id) => (players[id] || {}).emoji || '🎲';
const letters = ['A', 'B', 'C', 'D'];
function sideLabel(r, players, side) {
  if (r.teams && r.teams[side]) return `${r.teams[side].emoji} ${esc(r.teams[side].name)}`;
  return `${emojiOf(players, side)} ${esc(nameOf(players, side))}`;
}
function scoresHTML(r, players) {
  if (r.teams) {
    return `<div class="dd-scores">${Object.values(r.teams).map(t => {
      const s = (players[(t.members || [])[0]] || {}).score || 0;
      return `<div class="dd-sc ${r.control === t.id ? 'on' : ''}"><b>${t.emoji} ${esc(t.name)}</b><i>${s.toLocaleString()}</i>
        <span>${(t.members || []).map(id => esc(nameOf(players, id))).join(', ')}</span></div>`;
    }).join('')}</div>`;
  }
  return `<div class="dd-scores">${sortedPlayers(players).map(p =>
    `<div class="dd-sc ${r.control === p.id ? 'on' : ''}"><b>${p.emoji || '🎲'} ${esc(p.name)}</b><i>${(p.score || 0).toLocaleString()}</i></div>`).join('')}</div>`;
}
function boardHTML(r, small = false) {
  const cats = r.cats || [];
  const head = cats.map(c => `<div class="dd-cat">${esc(c)}</div>`).join('');
  let cells = '';
  for (let row = 0; row < (r.rows || 5); row++) {
    for (let c = 0; c < cats.length; c++) {
      const k = `${c}_${row}`;
      const live = (r.cells || {})[k];
      cells += live ? `<div class="dd-cell">${(r.values || VALUES)[row]}</div>` : '<div class="dd-cell used"></div>';
    }
  }
  return `<div class="dd-board ${small ? 'small' : ''}" style="--cols:${cats.length}">${head}${cells}</div>`;
}

export function hostView(r, players) {
  players = players || {};
  if (!r) return '…';
  if (r.phase === 'final') return finalScoreboard(players, 'Final scores');
  const c = r.clue;
  if (r.phase === 'board') {
    return `<div class="dd">${boardHTML(r)}
      <p class="phint big">${sideLabel(r, players, r.control)} picks.</p>${scoresHTML(r, players)}</div>`;
  }
  if (r.phase === 'clue' || r.phase === 'answer' || r.phase === 'result') {
    const opts = (c.options || []).map((o, i) => `<div class="opt ${r.phase === 'result' && (r.result || {}).reveal !== false && (r.result.reveal || r.result.right) ? (i === c.answer ? 'correct' : 'dim') : ''}"><span class="letter">${letters[i]}</span>${esc(o)}</div>`).join('');
    let status = '';
    if (r.phase === 'clue') {
      status = r.lastMiss ? `<div class="dd-miss">${esc(nameOf(players, r.lastMiss.by))} missed (${r.lastMiss.delta}). Anyone else?</div>` : '<div class="dd-buzz">Buzz in when you know it</div>';
    }
    if (r.phase === 'answer') status = `<div class="dd-buzz on">${emojiOf(players, r.buzz)} ${esc(nameOf(players, r.buzz))} buzzed in</div>`;
    if (r.phase === 'result') {
      const res = r.result || {};
      status = res.by ? `<div class="dd-res ${res.right ? 'good' : 'bad'}">${esc(nameOf(players, res.by))} ${res.right ? 'got it' : 'missed'} · ${res.delta > 0 ? '+' : ''}${res.delta}</div>`
                      : '<div class="dd-res">Nobody buzzed.</div>';
    }
    return `<div class="dd">
      <div class="qmeta">${esc(c.cat)} · ${r.wager !== undefined && r.wager !== null && r.result?.wager ? `wager ${r.wager}` : c.value}</div>
      ${r.phase === 'result' ? '' : timerHTML(r.deadline, r.phase === 'answer' ? ANSWER_MS : BUZZ_MS)}
      <h1 class="question">${esc(c.q)}</h1>
      ${r.phase === 'clue' ? '' : `<div class="opts">${opts}</div>`}
      ${status}
      ${r.phase === 'result' ? '<button class="nextbtn" data-next="1">Next</button>' : r.phase === 'clue' ? '<button class="nextbtn" data-next="1">Nobody knows</button>' : ''}
      ${scoresHTML(r, players)}</div>`;
  }
  if (r.phase === 'wager' || r.phase === 'wagerAnswer') {
    return `<div class="dd dd-hidden">
      <div class="dd-dd">DOUBLE DOWN</div>
      <p class="phint big">${esc(nameOf(players, r.picker))} found the hidden square. ${r.phase === 'wager' ? 'Wagering…' : `Wagered ${r.wager}.`}</p>
      ${r.phase === 'wagerAnswer' ? `<div class="qmeta">${esc(c.cat)}</div><h1 class="question">${esc(c.q)}</h1><div class="opts">${(c.options || []).map((o, i) => `<div class="opt"><span class="letter">${letters[i]}</span>${esc(o)}</div>`).join('')}</div>` : ''}
      ${timerHTML(r.deadline, r.phase === 'wager' ? WAGER_MS : ANSWER_MS + 4000)}</div>`;
  }
  if (r.phase === 'lastWager') {
    const n = Object.keys(r.wagers || {}).length;
    return `<div class="dd dd-hidden"><div class="dd-dd">LAST CALL</div>
      <div class="qmeta">Category</div><h1 class="question">${esc(r.lastCat || '')}</h1>
      <p class="phint big">Wager on your phone. ${n} in.</p>${timerHTML(r.deadline, WAGER_MS + 5000)}${scoresHTML(r, players)}</div>`;
  }
  if (r.phase === 'lastClue' || r.phase === 'lastReveal') {
    const reveal = r.phase === 'lastReveal';
    const rows = reveal ? Object.entries(r.last || {}).map(([sd, o]) => `<div class="dd-lr ${o.right ? 'good' : 'bad'}">${sideLabel(r, players, sd)} <b>${o.delta > 0 ? '+' : ''}${o.delta}</b></div>`).join('') : '';
    return `<div class="dd dd-hidden"><div class="dd-dd small">LAST CALL · ${esc(c.cat)}</div>
      ${reveal ? '' : timerHTML(r.deadline, LAST_Q_MS)}
      <h1 class="question">${esc(c.q)}</h1>
      <div class="opts">${(c.options || []).map((o, i) => `<div class="opt ${reveal ? (i === c.answer ? 'correct' : 'dim') : ''}"><span class="letter">${letters[i]}</span>${esc(o)}</div>`).join('')}</div>
      ${reveal ? `<div class="dd-lrs">${rows}</div>` : ''}
      ${scoresHTML(r, players)}</div>`;
  }
  return '';
}

export function playerView(r, me, submitted, voted, players, extra = {}) {
  players = players || {};
  const mirror = extra.mirror;
  if (!r) return '<div class="pcard">…</div>';
  const mySide = r.teamOf ? r.teamOf[me.id] : me.id;
  const teamTag = r.teams && mySide ? `<div class="dd-myteam">${r.teams[mySide].emoji} ${esc(r.teams[mySide].name)}</div>` : '';
  const c = r.clue;

  if (r.phase === 'board') {
    if (r.control !== mySide) return `<div class="pcard">${teamTag}<h2>${sideLabel(r, players, r.control)} picks</h2>${mirror ? boardHTML(r, true) : ''}</div>`;
    const cats = r.cats || [];
    let grid = cats.map(cat => `<div class="dd-pcat">${esc(cat)}</div>`).join('');
    for (let row = 0; row < (r.rows || 5); row++) for (let col = 0; col < cats.length; col++) {
      const k = `${col}_${row}`; const live = (r.cells || {})[k];
      grid += live ? `<button class="dd-pcell" data-action="ddpick" data-cell="${k}">${(r.values || VALUES)[row]}</button>` : '<div class="dd-pcell used"></div>';
    }
    return `<div class="pcard">${teamTag}<h2>Your pick</h2><div class="dd-pgrid" style="--cols:${cats.length}">${grid}</div></div>`;
  }
  if (r.phase === 'clue') {
    const locked = (r.locked || []).includes(mySide);
    const open = Date.now() >= (r.opensAt || 0);
    return `<div class="pcard tall">${teamTag}<p class="phint">${esc(c.cat)} · ${c.value}</p>${mirror ? `<h2 class="small-h">${esc(c.q)}</h2>` : ''}
      ${locked ? '<h2>Locked out</h2><p>You already missed this one.</p>'
               : submitted ? '<h2>Buzzed</h2>'
               : `<button class="hugebtn got dd-buzzbtn" data-action="ddbuzz">BUZZ</button>${open ? '' : '<p class="phint center">Opens in a second…</p>'}`}</div>`;
  }
  if (r.phase === 'answer' || r.phase === 'wagerAnswer') {
    const mine = r.phase === 'answer' ? r.buzz === me.id : r.picker === me.id;
    if (!mine) return `<div class="pcard">${teamTag}<h2>${esc(nameOf(players, r.phase === 'answer' ? r.buzz : r.picker))} is answering</h2>${mirror ? `<p>${esc(c.q)}</p>` : ''}</div>`;
    if (submitted) return `<div class="pcard"><h2>Locked in</h2></div>`;
    return `<div class="pcard">${timerHTML(r.deadline, r.phase === 'answer' ? ANSWER_MS : ANSWER_MS + 4000)}<h2 class="small-h">${esc(c.q)}</h2>
      ${(c.options || []).map((o, i) => `<button class="pbtn" data-action="choose" data-choice="${i}"><span class="letter">${letters[i]}</span>${esc(o)}</button>`).join('')}</div>`;
  }
  if (r.phase === 'result') {
    const res = r.result || {};
    const mineSide = res.side && res.side === mySide;
    return `<div class="pcard ${mineSide ? (res.right ? 'win' : 'lose') : ''}">${teamTag}<h2>${res.by ? `${esc(nameOf(players, res.by))} ${res.right ? 'got it' : 'missed'}` : 'Nobody buzzed'}</h2>
      ${res.delta ? `<p>${res.delta > 0 ? '+' : ''}${res.delta}</p>` : ''}${mirror && c ? `<p class="phint">Answer: <b>${esc(c.options[c.answer])}</b></p>` : ''}</div>`;
  }
  if (r.phase === 'wager') {
    if (r.picker !== me.id) return `<div class="pcard"><h2>Double Down</h2><p>${esc(nameOf(players, r.picker))} is wagering.</p></div>`;
    return wagerHTML(r.maxWager || 1000, 'Hidden square. How much?', c ? `${esc(c.cat)}` : '');
  }
  if (r.phase === 'lastWager') {
    if (!mySide) return '<div class="pcard"><h2>Last Call</h2></div>';
    if ((r.wagers || {})[mySide] !== undefined) return `<div class="pcard">${teamTag}<h2>Wagered ${(r.wagers || {})[mySide]}</h2><p>Waiting on the others.</p></div>`;
    const bank = Math.max(LAST_FLOOR, (players[me.id] || {}).score || 0);
    return wagerHTML(bank, `Last Call: ${esc(r.lastCat || '')}`, r.teams ? 'One wager per team. First one in counts.' : '');
  }
  if (r.phase === 'lastClue') {
    if (submitted) return `<div class="pcard">${teamTag}<h2>Locked in</h2></div>`;
    return `<div class="pcard">${teamTag}${timerHTML(r.deadline, LAST_Q_MS)}<h2 class="small-h">${esc(c.q)}</h2>
      ${(c.options || []).map((o, i) => `<button class="pbtn" data-action="choose" data-choice="${i}"><span class="letter">${letters[i]}</span>${esc(o)}</button>`).join('')}
      ${r.teams ? '<p class="phint">First answer from your team counts.</p>' : ''}</div>`;
  }
  if (r.phase === 'lastReveal') {
    const o = (r.last || {})[mySide];
    return `<div class="pcard ${o && o.right ? 'win' : 'lose'}">${teamTag}<h2>${o ? `${o.delta > 0 ? '+' : ''}${o.delta}` : '—'}</h2></div>`;
  }
  return '<div class="pcard">…</div>';
}

function wagerHTML(max, title, sub) {
  const opts = [...new Set([0, Math.round(max * 0.25 / 100) * 100, Math.round(max * 0.5 / 100) * 100, max].filter(x => x >= 0))];
  return `<div class="pcard"><h2 class="small-h">${title}</h2>${sub ? `<p class="phint">${sub}</p>` : ''}
    ${opts.map(v => `<button class="pbtn" data-action="ddwager" data-amount="${v}">${v === max && v ? `All in · ${v}` : v}</button>`).join('')}</div>`;
}

export function scoreboard(players, title = 'Scores') { return finalScoreboard(players, title); }

export async function handleAction(room, me, action, r) {
  if (!r) return;
  if (action.action === 'ddpick' && r.phase === 'board') {
    await room.t.set(`${room.base}/intent`, { by: me.id, action: 'ddpick', cell: action.cell, at: Date.now() });
    return { rerender: true };
  }
  if (action.action === 'ddbuzz' && r.phase === 'clue') {
    if (Date.now() < (r.opensAt || 0) - 150) return;           // too early: ignored
    await room.submit(me.id, { buzz: true, at: Date.now() });
    return { rerender: true };
  }
  if (action.action === 'choose' && (r.phase === 'answer' || r.phase === 'wagerAnswer' || r.phase === 'lastClue')) {
    await room.submit(me.id, { choice: Number(action.choice), at: Date.now() });
    return { rerender: true };
  }
  if (action.action === 'ddwager' && (r.phase === 'wager' || r.phase === 'lastWager')) {
    await room.t.set(`${room.base}/intent`, { by: me.id, action: 'ddwager', amount: Number(action.amount), at: Date.now() });
    return { rerender: true };
  }
}
