// ---------------------------------------------------------------------------
// BLIND VOTE: everyone votes without seeing the others, then the split shows.
//
//   mode 'wyr'    : two options. Minority has to defend themselves (or drink).
//                   Points go to the majority, bonus for a perfectly split room.
//   mode 'likely' : vote for a PLAYER. The person with the most votes gets
//                   "the title" and everyone who voted for them scores.
//
// Phases: vote -> reveal -> ... -> final
// ---------------------------------------------------------------------------

import { sample, esc, sortedPlayers, playerList,
         timerHTML, finalScoreboard, pendingPlayers, waitingHTML, revealMs, sampleUnseen, isPresent, roundMeta } from '../util.js';
import { loadPack } from '../content.js';

export const meta = {
  id: 'blindvote',
  name: 'Blind Vote',
  blurb: 'Vote blind. Watch the room split.',
  minPlayers: 3,
  defaultRounds: 10
};

const VOTE_MS   = 30000;
const REVEAL_MS = 8000;
const MAJ_PTS   = 300;
const SPLIT_PTS = 150;
const LIKELY_PTS = 400;

export class Host {
  constructor(room, opts = {}) {
    this.room = room;
    this.mode = opts.mode || 'wyr';
    this.rounds = opts.rounds || meta.defaultRounds;
    this.timer = null;
  }

  async load() {
    if (this.mode === 'wyr') {
      const pairs = await loadPack('wyr');
      this.deck = await sampleUnseen(this.room, 'wyr', pairs, this.rounds, p => p.a + '|' + p.b);
    } else {
      const prompts = await loadPack('likely');
      this.deck = (await sampleUnseen(this.room, 'likely', prompts, this.rounds, p => p)).map(p => ({ text: p }));
    }
    return this;
  }

  async begin() {
    await this.room.setGame('blindvote');
    await this.room.setPhase('playing');
    await this.ask(0);
  }

  async ask(index) {
    clearTimeout(this.timer);
    if (index >= this.deck.length) return this.finish();
    const item = this.deck[index];
    await this.room.clearRoundData();
    await this.room.setRound({
      phase: 'vote', mode: this.mode,
      index, total: this.deck.length,
      a: item.a || null, b: item.b || null, text: item.text || null,
      deadline: Date.now() + VOTE_MS
    });
    this.timer = setTimeout(() => this.reveal(), VOTE_MS);
  }

  async onVotes(votes, players) {
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round || round.phase !== 'vote') return;
    const live = playerList(players).filter(isPresent).length;
    if (live && Object.keys(votes || {}).length >= live) {
      clearTimeout(this.timer);
      await this.reveal();
    }
  }

  async reveal() {
    clearTimeout(this.timer);
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round || round.phase !== 'vote') return;
    const votes = (await this.room.t.get(`${this.room.base}/votes`)) || {};
    const gained = {};
    const add = (pid, n) => { gained[pid] = (gained[pid] || 0) + n; };

    if (round.mode === 'wyr') {
      const A = Object.entries(votes).filter(([, v]) => v === 'a').map(([p]) => p);
      const B = Object.entries(votes).filter(([, v]) => v === 'b').map(([p]) => p);
      // '-' is a host skip; it counts as a vote cast for closing the round only.
      const total = A.length + B.length;
      if (total) {
        if (A.length === B.length) { for (const p of [...A, ...B]) add(p, SPLIT_PTS); }
        else { const maj = A.length > B.length ? A : B; for (const p of maj) add(p, MAJ_PTS); }
      }
      for (const [pid, n] of Object.entries(gained)) await this.room.addScore(pid, n);
      await this.room.patchRound({ phase: 'reveal', a_ids: A, b_ids: B, gained });
    } else {
      const tally = {};
      for (const target of Object.values(votes)) if (target !== '-') tally[target] = (tally[target] || 0) + 1;
      const top = Math.max(0, ...Object.values(tally));
      const winners = Object.keys(tally).filter(k => tally[k] === top && top > 0);
      for (const [pid, target] of Object.entries(votes)) if (winners.includes(target)) add(pid, LIKELY_PTS);
      for (const [pid, n] of Object.entries(gained)) await this.room.addScore(pid, n);
      await this.room.patchRound({ phase: 'reveal', tally, winners, gained, votes });
    }
    const n = round.mode === 'wyr' ? Object.keys(votes).length : Object.keys(round.tally || {}).length;
    this.timer = setTimeout(() => this.ask(round.index + 1), revealMs(n, { base: 5000, per: 900 }));
  }

  async nudge(kind, pid) {
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round) return;
    if (kind === 'next' && round.phase === 'reveal') { clearTimeout(this.timer); return this.ask(round.index + 1); }
    if (kind === 'skip' && pid && round.phase === 'vote') await this.room.vote(pid, '-');
  }

  async finish() {
    clearTimeout(this.timer);
    if (this.onFinish) return this.onFinish();
    await this.room.patchRound({ phase: 'final' });
    await this.room.setPhase('scoreboard');
  }

  /**
   * Called when a new director takes over mid-game: re-arm the timer for the
   * phase we're in, from the deadline already stored on the round.
   */
  async resume() {
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round || !round.phase) return;
    const left = Math.max(300, (round.deadline || Date.now()) - Date.now());
    clearTimeout(this.timer);
    if (round.phase === 'vote') this.timer = setTimeout(() => this.reveal(), left);
    else if (round.phase === 'reveal') this.timer = setTimeout(() => this.ask(round.index + 1), 2500);
  }

  stop() { clearTimeout(this.timer); }
}

/* -------------------------------- views -------------------------------- */

