// ---------------------------------------------------------------------------
// QUIZ - trivia. Question on the TV, four buttons on every phone.
// Fastest correct answer scores most. Phases: question -> reveal -> ... -> final
// ---------------------------------------------------------------------------

import { shuffle, sample, esc, sortedPlayers, playerList, countdown, loadJSON, contentURL } from '../util.js';

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
    const data = await loadJSON(contentURL('trivia.json'));
    this.deck = sample(data.questions, this.rounds);
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
    const live = playerList(players).filter(p => p.connected !== false);
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
    this.timer = setTimeout(() => this.ask(round.index + 1), REVEAL_MS);
  }

  async finish() {
    clearTimeout(this.timer);
    await this.room.patchRound({ phase: 'final' });
    await this.room.setPhase('scoreboard');
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
  const timer = round.phase === 'question'
    ? `<div class="timer" data-deadline="${round.deadline}">${countdown(round.deadline)}</div>` : '';

  return `
    ${header}
    ${timer}
    <h1 class="question">${esc(round.q)}</h1>
    <div class="opts">${opts}</div>
    ${note}
  `;
}

export function playerView(round, me, submitted) {
  if (!round || round.phase === 'final') {
    return `<div class="pcard"><h2>Game over</h2><p>Check the big screen.</p></div>`;
  }

  if (round.phase === 'reveal') {
    const got = (round.gained || {})[me.id] || 0;
    return `<div class="pcard ${got ? 'win' : 'lose'}">
      <h2>${got ? `+${got}` : 'Nope'}</h2>
      <p>${got ? 'Nice.' : 'Better luck next one.'}</p>
    </div>`;
  }

  if (submitted) {
    return `<div class="pcard"><h2>Locked in</h2><p>Eyes up.</p></div>`;
  }

  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  const btns = (round.options || []).map((o, i) =>
    `<button class="pbtn" data-action="choose" data-choice="${i}">
       <span class="letter">${letters[i]}</span>${esc(o)}
     </button>`
  ).join('');

  return `<div class="pcard"><p class="phint">Pick one. Fast.</p>${btns}</div>`;
}

export function scoreboard(players, title = 'Scores') {
  const rows = sortedPlayers(players).map((p, i) => `
    <div class="srow ${i === 0 ? 'lead' : ''}">
      <span class="rank">${i + 1}</span>
      <span class="emoji">${p.emoji || '🎲'}</span>
      <span class="sname">${esc(p.name)}</span>
      <span class="spts">${p.score || 0}</span>
    </div>`).join('');
  return `<h1 class="question">${esc(title)}</h1><div class="scores">${rows}</div>`;
}

/** Phone taps -> room writes. */
export async function handleAction(room, me, action, round) {
  if (action.action === 'choose' && round && round.phase === 'question') {
    await room.submit(me.id, { choice: Number(action.choice), at: Date.now() });
  }
}
