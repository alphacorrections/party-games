// ---------------------------------------------------------------------------
// Phone controller. Join a room, then render whatever the active game needs.
// ---------------------------------------------------------------------------

import { Room, playerIdFor, rememberName, recalledName } from './room.js';
import { getTransport } from './transport.js';
import { esc } from './util.js';
import { swapIn, stagger, countUp, sound, haptic, mountSoundToggle, flash } from './fx.js';
import { mountDie } from './dice.js';

const ENGINES = {
  quiz:       () => import('./games/quiz.js'),
  promptvote: () => import('./games/promptvote.js'),
  charades:   () => import('./games/charades.js'),
  board:      () => import('./games/board.js')
};

const el = id => document.getElementById(id);
const setHTML = (id, html) => { const n = el(id); if (n) n.innerHTML = html; };

class PlayApp {
  constructor() {
    this.me = {};
    this.state = { draft: [] };
    this.mod = null;
    this.miniMod = null;
    this.gameId = null;
    this.round = null;
    this.board = null;
    this.hand = [];
    this.submitted = false;
    this.voted = false;
  }

  async boot() {
    await getTransport();
    const code = new URLSearchParams(location.search).get('room');
    if (code) el('roomcode').value = code.toUpperCase();
    el('name').value = recalledName();
    el('join').addEventListener('click', () => this.join());
    el('joinform').addEventListener('submit', e => { e.preventDefault(); this.join(); });
  }

  async join() {
    const code = el('roomcode').value.trim().toUpperCase();
    const name = el('name').value.trim();
    if (!code || !name) return this.err('Need a room code and a name.');

    const room = await Room.open(code);
    if (!(await room.exists())) return this.err(`No room called ${code}.`);
    if (await room.isExpired())  return this.err('That room has expired.');

    this.room = room;
    this.me.id = playerIdFor(name);
    this.me.name = name;
    rememberName(name);
    this.me.emoji = await room.addPlayer(this.me.id, name);

    el('joinscreen').hidden = true;
    el('playscreen').hidden = false;
    el('whoami').innerHTML = `${this.me.emoji} ${esc(name)}`;
    mountSoundToggle(el('pbar-tools'));
    sound.lock(); haptic.lock();

    room.on('game',  v => this.onGame(v));
    room.on('round', v => this.onRound(v));
    room.on('board', v => { this.board = v; this.render(); });
    room.on('mini',  v => this.onMini(v));
    room.on('phase', v => { this.phase = v; this.render(); });
    room.on(`hands/${this.me.id}`,       v => { this.hand = v || []; this.render(); });
    room.on(`submissions/${this.me.id}`, v => { this.submitted = Boolean(v); this.render(); });
    room.on(`votes/${this.me.id}`,       v => { this.voted = v !== null && v !== undefined; this.render(); });
    room.on(`players/${this.me.id}`,     v => {
      if (v === null) return this.kicked();
      const n = el('myscore');
      const prev = Number(n.textContent) || 0;
      const next = v.score || 0;
      if (next !== prev) {
        countUp(n, next, 600);
        if (next > prev) { sound.correct(); haptic.correct(); flash('volt'); }
        else if (next < prev) { sound.wrong(); haptic.wrong(); flash('hot'); }
      }
    });
  }

  kicked() {
    this.room?.detach();
    setHTML('playscreen',
      `<div class="pcard"><h2>You've been removed</h2><p>Ask the host nicely.</p></div>`);
  }

  async onGame(id) {
    if (id === this.gameId) return;
    if (!id) {
      // Host ended the game and went back to the menu.
      this.gameId = null;
      this.mod = null;
      this.round = null;
      this.hand = [];
      this.board = null;
      this.miniMod = null;
      this.submitted = false;
      this.voted = false;
      this.state.draft = [];
      return this.render();
    }
    // Load the module BEFORE flipping gameId: other listeners (board, round)
    // can fire during the await and render() must never see a gameId whose
    // module isn't in hand yet.
    const mod = await ENGINES[id]();
    let board = this.board, miniMod = this.miniMod;
    if (id === 'board') {
      if (!board) board = await this.room.t.get(`${this.room.base}/board`);
      if (!miniMod) {
        const mini = await this.room.t.get(`${this.room.base}/mini`);
        if (mini && mini.id) miniMod = await ENGINES[mini.id]();
      }
    }
    this.mod = mod;
    this.board = board;
    this.miniMod = miniMod;
    this.gameId = id;
    this.render();
  }

