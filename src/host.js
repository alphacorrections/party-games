// ---------------------------------------------------------------------------
// Host screen: the TV. Renders the room; the Director runs the game.
// ---------------------------------------------------------------------------

import { Room, localPlayerId } from './room.js';
import { getTransport } from './transport.js';
import { esc, playerList, countdown } from './util.js';
import * as fx from './fx.js';
import { swapIn, stagger, countUp, confetti, mountSoundToggle, sound } from './fx.js';
import { installViewport } from './viewport.js';
import { Director, ENGINES, GAME_MENU } from './director.js';

const el = id => document.getElementById(id);

function introHTML(round) {
  return `<div class="intro">
    <div class="intro-kicker">Up next</div>
    <div class="intro-title">${esc(round.title || '')}</div>
    <div class="intro-hint">${esc(round.hint || '')}</div>
  </div>`;
}
const setHTML = (id, html) => { const n = el(id); if (n) n.innerHTML = html; };
const setText = (id, txt)  => { const n = el(id); if (n) n.textContent = txt; };

class HostApp {
  constructor() {
    this.hostId = localPlayerId();
    this.players = {};
    this.round = null;
    this.board = null;
    this.miniMod = null;
    this.mod = null;
    this.gameId = null;
    this.tickTimer = null;
  }

