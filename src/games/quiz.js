// ---------------------------------------------------------------------------
// QUIZ - trivia. Question on the TV, four buttons on every phone.
// Fastest correct answer scores most. Phases: question -> reveal -> ... -> final
// ---------------------------------------------------------------------------

import { shuffle, sample, esc, sortedPlayers, playerList, countdown, timerHTML, finalScoreboard,
         pendingPlayers, waitingHTML, revealMs, sampleUnseen, isPresent } from '../util.js';
import { loadPack } from '../content.js';

export const meta = {
  id: 'quiz',
  name: 'Degenerate Trivia',
  blurb: 'Four options, one right, speed matters.',
  minPlayers: 1,
  defaultRounds: 10
};

const ANSWER_MS = 20000;
const REVEAL_MS = 6000;
const BASE_POINTS = 600;
const SPEED_BONUS = 400;

export class Host {
  constructor(room, opts = {}) {
    this.room = room;
    this.rounds = opts.rounds || meta.defaultRounds;
    this.deck = null;
    this.timer = null;
  }

  async load() {
    const questions = await loadPack('trivia');
    this.deck = await sampleUnseen(this.room, 'trivia', questions, this.rounds, q => q.q);
    return this;
  }

  async begin() {
    await this.room.setGame('quiz');
    await this.room.setPhase('playing');
    await this.ask(0);
  }

  async ask(index) {
    clearTimeout(this.timer);
    if (this._busy) return;
    this._busy = true;
    try {
      await this._ask(index);
    } finally {
      this._busy = false;
    }
  }

  async _ask(index) {
    if (index >= this.deck.length) return this.finish();

    const q = this.deck[index];
    // Shuffle options but keep track of where the right one landed.
    const tagged = q.options.map((text, i) => ({ text, correct: i === q.answer }));
    const mixed = shuffle(tagged);

    await this.room.clearRoundData();
    await this.room.setRound({
      phase: 'question',
      index,
      total: this.deck.length,
      q: q.q,
      options: mixed.map(o => o.text),
      answer: mixed.findIndex(o => o.correct),
      note: q.note || '',
      startedAt: Date.now(),
      deadline: Date.now() + ANSWER_MS
    });

    this.timer = setTimeout(() => this.reveal(), ANSWER_MS);
  }

  /** Called by the host page when submissions change. */
  async onSubmissions(subs, players) {
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round || round.phase !== 'question') return;
    const live = playerList(players).filter(isPresent);
    if (live.length && Object.keys(subs || {}).length >= live.length) {
      clearTimeout(this.timer);
      await this.reveal();
    }
  }

  async reveal() {
    clearTimeout(this.timer);
    if (this._revealing) return;
    this._revealing = true;
    try {
      await this._reveal();
    } finally {
      this._revealing = false;
    }
  }

  async _reveal() {
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round || round.phase !== 'question') return;

    const subs = (await this.room.t.get(`${this.room.base}/submissions`)) || {};
    const gained = {};

    for (const [pid, s] of Object.entries(subs)) {
      if (s.choice !== round.answer) { gained[pid] = 0; continue; }
      const elapsed = Math.max(0, (s.at || Date.now()) - round.startedAt);
      const frac = Math.max(0, 1 - elapsed / ANSWER_MS);
      const pts = BASE_POINTS + Math.round(SPEED_BONUS * frac);
      gained[pid] = pts;
      await this.room.addScore(pid, pts);
    }

    await this.room.patchRound({ phase: 'reveal', gained });
    this.timer = setTimeout(() => this.ask(round.index + 1), revealMs(1, { base: 5500, per: 1500 }));
  }

  /** Host tapped Next on a reveal, or Skip on a straggler. */
  async nudge(kind, pid) {
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round) return;
    if (kind === 'next' && round.phase === 'reveal') { clearTimeout(this.timer); return this.ask(round.index + 1); }
    if (kind === 'skip' && round.phase === 'question' && pid) {
      // Mark them as answered-with-nothing so the round can close.
      await this.room.submit(pid, { choice: -1, at: Date.now(), skipped: true });
    }
  }

  async finish() {
    clearTimeout(this.timer);
    // When something else is driving (the board game), hand control back
    // instead of declaring the party over.
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
    if (round.phase === 'question') this.timer = setTimeout(() => this.reveal(), left);
    else if (round.phase === 'reveal') this.timer = setTimeout(() => this.ask(round.index + 1), 2000);
  }

  stop() { clearTimeout(this.timer); }
}

