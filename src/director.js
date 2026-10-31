// ---------------------------------------------------------------------------
// Director: the thing that runs a game.
//
// Owns the active engine and forwards room events into it. Knows nothing
// about screens. Both host.html (a TV) and play.html (a phone acting as host)
// instantiate one, which is what lets a phone drive the party.
//
// Exactly one director should be live for a room at a time. Leadership is
// recorded at rooms/{code}/director = { id, at }; a director renews its
// heartbeat and a phone that sees the heartbeat go stale can take over.
// ---------------------------------------------------------------------------

import { sortedPlayers, isPresent } from './util.js';
import { commitGame } from './scores.js';

export const ENGINES = {
  quiz:       () => import('./games/quiz.js'),
  promptvote: () => import('./games/promptvote.js'),
  charades:   () => import('./games/charades.js'),
  board:      () => import('./games/board.js'),
  liars:      () => import('./games/liars.js'),
  blindvote:  () => import('./games/blindvote.js'),
  bodycount:  () => import('./games/bodycount.js'),
  context:    () => import('./games/context.js'),
  doubledown: () => import('./games/doubledown.js')
};

/**
 * The menu. `tv: true` means the game needs a shared screen; it is hidden
 * when a phone is hosting. `mirror: true` means phones render the full
 * game state themselves when there is no shared screen.
 */
export const GAME_MENU = [
  { id: 'quiz',       opts: {},                                 label: 'Degenerate Trivia', rules: ["A question and four answers. Pick on your phone.", "Right answers score. Faster answers score more.", "Pick a category, or Mixed for a bit of everything."],        sub: 'Four options. Speed scores.',          mirror: true },
  { id: 'liars',      opts: {},                                 label: "Liar's Trivia", rules: ["You'll see a real fact with a blank in it.", "Write a fake answer that sounds true.", "Then find the truth among everyone's lies.", "Points for spotting the truth, and for everyone your lie fools."],            sub: 'Write a fake. Spot the truth.',        mirror: true },
  { id: 'doubledown', opts: {},                                 label: 'Double Down', rules: ["A board of categories and dollar values. Whoever has control picks a square on their phone.", "Everyone can buzz. First buzz answers from four choices.", "Right: win the money and control. Wrong: lose the money, and the others can buzz.", "One square is hidden: the picker wagers on it.", "Last Call: everyone bets on one final question."],              sub: 'Quiz-show board. Buzz in. Solo or teams.', mirror: true, pick: 'Pick a mode', noRandom: true },
  { id: 'bodycount',  opts: {},                                 label: 'Body Count', rules: ["Trivia. Right answers pay 1,000 while you're alive.", "Wrong answer: you go to the Basement for a quick trial on your phone. Lose it and you die.", "The dead keep playing as ghosts for smaller points.", "Final round, the Escape: right answers move you toward the door, and the killer moves every question.", "First one out wins big. Ghosts can escape too."],               sub: 'Horror trivia. Wrong answers die.',    mirror: true },
  { id: 'promptvote', opts: { mode: 'pick', judge: 'all' },      label: 'Fill In The Blank', rules: ["You get a hand of answer cards.", "Play the card that best fills the blank.", "Everyone votes for the funniest. Not your own.", "Hate your hand? You get one mulligan."],        sub: 'Play a card. Everyone votes.',          mirror: true },
  { id: 'promptvote', opts: { mode: 'pick', judge: 'czar' },     label: 'Fill In The Blank, Judge', rules: ["You get a hand of answer cards.", "Play the card that best fills the blank.", "One judge picks the winner each round. The judge rotates.", "Hate your hand? You get one mulligan."], sub: 'One rotating judge picks.',             mirror: true },
  { id: 'promptvote', opts: { mode: 'type', judge: 'all' },      label: 'Write Your Own', rules: ["Type your own answer to the prompt.", "Everyone votes for the funniest. Not your own.", "Points for every vote you get."],           sub: 'Type an answer. Funniest wins.',        mirror: true },
  { id: 'context',    opts: {},                                  label: 'Out of Context', rules: ["Answer a normal question about yourself.", "Your answer goes to someone else, who writes the setting that makes it look worst.", "Everyone votes for the best one. The writer gets 500 a vote, the original author 200.", "Last round counts double. Needs 3+ players."],           sub: 'Your answer. Their setting. 3+ players.', mirror: true },
  { id: 'blindvote',  opts: { mode: 'wyr' },                     label: 'Would You Rather', rules: ["Two bad options. Pick one on your phone.", "Side with the majority to score.", "The minority has to explain themselves."],         sub: 'Two bad options. The room splits.',     mirror: true },
  { id: 'blindvote',  opts: { mode: 'likely' },                  label: 'Most Likely To', rules: ["Vote for who's most likely to do it. You can vote for yourself.", "Points if you voted with the room."],           sub: 'Vote for a person. Results reveal.',    mirror: true },
  { id: 'charades',   opts: {},                                  label: 'Shout It Out', rules: ["One person stands with their back to the TV.", "Everyone else shouts clues. No saying the word, rhyming it, or spelling it.", "The guesser taps Got it or Skip on their phone. 60 seconds a turn.", "The guesser gets an I'm ready button to start when set."],             sub: 'Word on the TV, you face away.',        tv: true, phoneMode: 'headsup' },
  { id: 'board',      opts: {},                                  label: 'Spiral', rules: ["Take turns rolling on your phone and moving around the board.", "Spaces pay, cost, hand out items, or start minigames.", "At a fork, choose your path on your phone.", "Land on someone and you duel. Most points at the end wins."],                   sub: 'A board. Minigames. Consequences.',     tv: true }
];