  async onMini(mini) {
    if (!mini || !mini.id) { this.miniMod = null; this.state.draft = []; return this.render(); }
    this.miniMod = await ENGINES[mini.id]();
    this.render();
  }

  onRound(round) {
    const prevPhase = this.round && this.round.phase;
    const prevIndex = this.round && this.round.index;
    this.round = round;
    // New round or new phase clears any half-finished input.
    if (round && (round.phase !== prevPhase || round.index !== prevIndex)) {
      this.state.draft = [];
    }
    this.render();
  }

  render() {
    const stage = el('pstage');
    if (!stage) return;

    let html, key;
    if (!this.mod || (this.gameId && this.mod.meta && this.mod.meta.id !== this.gameId)) {
      html = `<div class="pcard"><h2>You're in</h2><p>Waiting for the host to pick a game.</p></div>`;
      key = 'waiting';
    } else if (this.gameId === 'board') {
      html = this.mod.playerView(
        this.board, this.me, this.round, this.miniMod,
        this.hand, this.submitted, this.voted, this.state.draft);
      const b = this.board || {};
      key = `board|${b.phase}|${b.active}|${b.turnNo}|${this.round?.phase}|${this.submitted}|${this.voted}|${(this.state.draft||[]).join(',')}`;
    } else if (this.gameId === 'promptvote') {
      html = this.mod.playerView(
        this.round, this.me, this.hand, this.submitted, this.voted, this.state.draft);
      key = `pv|${this.round?.phase}|${this.round?.index}|${this.submitted}|${this.voted}|${(this.state.draft||[]).join(',')}|${this.hand.length}`;
    } else if (this.gameId === 'charades') {
      html = this.mod.playerView(this.round, this.me);
      key = `ch|${this.round?.phase}|${this.round?.active}|${this.round?.turn}`;
    } else {
      html = this.mod.playerView(this.round, this.me, this.submitted);
      key = `q|${this.round?.phase}|${this.round?.index}|${this.submitted}`;
    }

    // Draft changes (picking cards) shouldn't re-animate the whole screen.
    const screenKey = key.replace(/\|[^|]*$/, '');
    const isNewScreen = screenKey !== this._screenKey;
    this._screenKey = screenKey;

    if (isNewScreen) {
      swapIn(stage, html, key);
      stagger(stage, '.pbtn, .card, .hugebtn', 45);
    } else {
      stage.innerHTML = html;
    }
    this.mountDieIfNeeded(stage);
  }

  /** The board's roll screens carry a die slot; mount a live 3D die into it. */
  mountDieIfNeeded(stage) {
    const slot = stage.querySelector('[data-die]');
    if (!slot) { this.die = null; return; }
    if (!this.die || !slot.contains(this._dieEl)) {
      this.die = mountDie(slot);
      this._dieEl = slot.querySelector('.dscene');
      this.die.idle();
    }
    const result = Number(slot.dataset.result);
    if (result && result !== this._lastShownRoll) {
      this._lastShownRoll = result;
      sound.dice(); haptic.dice();
      this.die.roll(result).then(() => { sound.land(); haptic.land(); });
    }
    if (!result) this._lastShownRoll = null;
  }

  async act(action) {
    if (!this.mod || !this.mod.handleAction) return;
    const res = this.gameId === 'board'
      ? await this.mod.handleAction(this.room, this.me, action, this.board,
                                    this.state, this.round, this.miniMod)
      : await this.mod.handleAction(this.room, this.me, action, this.round, this.state);
    if (res && res.rerender) this.render();
  }

  err(msg) {
    el('joinerr').textContent = msg;
    el('joinerr').hidden = false;
  }
}

const app = new PlayApp();
app.boot().catch(console.error);

window.addEventListener('pagehide', () => app.room?.detach());

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;
  const action = { ...btn.dataset };
  // Feel: a press you can hear and feel, a lock-in that's distinct.
  const locking = ['choose', 'confirmcards', 'submittext', 'vote', 'roll'].includes(action.action);
  if (locking) { sound.lock(); haptic.lock(); } else { sound.tap(); haptic.tap(); }
  btn.classList.add('pressed');
  setTimeout(() => btn.classList.remove('pressed'), 180);
  if (action.action === 'submittext') {
    const ta = document.querySelector('[data-role="answer"]');
    action.text = ta ? ta.value : '';
  }
  app.act(action);
});

// Stop the keyboard hiding the send button on iOS.
document.addEventListener('focusin', e => {
  if (e.target.matches('.ptext')) {
    setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250);
  }
});