/* ------------------------------- views --------------------------------- */

export function hostView(round, players) {
  if (!round) return '<div class="big">Loading…</div>';

  if (round.phase === 'final') {
    return scoreboard(players, 'Final scores');
  }

  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  const opts = (round.options || []).map((o, i) => {
    let cls = 'opt';
    if (round.phase === 'reveal') {
      cls += i === round.answer ? ' correct' : ' dim';
    }
    return `<div class="${cls}"><span class="letter">${letters[i]}</span>${esc(o)}</div>`;
  }).join('');

  const header = `<div class="qmeta">Question ${round.index + 1} of ${round.total}</div>`;
  const note = round.phase === 'reveal' && round.note
    ? `<div class="note">${esc(round.note)}</div>` : '';
  const timer = round.phase === 'question' ? timerHTML(round.deadline, ANSWER_MS) : '';

  const waiting = round.phase === 'question'
    ? waitingHTML(pendingPlayers(players, subsCache, []), { skippable: true }) : '';
  return `
    ${header}
    ${timer}
    <h1 class="question">${esc(round.q)}</h1>
    <div class="opts">${opts}</div>
    ${note}
    ${waiting}
    ${round.phase === 'reveal' ? '<button class="nextbtn" data-next="1">Next</button>' : ''}
  `;
}

// The host passes the live submissions map in so the waiting chips are live.
let subsCache = {};
export function setSubmissions(s) { subsCache = s || {}; }

export function playerView(round, me, submitted, _voted, _players, extra = {}) {
  const mirror = extra && extra.mirror;
  if (!round || round.phase === 'final') {
    return `<div class="pcard"><h2>Game over</h2><p>Check the big screen.</p></div>`;
  }

  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];

  if (round.phase === 'reveal') {
    const got = (round.gained || {})[me.id] || 0;
    if (mirror) {
      const opts = (round.options || []).map((o, i) =>
        `<div class="pbtn static ${i === round.answer ? 'correct' : 'dim'}">
           <span class="letter">${letters[i]}</span>${esc(o)}</div>`).join('');
      return `<div class="pcard">
        <h2 class="${got ? 'winc' : 'losec'}">${got ? `+${got}` : 'Nope'}</h2>
        <p class="phint">${esc(round.q)}</p>${opts}
        ${round.note ? `<p class="note">${esc(round.note)}</p>` : ''}</div>`;
    }
    return `<div class="pcard ${got ? 'win' : 'lose'}">
      <h2>${got ? `+${got}` : 'Nope'}</h2>
      <p>${got ? 'Nice.' : 'Better luck next one.'}</p>
    </div>`;
  }

  if (submitted) {
    return `<div class="pcard"><h2>Locked in</h2><p>${mirror ? 'Waiting for the others.' : 'Eyes up.'}</p>
      ${mirror ? timerHTML(round.deadline, ANSWER_MS) : ''}</div>`;
  }

  const btns = (round.options || []).map((o, i) =>
    `<button class="pbtn" data-action="choose" data-choice="${i}">
       <span class="letter">${letters[i]}</span>${esc(o)}
     </button>`
  ).join('');

  if (mirror) {
    return `<div class="pcard">
      <div class="qmeta">Question ${round.index + 1} of ${round.total}</div>
      ${timerHTML(round.deadline, ANSWER_MS)}
      <h2 class="small-h">${esc(round.q)}</h2>${btns}</div>`;
  }
  return `<div class="pcard"><p class="phint">Pick one. Fast.</p>${btns}</div>`;
}
export const mirrorView = playerView;

export function scoreboard(players, title = 'Scores') {
  return finalScoreboard(players, title);
}

/** Phone taps -> room writes. */
export async function handleAction(room, me, action, round) {
  if (action.action === 'choose' && round && round.phase === 'question') {
    await room.submit(me.id, { choice: Number(action.choice), at: Date.now() });
  }
}