export const LENGTHS = {
  quick:    { label: 'Quick',    mult: 0.6 },
  standard: { label: 'Standard', mult: 1.0 },
  long:     { label: 'Long',     mult: 1.6 }
};

const HEARTBEAT_MS = 4000;
const RULES_MAX_MS = 120000;   // rules screen starts the game on its own after this
const HEADSUP_RULES = ['Hold the phone sideways on your forehead, screen facing out.', 'Everyone else shouts clues. No saying the word.', 'Tip down for got it, tip up to skip. 60 seconds a turn.', 'The guesser can tap I\'m ready to start early.'];
const STALE_MS     = 12000;

export class Director {
  constructor(room, { id, onState, onDemoted } = {}) {
    this.room = room;
    this.id = id;
    this.onState = onState || (() => {});
    this.onDemoted = onDemoted || null;
    this.engine = null;
    this.mod = null;
    this.gameId = null;
    this.players = {};
    this._committed = false;
    this._unsubs = [];
    this._hb = null;
    this._launching = false;
  }

  get base() { return this.room.base; }

  /* ----------------------------- leadership ----------------------------- */

  async claim() {
    this.demoted = false;
    await this.room.t.set(`${this.base}/director`, { id: this.id, at: Date.now() });
    // If this tab dies, drop the claim so another device can take over.
    await this.room.t.onDisconnectRemove(`${this.base}/director`);
    this._hb = setInterval(() => this.heartbeat().catch(() => {}), HEARTBEAT_MS);
    // Only one device may run the game. If someone else holds a live claim
    // (they took over while this phone was asleep), stop immediately.
    this._dirUnsub = this.room.on('director', v => {
      if (v && v.id && v.id !== this.id && !Director.isStale(v)) this.stepDown(v.id);
    });
  }

  async heartbeat() {
    if (this.demoted) return;
    const cur = await this.room.t.get(`${this.base}/director`);
    if (cur && cur.id && cur.id !== this.id && !Director.isStale(cur)) return this.stepDown(cur.id);
    await this.room.t.set(`${this.base}/director`, { id: this.id, at: Date.now() });
    // A dropped connection fires (and uses up) the disconnect handler: re-arm it.
    if (!cur || cur.id !== this.id) await this.room.t.onDisconnectRemove(`${this.base}/director`);
  }

  /** Another device is running the game now. Stop everything here. */
  stepDown(byId) {
    if (this.demoted) return;
    this.demoted = true;
    if (this._introDone) { const f = this._introDone; this._introDone = null; }
    this.stop();
    this.engine = null; this.mod = null; this.gameId = null;
    this.onDemoted?.(byId);
  }

