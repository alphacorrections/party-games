// ---------------------------------------------------------------------------
// Host screen controller. This is the big screen / TV.
// Owns the room, drives the active game engine, commits scores at the end.
// ---------------------------------------------------------------------------

import { Room, localPlayerId, EMOJI } from './room.js';
import { getTransport } from './transport.js';
import { commitGame } from './scores.js';
import { esc, playerList, sortedPlayers, countdown } from './util.js';
import * as fx from './fx.js';
import { swapIn, stagger, countUp, confetti, mountSoundToggle, sound } from './fx.js';

const ENGINES = {
  quiz:       () => import('./games/quiz.js'),
  promptvote: () => import('./games/promptvote.js'),
  charades:   () => import('./games/charades.js'),
  board:      () => import('./games/board.js')
};

const GAME_MENU = [
  { id: 'quiz',       opts: {},                               label: 'Degenerate Trivia',  sub: 'Four options. Speed scores.' },
  { id: 'promptvote', opts: { mode: 'pick', judge: 'all' },    label: 'Fill In The Blank',  sub: 'Play a card. Everyone votes.' },
  { id: 'promptvote', opts: { mode: 'pick', judge: 'czar' },   label: 'Fill In The Blank — Judge', sub: 'One rotating judge picks.' },
  { id: 'promptvote', opts: { mode: 'type', judge: 'all' },    label: 'Write Your Own',     sub: 'Type an answer. Funniest wins.' },
  { id: 'charades',   opts: {},                               label: 'Shout It Out',       sub: 'Word on the TV, you face away.' },
  { id: 'board',      opts: {},                               label: 'Spiral',             sub: 'A board. Minigames. Consequences.' }
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
    mountSoundToggle(el('topbar-tools'));

    this.room = await Room.create(this.hostId);
    el('code').textContent = this.room.code;

    const joinURL = new URL('play.html', location.href);
    joinURL.searchParams.set('room', this.room.code);
    this.joinURL = joinURL.href;
    el('joinurl').textContent = joinURL.href.replace(/^https?:\/\//, '');
    this.renderQR(joinURL.href);

    this.room.on('players', v => {
      this.players = v || {};
      this.onPlayers();
      this.engine?.onPlayers?.(this.players);
    });
    this.room.on('round',   v => { this.round = v; this.render(); });
    this.room.on('board',   v => { this.board = v; this.render(); });
    this.room.on('mini',    v => this.onMini(v));
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

  async launch(i, extraOpts = {}) {
    if (this._launching) return;
    const choice = GAME_MENU[i];
    if (choice.id === 'charades' && !extraOpts.category && !extraOpts.random) {
      return this.pickCategory(i);
    }
    this._launching = true;
    try {
      const mod = await ENGINES[choice.id]();
      const engine = new mod.Host(this.room, { ...choice.opts, ...extraOpts });
      await engine.load();
      // Commit all three together so no listener sees a half-swapped state.
      this.mod = mod;
      this.gameId = choice.id;
      this.engine = engine;
      this._committed = false;
      this._fxKey = null;
      document.body.classList.add('playing');
      this.setEndGameVisible(true);
      await engine.begin();
    } finally {
      this._launching = false;
    }
  }

  setEndGameVisible(on) {
    const b = el('endgame');
    if (b) b.hidden = !on;
    document.body.classList.toggle('ingame', on);
  }

  /** Charades: choose a category before the first turn. */
  async pickCategory(menuIndex) {
    const mod = await ENGINES.charades();
    const cats = await mod.Host.listCategories();
    const cards = cats.map(c => `
      <button class="catcard" data-cat="${esc(c.name)}" data-menu="${menuIndex}">
        <span class="catemoji">${c.emoji}</span>
        <b>${esc(c.name)}</b>
        <span class="catblurb">${esc(c.blurb)}</span>
        <span class="catcount">${c.count}</span>
      </button>`).join('');
    document.body.classList.add('playing');
    swapIn(el('stage'), `
      <div class="qmeta">Shout It Out</div>
      <h1 class="question">Pick a category</h1>
      <div class="catgrid">${cards}
        <button class="catcard random" data-cat="" data-menu="${menuIndex}">
          <span class="catemoji">🎲</span><b>Surprise me</b>
          <span class="catblurb">Mixed bag from everything</span>
        </button>
      </div>
      <button class="linkbtn" id="catback">Back</button>`, 'catpick');
    stagger(el('stage'), '.catcard', 40);
  }

  /** Load the engine module for a minigame the board just started. */
  async onMini(mini) {
    if (!mini || !mini.id) { this.miniMod = null; return this.render(); }
    this.miniMod = await ENGINES[mini.id]();
    this.render();
  }

  async onIntent(intent) {
    if (!intent || !this.engine) return;
    if (intent.at && intent.at === this._lastIntentAt) return;
    this._lastIntentAt = intent.at;

    if (intent.action === 'roll') {
      await this.engine.onIntent?.(intent);
    } else if (intent.result) {
      // Charades GOT IT / SKIP, standalone or running inside the board.
      if (this.gameId === 'charades') await this.engine.resolve(intent.result);
      else await this.engine.charadesResolve?.(intent.result);
    }
    await this.room.t.remove(`${this.room.base}/intent`);
  }

  render() {
    const stage = el('stage');
    if (!stage) return;

    if (this.gameId === 'board' && this.board && this.phase !== 'lobby') {
      document.body.classList.add('playing');
      const onBoard = this.board.phase !== 'minigame' && this.board.phase !== 'final';
      // Mount the 3D shell once; while we stay on the board, only patch.
      if (onBoard) {
        if (!stage.querySelector('[data-board]')) {
          swapIn(stage, this.mod.hostView(this.board, this.players, this.round, this.miniMod), 'board');
          stagger(stage, '.tile', 35);
        }
        // Patch after layout so tile positions are measurable.
        requestAnimationFrame(() => this.mod.patchBoard(stage, this.board, this.players, fx));
      } else {
        const key = `${this.board.phase}|${this.round?.phase}|${this.round?.index}`;
        swapIn(stage, this.mod.hostView(this.board, this.players, this.round, this.miniMod), key);
        this.afterRender(key);
      }
      if (this.board.phase === 'final' && !this._committed) this.commitResults();
      return;
    }

    if (!this.round || this.phase === 'lobby') {
      document.body.classList.remove('playing');
      setHTML('stage', '');
      return;
    }
    document.body.classList.add('playing');
    const key = `${this.gameId}|${this.round.phase}|${this.round.index ?? this.round.turn ?? ''}`;
    swapIn(stage, this.mod ? this.mod.hostView(this.round, this.players) : '', key);
    this.afterRender(key);

    if (this.round.phase === 'final' && !this._committed) this.commitResults();
  }

  /** Per-screen flourishes once the markup is in. */
  afterRender(key) {
    if (key === this._fxKey) return;
    this._fxKey = key;
    const stage = el('stage');
    const ph = this.round?.phase;
    if (ph === 'question')   { stagger(stage, '.opt', 90); sound.reveal(); }
    if (ph === 'vote')       { stagger(stage, '.vcard', 110); sound.reveal(); }
    if (ph === 'reveal')     { stagger(stage, '.vcard, .opt', 70); sound.correct(); }
    if (ph === 'playing')    { sound.tick(); }
    if (ph === 'roundEnd')   { stagger(stage, '.wlist li', 50); }
    if (ph === 'final')      {
      stagger(stage, '.srow', 120);
      sound.win();
      setTimeout(() => confetti(), 400);
      // Count scores up from zero for the podium moment.
      stage.querySelectorAll('.srow .spts').forEach(n => {
        const to = Number(n.textContent) || 0;
        n.textContent = '0';
        setTimeout(() => countUp(n, to, 1100), 300);
      });
    }
  }

  commitResults() {
    this._committed = true;
    this.setEndGameVisible(false);
    const results = sortedPlayers(this.players)
      .map(p => ({ name: p.name, score: p.score || 0 }));
    commitGame(this.gameId, this.room.code, results).catch(console.error);
    // Bring the lobby back underneath the final scores so "play again" works.
    document.body.classList.remove('playing');
    const again = el('again');
    if (again) again.hidden = false;
  }

  /** Keep countdown elements ticking without re-rendering the whole stage. */
  startTicking() {
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      document.querySelectorAll('.timer[data-deadline]').forEach(n => {
        const left = countdown(Number(n.dataset.deadline));
        const total = Number(n.dataset.total) || 0;
        if (String(left) !== n.dataset.shown) {
          n.dataset.shown = String(left);
          const num = n.querySelector('.tnum') || n;
          num.textContent = left;
          if (left <= 5 && left > 0) sound.tick();
          if (left === 0) sound.timeup();
        }
        n.classList.toggle('urgent', left <= 5);
        // Drive the ring if the timer has one.
        const ring = n.querySelector('.tring circle.prog');
        if (ring && total) {
          const frac = Math.max(0, Math.min(1, left / total));
          ring.style.strokeDashoffset = String((1 - frac) * 100);
        }
      });
    }, 250);
  }

  /**
   * Abandon the game in progress and go back to the menu. Players stay in the
   * room and keep their place; the abandoned game is NOT written to the
   * leaderboard, because a game nobody finished isn't a result.
   */
  async endGame() {
    this.setEndGameVisible(false);
    this.engine?.stop();
    this.engine = null;
    this.mod = null;
    this.gameId = null;
    this._committed = false;
    this.round = null;
    await this.room.setGame(null);
    await this.room.setRound(null);
    await this.room.clearRoundData();
    await this.room.t.remove(`${this.room.base}/hands`);
    await this.room.t.remove(`${this.room.base}/board`);
    await this.room.t.remove(`${this.room.base}/mini`);
    this.board = null;
    this.miniMod = null;
    this._fxKey = null;
    await this.room.setPhase('lobby');
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

  async playAgain() {
    this._committed = false;
    this.engine?.stop();
    this.engine = null;
    this.round = null;
    await this.room.setPhase('lobby');
    await this.room.setRound(null);
    await this.room.clearRoundData();
    await this.room.t.remove(`${this.room.base}/hands`);
    await this.room.t.remove(`${this.room.base}/board`);
    await this.room.t.remove(`${this.room.base}/mini`);
    this.board = null;
    this.miniMod = null;
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
  const cat = e.target.closest('[data-cat]');
  if (cat) {
    const opts = cat.dataset.cat ? { category: cat.dataset.cat } : { random: true };
    return app.launch(Number(cat.dataset.menu), opts);
  }
  if (e.target.closest('#catback')) {
    document.body.classList.remove('playing');
    setHTML('stage', '');
    return;
  }

  const g = e.target.closest('[data-game]');
  if (g) return app.launch(Number(g.dataset.game));

  const k = e.target.closest('[data-kick]');
  if (k) return app.room.removePlayer(k.dataset.kick);

  if (e.target.closest('#again')) return app.playAgain();
  if (e.target.closest('#endgame')) return app.endGame();
});
