// ---------------------------------------------------------------------------
// Host screen: the TV. Renders the room; the Director runs the game.
// ---------------------------------------------------------------------------

import { partyChipsHTML, isPresent } from './util.js';
import { Room, localPlayerId } from './room.js';
import { getTransport } from './transport.js';
import { esc, playerList, countdown, finalScoreboard } from './util.js';
import * as fx from './fx.js';
import { swapIn, stagger, countUp, confetti, mountSoundToggle, sound } from './fx.js';
import { installViewport } from './viewport.js';
import { Director, ENGINES, GAME_MENU, LENGTHS } from './director.js';
import { getLeaderboard, keyFor } from './scores.js';

const el = id => document.getElementById(id);

function introHTML(round, players) {
  const rules = round.rules || [];
  const list = playerList(players || {}).filter(isPresent);
  const ready = round.ready || {};
  const chips = list.map(p => `<span class="rchip ${ready[p.id] ? 'on' : ''}">${ready[p.id] ? '✓' : (p.emoji || '🎲')} ${esc(p.name)}</span>`).join('');
  return `<div class="intro rules">
    <div class="intro-kicker">How to play</div>
    <div class="intro-title">${esc(round.title || '')}${round.mode ? `<span class="intro-mode">${esc(round.mode)}</span>` : ''}</div>
    ${rules.length ? `<ol class="rules-list">${rules.map(r => `<li>${esc(r)}</li>`).join('')}</ol>` : `<div class="intro-hint">${esc(round.hint || '')}</div>`}
    <div class="ready-row">${chips}</div>
    <button class="nextbtn big" data-next="1">Start</button>
    <p class="phint">Starts when everyone taps I'm ready, or when you hit Start.</p>
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

    // A reload (or the TV browser restarting) reopens the same room instead
    // of stranding everyone in the old one. ?new=1 forces a fresh room.
    this.room = await this.reopenRoom(t) || await Room.create(this.hostId);
    try { localStorage.setItem('pg_host_room', JSON.stringify({ code: this.room.code, at: Date.now() })); } catch {}
    await this.room.t.set(`${this.room.base}/hasScreen`, true);
    el('code').textContent = this.room.code;

    const joinURL = new URL('play.html', location.href);
    joinURL.searchParams.set('room', this.room.code);
    el('joinurl').textContent = joinURL.href.replace(/^https?:\/\//, '');
    this.renderQR(joinURL.href);

    this.director = new Director(this.room, { id: this.hostId, onState: () => { this.onPlayers(); this.render(); } });
    await this.director.claim();
    this.director.attach();
    if (this._reopened) {
      try { await this.director.adoptRunning(); } catch (e) { console.warn('resume failed', e); }
    }

    this.room.on('players', v => {
      const prev = this.players || {};
      this.players = v || {};
      this.onPlayers();
      this.floatDeltas(prev, this.players);
    });
    this.room.on('game',    v => this.onGame(v));
    this.room.on('round',   v => { this.round = v; this.render(); });
    this.room.on('board',   v => { this.board = v; this.render(); });
    this.room.on('mini',    v => this.onMini(v));
    this.room.on('phase',   v => { this.phase = v; this.render(); });
    this.room.on('length',  v => this.renderLength(v || 'standard'));
    this.room.on('highlights', v => { this.highlights = v || {}; if (this.round?.phase === 'final') this.render(); });
    this.room.on('party',      v => { this.party = v || {}; this.onPlayers(); });
    this.room.on('committed',  v => { if (v) this.loadAllTime(); else this.allTime = null; });

    this.renderMenu();
    this.startTicking();
    t.onConnection(ok => document.body.classList.toggle('offline', !ok));
    window.addEventListener('pagehide', () => {
      this.director.stop();
      this.room.detach();
      clearInterval(this.tickTimer);
      // Don't delete the room: a reload reopens it. Rooms expire on their own.
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
      ? partyChipsHTML(this.players, this.party, { kick: true })
      : '<p class="muted">Nobody yet. Scan the code.</p>';
    const ranked = Object.values(this.party || {}).some(r => r && r.games);
    const h = el('plisth'); if (h) h.innerHTML = ranked ? `Party standings <span class="muted small">(${list.length} playing)</span>` : `Players (<span id="pcount">${list.length}</span>)`;
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

  async reopenRoom(t) {
    if (new URLSearchParams(location.search).has('new')) return null;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('pg_host_room') || 'null'); } catch {}
    if (!saved || !saved.code || Date.now() - (saved.at || 0) > 6 * 3600 * 1000) return null;
    const meta = await t.get(`rooms/${saved.code}/meta`);
    if (!meta || (meta.expiresAt && meta.expiresAt < Date.now())) return null;
    this._reopened = true;
    return Room.open(saved.code);
  }

  renderLength(cur) {
    setHTML('lenpick', Object.entries(LENGTHS).map(([k, v]) =>
      `<button class="tab ${k === cur ? 'on' : ''}" data-len="${k}">${v.label}</button>`).join(''));
  }

  renderMenu() {
    setHTML('menu', GAME_MENU.map((g, i) =>
      `<button class="gamebtn" data-game="${i}">
        <b>${esc(g.label)}</b><span>${esc(g.sub)}</span></button>`).join(''));
    stagger(el('menu'), '.gamebtn', 40);
  }

  async launch(i, extraOpts = {}) {
    const choice = GAME_MENU[i];
    if ((choice.pick || choice.id === 'charades' || choice.id === 'quiz') && !extraOpts.category && !extraOpts.random) {
      return this.pickCategory(i);
    }
    this._picking = false;
    document.body.classList.add('playing');
    this.setEndGameVisible(true);
    this._fxKey = null;
    await this.director.launch(i, extraOpts);
  }

  async pickCategory(menuIndex) {
    const id = GAME_MENU[menuIndex].id;
    const mod = await ENGINES[id]();
    const cats = await mod.Host.listCategories();
    this._picking = true;
    const title = GAME_MENU[menuIndex].label;
    const cards = cats.map(c => `
      <button class="catcard" data-cat="${esc(c.name)}" data-menu="${menuIndex}">
        <span class="catemoji">${c.emoji}</span><b>${esc(c.name)}</b>
        <span class="catblurb">${esc(c.blurb || '')}</span><span class="catcount">${c.count}</span>
      </button>`).join('');
    document.body.classList.add('playing');
    const hasMixed = cats.some(c => c.name === 'Mixed') || GAME_MENU[menuIndex].noRandom;
    swapIn(el('stage'), `
      <div class="qmeta">${esc(title)}</div>
      <h1 class="question">${esc(GAME_MENU[menuIndex].pick || 'Pick a category')}</h1>
      <div class="catgrid">${cards}
        ${hasMixed ? '' : `<button class="catcard random" data-cat="" data-menu="${menuIndex}">
          <span class="catemoji">🎲</span><b>Surprise me</b>
          <span class="catblurb">Mixed bag from everything</span>
        </button>`}
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
    document.body.classList.toggle('horror', this.gameId === 'bodycount' && this.phase !== 'lobby');
    this._patchWaiting(stage);

    if (this.gameId === 'board' && this.board && this.phase !== 'lobby' && this.mod) {
      document.body.classList.add('playing');
      this.setEndGameVisible(true);
      const onBoard = this.board.phase !== 'minigame' && this.board.phase !== 'final';
      if (onBoard) {
        if (!stage.querySelector('[data-board]')) {
          swapIn(stage, this.mod.hostView(this.board, this.players, this.round, this.miniMod), 'board');
          stagger(stage, '.tile', 35);
        }
        requestAnimationFrame(() => this.mod.patchBoard(stage, this.board, this.players, fx));
      } else if (this.board.phase === 'final') {
        const key = `boardfinal|${Object.keys(this.highlights || {}).length}|${(this.allTime || []).length}`;
        swapIn(stage, finalScoreboard(this.players, 'Final scores', this.highlights) + this.allTimeHTML(), key);
        this.afterRender(key); this.onFinal();
      } else {
        const key = `${this.board.phase}|${this.round?.phase}|${this.round?.index}`;
        swapIn(stage, this.mod.hostView(this.board, this.players, this.round, this.miniMod), key);
        this.afterRender(key);
      }
      return;
    }

    if (!this.round || this.phase === 'lobby' || !this.mod) {
      // Between launch and the first round write there's a brief gap where
      // a game is chosen but no round exists yet; keep 'playing' on then.
      // The director is the source of truth for "a game is running"; the
      // screen's own gameId lags behind it while a module loads.
      const running = Boolean(this.director && this.director.gameId);
      if (this._picking && !running) return;   // category picker is up: leave it
      if (this.phase === 'lobby' || !running) {
        document.body.classList.remove('playing');
        setHTML('stage', '');
        this.setEndGameVisible(false);
        const again = el('again'); if (again) again.hidden = true;
      }
      return;
    }
    document.body.classList.add('playing');
    this.setEndGameVisible(true);
    const key = `${this.gameId}|${this.round.phase}|${this.round.index ?? this.round.turn ?? ''}|${Object.keys(this.highlights || {}).length}`;
    if (this.round.phase === 'final') {
      const k2 = key + `|${(this.allTime || []).length}`;
      swapIn(stage, finalScoreboard(this.players, 'Final scores', this.highlights) + this.allTimeHTML(), k2);
      this.afterRender(key); this.onFinal(); return;
    }
    if (this.round.phase === 'intro') {
      swapIn(stage, introHTML(this.round, this.players), key);
      this.afterRender(key);
      return;
    }
    swapIn(stage, this.mod.hostView(this.round, this.players), key);
    this.afterRender(key);
    if (this.round.phase === 'final') this.onFinal();
  }

  /**
   * Score changes float up from the bottom of the TV as "+600 Jake". One
   * element per change, staggered so simultaneous payouts don't stack.
   */
  floatDeltas(prev, next) {
    if (document.body.classList.contains('playing') === false) return;
    const changes = [];
    for (const [id, p] of Object.entries(next)) {
      const d = (p.score || 0) - ((prev[id] && prev[id].score) || 0);
      if (d) changes.push({ name: p.name, emoji: p.emoji, d });
    }
    if (!changes.length || fx.reducedMotion()) return;
    changes.sort((a, b) => b.d - a.d);
    let layer = document.getElementById('deltas');
    if (!layer) { layer = document.createElement('div'); layer.id = 'deltas'; document.body.appendChild(layer); }
    changes.forEach((c, i) => {
      const n = document.createElement('div');
      n.className = `delta ${c.d > 0 ? 'up' : 'down'}`;
      n.style.setProperty('--i', i);
      n.innerHTML = `<span class="demoji">${c.emoji || ''}</span><b>${c.d > 0 ? '+' : '−'}${Math.abs(c.d)}</b><span>${esc(c.name)}</span>`;
      layer.appendChild(n);
      n.addEventListener('animationend', () => n.remove(), { once: true });
    });
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

  /** Once the commit lands, fetch all-time totals; render() draws them. */
  async loadAllTime() {
    try {
      const board = await getLeaderboard();
      const byKey = Object.fromEntries(board.map(r => [r.key, r]));
      this.allTime = playerList(this.players).map(p => byKey[keyFor(p.name)]).filter(Boolean)
        .sort((a, b) => (b.points || 0) - (a.points || 0));
      this.render();
    } catch {}
  }

  allTimeHTML() {
    const rows = this.allTime || [];
    if (!rows.length) return '';
    return `<div class="alltime"><div class="atlabel">All-time</div>${rows.map((r, i) =>
      `<span class="atchip ${i === 0 ? 'lead' : ''}">${esc(r.emoji || '')} ${esc(r.name)} <b>${r.points || 0}</b> <i>${r.wins || 0}W</i></span>`).join('')}</div>`;
  }

  afterRender(key) {
    if (key === this._fxKey) return;
    this._fxKey = key;
    const stage = el('stage');
    const ph = this.round?.phase;
    if (this.gameId === 'bodycount') {
      if (ph === 'question' || ph === 'escape') { stagger(stage, '.opt', 90); sound.tick(); }
      if (ph === 'reveal' || ph === 'escapeReveal') { const bad = (this.round.doomed || []).length || (this.round.caught || []).length; bad ? sound.wrong() : sound.correct(); }
      if (ph === 'doom' || ph === 'escapeIntro') { sound.sting(); }
      if (ph === 'trialEnd') { const deaths = Object.values(this.round.outcome || {}).filter(v => v === 'die').length; deaths ? sound.die() : sound.correct(); stagger(stage, '.bc-res', 260); }
      if (ph === 'escaped') { sound.win(); setTimeout(() => confetti(), 300); }
    }
    if (ph === 'intro')      { sound.intro(); }
    if (ph === 'question' && this.gameId !== 'bodycount') { stagger(stage, '.opt', 90); sound.reveal(); }
    if (ph === 'vote')       { stagger(stage, '.vcard', 110); sound.reveal(); }
    if (ph === 'reveal' && this.gameId !== 'bodycount') { stagger(stage, '.vcard, .opt, .rrow', 70); sound.correct(); }
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
    this._picking = false;
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
  if (e.target.closest('#catback')) { app._picking = false; document.body.classList.remove('playing'); setHTML('stage', ''); return; }
  const g = e.target.closest('[data-game]');
  if (g) return app.launch(Number(g.dataset.game));
  const ln = e.target.closest('[data-len]');
  if (ln) { sound.tap(); return app.director.setLength(ln.dataset.len); }
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
