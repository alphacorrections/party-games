// ---------------------------------------------------------------------------
// LIAR'S TRIVIA. A real question with the answer blanked. Everyone writes a
// convincing lie. Lies and truth are shuffled; everyone picks what they think
// is real.
//
//   pick the truth           +1000
//   someone picks your lie   +500 each
//   pick your own lie        not allowed
//
// Phases: write -> pick -> reveal -> ... -> final
// ---------------------------------------------------------------------------

import { shuffle, sample, esc, sortedPlayers, playerList, loadJSON, contentURL,
         timerHTML, finalScoreboard } from '../util.js';

export const meta = {
  id: 'liars',
  name: "Liar's Trivia",
  blurb: 'Write a fake. Spot the truth.',
  minPlayers: 2,
  defaultRounds: 7
};

const WRITE_MS  = 60000;
const PICK_MS   = 40000;
const REVEAL_MS = 11000;
const TRUTH_PTS = 1000;
const FOOL_PTS  = 500;

export class Host {
  constructor(room, opts = {}) {
    this.room = room;
    this.rounds = opts.rounds || meta.defaultRounds;
    this.timer = null;
    this.deck = [];
  }

  async load() {
    const data = await loadJSON(contentURL('liars.json'));
    this.deck = sample(data.questions, this.rounds);
    return this;
  }

  async begin() {
    await this.room.setGame('liars');
    await this.room.setPhase('playing');
    await this.ask(0);
  }

  async ask(index) {
    clearTimeout(this.timer);
    if (index >= this.deck.length) return this.finish();
    const q = this.deck[index];
    await this.room.clearRoundData();
    await this.room.setRound({
      phase: 'write',
      index, total: this.deck.length,
      q: q.q,
      truth: q.answer,            // readable by a devtools cheater; see README
      note: q.note || '',
      startedAt: Date.now(),
      deadline: Date.now() + WRITE_MS
    });
    this.timer = setTimeout(() => this.startPick(), WRITE_MS);
  }

  async onSubmissions(subs, players) {
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round || round.phase !== 'write') return;
    const live = playerList(players).filter(p => p.connected !== false).length;
    if (live && Object.keys(subs || {}).length >= live) {
      clearTimeout(this.timer);
      await this.startPick();
    }
  }

  async onVotes(votes, players) {
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round || round.phase !== 'pick') return;
    const live = playerList(players).filter(p => p.connected !== false).length;
    if (live && Object.keys(votes || {}).length >= live) {
      clearTimeout(this.timer);
      await this.reveal();
    }
  }

  async startPick() {
    clearTimeout(this.timer);
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round || round.phase !== 'write') return;

    const subs = (await this.room.t.get(`${this.room.base}/submissions`)) || {};
    const norm = s => String(s || '').trim().toLowerCase().replace(/[^\w\s]/g, '');
    const truthN = norm(round.truth);

    // Dedupe lies; a lie identical to the truth is dropped (they just win the
    // pick by knowing it), and identical lies merge so both authors score.
    const byText = new Map();
    for (const [pid, s] of Object.entries(subs)) {
      const t = String(s.text || '').trim();
      if (!t) continue;
      const k = norm(t);
      if (k === truthN) continue;
      if (!byText.has(k)) byText.set(k, { text: t, authors: [] });
      byText.get(k).authors.push(pid);
    }
    const options = shuffle([
      { text: round.truth, truth: true, authors: [] },
      ...byText.values()
    ]).map((o, i) => ({ ...o, slot: i }));

    await this.room.patchRound({ phase: 'pick', options, deadline: Date.now() + PICK_MS });
    this.timer = setTimeout(() => this.reveal(), PICK_MS);
  }

  async reveal() {
    clearTimeout(this.timer);
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round || round.phase !== 'pick') return;

    const votes = (await this.room.t.get(`${this.room.base}/votes`)) || {};
    const gained = {};
    const picks = {};        // slot -> [pid]
    const add = (pid, n) => { gained[pid] = (gained[pid] || 0) + n; };

    for (const [pid, slot] of Object.entries(votes)) {
      const opt = round.options.find(o => String(o.slot) === String(slot));
      if (!opt) continue;
      (picks[slot] = picks[slot] || []).push(pid);
      if (opt.truth) add(pid, TRUTH_PTS);
      else for (const author of opt.authors) if (author !== pid) add(author, FOOL_PTS);
    }
    for (const [pid, n] of Object.entries(gained)) await this.room.addScore(pid, n);

    await this.room.patchRound({ phase: 'reveal', gained, picks });
    this.timer = setTimeout(() => this.ask(round.index + 1), REVEAL_MS);
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
    if (round.phase === 'write') this.timer = setTimeout(() => this.startPick(), left);
    else if (round.phase === 'pick') this.timer = setTimeout(() => this.reveal(), left);
    else if (round.phase === 'reveal') this.timer = setTimeout(() => this.ask(round.index + 1), 2500);
  }

  stop() { clearTimeout(this.timer); }
}

/* -------------------------------- views -------------------------------- */

function blank(q) { return esc(q).replace(/_{2,}/g, '<b class="fill">______</b>'); }
function filled(q, a) { return esc(q).replace(/_{2,}/g, `<b class="fill">${esc(a)}</b>`); }

