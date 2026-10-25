// ---------------------------------------------------------------------------
// Phone controller. Join a room, then render whatever the active game needs.
// ---------------------------------------------------------------------------

import { Room, localPlayerId, rememberName, recalledName } from './room.js';
import { getTransport } from './transport.js';
import { esc } from './util.js';

const ENGINES = {
  quiz:       () => import('./games/quiz.js'),
  promptvote: () => import('./games/promptvote.js'),
  charades:   () => import('./games/charades.js')
};

const el = id => document.getElementById(id);
const setHTML = (id, html) => { const n = el(id); if (n) n.innerHTML = html; };

class PlayApp {
  constructor() {
    this.me = { id: localPlayerId() };
    this.state = { draft: [] };
    this.mod = null;
    this.gameId = null;
    this.round = null;
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
    this.me.name = name;
    rememberName(name);
    this.me.emoji = await room.addPlayer(this.me.id, name);

    el('joinscreen').hidden = true;
    el('playscreen').hidden = false;
    el('whoami').innerHTML = `${this.me.emoji} ${esc(name)}`;

    room.on('game',  v => this.onGame(v));
    room.on('round', v => this.onRound(v));
    room.on('phase', v => { this.phase = v; this.render(); });
    room.on(`hands/${this.me.id}`,       v => { this.hand = v || []; this.render(); });
    room.on(`submissions/${this.me.id}`, v => { this.submitted = Boolean(v); this.render(); });
    room.on(`votes/${this.me.id}`,       v => { this.voted = v !== null && v !== undefined; this.render(); });
    room.on(`players/${this.me.id}`,     v => {
      if (v === null) this.kicked();
      else el('myscore').textContent = v.score || 0;
    });
  }

  kicked() {
    this.room?.detach();
    setHTML('playscreen',
      `<div class="pcard"><h2>You've been removed</h2><p>Ask the host nicely.</p></div>`);
  }

  async onGame(id) {
    if (!id || id === this.gameId) return;
    this.gameId = id;
    this.mod = await ENGINES[id]();
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
    if (!el('pstage')) return;
    if (!this.mod) {
      setHTML('pstage',
        `<div class="pcard"><h2>You're in</h2><p>Waiting for the host to pick a game.</p></div>`);
      return;
    }
    if (this.gameId === 'promptvote') {
      setHTML('pstage', this.mod.playerView(
        this.round, this.me, this.hand, this.submitted, this.voted, this.state.draft));
    } else if (this.gameId === 'charades') {
      setHTML('pstage', this.mod.playerView(this.round, this.me));
    } else {
      setHTML('pstage', this.mod.playerView(this.round, this.me, this.submitted));
    }
  }

  async act(action) {
    if (!this.mod || !this.mod.handleAction) return;
    const res = await this.mod.handleAction(this.room, this.me, action, this.round, this.state);
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