function wyrSplit(round, players) {
  const byId = Object.fromEntries(playerList(players).map(p => [p.id, p]));
  const A = round.a_ids || [], B = round.b_ids || [];
  const n = A.length + B.length || 1;
  const pa = Math.round(A.length / n * 100), pb = 100 - pa;
  const chips = ids => ids.map(id => `<span class="vchip">${byId[id]?.emoji || ''} ${esc(byId[id]?.name || '')}</span>`).join('') || '<span class="muted">nobody</span>';
  const minority = A.length === B.length ? null : (A.length < B.length ? 'a' : 'b');
  return `
    <div class="split">
      <div class="side a ${minority === 'a' ? 'minority' : ''}" style="--pct:${pa}">
        <div class="pct">${pa}%</div><div class="opttext">${esc(round.a)}</div><div class="vchips">${chips(A)}</div>
      </div>
      <div class="side b ${minority === 'b' ? 'minority' : ''}" style="--pct:${pb}">
        <div class="pct">${pb}%</div><div class="opttext">${esc(round.b)}</div><div class="vchips">${chips(B)}</div>
      </div>
    </div>
    <p class="phint big">${minority ? 'Minority: explain yourselves.' : 'Dead even. Everybody drinks.'}</p>`;
}

function likelyReveal(round, players) {
  const byId = Object.fromEntries(playerList(players).map(p => [p.id, p]));
  const ranked = Object.entries(round.tally || {}).sort((x, y) => y[1] - x[1]);
  const rows = ranked.map(([pid, n]) => `
    <div class="srow ${(round.winners || []).includes(pid) ? 'lead' : ''}">
      <span class="rank">${n}</span><span class="emoji">${byId[pid]?.emoji || '🎲'}</span>
      <span class="sname">${esc(byId[pid]?.name || '')}</span>
      <span class="spts">${n === 1 ? 'vote' : 'votes'}</span>
    </div>`).join('');
  const w = (round.winners || []).map(id => byId[id]?.name).filter(Boolean);
  return `<div class="scores">${rows}</div>
    <p class="phint big">${w.length ? `${esc(w.join(' and '))}. Obviously.` : 'No votes?'}</p>`;
}

export function hostView(round, players) {
  if (!round) return '<div class="big">Loading…</div>';
  if (round.phase === 'final') return finalScoreboard(players, 'Final scores');
  const header = roundMeta(round.index, round.total);

  if (round.phase === 'vote') {
    if (round.mode === 'wyr') {
      return `${header}${timerHTML(round.deadline, VOTE_MS)}
        <div class="wyr"><div class="wopt a">${esc(round.a)}</div><div class="or">or</div><div class="wopt b">${esc(round.b)}</div></div>
        ${waitingHTML(pendingPlayers(players, liveVotes), { skippable: true })}`;
    }
    return `${header}${timerHTML(round.deadline, VOTE_MS)}
      <h1 class="question">…${esc(round.text)}?</h1>
      ${waitingHTML(pendingPlayers(players, liveVotes), { skippable: true })}`;
  }
  return `${header}${round.mode === 'wyr' ? wyrSplit(round, players) : `<h2 class="subq">…${esc(round.text)}?</h2>${likelyReveal(round, players)}`}
    <button class="nextbtn" data-next="1">Next</button>`;
}

let liveVotes = {};
export function setVotes(v) { liveVotes = v || {}; }
export function setSubmissions() {}

export function playerView(round, me, submitted, voted, players, extra = {}) {
  if (!round || round.phase === 'final') return `<div class="pcard"><h2>Game over</h2></div>`;
  const mirror = extra.mirror;

  if (round.phase === 'vote') {
    if (voted) return `<div class="pcard"><h2>Voted</h2><p>Waiting on the rest.</p></div>`;
    if (round.mode === 'wyr') {
      return `<div class="pcard">
        ${mirror ? timerHTML(round.deadline, VOTE_MS) : ''}
        <p class="phint">Would you rather…</p>
        <button class="pbtn wyrbtn" data-action="vote" data-slot="a">${esc(round.a)}</button>
        <div class="or small">or</div>
        <button class="pbtn wyrbtn" data-action="vote" data-slot="b">${esc(round.b)}</button>
      </div>`;
    }
    const btns = playerList(players || {}).map(p =>
      `<button class="pbtn" data-action="vote" data-slot="${p.id}"><span class="letter">${p.emoji || '🎲'}</span>${esc(p.name)}</button>`).join('');
    return `<div class="pcard">
      ${mirror ? timerHTML(round.deadline, VOTE_MS) : ''}
      <p class="phint">Who's most likely to…</p><h2 class="small-h">${esc(round.text)}?</h2>${btns}</div>`;
  }
  // reveal
  const got = (round.gained || {})[me.id] || 0;
  if (mirror) {
    return `<div class="pcard">
      <h2 class="${got ? 'winc' : ''}">${got ? `+${got}` : '—'}</h2>
      ${round.mode === 'wyr' ? wyrSplit(round, players) : likelyReveal(round, players)}
    </div>`;
  }
  return `<div class="pcard ${got ? 'win' : ''}"><h2>${got ? `+${got}` : 'Minority'}</h2>
    <p>${got ? 'You were with the room.' : 'Defend yourself.'}</p></div>`;
}
export const mirrorView = playerView;

export async function handleAction(room, me, action, round) {
  if (!round || round.phase !== 'vote' || action.action !== 'vote') return;
  if (round.mode === 'likely' && action.slot === me.id) return;   // can't vote yourself
  await room.vote(me.id, action.slot);
  return { rerender: true };
}
