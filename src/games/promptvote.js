// ---------------------------------------------------------------------------
// PROMPTVOTE - one engine, three games.
//
//   mode 'pick' : fill-in-the-blank. Everyone holds a hand of answer cards and
//                 plays one (or two) into a prompt. Cards-Against-style.
//   mode 'type' : open prompt, everyone types their own answer. Quiplash-style.
//   mode 'meme' : same as 'type' but the prompt carries an image.
//
//   judge 'all'  : everyone votes, can't vote for themselves. Points per vote.
//   judge 'czar' : one rotating judge picks the winner. Winner takes the pot.
//
// Phases: answer -> vote -> reveal -> (next round) -> final
// ---------------------------------------------------------------------------

import { shuffle, sample, esc, sortedPlayers, playerList, countdown,
         fillBlanks, timerHTML, finalScoreboard,
         pendingPlayers, waitingHTML, revealMs, sampleUnseen, isPresent } from '../util.js';
import { loadPack } from '../content.js';

export const meta = {
  id: 'promptvote',
  name: 'Prompt & Vote',
  blurb: 'Fill in the blank, or write your own. Funniest wins.',
  minPlayers: 3,
  defaultRounds: 8
};

const HAND_SIZE   = 7;
const ANSWER_MS   = 90000;
const VOTE_MS     = 45000;
const REVEAL_MS   = 9000;
const PER_VOTE    = 300;
const CZAR_PRIZE  = 1000;
const SWEEP_BONUS = 250;

export class Host {
  constructor(room, opts = {}) {
    this.room   = room;
    this.mode   = opts.mode  || 'pick';     // pick | type | meme
    this.judge  = opts.judge || 'all';      // all | czar
    this.rounds = opts.rounds || meta.defaultRounds;
    this.timer  = null;
    this.prompts = [];
    this.answerDeck = [];
    this.discard = [];
  }

  async load() {
    if (this.mode === 'pick') {
      const prompts = await loadPack('fillblank');
      const answers = await loadPack('answers');
      this.prompts    = await sampleUnseen(this.room, 'fillblank', prompts, this.rounds, p => p.text);
      this.answerDeck = shuffle(answers);
    } else {
      const prompts = await loadPack(this.mode === 'meme' ? 'memes' : 'quiplash');
      const raw = prompts.map(p => (typeof p === 'string' ? { text: p } : p));
      this.prompts = await sampleUnseen(this.room, this.mode === 'meme' ? 'memes' : 'quiplash', raw, this.rounds, p => p.text);
    }
    return this;
  }

