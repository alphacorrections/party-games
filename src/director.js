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

import { sortedPlayers } from './util.js';
import { commitGame } from './scores.js';

export const ENGINES = {
  quiz:       () => import('./games/quiz.js'),
  promptvote: () => import('./games/promptvote.js'),
  charades:   () => import('./games/charades.js'),
  board:      () => import('./games/board.js'),
  liars:      () => import('./games/liars.js'),
  blindvote:  () => import('./games/blindvote.js')
};

/**
 * The menu. `tv: true` means the game needs a shared screen; it is hidden
 * when a phone is hosting. `mirror: true` means phones render the full
 * game state themselves when there is no shared screen.
 */
export const GAME_MENU = [
  { id: 'quiz',       opts: {},                                 label: 'Degenerate Trivia',        sub: 'Four options. Speed scores.',          mirror: true },
  { id: 'liars',      opts: {},                                 label: "Liar's Trivia",            sub: 'Write a fake. Spot the truth.',        mirror: true },
  { id: 'promptvote', opts: { mode: 'pick', judge: 'all' },      label: 'Fill In The Blank',        sub: 'Play a card. Everyone votes.',          mirror: true },
  { id: 'promptvote', opts: { mode: 'pick', judge: 'czar' },     label: 'Fill In The Blank, Judge', sub: 'One rotating judge picks.',             mirror: true },
  { id: 'promptvote', opts: { mode: 'type', judge: 'all' },      label: 'Write Your Own',           sub: 'Type an answer. Funniest wins.',        mirror: true },
  { id: 'blindvote',  opts: { mode: 'wyr' },                     label: 'Would You Rather',         sub: 'Two bad options. The room splits.',     mirror: true },
  { id: 'blindvote',  opts: { mode: 'likely' },                  label: 'Most Likely To',           sub: 'Vote for a person. Results reveal.',    mirror: true },
  { id: 'charades',   opts: {},                                  label: 'Shout It Out',             sub: 'Word on the TV, you face away.',        tv: true, phoneMode: 'headsup' },
  { id: 'board',      opts: {},                                  label: 'Spiral',                   sub: 'A board. Minigames. Consequences.',     tv: true }
];

const HEARTBEAT_MS = 4000;
const STALE_MS     = 12000;

export class Director {
  constructor(room, { id, onState } = {}) {
    this.room = room;
    this.id = id;
    this.onState = onState || (() => {});
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
    await this.room.t.set(`${this.base}/director`, { id: this.id, at: Date.now() });
    this._hb = setInterval(() => {
      this.room.t.update(`${this.base}/director`, { at: Date.now() }).catch(() => {});
    }, HEARTBEAT_MS);
    // If this tab dies, drop the claim so another device can take over.
    await this.room.t.onDisconnectRemove(`${this.base}/director`);
  }

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
    on('submissions', v => this.engine?.onSubmissions?.(v || {}, this.players));
    on('votes',       v => this.engine?.onVotes?.(v || {}, this.players));
    on('intent',      v => this.onIntent(v));
    on('round',       v => { if (v && v.phase === 'final') this.commitIfNeeded(); });
    on('board',       v => { if (v && v.phase === 'final') this.commitIfNeeded(); });
    return this;
  }

  async onIntent(intent) {
    if (!intent || !this.engine) return;
    if (intent.at && intent.at === this._lastIntentAt) return;
    this._lastIntentAt = intent.at;
    if (intent.action === 'roll') {
      await this.engine.onIntent?.(intent);
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
      const engine = new mod.Host(this.room, { ...choice.opts, ...extraOpts });
      await engine.load();
      this.mod = mod;
      this.gameId = choice.id;
      this.engine = engine;
      this._committed = false;
      await this.room.t.set(`${this.base}/menuIndex`, menuIndex);
      await engine.begin();
    } finally {
      this._launching = false;
    }
  }

  async commitIfNeeded() {
    if (this._committed || !this.gameId) return;
    this._committed = true;
    const results = sortedPlayers(this.players).map(p => ({ name: p.name, score: p.score || 0 }));
    commitGame(this.gameId, this.room.code, results).catch(console.error);
  }

  /** Back to the lobby. Keeps players; does not record the abandoned game. */
  async endGame() {
    this.engine?.stop?.();
    this.engine = null; this.mod = null; this.gameId = null;
    this._committed = false;
    await this.room.setGame(null);
    await this.room.setRound(null);
    await this.room.clearRoundData();
    for (const k of ['hands', 'board', 'mini', 'intent', 'menuIndex']) {
      await this.room.t.remove(`${this.base}/${k}`);
    }
    await this.room.setPhase('lobby');
    for (const pid of Object.keys(this.players)) {
      await this.room.t.set(`${this.base}/players/${pid}/score`, 0);
    }
  }

  /** After a finished game: same as endGame but the result was already recorded. */
  async playAgain() { return this.endGame(); }

  stop() {
    clearInterval(this._hb);
    this.engine?.stop?.();
    for (const u of this._unsubs) { try { u(); } catch {} }
    this._unsubs = [];
  }
}
