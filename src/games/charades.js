// ---------------------------------------------------------------------------
// CHARADES - Heads Up style, built for a TV.
//
// The word shows BIG on the TV. The active player sits facing away from the
// screen; their phone shows only GOT IT / SKIP. Everyone else shouts clues.
// 60 seconds, then the phone passes to the next player.
//
// Phases: ready -> playing -> roundEnd -> (next player) -> final
// ---------------------------------------------------------------------------

import { shuffle, esc, sortedPlayers, playerList, countdown,
         loadJSON, contentURL, timerHTML, finalScoreboard, hashKey } from '../util.js';

export const meta = {
  id: 'charades',
  name: 'Shout It Out',
  blurb: 'Word on the TV, you face away, they scream clues.',
  minPlayers: 3,
  defaultRounds: 1   // = turns per player
};

const TURN_MS    = 60000;
const READY_MS   = 5000;
const POINTS_GOT = 150;
const SKIP_COST  = 0;

export class Host {
  constructor(room, opts = {}) {
    this.room      = room;
    this.categoryName = opts.category || null;
    this.turnsEach = opts.rounds || meta.defaultRounds;
    // When the board game runs this as a one-tile minigame it names the single
    // player who has to do it, instead of queueing a turn for everybody.
    this.only      = opts.only || null;
    // Points per word. The board passes a smaller value so one lucky tile
    // can't out-earn the rest of the game.
    this.pointsPer = opts.pointsPer || POINTS_GOT;
    // headsup: no shared screen. The word shows on the active player's phone
    // (held to the forehead) and the others see "give clues".
    this.headsup   = Boolean(opts.headsup);
    this.timer     = null;
    this.words     = [];
    this.queue     = [];
  }

  async load() {
    const data = await loadJSON(contentURL('charades.json'));
    this.categories = data.categories || [];
    const chosen = this.categoryName
      ? this.categories.find(c => c.name === this.categoryName)
      : this.categories[Math.floor(Math.random() * this.categories.length)];
    this.categoryName = chosen ? chosen.name : 'Mixed';
    this.categoryEmoji = chosen ? (chosen.emoji || '') : '🎲';
    this.categoryBlurb = chosen ? (chosen.blurb || '') : 'Anything goes.';
    const pool = chosen ? chosen.words : this.categories.flatMap(c => c.words);
    this.seenPath = `${this.room.base}/seen/charades-${hashKey(this.categoryName)}`;
    let seen = (await this.room.t.get(this.seenPath)) || {};
    let fresh = pool.filter(w => !seen[hashKey(w)]);
    if (fresh.length < 15) { seen = {}; fresh = pool.slice(); await this.room.t.set(this.seenPath, {}); }
    this.words = shuffle(fresh);
    return this;
  }

  /** For the host's category picker: name/emoji/blurb/count per category. */
  static async listCategories() {
    const data = await loadJSON(contentURL('charades.json'));
    return (data.categories || []).map(c => ({
      name: c.name, emoji: c.emoji || '', blurb: c.blurb || '', count: (c.words || []).length
    }));
  }

  nextWord() {
    if (!this.words.length) return null;
    const w = this.words.pop();
    // Mark as seen only when actually shown.
    this.room.t.set(`${this.seenPath}/${hashKey(w)}`, true).catch(() => {});
    return w;
  }

  async begin() {
    await this.room.setGame('charades');
    await this.room.setPhase('playing');

    const all = playerList(await this.room.players())
      .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
    const players = this.only
      ? all.filter(p => this.only.includes(p.id))
      : all;
    this.queue = [];
    for (let t = 0; t < this.turnsEach; t++) {
      for (const p of players) this.queue.push(p.id);
    }
    if (!this.queue.length) this.queue = all.slice(0, 1).map(p => p.id);
    this.turnNo = 0;
    await this.ready();
  }

  async ready() {
    clearTimeout(this.timer);
    if (!this.queue.length) return this.finish();

    const pid = this.queue.shift();
    this.activePid = pid;
    this.turnNo++;

    await this.room.clearRoundData();
    await this.room.setRound({
      phase: 'ready',
      headsup: this.headsup,
      category: this.categoryName,
      categoryEmoji: this.categoryEmoji,
      categoryBlurb: this.categoryBlurb,
      active: pid,
      turn: this.turnNo,
      totalTurns: this.turnNo + this.queue.length,
      got: [],
      skipped: [],
      word: null,
      deadline: Date.now() + READY_MS
    });

    this.timer = setTimeout(() => this.play(), READY_MS);
  }