  draw(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (!this.answerDeck.length) {
        this.answerDeck = shuffle(this.discard);
        this.discard = [];
      }
      if (!this.answerDeck.length) break;
      out.push(this.answerDeck.pop());
    }
    return out;
  }

  /** Swap the whole hand, once per game per player. */
  async mulligan(pid) {
    const used = (await this.room.t.get(`${this.room.base}/mulliganed/${pid}`));
    if (used) return false;
    const hand = (await this.room.t.get(`${this.room.base}/hands/${pid}`)) || [];
    this.discard.push(...hand);
    await this.room.t.set(`${this.room.base}/hands/${pid}`, this.draw(HAND_SIZE));
    await this.room.t.set(`${this.room.base}/mulliganed/${pid}`, true);
    return true;
  }

  async dealTo(pid, hand) {
    const need = HAND_SIZE - (hand ? hand.length : 0);
    const next = (hand || []).concat(this.draw(Math.max(0, need)));
    await this.room.t.set(`${this.room.base}/hands/${pid}`, next);
    return next;
  }

  async begin() {
    await this.room.setGame('promptvote');
    await this.room.setPhase('playing');

    await this.room.t.remove(`${this.room.base}/mulliganed`);
    if (this.mode === 'pick') {
      const players = await this.room.players();
      for (const pid of Object.keys(players)) await this.dealTo(pid, []);
    }
    await this.ask(0);
  }

  async ask(index) {
    clearTimeout(this.timer);
    if (index >= this.prompts.length) return this.finish();

    const players = playerList(await this.room.players());
    const prompt = this.prompts[index];
    const blanks = prompt.blanks || 1;

    // Czar rotates in stable join order.
    const ordered = players.slice().sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
    const czar = this.judge === 'czar' && ordered.length
      ? ordered[index % ordered.length].id
      : null;

    await this.room.clearRoundData();
    await this.room.t.remove(`${this.room.base}/skipped`);
    await this.room.setRound({
      phase: 'answer',
      mode: this.mode,
      judge: this.judge,
      index,
      total: this.prompts.length,
      prompt: prompt.text,
      image: prompt.image || null,
      blanks,
      czar,
      startedAt: Date.now(),
      deadline: Date.now() + ANSWER_MS
    });

    if (this.mode === 'pick') {
      const hands = (await this.room.t.get(`${this.room.base}/hands`)) || {};
      for (const p of players) await this.dealTo(p.id, hands[p.id] || []);
    }

    this.timer = setTimeout(() => this.startVote(), ANSWER_MS);
  }

  /**
   * Called whenever the player list changes. Anyone who joined mid-round — or
   * whose phone dropped and came back — has no cards, and without this they
   * would stare at an empty hand until the next round started.
   */
  async onPlayers(players) {
    if (this.mode !== 'pick') return;
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round || round.phase !== 'answer') return;

    const hands = (await this.room.t.get(`${this.room.base}/hands`)) || {};
    for (const pid of Object.keys(players || {})) {
      const hand = hands[pid] || [];
      if (hand.length < HAND_SIZE) await this.dealTo(pid, hand);
    }
  }

  /** Everyone who needs to answer has answered -> move on early. */
  async onSubmissions(subs, players) {
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round || round.phase !== 'answer') return;
    const hands = this.mode === 'pick'
      ? ((await this.room.t.get(`${this.room.base}/hands`)) || {})
      : null;
    const skipped = (await this.room.t.get(`${this.room.base}/skipped`)) || {};
    const expected = playerList(players)
      .filter(p => isPresent(p) && p.id !== round.czar && !skipped[p.id])
      .filter(p => !hands || (hands[p.id] || []).length > 0).length;
    if (expected && Object.keys(subs || {}).length >= expected) {
      clearTimeout(this.timer);
      await this.startVote();
    }
  }

  async onVotes(votes, players) {
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round || round.phase !== 'vote') return;
    const subs = (await this.room.t.get(`${this.room.base}/submissions`)) || {};

    if (round.judge === 'czar') {
      if (votes && votes[round.czar]) {
        clearTimeout(this.timer);
        await this.reveal();
      }
      return;
    }
    const skipped = (await this.room.t.get(`${this.room.base}/skipped`)) || {};
    const eligible = playerList(players)
      .filter(p => isPresent(p) && subs[p.id] && !skipped[p.id]).length;
    if (eligible && Object.keys(votes || {}).length >= eligible) {
      clearTimeout(this.timer);
      await this.reveal();
    }
  }

  async startVote() {
    clearTimeout(this.timer);
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round || round.phase !== 'answer') return;

    const subs = (await this.room.t.get(`${this.room.base}/submissions`)) || {};
    const entries = shuffle(Object.entries(subs));

    // Slot ids decouple the on-screen order from player identity.
    const slots = entries.map(([pid, s], i) => ({
      slot: i,
      pid,
      text: s.text || ''
    }));

    if (!slots.length) return this.ask(round.index + 1);

    if (this.mode === 'pick') {
      const hands = (await this.room.t.get(`${this.room.base}/hands`)) || {};
      for (const [pid, s] of entries) {
        const used = s.cards || [];
        const hand = (hands[pid] || []).filter(c => !used.includes(c));
        this.discard.push(...used);
        await this.room.t.set(`${this.room.base}/hands/${pid}`, hand);
      }
    }

    await this.room.patchRound({
      phase: 'vote',
      slots,
      deadline: Date.now() + VOTE_MS
    });
    this.timer = setTimeout(() => this.reveal(), VOTE_MS);
  }

  async reveal() {
    clearTimeout(this.timer);
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round || round.phase !== 'vote') return;

    const votes = (await this.room.t.get(`${this.room.base}/votes`)) || {};
    const tally = {};
    for (const slot of round.slots) tally[slot.slot] = 0;
    for (const target of Object.values(votes)) {
      if (tally[target] !== undefined) tally[target]++;
    }

    const gained = {};
    if (round.judge === 'czar') {
      const pickedSlot = votes[round.czar];
      const winner = round.slots.find(s => String(s.slot) === String(pickedSlot));
      if (winner) {
        gained[winner.pid] = CZAR_PRIZE;
        await this.room.addScore(winner.pid, CZAR_PRIZE);
      }
    } else {
      const voters = Object.keys(votes).length;
      for (const slot of round.slots) {
        const n = tally[slot.slot] || 0;
        let pts = n * PER_VOTE;
        if (n > 0 && voters > 2 && n === voters) pts += SWEEP_BONUS;
        if (pts) {
          gained[slot.pid] = pts;
          await this.room.addScore(slot.pid, pts);
        }
      }
    }

    await this.room.patchRound({ phase: 'reveal', tally, gained });
    this.timer = setTimeout(() => this.ask(round.index + 1), revealMs(round.slots.length));
  }

  async nudge(kind, pid) {
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round) return;
    if (kind === 'mulligan' && pid && round.phase === 'answer' && this.mode === 'pick') return this.mulligan(pid);
    if (kind === 'next' && round.phase === 'reveal') { clearTimeout(this.timer); return this.ask(round.index + 1); }
    if (kind === 'skip' && pid) {
      if (round.phase === 'answer') {
        // Drop them from this round; onSubmissions will close it if they were last.
        await this.room.t.set(`${this.room.base}/skipped/${pid}`, true);
        await this.onSubmissions((await this.room.t.get(`${this.room.base}/submissions`)) || {}, await this.room.players());
      } else if (round.phase === 'vote') {
        await this.room.t.set(`${this.room.base}/skipped/${pid}`, true);
        await this.onVotes((await this.room.t.get(`${this.room.base}/votes`)) || {}, await this.room.players());
      }
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
    // Re-sample the deck position so later rounds have prompts to draw from.
    if (round.index !== undefined && this.prompts.length <= round.index + 1) {
      // not enough prompts loaded for the rest of the game; load() already
      // sampled a fresh set, which is acceptable after a takeover.
    }
    if (round.phase === 'answer') this.timer = setTimeout(() => this.startVote(), left);
    else if (round.phase === 'vote') this.timer = setTimeout(() => this.reveal(), left);
    else if (round.phase === 'reveal') this.timer = setTimeout(() => this.ask(round.index + 1), 2500);
  }

  stop() { clearTimeout(this.timer); }
}

