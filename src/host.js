// ---------------------------------------------------------------------------
// Host screen controller. This is the big screen / TV.
// Owns the room, drives the active game engine, commits scores at the end.
// ---------------------------------------------------------------------------

import { Room, localPlayerId, EMOJI } from './room.js';
import { getTransport } from './transport.js';
import { commitGame } from './scores.js';
import { esc, playerList, sortedPlayers, countdown } from './util.js';

const ENGINES = {
  quiz:       () => import('./games/quiz.js'),
  promptvote: () => import('./games/promptvote.js'),
  charades:   () => import('./games/charades.js')
};

const GAME_MENU = [
  { id: 'quiz',       opts: {},                               label: 'Degenerate Trivia',  sub: 'Four options. Speed scores.' },
  { id: 'promptvote', opts: { mode: 'pick', judge: 'all' },    label: 'Fill In The Blank',  sub: 'Play a card. Everyone votes.' },
  { id: 'promptvote', opts: { mode: 'pick', judge: 'czar' },   label: 'Fill In The Blank — Judge', sub: 'One rotating judge picks.' },
  { id: 'promptvote', opts: { mode: 'type', judge: 'all' },    label: 'Write Your Own',     sub: 'Type an answer. Funniest wins.' },
  { id: 'charades',   opts: {},                               label: 'Shout It Out',       sub: 'Word on the TV, you face away.' }
];

const el = id => document.getElementById(id);
const setHTML = (id, html) => { const n = el(id); if (n) n.innerHTML = html; };
const setText = (id, txt)  => { const n = el(id); if (n) n.textContent = txt; };

class HostApp {
  constructor() {
    this.hostId = localPlayerId();
    this.engine = null;
    this.mod = null;
    this.players = {};
    this.round = null;
    this.tickTimer = null;
  }

  async start() {
    const t = await getTransport();
    this.mode = t.mode;
    el('modebadge').textContent = t.mode === 'firebase' ? 'live' : 'local only';
    el('modebadge').className = `badge ${t.mode}`;

    this.room = await Room.create(this.hostId);
    el('code').textContent = this.room.code;

    const joinURL = new URL('play.html', location.href);
    joinURL.searchParams.set('room', this.room.code);
    this.joinURL = joinURL.href;
    el('joinurl').textContent = joinURL.href.replace(/^https?:\/\//, '');
    this.renderQR(joinURL.href);

    this.room.on('players', v => { this.players = v || {}; this.onPlayers(); });
    this.room.on('round',   v => { this.round = v; this.render(); });
    this.room.on('phase',   v => { this.phase = v; this.render(); });
    this.room.on('submissions', v => this.engine?.onSubmissions?.(v || {}, this.players));
    this.room.on('votes',       v => this.engine?.onVotes?.(v || {}, this.players));
    this.room.on('intent',      v => this.onIntent(v));

    this.renderMenu();
    this.startTicking();
    window.addEventListener('pagehide', () => {
      this.engine?.stop();
      this.room.detach();
      clearInterval(this.tickTimer);
      this.room.destroy();
    });
  }

  async renderQR(url) {
    try {
      const mod = await import('https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm');
      const qr = (mod.default || mod)(0, 'M');
      qr.addData(url);
      qr.make();
      el('qr').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    } catch (e) {
      // The QR library lives on a CDN. If it can't load, drop the whole panel
      // rather than leaving an empty white square — the join URL is right below.
      const box = el('qr');
      if (box) box.remove();
      console.warn('QR unavailable', e);
    }
  }

  onPlayers() {
    const list = playerList(this.players);
    setHTML('plist', list.length
      ? list.map(p => `
          <div class="chip ${p.connected === false ? 'off' : ''}">
            <span>${p.emoji || '🎲'}</span>${esc(p.name)}
            <button class="kick" data-kick="${p.id}" title="Remove">×</button>
          </div>`).join('')
      : '<p class="muted">Nobody yet. Scan the code.</p>');
    setText('pcount', list.length);
    if (this.phase === 'lobby' || !this.phase) this.renderMenu();
  }

  renderMenu() {
    const n = playerList(this.players).length;
    setHTML('menu', GAME_MENU.map((g, i) =>
      `<button class="gamebtn" data-game="${i}">
        <b>${esc(g.label)}</b><span>${esc(g.sub)}</span></button>`).join(''));
  }

  async launch(i) {
    const choice = GAME_MENU[i];
    this.mod = await ENGINES[choice.id]();
    this.gameId = choice.id;
    this.engine = new this.mod.Host(this.room, choice.opts);
    await this.engine.load();
    document.body.classList.add('playing');
    await this.engine.begin();
  }

  async onIntent(intent) {
    if (!intent || this.gameId !== 'charades' || !this.engine) return;
    if (intent.at && intent.at === this._lastIntentAt) return;
    this._lastIntentAt = intent.at;
    await this.engine.resolve(intent.result);
    await this.room.t.remove(`${this.room.base}/intent`);
  }

  render() {
    if (!this.round || this.phase === 'lobby') {
      document.body.classList.remove('playing');
      setHTML('stage', '');
      return;
    }
    document.body.classList.add('playing');
    setHTML('stage', this.mod ? this.mod.hostView(this.round, this.players) : '');

    if (this.round.phase === 'final' && !this._committed) {
      this._committed = true;
      const results = sortedPlayers(this.players)
        .map(p => ({ name: p.name, score: p.score || 0 }));
      commitGame(this.gameId, this.room.code, results).catch(console.error);
      // Bring the lobby back underneath the final scores so "play again" works.
      document.body.classList.remove('playing');
      const again = el('again');
      if (again) again.hidden = false;
    }
  }

  /** Keep countdown elements ticking without re-rendering the whole stage. */
  startTicking() {
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      document.querySelectorAll('.timer[data-deadline]').forEach(n => {
        const left = countdown(Number(n.dataset.deadline));
        n.textContent = left;
        n.classList.toggle('urgent', left <= 5);
      });
    }, 250);
  }

  async playAgain() {
    this._committed = false;
    this.engine?.stop();
    this.engine = null;
    this.round = null;
    await this.room.setPhase('lobby');
    await this.room.setRound(null);
    for (const pid of Object.keys(this.players)) {
      await this.room.t.set(`${this.room.base}/players/${pid}/score`, 0);
    }
    const again = el('again');
    if (again) again.hidden = true;
    document.body.classList.remove('playing');
    setHTML('stage', '');
    this.renderMenu();
    this.onPlayers();
  }
}

const app = new HostApp();
app.start().catch(e => {
  const n = document.getElementById('stage');
  if (n) n.innerHTML = `<div class="err"><h2>Couldn't start</h2><p>${esc(e.message)}</p></div>`;
  console.error(e);
});

document.addEventListener('click', async e => {
  const g = e.target.closest('[data-game]');
  if (g) return app.launch(Number(g.dataset.game));

  const k = e.target.closest('[data-kick]');
  if (k) return app.room.removePlayer(k.dataset.kick);

  if (e.target.closest('#again')) return app.playAgain();
});