  async start() {
    const t = await getTransport();
    el('modebadge').textContent = t.mode === 'firebase' ? 'live' : 'local only';
    el('modebadge').className = `badge ${t.mode}`;
    mountSoundToggle(el('topbar-tools'));

    this.room = await Room.create(this.hostId);
    await this.room.t.set(`${this.room.base}/hasScreen`, true);
    el('code').textContent = this.room.code;

    const joinURL = new URL('play.html', location.href);
    joinURL.searchParams.set('room', this.room.code);
    el('joinurl').textContent = joinURL.href.replace(/^https?:\/\//, '');
    this.renderQR(joinURL.href);

    this.director = new Director(this.room, { id: this.hostId, onState: () => { this.onPlayers(); this.render(); } });
    await this.director.claim();
    this.director.attach();

    this.room.on('players', v => { this.players = v || {}; this.onPlayers(); });
    this.room.on('game',    v => this.onGame(v));
    this.room.on('round',   v => { this.round = v; this.render(); });
    this.room.on('board',   v => { this.board = v; this.render(); });
    this.room.on('mini',    v => this.onMini(v));
    this.room.on('phase',   v => { this.phase = v; this.render(); });

    this.renderMenu();
    this.startTicking();
    t.onConnection(ok => document.body.classList.toggle('offline', !ok));
    window.addEventListener('pagehide', () => {
      this.director.stop();
      this.room.detach();
      clearInterval(this.tickTimer);
      this.room.destroy();
    });
  }

  async renderQR(url) {
    try {
      const mod = await import('https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm');
      const qr = (mod.default || mod)(0, 'M');
      qr.addData(url); qr.make();
      el('qr').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    } catch (e) {
      const box = el('qr'); if (box) box.remove();
      console.warn('QR unavailable', e);
    }
  }

  /* ------------------------------- lobby ------------------------------- */

  onPlayers() {
    const list = playerList(this.players);
    const html = list.length
      ? list.map(p => `
          <div class="chip ${p.connected === false ? 'off' : ''}" data-chip="${p.id}">
            <span>${p.emoji || '🎲'}</span>${esc(p.name)}
            <button class="kick" data-kick="${p.id}" title="Remove">×</button>
          </div>`).join('')
      : '<p class="muted">Nobody yet. Scan the code.</p>';
    const box = el('plist');
    if (box && box.innerHTML !== html) {
      const before = new Set([...box.querySelectorAll('[data-chip]')].map(n => n.dataset.chip));
      box.innerHTML = html;
      // New arrivals pop in.
      box.querySelectorAll('[data-chip]').forEach(n => {
        if (!before.has(n.dataset.chip)) { n.classList.add('pop'); sound.tap(); }
      });
    }
    setText('pcount', list.length);
  }

  renderMenu() {
    setHTML('menu', GAME_MENU.map((g, i) =>
      `<button class="gamebtn" data-game="${i}">
        <b>${esc(g.label)}</b><span>${esc(g.sub)}</span></button>`).join(''));
    stagger(el('menu'), '.gamebtn', 40);
  }

  async launch(i, extraOpts = {}) {
    const choice = GAME_MENU[i];
    if (choice.id === 'charades' && !extraOpts.category && !extraOpts.random) {
      return this.pickCategory(i);
    }
    document.body.classList.add('playing');
    this.setEndGameVisible(true);
    this._fxKey = null;
    await this.director.launch(i, extraOpts);
  }

  async pickCategory(menuIndex) {
    const mod = await ENGINES.charades();
    const cats = await mod.Host.listCategories();
    const cards = cats.map(c => `
      <button class="catcard" data-cat="${esc(c.name)}" data-menu="${menuIndex}">
        <span class="catemoji">${c.emoji}</span><b>${esc(c.name)}</b>
        <span class="catblurb">${esc(c.blurb)}</span><span class="catcount">${c.count}</span>
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

  setEndGameVisible(on) {
    const b = el('endgame'); if (b) b.hidden = !on;
    document.body.classList.toggle('ingame', on);
  }

  /* ------------------------------ game state --------------------------- */

  async onGame(id) {
    if (id === this.gameId) return;
    if (!id) { this.gameId = null; this.mod = null; this.board = null; this.miniMod = null; return this.render(); }
    const mod = await ENGINES[id]();
    this.mod = mod; this.gameId = id;
    this.render();
  }

  async onMini(mini) {
    if (!mini || !mini.id) { this.miniMod = null; return this.render(); }
    this.miniMod = await ENGINES[mini.id]();
    this.render();
  }

  render() {
    const stage = el('stage');
    if (!stage) return;
    this._patchWaiting(stage);

    if (this.gameId === 'board' && this.board && this.phase !== 'lobby' && this.mod) {
      document.body.classList.add('playing');
      const onBoard = this.board.phase !== 'minigame' && this.board.phase !== 'final';
      if (onBoard) {
        if (!stage.querySelector('[data-board]')) {
          swapIn(stage, this.mod.hostView(this.board, this.players, this.round, this.miniMod), 'board');
          stagger(stage, '.tile', 35);
        }
        requestAnimationFrame(() => this.mod.patchBoard(stage, this.board, this.players, fx));
      } else {
        const key = `${this.board.phase}|${this.round?.phase}|${this.round?.index}`;
        swapIn(stage, this.mod.hostView(this.board, this.players, this.round, this.miniMod), key);
        this.afterRender(key);
      }
      if (this.board.phase === 'final') this.onFinal();
      return;
    }

    if (!this.round || this.phase === 'lobby' || !this.mod) {
      // Between launch and the first round write there's a brief gap where
      // a game is chosen but no round exists yet; keep 'playing' on then.
      // The director is the source of truth for "a game is running"; the
      // screen's own gameId lags behind it while a module loads.
      const running = Boolean(this.director && this.director.gameId);
      if (this.phase === 'lobby' || !running) {
        document.body.classList.remove('playing');
        setHTML('stage', '');
        this.setEndGameVisible(false);
        const again = el('again'); if (again) again.hidden = true;
      }
      return;
    }
    document.body.classList.add('playing');
    const key = `${this.gameId}|${this.round.phase}|${this.round.index ?? this.round.turn ?? ''}`;
    if (this.round.phase === 'intro') {
      swapIn(stage, introHTML(this.round), key);
      this.afterRender(key);
      return;
    }
    swapIn(stage, this.mod.hostView(this.round, this.players), key);
    this.afterRender(key);
    if (this.round.phase === 'final') this.onFinal();
  }

  /** Update the waiting-on chips in place, no full re-render. */
  _patchWaiting(stage) {
    if (!this.mod || !this.round || this.round.phase === 'intro' || this.round.phase === 'final') return;
    if (!stage.querySelector('.waiting')) return;     // nothing to patch on this screen
    const fresh = document.createElement('div');
    try {
      fresh.innerHTML = this.gameId === 'board'
        ? (this.miniMod ? this.miniMod.hostView(this.round, this.players) : '')
        : this.mod.hostView(this.round, this.players);
    } catch { return; }
    const a = stage.querySelector('.waiting'), b = fresh.querySelector('.waiting');
    if (a && b && a.outerHTML !== b.outerHTML) a.outerHTML = b.outerHTML;
  }

  onFinal() {
    if (this._finalShown) return;
    this._finalShown = true;
    this.setEndGameVisible(false);
    document.body.classList.remove('playing');
    const again = el('again'); if (again) again.hidden = false;
  }

  afterRender(key) {
    if (key === this._fxKey) return;
    this._fxKey = key;
    const stage = el('stage');
    const ph = this.round?.phase;
    if (ph === 'intro')      { sound.reveal(); }
    if (ph === 'question')   { stagger(stage, '.opt', 90); sound.reveal(); }
    if (ph === 'vote')       { stagger(stage, '.vcard', 110); sound.reveal(); }
    if (ph === 'reveal')     { stagger(stage, '.vcard, .opt, .rrow', 70); sound.correct(); }
    if (ph === 'playing')    { sound.tick(); }
    if (ph === 'roundEnd')   { stagger(stage, '.wlist li', 50); }
    if (ph === 'final')      {
      stagger(stage, '.srow', 120);
      sound.win();
      setTimeout(() => confetti(), 400);
      stage.querySelectorAll('.srow .spts, .wpts .spts').forEach(n => {
        const to = Number(n.textContent) || 0;
        n.textContent = '0';
        setTimeout(() => countUp(n, to, 1100), 300);
      });
    }
  }

  startTicking() {
    clearInterval(this.tickTimer);
    let n = 0;
    this.tickTimer = setInterval(() => {
      // Once a second, re-check who's still here: a vanished phone sends no
      // event, so presence staleness has to be polled.
      if (++n % 4 === 0) { const st = el('stage'); if (st) this._patchWaiting(st); }
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
        const ring = n.querySelector('.tring circle.prog');
        if (ring && total) ring.style.strokeDashoffset = String((1 - Math.max(0, Math.min(1, left / total))) * 100);
      });
    }, 250);
  }

  async backToLobby() {
    // Flip the screen first so the lobby is usable immediately; the room
    // writes catch up behind it.
    this._finalShown = false;
    this._fxKey = null;
    this.board = null; this.miniMod = null;
    this.gameId = null; this.mod = null; this.round = null;
    document.body.classList.remove('playing');
    this.setEndGameVisible(false);
    setHTML('stage', '');
    const again = el('again'); if (again) again.hidden = true;
    this.renderMenu();
    this.onPlayers();
    await this.director.endGame();
  }
}

window.__pgBooted = true;
installViewport({ stageId: 'stage' });

const app = new HostApp();
app.start().catch(e => {
  const n = el('stage');
  if (n) n.innerHTML = `<div class="err"><h2>Couldn't start</h2><p>${esc(e.message)}</p></div>`;
  console.error(e);
});

document.addEventListener('click', async e => {
  const cat = e.target.closest('[data-cat]');
  if (cat) return app.launch(Number(cat.dataset.menu), cat.dataset.cat ? { category: cat.dataset.cat } : { random: true });
  if (e.target.closest('#catback')) { document.body.classList.remove('playing'); setHTML('stage', ''); return; }
  const g = e.target.closest('[data-game]');
  if (g) return app.launch(Number(g.dataset.game));
  const k = e.target.closest('[data-kick]');
  if (k) return app.room.removePlayer(k.dataset.kick);
  if (e.target.closest('#again') || e.target.closest('#endgame')) return app.backToLobby();
  const nx = e.target.closest('[data-next]');
  if (nx) { sound.tap(); return app.director.nudge('next'); }
  const sk = e.target.closest('[data-skip]');
  if (sk) { sound.tap(); return app.director.nudge('skip', sk.dataset.skip); }
});

// TV remotes: Enter/OK advances a reveal, same as tapping Next.
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.querySelector('[data-next]')) {
    e.preventDefault(); sound.tap(); app.director.nudge('next');
  }
});