  async play() {
    clearTimeout(this.timer);
    const word = this.nextWord();
    if (!word) return this.finish();

    await this.room.patchRound({
      phase: 'playing',
      word,
      startedAt: Date.now(),
      deadline: Date.now() + TURN_MS
    });
    this.timer = setTimeout(() => this.endTurn(), TURN_MS);
  }

  /** Active player tapped GOT IT or SKIP. */
  async resolve(result) {
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round || round.phase !== 'playing') return;

    const got     = round.got || [];
    const skipped = round.skipped || [];

    if (result === 'got') {
      got.push(round.word);
      await this.room.addScore(round.active, this.pointsPer);
    } else {
      skipped.push(round.word);
      if (SKIP_COST) await this.room.addScore(round.active, -SKIP_COST);
    }

    const word = this.nextWord();
    if (!word) return this.endTurn();

    await this.room.patchRound({ got, skipped, word, flash: result, flashAt: Date.now() });
  }

  async endTurn() {
    clearTimeout(this.timer);
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round) return;
    await this.room.patchRound({ phase: 'roundEnd', word: null });
    this.timer = setTimeout(() => this.ready(), 6000);
  }

  async nudge(kind) {
    const round = await this.room.t.get(`${this.room.base}/round`);
    if (!round) return;
    if (kind === 'next' && round.phase === 'roundEnd') { clearTimeout(this.timer); return this.ready(); }
    if (kind === 'next' && round.phase === 'ready')    { clearTimeout(this.timer); return this.play(); }
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
    this.turnNo = round.turn || 1;
    this.activePid = round.active;
    // Rebuild the remaining turn queue from room state: everyone after the
    // active player in join order, for the turns that remain.
    const all = playerList(await this.room.players())
      .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
    const pool = this.only ? all.filter(p => this.only.includes(p.id)) : all;
    const remainingTurns = Math.max(0, (round.totalTurns || 0) - (round.turn || 0));
    const idx = Math.max(0, pool.findIndex(p => p.id === round.active));
    this.queue = [];
    for (let k = 1; k <= remainingTurns; k++) this.queue.push(pool[(idx + k) % pool.length].id);
    if (round.phase === 'ready') this.timer = setTimeout(() => this.play(), left);
    else if (round.phase === 'playing') this.timer = setTimeout(() => this.endTurn(), left);
    else if (round.phase === 'roundEnd') this.timer = setTimeout(() => this.ready(), 2500);
  }

  stop() { clearTimeout(this.timer); }
}

/* ------------------------------- views --------------------------------- */

export function hostView(round, players) {
  if (!round) return '<div class="big">Loading…</div>';
  if (round.phase === 'final') return scoreboard(players, 'Final scores');

  const byId = Object.fromEntries(playerList(players).map(p => [p.id, p]));
  const who  = byId[round.active] || {};
  const header = `<div class="qmeta">${round.categoryEmoji || ''} ${esc(round.category || '')} &nbsp;&nbsp; turn ${round.turn} of ${round.totalTurns}</div>`;

  if (round.phase === 'ready') {
    return `
      ${header}
      <div class="catbadge"><span class="catemoji">${round.categoryEmoji || ''}</span>${esc(round.category || '')}</div>
      <h1 class="question">${who.emoji || '🎲'} ${esc(who.name || '')}, face away from the screen</h1>
      <p class="phint big">${esc(round.categoryBlurb || 'Everyone else: give clues.')} Don't say the word.</p>
      ${timerHTML(round.deadline, READY_MS)}`;
  }

  if (round.phase === 'playing') {
    const got = (round.got || []).length;
    return `
      ${header}
      ${timerHTML(round.deadline, TURN_MS, true)}
      <div class="word ${round.flash === 'got' ? 'flash-got' : round.flash === 'skip' ? 'flash-skip' : ''}">${esc(round.word || '')}</div>
      <p class="phint">${who.emoji || '🎲'} ${esc(who.name || '')} is guessing &nbsp;&nbsp; ${got} so far</p>`;
  }

  // roundEnd
  const got = round.got || [];
  const skipped = round.skipped || [];
  const next = `<button class="nextbtn" data-next="1">Next player</button>`;
  const list = w => w.length
    ? w.map(x => `<li>${esc(x)}</li>`).join('')
    : '<li class="muted">none</li>';
  return `
    ${header}
    <h1 class="question">${who.emoji || '🎲'} ${esc(who.name || '')} got ${got.length}</h1>
    <div class="twocol">
      <div><h3>Got it</h3><ul class="wlist got">${list(got)}</ul></div>
      <div><h3>Skipped</h3><ul class="wlist skip">${list(skipped)}</ul></div>
    </div>${next}`;
}
export function setSubmissions() {}
export function setVotes() {}