/* ------------------------------- views --------------------------------- */

function promptHTML(round, answers) {
  if (round.mode === 'pick') return fillBlanks(round.prompt, answers || []);
  return esc(round.prompt);
}

export function hostView(round, players) {
  if (!round) return '<div class="big">Loading…</div>';
  if (round.phase === 'final') return scoreboard(players, 'Final scores');

  const byId = Object.fromEntries(playerList(players).map(p => [p.id, p]));
  const header = `<div class="qmeta">Round ${round.index + 1} of ${round.total}${
    round.czar ? ` &nbsp;&nbsp; ${esc((byId[round.czar] || {}).name || '')} judges` : ''}</div>`;
  const img = round.image
    ? `<img class="memeimg" src="${esc(round.image)}" alt="">` : '';

  if (round.phase === 'answer') {
    const exclude = round.czar ? [round.czar] : [];
    return `
      ${header}
      ${timerHTML(round.deadline, ANSWER_MS)}
      ${img}
      <h1 class="question">${promptHTML(round, [])}</h1>
      ${waitingHTML(pendingPlayers(players, liveSubs, exclude), { skippable: true })}`;
  }

  if (round.phase === 'vote') {
    const cards = round.slots.map(s => `
      <div class="vcard"><div class="vtext">${
        round.mode === 'pick' ? fillBlanks(round.prompt, [s.text]) : esc(s.text)
      }</div></div>`).join('');
    return `
      ${header}
      ${timerHTML(round.deadline, VOTE_MS)}
      ${img}
      <h2 class="subq">${promptHTML(round, [])}</h2>
      <div class="vgrid">${cards}</div>
      ${round.judge === 'czar'
        ? `<p class="phint">${esc((byId[round.czar] || {}).name || 'Judge')} picks.</p>`
        : waitingHTML(pendingPlayers(players, liveVotes, round.slots.length < 2 ? [] : []), { skippable: true })}`;
  }

  // reveal
  const cards = round.slots.map(s => {
    const n = (round.tally || {})[s.slot] || 0;
    const pts = (round.gained || {})[s.pid] || 0;
    const who = byId[s.pid] || {};
    return `
      <div class="vcard ${pts ? 'won' : ''}">
        <div class="vtext">${round.mode === 'pick'
          ? fillBlanks(round.prompt, [s.text]) : esc(s.text)}</div>
        <div class="vwho">${who.emoji || '🎲'} ${esc(who.name || '')}
          ${n ? `&nbsp;&nbsp; ${n} vote${n === 1 ? '' : 's'}` : ''}
          ${pts ? `<b>+${pts}</b>` : ''}</div>
      </div>`;
  }).join('');
  return `${header}<h2 class="subq">${promptHTML(round, [])}</h2><div class="vgrid">${cards}</div>
    <button class="nextbtn" data-next="1">Next</button>`;
}