  /** Pick up a game that's already running (after a reload or takeover). */
  async adoptRunning(GAME_MENU_REF) {
    const game = await this.room.t.get(`${this.base}/game`);
    const menuIndex = await this.room.t.get(`${this.base}/menuIndex`);
    if (!game || menuIndex === null || menuIndex === undefined || !ENGINES[game]) return false;
    const mod = await ENGINES[game]();
    const engine = new mod.Host(this.room, (GAME_MENU_REF || GAME_MENU)[menuIndex]?.opts || {});
    await engine.load();
    this.mod = mod; this.engine = engine; this.gameId = game;
    const r = await this.room.t.get(`${this.base}/round`);
    if (r && r.phase === 'intro') {
      this.waitIntro().then(go => { if (go && this.engine === engine) engine.begin(); });
      return true;
    }
    if (engine.resume) await engine.resume();
    return true;
  }

  static get STALE_MS() { return STALE_MS; }

  static isStale(director) {
    return !director || !director.at || (Date.now() - director.at) > STALE_MS;
  }

  /* ------------------------------- wiring ------------------------------- */

  attach() {
    const on = (path, cb) => this._unsubs.push(this.room.on(path, cb));
    on('players', v => {
      this.players = v || {};
      this.engine?.onPlayers?.(this.players);
      this.onState();
    });
    on('submissions', v => { this.subs = v || {}; this.mod?.setSubmissions?.(this.subs); this.engine?.onSubmissions?.(this.subs, this.players); this.onState(); });
    on('votes',       v => { this.votes = v || {}; this.mod?.setVotes?.(this.votes); this.engine?.onVotes?.(this.votes, this.players); this.onState(); });
    on('intent',      v => this.onIntent(v));
    on('round',       v => { if (v && v.phase === 'final') this.commitIfNeeded(); });
    on('board',       v => { if (v && v.phase === 'final') this.commitIfNeeded(); });
    return this;
  }

  async onIntent(intent) {
    if (!intent) return;
    if (intent.action === 'endgame') {
      // Any phone can send the room back to the lobby, even after the game finished.
      if (intent.at && intent.at === this._lastIntentAt) return;
      this._lastIntentAt = intent.at;
      await this.room.t.remove(`${this.base}/intent`);
      return this.endGame();
    }
    if (!this.engine) return;
    if (intent.at && intent.at === this._lastIntentAt) return;
    this._lastIntentAt = intent.at;
    if (this._introDone && (intent.action === 'ready' || intent.action === 'next')) {
      await this.room.t.remove(`${this.base}/intent`);
      return intent.action === 'ready' ? this.markReady(intent.by) : this.startNow();
    }
    if (intent.action === 'roll' || intent.action === 'useitem' || intent.action === 'fork') {
      await this.engine.onIntent?.(intent);
    } else if (intent.action === 'next' || intent.action === 'skip' || intent.action === 'mulligan') {
      await this.engine.nudge?.(intent.action, intent.pid || intent.by);
    } else if (intent.action && this.engine.onIntent && !intent.result) {
      await this.engine.onIntent(intent);
    } else if (intent.result) {
      if (this.gameId === 'charades') await this.engine.resolve(intent.result);
      else await this.engine.charadesResolve?.(intent.result);
    }
    await this.room.t.remove(`${this.base}/intent`);
  }

  /* ------------------------------ lifecycle ----------------------------- */

  async launch(menuIndex, extraOpts = {}) {
    if (this._launching) return;
    const choice = GAME_MENU[menuIndex];
    if (!choice) return;
    this._launching = true;
    try {
      const mod = await ENGINES[choice.id]();
      const length = (await this.room.t.get(`${this.base}/length`)) || 'standard';
      const mult = (LENGTHS[length] || LENGTHS.standard).mult;
      const base = (choice.opts && choice.opts.rounds) || mod.meta?.defaultRounds || 8;
      const rounds = Math.max(1, Math.round(base * mult));
      const engine = new mod.Host(this.room, { rounds, ...choice.opts, ...extraOpts });
      await engine.load();
      this.mod = mod;
      this.gameId = choice.id;
      this.engine = engine;
      this._committed = false;
      await this.room.t.set(`${this.base}/menuIndex`, menuIndex);
      // Rules screen. Waits for the host's Start, or everyone tapping Ready.
      const title = (extraOpts.headsup ? 'Heads Up' : choice.label);
      const hint  = mod.meta?.blurb || choice.sub || '';
      const rules = extraOpts.headsup ? HEADSUP_RULES : (choice.rules || []);
      const mode  = extraOpts.category ? String(extraOpts.category) : '';
      await this.room.setGame(choice.id);
      await this.room.setPhase('playing');
      await this.room.setRound({ phase: 'intro', title, hint, rules, mode, ready: {}, until: Date.now() + RULES_MAX_MS });
      const go = await this.waitIntro();
      if (!go || this.engine !== engine) return;      // ended during the rules
      await engine.begin();
    } finally {
      this._launching = false;
    }
  }