export function playerView(round, me, _a, _b, _c, extra = {}) {
  if (!round || round.phase === 'final') {
    return `<div class="pcard"><h2>Game over</h2><p>Check the scores.</p></div>`;
  }
  const isActive = round.active === me.id;
  const headsup = Boolean(round.headsup);

  if (!isActive) {
    if (round.phase === 'playing') {
      return `<div class="pcard">
        <h2>Shout clues</h2>
        <p>${esc(round.categoryBlurb || '')} Don't say the word, don't rhyme it, don't spell it.</p>
        <p class="phint">${headsup ? 'Read it off their forehead.' : 'Read it off the TV.'} ${(round.got || []).length} so far.</p>
      </div>`;
    }
    if (round.phase === 'roundEnd') {
      return `<div class="pcard"><h2>${(round.got || []).length} got</h2><p>Next player up.</p></div>`;
    }
    return `<div class="pcard"><h2>Hang tight</h2><p>Not your turn yet.</p></div>`;
  }

  if (round.phase === 'ready') {
    return `<div class="pcard tall">
      <div class="catbadge"><span class="catemoji">${round.categoryEmoji || ''}</span>${esc(round.category || '')}</div>
      <h2>You're up</h2>
      <p>${headsup
        ? 'Hold the phone to your forehead, screen facing them. Tilt <b>down</b> for got it, <b>up</b> to skip.'
        : 'Face away from the TV. Starting in a second.'}</p>
      ${headsup && needsMotionPrompt() ? `<button class="pbtn primary" data-action="enabletilt">Enable tilt</button>` : ''}
      ${timerHTML(round.deadline, READY_MS)}
    </div>`;
  }

  if (round.phase === 'roundEnd') {
    return `<div class="pcard win"><h2>${(round.got || []).length} correct</h2><p>Pass it on.</p></div>`;
  }

  if (headsup) {
    // The forehead screen. Big word, tilt zones, buttons as fallback.
    return `
      <div class="hu" data-tilt>
        <div class="hu-top">
          ${timerHTML(round.deadline, TURN_MS)}
          <span class="hu-count">${(round.got || []).length}</span>
        </div>
        <div class="hu-word ${round.flash === 'got' ? 'flash-got' : round.flash === 'skip' ? 'flash-skip' : ''}">${esc(round.word || '')}</div>
        <div class="hu-zones">
          <button class="hu-zone skip" data-action="skip">▲ Skip</button>
          <button class="hu-zone got" data-action="got">▼ Got it</button>
        </div>
        <div class="hu-state" data-tiltstate>ready</div>
      </div>`;
  }

  return `
    <div class="pcard tall">
      <button class="hugebtn got" data-action="got">GOT IT</button>
      <button class="hugebtn skip" data-action="skip">SKIP</button>
      <p class="phint small">Don't look at the screen.</p>
    </div>`;
}

function needsMotionPrompt() {
  return typeof DeviceOrientationEvent !== 'undefined' &&
         typeof DeviceOrientationEvent.requestPermission === 'function';
}

export function scoreboard(players, title = 'Scores') {
  return finalScoreboard(players, title);
}

/** The active player's taps are written as an intent the host acts on. */
export async function handleAction(room, me, action, round) {
  if (!round || round.phase !== 'playing' || round.active !== me.id) return;
  if (action.action === 'got' || action.action === 'skip') {
    await room.t.set(`${room.base}/intent`, {
      by: me.id,
      result: action.action === 'got' ? 'got' : 'skip',
      word: round.word,
      at: Date.now()
    });
    return { rerender: true };
  }
}