export function hostView(round, players) {
  if (!round) return '<div class="big">Loading…</div>';
  if (round.phase === 'final') return finalScoreboard(players, 'Final scores');
  const byId = Object.fromEntries(playerList(players).map(p => [p.id, p]));
  const header = `<div class="qmeta">Round ${round.index + 1} of ${round.total}</div>`;

  if (round.phase === 'write') {
    return `${header}${timerHTML(round.deadline, WRITE_MS)}
      <h1 class="question">${blank(round.q)}</h1>
      <p class="phint big">Write a lie that sounds true.</p>`;
  }
  if (round.phase === 'pick') {
    const opts = round.options.map((o, i) =>
      `<div class="opt"><span class="letter">${String.fromCharCode(65 + i)}</span>${esc(o.text)}</div>`).join('');
    return `${header}${timerHTML(round.deadline, PICK_MS)}
      <h2 class="subq">${blank(round.q)}</h2>
      <div class="opts wide">${opts}</div>
      <p class="phint">One of these is true.</p>`;
  }
  // reveal: truth last, lies first with who fell for them
  const lies = round.options.filter(o => !o.truth);
  const truth = round.options.find(o => o.truth);
  const who = ids => (ids || []).map(id => `${byId[id]?.emoji || ''} ${esc(byId[id]?.name || '')}`).join(', ');
  const rows = lies.map(o => {
    const fooled = (round.picks || {})[o.slot] || [];
    return `<div class="rrow lie ${fooled.length ? 'scored' : ''}">
      <div class="rtext">${esc(o.text)}</div>
      <div class="rmeta">by ${who(o.authors)}${fooled.length ? ` <b>fooled ${who(fooled)}</b>` : ''}</div>
    </div>`;
  }).join('');
  const right = (round.picks || {})[truth.slot] || [];
  return `${header}
    <h2 class="subq">${filled(round.q, truth.text)}</h2>
    <div class="rlist">${rows}
      <div class="rrow truth">
        <div class="rtext">${esc(truth.text)}</div>
        <div class="rmeta">The truth. ${right.length ? `Got it: ${who(right)}` : 'Nobody got it.'}</div>
      </div>
    </div>
    ${round.note ? `<div class="note">${esc(round.note)}</div>` : ''}`;
}

export function playerView(round, me, submitted, voted, players, extra = {}) {
  if (!round || round.phase === 'final') return `<div class="pcard"><h2>Game over</h2></div>`;
  const mirror = extra.mirror;

  if (round.phase === 'write') {
    if (submitted) return `<div class="pcard"><h2>Lie submitted</h2><p>Waiting on the others.</p></div>`;
    return `<div class="pcard">
      ${mirror ? timerHTML(round.deadline, WRITE_MS) : ''}
      <p class="phint">${blank(round.q)}</p>
      <textarea class="ptext" data-role="answer" maxlength="60" placeholder="Something believable"></textarea>
      <button class="pbtn primary" data-action="submittext">Lock it in</button>
    </div>`;
  }
  if (round.phase === 'pick') {
    if (voted) return `<div class="pcard"><h2>Picked</h2><p>Let's see.</p></div>`;
    const btns = round.options.map((o, i) => {
      const mine = o.authors.includes(me.id);
      return `<button class="pbtn ${mine ? 'own' : ''}" data-action="pickvote" data-slot="${o.slot}" ${mine ? 'disabled' : ''}>
        <span class="letter">${String.fromCharCode(65 + i)}</span>${esc(o.text)}${mine ? ' <i>(yours)</i>' : ''}</button>`;
    }).join('');
    return `<div class="pcard">
      ${mirror ? timerHTML(round.deadline, PICK_MS) : ''}
      <p class="phint">${blank(round.q)}</p>
      <p class="phint small">Which one's true?</p>${btns}</div>`;
  }
  // reveal
  const got = (round.gained || {})[me.id] || 0;
  const truth = round.options.find(o => o.truth);
  const myPick = Object.entries(round.picks || {}).find(([, ids]) => ids.includes(me.id));
  const pickedTruth = myPick && String(myPick[0]) === String(truth.slot);
  const fooledN = Object.entries(round.picks || {})
    .filter(([slot]) => (round.options.find(o => String(o.slot) === String(slot)) || {}).authors?.includes(me.id))
    .reduce((n, [, ids]) => n + ids.length, 0);
  return `<div class="pcard ${got ? 'win' : 'lose'}">
    <h2>${got ? `+${got}` : 'Nothing'}</h2>
    <p><b>${pickedTruth ? 'You spotted the truth.' : 'You fell for a lie.'}</b>
       ${fooledN ? ` Your lie fooled ${fooledN}.` : ''}</p>
    <div class="rrow truth"><div class="rtext">${esc(truth.text)}</div><div class="rmeta">The truth</div></div>
    <p class="phint">${filled(round.q, truth.text)}</p>
    ${round.note ? `<p class="note">${esc(round.note)}</p>` : ''}
  </div>`;
}

/** No separate mirror view needed: playerView takes { mirror } and adds timers. */
export const mirrorView = playerView;

export async function handleAction(room, me, action, round) {
  if (!round) return;
  if (action.action === 'submittext' && round.phase === 'write') {
    const text = (action.text || '').trim().slice(0, 60);
    if (!text) return;
    await room.submit(me.id, { text });
    return { rerender: true };
  }
  if (action.action === 'pickvote' && round.phase === 'pick') {
    const opt = round.options.find(o => String(o.slot) === String(action.slot));
    if (!opt || opt.authors.includes(me.id)) return;
    await room.vote(me.id, Number(action.slot));
    return { rerender: true };
  }
}