  /** Party standings: every finished game in this room adds to a running total. */
  async addToParty() {
    const ranked = sortedPlayers(this.players);
    if (!ranked.length) return;
    const top = ranked[0].score || 0;
    const party = (await this.room.t.get(`${this.base}/party`)) || {};
    const patch = {};
    for (const p of ranked) {
      const cur = party[p.id] || { total: 0, wins: 0, games: 0 };
      patch[p.id] = {
        name: p.name, emoji: p.emoji || '',
        total: (cur.total || 0) + (p.score || 0),
        wins: (cur.wins || 0) + (top > 0 && (p.score || 0) === top ? 1 : 0),
        games: (cur.games || 0) + 1
      };
    }
    await this.room.t.update(`${this.base}/party`, patch);
  }

  async commitIfNeeded() {
    if (this._committed || !this.gameId) return;
    this._committed = true;
    const results = sortedPlayers(this.players).map(p => ({ name: p.name, score: p.score || 0 }));
    try { await commitGame(this.gameId, this.room.code, results); } catch (e) { console.error(e); }
    try { await this.addToParty(); } catch (e) { console.error(e); }
    // Tell screens the all-time board has the new totals.
    await this.room.t.set(`${this.base}/committed`, Date.now());
  }

  /** Back to the lobby. Keeps players; does not record the abandoned game. */
  async endGame() {
    if (this._introDone) this._introDone(false);
    this.engine?.stop?.();
    this.engine = null; this.mod = null; this.gameId = null;
    this._committed = false;
    await this.room.setGame(null);
    await this.room.setRound(null);
    await this.room.clearRoundData();
    for (const k of ['hands', 'board', 'mini', 'intent', 'menuIndex', 'mulliganed', 'skipped', 'highlights', 'committed']) {
      await this.room.t.remove(`${this.base}/${k}`);
    }
    await this.room.setPhase('lobby');
    for (const pid of Object.keys(this.players)) {
      await this.room.t.set(`${this.base}/players/${pid}/score`, 0);
    }
  }

  async setLength(key) {
    if (!LENGTHS[key]) return;
    await this.room.t.set(`${this.base}/length`, key);
  }

  /** Host screen or hosting phone: advance a reveal, or skip a straggler. */
  /** Resolve true when the host starts, everyone's ready, or the timer runs out; false if ended. */
  waitIntro() {
    clearTimeout(this._introT);
    return new Promise(resolve => {
      this._introDone = v => { clearTimeout(this._introT); const f = this._introDone; this._introDone = null; if (f) resolve(v); };
      this._introT = setTimeout(() => this._introDone && this._introDone(true), RULES_MAX_MS);
    });
  }
  startNow() { if (this._introDone) this._introDone(true); }

  async markReady(pid) {
    if (!this._introDone || !pid) return;
    await this.room.t.set(`${this.base}/round/ready/${pid}`, true);
    const r = await this.room.t.get(`${this.base}/round`);
    const ready = (r && r.ready) || {};
    const here = Object.entries(this.players || {}).filter(([, p]) => isPresent(p)).map(([id]) => id);
    if (here.length && here.every(id => ready[id])) this.startNow();
  }

  async nudge(kind, pid) {
    if (this._introDone && kind === 'next') return this.startNow();
    if (this.engine) return this.engine.nudge?.(kind, pid);
  }

  /** After a finished game: same as endGame but the result was already recorded. */
  async playAgain() { return this.endGame(); }

  stop() {
    clearInterval(this._hb);
    try { this._dirUnsub?.(); } catch {} this._dirUnsub = null;
    this.engine?.stop?.();
    for (const u of this._unsubs) { try { u(); } catch {} }
    this._unsubs = [];
  }
}