let liveSubs = {}, liveVotes = {};
export function setSubmissions(s) { liveSubs = s || {}; }
export function setVotes(v) { liveVotes = v || {}; }

export function playerView(round, me, hand, submitted, voted, draft, extra = {}) {
  const mirror = extra && extra.mirror;
  const players = (extra && extra.players) || {};
  if (!round || round.phase === 'final') {
    return `<div class="pcard"><h2>Game over</h2><p>Check the big screen.</p></div>`;
  }

  const isCzar = round.czar === me.id;

  if (round.phase === 'reveal') {
    const got = (round.gained || {})[me.id] || 0;
    if (mirror) {
      const byId = Object.fromEntries(playerList(players).map(p => [p.id, p]));
      const cards = (round.slots || []).map(s => {
        const n = (round.tally || {})[s.slot] || 0;
        const pts = (round.gained || {})[s.pid] || 0;
        const who = byId[s.pid] || {};
        return `<div class="vcard small ${pts ? 'won' : ''}">
          <div class="vtext">${round.mode === 'pick' ? fillBlanks(round.prompt, [s.text]) : esc(s.text)}</div>
          <div class="vwho">${who.emoji || ''} ${esc(who.name || '')}${n ? ` &nbsp; ${n} vote${n === 1 ? '' : 's'}` : ''}${pts ? ` <b>+${pts}</b>` : ''}</div>
        </div>`;
      }).join('');
      return `<div class="pcard"><h2 class="${got ? 'winc' : ''}">${got ? `+${got}` : 'Nothing'}</h2><div class="vstack">${cards}</div></div>`;
    }
    return `<div class="pcard ${got ? 'win' : ''}">
      <h2>${got ? `+${got}` : 'Nothing'}</h2>
      <p>${got ? 'They liked it.' : 'Rough crowd.'}</p></div>`;
  }

  if (round.phase === 'answer') {
    if (isCzar) {
      return `<div class="pcard"><h2>You're judging</h2><p>Sit this one out. Pick the best in a sec.</p></div>`;
    }
    if (submitted) {
      return `<div class="pcard"><h2>Submitted</h2><p>Waiting on the slow ones.</p>
        ${mirror ? timerHTML(round.deadline, ANSWER_MS) : ''}</div>`;
    }

    if (round.mode === 'pick') {
      const need = round.blanks || 1;
      const picked = draft || [];
      const cards = (hand || []).map((c, i) => {
        const at = picked.indexOf(c);
        return `<button class="card ${at > -1 ? 'picked' : ''}"
            data-action="pickcard" data-card="${esc(c)}">
            ${at > -1 ? `<span class="pickno">${at + 1}</span>` : ''}${esc(c)}
          </button>`;
      }).join('');
      const ready = picked.length === need;
      return `
        <div class="pcard">
          ${mirror ? `<div class="qmeta">Round ${round.index + 1} of ${round.total}</div>${timerHTML(round.deadline, ANSWER_MS)}` : ''}
          <p class="phint prompt">${fillBlanks(round.prompt, [])}</p>
          <p class="phint small">Pick ${need} card${need > 1 ? 's' : ''}</p>
          <div class="hand">${cards}</div>
          <button class="pbtn primary" data-action="confirmcards" ${ready ? '' : 'disabled'}>
            ${ready ? 'Play it' : `Pick ${need - picked.length} more`}
          </button>
          ${extra.mulliganed ? '' : `<button class="linkbtn mull" data-action="mulligan">Hand's garbage. Swap it.</button>`}
        </div>`;
    }

    return `
      <div class="pcard">
        ${mirror ? `<div class="qmeta">Round ${round.index + 1} of ${round.total}</div>${timerHTML(round.deadline, ANSWER_MS)}` : ''}
        <p class="phint prompt">${esc(round.prompt)}</p>
        <textarea class="ptext" data-role="answer" maxlength="140"
                  placeholder="Make it hurt"></textarea>
        <button class="pbtn primary" data-action="submittext">Send it</button>
      </div>`;
  }

  // vote
  const mayVote = round.judge === 'czar' ? isCzar : true;
  if (!mayVote) {
    return `<div class="pcard"><h2>Judge is deciding</h2><p>Grovel.</p></div>`;
  }
  if (voted) {
    return `<div class="pcard"><h2>Voted</h2><p>Eyes up.</p></div>`;
  }

  const btns = round.slots.map(s => {
    const own = s.pid === me.id && round.judge !== 'czar';
    const body = (mirror && round.mode === 'pick') ? fillBlanks(round.prompt, [s.text]) : esc(s.text);
    return `<button class="pbtn vote ${own ? 'own' : ''}" data-action="vote"
      data-slot="${s.slot}" ${own ? 'disabled' : ''}>
      ${body}${own ? ' <i>(yours)</i>' : ''}</button>`;
  }).join('');

  return `<div class="pcard">
    ${mirror ? timerHTML(round.deadline, VOTE_MS) : ''}
    ${mirror && round.mode !== 'pick' ? `<p class="phint prompt">${esc(round.prompt)}</p>` : ''}
    <p class="phint small">Pick the best one</p>${btns}</div>`;
}

export function scoreboard(players, title = 'Scores') {
  return finalScoreboard(players, title);
}
export const mirrorView = playerView;

export async function handleAction(room, me, action, round, state) {
  if (!round) return;

  if (action.action === 'pickcard' && round.phase === 'answer') {
    const need = round.blanks || 1;
    const draft = state.draft || [];
    const card = action.card;
    const at = draft.indexOf(card);
    if (at > -1) draft.splice(at, 1);
    else if (draft.length < need) draft.push(card);
    state.draft = draft;
    return { rerender: true };
  }

  if (action.action === 'confirmcards' && round.phase === 'answer') {
    const draft = state.draft || [];
    if (draft.length !== (round.blanks || 1)) return;
    await room.submit(me.id, { cards: draft, text: draft.join(' / ') });
    state.draft = [];
    return { rerender: true };
  }

  if (action.action === 'submittext' && round.phase === 'answer') {
    const text = (action.text || '').trim().slice(0, 140);
    if (!text) return;
    await room.submit(me.id, { text });
    return { rerender: true };
  }

  if (action.action === 'vote' && round.phase === 'vote') {
    await room.vote(me.id, Number(action.slot));
    return { rerender: true };
  }
}
