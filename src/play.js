// ---------------------------------------------------------------------------
// Phone. Two jobs:
//   1. Controller for a game a TV is hosting.
//   2. The whole game, when there's no TV: one phone creates the room, runs
//      the Director, and every phone (including that one) renders full state.
// ---------------------------------------------------------------------------

import { partyChipsHTML } from './util.js';
import { Room, playerIdFor, rememberName, recalledName, localPlayerId } from './room.js';
import { getTransport } from './transport.js';
import { esc, playerList, countdown, finalScoreboard } from './util.js';
import { swapIn, stagger, countUp, sound, haptic, mountSoundToggle, flash, confetti } from './fx.js';
import { mountDie } from './dice.js';
import { installViewport } from './viewport.js';
import { Director, ENGINES, GAME_MENU, LENGTHS } from './director.js';
import { matchRosterName, getRoster } from './scores.js';
import { startTilt, goSideways, leaveSideways, keepAwake, browserLandscape } from './tilt.js';

const el = id => document.getElementById(id);
const setHTML = (id, html) => { const n = el(id); if (n) n.innerHTML = html; };

class PlayApp {
  constructor() {
    this.me = {};
    this.state = { draft: [] };
    this.mod = null; this.miniMod = null;
    this.gameId = null; this.round = null; this.board = null;
    this.hand = []; this.submitted = false; this.voted = false;
    this.hasScreen = false;
    this.director = null;
    this.directorInfo = null;
  }

  async boot() {
    await getTransport();
    const code = new URLSearchParams(location.search).get('room');
    if (code) el('roomcode').value = code.toUpperCase();
    el('name').value = recalledName();
    el('joinform').addEventListener('submit', e => { e.preventDefault(); this.join(); });
    el('hostbtn').addEventListener('click', () => this.hostFromPhone());
    this.startTicking();
    this.renderNameChips();

    // A reload mid-game (iOS discards backgrounded tabs constantly) should
    // drop you straight back in, not make you retype your name. Only when
    // this device was already in that room.
    // Only when THIS device's player record is in THAT room, and the record is
    // recent: a stale name from last week must not hijack a new join.
    const last = (() => { try { return JSON.parse(sessionStorage.getItem('pg_last') || 'null'); } catch { return null; } })();
    if (code && last && last.room === code && last.name) {
      try {
        const room = await Room.open(code);
        const me = await room.t.get(`${room.base}/players/${playerIdFor(last.name)}`);
        if (me && me.device === Room.deviceId() && await room.exists() && !(await room.isExpired())) {
          await this.enter(room, last.name);
          this.toast('Back in');
        }
      } catch (e) { console.warn('auto-rejoin skipped', e); }
    }
  }

  /** One-tap chips for names this phone has used, plus the roster's regulars. */
  async renderNameChips() {
    const box = el('namechips'); if (!box) return;
    let mine = [];
    try { mine = JSON.parse(localStorage.getItem('pg_names') || '[]'); } catch {}
    let regulars = [];
    try {
      const roster = await getRoster();
      regulars = Object.values(roster).filter(r => r.active !== false).map(r => r.name)
        .filter(n => !mine.includes(n)).slice(0, 6);
    } catch {}
    const chip = (n, cls) => `<button type="button" class="namechip ${cls}" data-name="${esc(n)}">${esc(n)}</button>`;
    const html = [...mine.map(n => chip(n, 'mine')), ...regulars.map(n => chip(n, ''))].join('');
    box.innerHTML = html; box.hidden = !html;
  }

  rememberNameLocally(name) {
    try {
      const list = JSON.parse(localStorage.getItem('pg_names') || '[]').filter(n => n !== name);
      list.unshift(name);
      localStorage.setItem('pg_names', JSON.stringify(list.slice(0, 3)));
    } catch {}
  }

  /**
   * Before joining with a name, check it against the roster. A near-miss of
   * an existing regular ("kev" for "Kevin") is almost always the same person
   * and would split their leaderboard record; ask once.
   */
  async resolveName(name) {
    try {
      const { exact, suggestion } = await matchRosterName(name);
      if (exact) return exact.name;                    // canonical spelling
      if (suggestion && confirm(`Did you mean ${suggestion.name}? Tap OK to play as ${suggestion.name} so your points keep adding up, or Cancel to make a new name.`)) return suggestion.name;
    } catch {}
    return name;
  }

  /* -------------------------------- join -------------------------------- */

  async join(codeOverride) {
    const code = (codeOverride || el('roomcode').value).trim().toUpperCase();
    let name = el('name').value.trim();
    if (!code || !name) return this.err('Need a room code and a name.');
    name = await this.resolveName(name);

    const room = await Room.open(code);
    if (!(await room.exists())) return this.err(`No room called ${code}.`);
    if (await room.isExpired())  return this.err('That room has expired.');
    if (await room.nameTakenLive(playerIdFor(name), Room.deviceId())) {
      return this.err(`Someone's already in as ${name}. Add a last initial or pick another.`);
    }
    await this.enter(room, name);
  }

  /** "Start a party": create a room, be its director, and join it as a player. */
  async hostFromPhone() {
    let name = el('name').value.trim();
    if (!name) return this.err('Put your name in first.');
    name = await this.resolveName(name);
    const room = await Room.create(localPlayerId());
    await room.t.set(`${room.base}/hasScreen`, false);
    await this.enter(room, name);
    await this.becomeDirector();
  }

  async enter(room, name) {
    this.room = room;
    this.me.id = playerIdFor(name);
    this.me.name = name;
    rememberName(name);
    this.rememberNameLocally(name);
    this.me.emoji = await room.addPlayer(this.me.id, name);

    el('joinscreen').hidden = true;
    el('playscreen').hidden = false;
    el('whoami').innerHTML = `${this.me.emoji} ${esc(name)}`;
    el('roomtag').textContent = room.code;
    try { sessionStorage.setItem('pg_last', JSON.stringify({ room: room.code, name })); } catch {}
    mountSoundToggle(el('pbar-tools'));
    sound.lock(); haptic.lock();
    history.replaceState(null, '', `?room=${room.code}`);

    // Presence heartbeat + offline banner.
    this._presence = setInterval(() => room.touch(this.me.id).catch(() => {}), 8000);
    const t = await getTransport();
    t.onConnection(ok => {
      document.body.classList.toggle('offline', !ok);
      if (!ok) this.toast('Reconnecting…');
    });

    room.on('hasScreen', v => { this.hasScreen = Boolean(v); this.render(); });
    room.on('length',    v => { this.length = v || 'standard'; this.render(); });
    room.on('highlights', v => { this.highlights = v || {}; this.render(); });
    room.on('party',      v => { this.party = v || {}; this.render(); });
    room.on('director',  v => this.onDirector(v));
    // A dead director stops writing, so its staleness is the absence of an
    // event. Check on a timer as well as on change.
    this._watchdog = setInterval(() => this.onDirector(this.directorInfo), 2500);
    room.on('players',   v => { this.players = v || {}; this.render(); });
    room.on('game',      v => this.onGame(v));
    room.on('round',     v => this.onRound(v));
    room.on('board',     v => { this.board = v; this.render(); });
    room.on('mini',      v => this.onMini(v));
    room.on('phase',     v => { this.phase = v; this.render(); });
    room.on(`hands/${this.me.id}`,       v => { this.hand = v || []; this.render(); });
    room.on(`mulliganed/${this.me.id}`,  v => { this.mulliganed = Boolean(v); this.render(); });
    room.on(`submissions/${this.me.id}`, v => { this.submitted = Boolean(v); this.render(); });
    room.on(`votes/${this.me.id}`,       v => { this.voted = v !== null && v !== undefined; this.render(); });
    room.on(`players/${this.me.id}`,     v => {
      if (v === null) return this.kicked();
      const n = el('myscore');
      const prev = Number(n.textContent) || 0, next = v.score || 0;
      if (next !== prev) {
        countUp(n, next, 600);
        if (next > prev) { sound.correct(); haptic.correct(); flash('volt'); }
        else { sound.wrong(); haptic.wrong(); flash('hot'); }
      }
    });
  }

  /* ----------------------------- directing ------------------------------ */

  get isDirector() { return Boolean(this.director); }

  async becomeDirector() {
    if (this.director) return;
    this.director = new Director(this.room, { id: this.me.id, onState: () => this.render() });
    await this.director.claim();
    this.director.attach();
    // If a game is already mid-flight (we took over), rehydrate the engine.
    await this.director.adoptRunning();
    this.render();
  }

  /** Watch leadership. If the director disappears, the first player takes over. */
  onDirector(info) {
    this.directorInfo = info;
    if (this.isDirector) return;
    if (this.hasScreen) return;              // a TV is driving; phones never take over
    if (!Director.isStale(info)) {
      // A live director: cancel any pending takeover.
      clearTimeout(this._takeover); this._takeover = null;
      return;
    }
    if (this._takeover) return;              // already counting down; let it run
    // Stagger by join order so only one phone claims.
    const order = playerList(this.players || {}).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0)).map(p => p.id);
    const rank = Math.max(0, order.indexOf(this.me.id));
    this._takeover = setTimeout(async () => {
      this._takeover = null;
      const cur = await this.room.t.get(`${this.room.base}/director`);
      if (!Director.isStale(cur)) return;
      await this.becomeDirector();
      this.toast('You\'re hosting now');
    }, 1500 + rank * 1200);
  }

  kicked() {
    this.room?.detach();
    this.director?.stop();
    setHTML('playscreen', `<div class="pcard"><h2>You've been removed</h2><p>Ask the host nicely.</p></div>`);
  }

  /* ----------------------------- game state ----------------------------- */

  async onGame(id) {
    if (id === this.gameId) return;
    if (!id) {
      this.gameId = null; this.mod = null; this.round = null; this.hand = [];
      this.board = null; this.miniMod = null; this.submitted = false; this.voted = false;
      this.state.draft = []; this.stopTilt();
      return this.render();
    }
    const mod = await ENGINES[id]();
    let board = this.board, miniMod = this.miniMod;
    if (id === 'board') {
      if (!board) board = await this.room.t.get(`${this.room.base}/board`);
      if (!miniMod) {
        const mini = await this.room.t.get(`${this.room.base}/mini`);
        if (mini && mini.id) miniMod = await ENGINES[mini.id]();
      }
    }
    this.mod = mod; this.board = board; this.miniMod = miniMod; this.gameId = id;
    this.render();
  }

  async onMini(mini) {
    this.miniInfo = mini || null;
    if (!mini || !mini.id) { this.miniMod = null; this.state.draft = []; return this.render(); }
    this.miniMod = await ENGINES[mini.id]();
    this.render();
  }

  onRound(round) {
    const prev = this.round;
    this.round = round;
    if (round && prev && (round.phase !== prev.phase || round.index !== prev.index)) this.state.draft = [];
    if (round?.phase === 'final' && prev?.phase !== 'final') { sound.win(); haptic.win(); setTimeout(() => confetti(60), 300); }
    this.render();
  }

  /* -------------------------------- render ------------------------------ */

  render() {
    const stage = el('pstage');
    if (!stage) return;
    const mirror = !this.hasScreen;     // no TV -> phones show the whole game
    let html, key;

    const isFinal = this.round && this.round.phase === 'final' || (this.board && this.board.phase === 'final');
    if (isFinal && this.mod) {
      // With no TV the phone is the screen: show the podium, not "check the big screen".
      // With a TV, a compact version so you can see where you landed without looking up.
      html = `<div class="pcard final-p">${finalScoreboard(this.players || {}, mirror ? 'Final scores' : 'Final', mirror ? this.highlights : null)}
        <button class="pbtn primary" data-action="${this.isDirector ? 'again' : 'tolobby'}">Back to the lobby</button>
      </div>`;
      key = `final|${Object.keys(this.players || {}).length}|${Object.keys(this.highlights || {}).length}`;
    } else if (this.round && this.round.phase === 'intro' && this.mod) {
      html = `<div class="pcard intro-p"><div class="intro-kicker">Up next</div>
        <div class="intro-title">${esc(this.round.title || '')}</div>
        <div class="intro-hint">${esc(this.round.hint || '')}</div></div>`;
      key = `intro|${this.round.title}`;
    } else if (!this.mod || (this.gameId && this.mod.meta && this.mod.meta.id !== this.gameId)) {
      html = this.lobbyHTML();
      key = `lobby|${this.isDirector}|${Object.keys(this.players || {}).length}|${this.hasScreen}|${this.length}`;
    } else if (this.gameId === 'board') {
      html = this.mod.playerView(this.board, this.me, this.round, this.miniMod,
                                 this.hand, this.submitted, this.voted, this.state.draft,
                                 { mirror, players: this.players, mulliganed: this.mulliganed, duel: this.miniInfo?.duel || null });
      const b = this.board || {};
      key = `board|${b.phase}|${b.active}|${b.turnNo}|${(b.items||{})[this.me.id]?.length}|${this.round?.phase}|${this.submitted}|${this.voted}|${(this.state.draft||[]).join(',')}`;
    } else {
      const extra = { mirror, players: this.players, mulliganed: this.mulliganed };
      // Each engine's playerView has its own positional signature; the trailing
      // argument is always the extras bag.
      const args = this.gameId === 'promptvote'
        ? [this.round, this.me, this.hand, this.submitted, this.voted, this.state.draft, extra]
        : this.gameId === 'charades'
          ? [this.round, this.me, null, null, null, extra]
          : [this.round, this.me, this.submitted, this.voted, this.players, extra];
      html = this.mod.playerView(...args);
      key = `${this.gameId}|${mirror}|${this.round?.phase}|${this.round?.index ?? this.round?.turn}|${this.round?.active}|${this.submitted}|${this.voted}|${(this.state.draft||[]).join(',')}|${this.hand.length}`;
    }

    if (mirror && this.isDirector && this.round && /reveal|roundEnd/.test(this.round.phase) && !/data-action="next"/.test(html)) {
      html += `<button class="pbtn primary nexthost" data-action="next">Next</button>`;
    }
    const screenKey = key.replace(/\|[^|]*$/, '');
    const isNew = screenKey !== this._screenKey;
    this._screenKey = screenKey;

    // Anything the person is typing must survive a re-render. Live events
    // (other players answering, presence pings) arrive constantly mid-typing.
    const ta = stage.querySelector('.ptext');
    const typing = ta && document.activeElement === ta;
    const draftText = ta ? ta.value : null;
    const sel = typing ? [ta.selectionStart, ta.selectionEnd] : null;

    if (!isNew && draftText !== null && stage.innerHTML !== html) {
      // Same screen, same textarea: only patch the parts that aren't the input.
      const fresh = document.createElement('div'); fresh.innerHTML = html;
      const freshTa = fresh.querySelector('.ptext');
      if (freshTa) {
        freshTa.replaceWith(ta);          // keep the live node, with its value and focus
        stage.innerHTML = '';
        while (fresh.firstChild) stage.appendChild(fresh.firstChild);
        if (typing) { ta.focus(); try { ta.setSelectionRange(sel[0], sel[1]); } catch {} }
        this.mountDieIfNeeded(stage); this.mountTiltIfNeeded(stage);
        document.body.classList.toggle('headsup', Boolean(stage.querySelector('.hu')));
        this.afterRender();
        return;
      }
    }

    // A live widget (Body Count's timed trials) owns its screen until the key changes.
    const liveWidget = !isNew && stage.querySelector('[data-live][data-mounted]');
    if (isNew) { swapIn(stage, html, key); stagger(stage, '.pbtn, .card, .hugebtn, .gamebtn, .opt, .vcard', 45); }
    else if (!liveWidget && stage.innerHTML !== html) stage.innerHTML = html;

    // New screen that also has a textarea (rare: same phase re-keyed): restore text.
    const ta2 = stage.querySelector('.ptext');
    if (ta2 && draftText && !ta2.value && !isNew) ta2.value = draftText;

    this.mountDieIfNeeded(stage);
    this.mountTiltIfNeeded(stage);
    if (this.gameId === 'board' && this.mod?.patchPlayer) this.mod.patchPlayer(stage, this.board, this.me);
    if (this.mod?.mountPlayer && this.round) this.mod.mountPlayer(stage, { room: this.room, me: this.me, round: this.round, fx: { sound, haptic } });
    document.body.classList.toggle('horror', this.gameId === 'bodycount' && Boolean(this.mod));
    document.body.classList.toggle('ghostmode', Boolean(stage.querySelector('.ghostmode')));
    // Heads Up turns the whole phone light so the word reads from across the room.
    document.body.classList.toggle('headsup', Boolean(stage.querySelector('.hu')));
    this.afterRender();
  }

  afterRender() {
    // Director controls live in the top bar, so they're reachable mid-game.
    const tools = el('pbar-tools');
    if (!tools) return;
    let b = tools.querySelector('.endbtn');
    const show = this.isDirector ? Boolean(this.gameId || !this.hasScreen) : Boolean(this.gameId);
    if (show && !b) {
      b = document.createElement('button'); b.className = 'endbtn'; b.textContent = 'End';
      b.addEventListener('click', () => {
        // Two taps: first arms it, second ends. Stops pocket-taps killing a game.
        if (!b.classList.contains('armed')) {
          b.classList.add('armed'); b.textContent = 'End game?';
          clearTimeout(b._t); b._t = setTimeout(() => { b.classList.remove('armed'); b.textContent = 'End'; }, 3000);
          return;
        }
        b.classList.remove('armed'); b.textContent = 'End';
        if (this.director) return this.director.endGame();
        this.room.t.set(`${this.room.base}/intent`, { by: this.me.id, action: 'endgame', at: Date.now() });
      });
      tools.prepend(b);
    } else if (!show && b) b.remove();
  }

  lobbyHTML() {
    const list = playerList(this.players || {});
    const chips = list.length ? partyChipsHTML(this.players, this.party) : '<p class="muted">Just you so far.</p>';
    const ranked = Object.values(this.party || {}).some(r => r && r.games);
    const share = `<div class="sharebox">
        <div class="sharecode">${esc(this.room.code)}</div>
        <p class="phint small">Friends: open the site, join with this code. Or tap to share the link.</p>
        <button class="pbtn" data-action="share">Share invite</button>
      </div>`;
    if (!this.isDirector) {
      return `<div class="pcard">
        <h2>${this.hasScreen ? "You're in" : 'In the party'}</h2>
        ${this.hasScreen ? '<p>Waiting for the host to pick a game.</p>' : share}
        ${ranked ? '<h3 class="lobbyh">Party standings</h3>' : ''}<div class="plist">${chips}</div>
      </div>`;
    }
    const menu = GAME_MENU.map((g, i) => {
      if (g.tv && !this.hasScreen && !g.phoneMode) return '';
      const label = (!this.hasScreen && g.phoneMode === 'headsup') ? 'Heads Up' : g.label;
      const sub   = (!this.hasScreen && g.phoneMode === 'headsup') ? 'Phone on your forehead. Tilt to answer.' : g.sub;
      return `<button class="gamebtn" data-game="${i}"><b>${esc(label)}</b><span>${esc(sub)}</span></button>`;
    }).join('');
    return `<div class="pcard">
      ${share}
      <h3 class="lobbyh">${ranked ? 'Party standings' : `Players (${list.length})`}</h3>
      <div class="plist">${chips}</div>
      <h3 class="lobbyh">Game length</h3>
      <div class="tabs lenpick">${Object.entries(LENGTHS).map(([k, v]) =>
        `<button class="tab ${k === (this.length || 'standard') ? 'on' : ''}" data-action="setlen" data-len="${k}">${v.label}</button>`).join('')}</div>
      <h3 class="lobbyh">Pick a game</h3>
      <div class="menu">${menu}</div>
    </div>`;
  }

  mountDieIfNeeded(stage) {
    const slot = stage.querySelector('[data-die]');
    if (!slot) { this.die = null; return; }
    const result = Number(slot.dataset.result);
    const result2 = Number(slot.dataset.result2) || 0;
    const stamp = result ? `${result}:${result2}` : '';
    if (!this.die || !slot.contains(this._dieEl)) {
      this.die = mountDie(slot); this._dieEl = slot.querySelector('.dscene');
      // Re-mounted after the roll already played (the board moved on a phase): keep the face.
      if (result && stamp === this._lastShownRoll) this.die.show(result2 || result); else this.die.idle();
    }
    if (result && stamp !== this._lastShownRoll) {
      this._lastShownRoll = stamp; sound.dice(); haptic.dice();
      // A doubled roll: tumble once, then again, so both numbers land.
      this.die.roll(result).then(async () => {
        sound.land(); haptic.land();
        if (result2) { await new Promise(r => setTimeout(r, 250)); sound.dice(); await this.die.roll(result2); sound.land(); haptic.land(); }
      });
    }
    if (!result) this._lastShownRoll = null;
  }

  /* -------------------------------- tilt -------------------------------- */

  mountTiltIfNeeded(stage) {
    const zone = stage.querySelector('[data-tilt]');
    if (!zone) return this.stopTilt();
    const mode = zone.dataset.tilt || 'play';
    if (!this._tilt) {
      keepAwake();
      this._tilt = startTilt({
        onDown: () => { this.tiltFlash('got'); this.act({ action: 'got' }); },
        onUp:   () => { this.tiltFlash('skip'); this.act({ action: 'skip' }); },
        onState: s => { this._tiltState = s; const n = document.querySelector('[data-tiltstate]'); if (n) n.textContent = s; },
        onPose: pose => this.tiltPose(pose)
      });
    }
    this._tilt.setMode(mode);
    const n = stage.querySelector('[data-tiltstate]'); if (n && this._tiltState) n.textContent = this._tiltState;
    this.applyRotation();
  }
  stopTilt() {
    if (this._tilt) { this._tilt.stop(); this._tilt = null; this._tiltState = null; leaveSideways(); }
    delete document.body.dataset.hurot;
  }
  /** Rotate the word screen when the browser is stuck in portrait. */
  applyRotation() {
    const want = browserLandscape() ? 'none' : (this._side < 0 ? 'ccw' : 'cw');
    if (document.body.dataset.hurot !== want) document.body.dataset.hurot = want;
  }
  tiltPose({ side, delta, calibrated }) {
    if (side) this._side = side;
    this.applyRotation();
    const cal = document.querySelector('[data-cal]');
    if (cal) {
      // Steadiness meter during the countdown: fills as they hold it still near vertical.
      cal.classList.toggle('ok', calibrated);
      const i = cal.querySelector('i'); if (i) i.style.setProperty('--lvl', calibrated ? 1 : 0.35);
    }
    const hu = document.querySelector('.hu');
    if (hu) hu.style.setProperty('--tiltd', `${Math.max(-1, Math.min(1, delta / 38)).toFixed(2)}`);
  }
  tiltFlash(kind) {
    const hu = document.querySelector('.hu'); if (!hu) return;
    hu.classList.remove('hit-got', 'hit-skip'); void hu.offsetWidth; hu.classList.add(`hit-${kind}`);
    haptic[kind === 'got' ? 'lock' : 'tap']?.();
    if (kind === 'got') sound.correct?.(); else sound.wrong?.();
  }

  /* ------------------------------- actions ------------------------------ */

  async act(action) {
    if (action.action === 'share') return this.share();
    if (action.action === 'launch') {
      const i = Number(action.game);
      const choice = GAME_MENU[i];
      if ((choice.pick || choice.id === 'charades' || choice.id === 'quiz') && !action.cat && !action.random) return this.pickCategory(i);
      const opts = action.cat ? { category: action.cat } : {};
      if (!this.hasScreen && choice.phoneMode === 'headsup') opts.headsup = true;
      return this.director?.launch(i, opts);
    }
    if (action.action === 'setlen') return this.director?.setLength(action.len);
    if (action.action === 'again')  return this.director?.playAgain();
    if (action.action === 'tolobby') return this.room.t.set(`${this.room.base}/intent`, { by: this.me.id, action: 'endgame', at: Date.now() });
    if (action.action === 'mulligan') {
      this.state.draft = [];
      if (this.director) return this.director.nudge('mulligan', this.me.id);
      return this.room.t.set(`${this.room.base}/intent`, { by: this.me.id, action: 'mulligan', at: Date.now() });
    }
    // 'skip' with a pid = skip a slow player (waiting chips). Without one it's
    // the game's own skip (Heads Up word), handled by the engine below.
    if (action.action === 'next' || (action.action === 'skip' && action.pid)) {
      if (this.director) return this.director.nudge(action.action, action.pid);
      // Not the director: route through the room so the director picks it up.
      return this.room.t.set(`${this.room.base}/intent`, { by: this.me.id, action: action.action, pid: action.pid || null, at: Date.now() });
    }
    if (action.action === 'enabletilt') {
      const r = await startTilt.requestPermission();
      if (r !== 'granted') this.err('Motion permission was denied. Use the buttons.');
      await goSideways();
      return this.render();
    }
    if (!this.mod || !this.mod.handleAction) return;
    const res = this.gameId === 'board'
      ? await this.mod.handleAction(this.room, this.me, action, this.board, this.state, this.round, this.miniMod)
      : await this.mod.handleAction(this.room, this.me, action, this.round, this.state);
    if (res && res.rerender) this.render();
  }

  async pickCategory(i) {
    const mod = await ENGINES[GAME_MENU[i].id]();
    const cats = await mod.Host.listCategories();
    const cards = cats.map(c => `
      <button class="gamebtn" data-action="launch" data-game="${i}" data-cat="${esc(c.name)}">
        <b>${c.emoji} ${esc(c.name)}</b><span>${esc(c.blurb || `${c.count} questions`)}</span></button>`).join('');
    const hasMixed = cats.some(c => c.name === 'Mixed') || GAME_MENU[i].noRandom;
    swapIn(el('pstage'), `<div class="pcard"><h2>${esc(GAME_MENU[i].pick || 'Pick a category')}</h2><div class="menu">${cards}
      ${hasMixed ? '' : `<button class="gamebtn" data-action="launch" data-game="${i}" data-random="1"><b>🎲 Surprise me</b><span>Mixed bag</span></button>`}
      </div><button class="linkbtn" data-action="back">Back</button></div>`, 'catpick');
    this._screenKey = 'catpick';
  }

  async share() {
    const url = new URL('play.html', location.href); url.searchParams.set('room', this.room.code);
    const text = `Join my party games room: ${this.room.code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Party Games', text, url: url.href });
      else { await navigator.clipboard.writeText(url.href); this.toast('Link copied'); }
    } catch {}
  }

  toast(msg) {
    let n = el('ptoast');
    if (!n) { n = document.createElement('div'); n.id = 'ptoast'; document.body.appendChild(n); }
    n.textContent = msg; n.classList.add('show');
    clearTimeout(this._toastT); this._toastT = setTimeout(() => n.classList.remove('show'), 1500);
  }

  startTicking() {
    setInterval(() => {
      document.querySelectorAll('.timer[data-deadline]').forEach(n => {
        const left = countdown(Number(n.dataset.deadline));
        const total = Number(n.dataset.total) || 0;
        if (String(left) !== n.dataset.shown) {
          n.dataset.shown = String(left);
          (n.querySelector('.tnum') || n).textContent = left;
          if (left <= 5 && left > 0) { sound.tick(); haptic.tap(); }
        }
        n.classList.toggle('urgent', left <= 5);
        const ring = n.querySelector('.tring circle.prog');
        if (ring && total) ring.style.strokeDashoffset = String((1 - Math.max(0, Math.min(1, left / total))) * 100);
      });
    }, 250);
  }

  err(msg) { const n = el('joinerr'); if (n) { n.textContent = msg; n.hidden = false; } else this.toast(msg); }
}

installViewport({ stageId: 'pstage', remoteKeys: false });
const app = new PlayApp();
app.boot().catch(console.error);
window.addEventListener('pagehide', () => {
  clearInterval(app._watchdog); clearInterval(app._presence);
  app.room?.detach(); app.director?.stop(); app.stopTilt();
});

document.addEventListener('click', e => {
  const nc = e.target.closest('.namechip');
  if (nc) { el('name').value = nc.dataset.name; sound.tap(); return; }
  const btn = e.target.closest('[data-action], [data-game]');
  if (!btn || btn.disabled) return;
  const action = { ...btn.dataset };
  if (!action.action && action.game !== undefined) action.action = 'launch';
  if (action.action === 'back') { app._screenKey = null; return app.render(); }
  if (action.action === 'submittext') {
    const ta = document.querySelector('[data-role="answer"]'); action.text = ta ? ta.value : '';
  }
  const locking = ['choose', 'confirmcards', 'submittext', 'vote', 'roll', 'fork', 'got', 'skip', 'pickvote', 'launch'].includes(action.action);
  if (locking) { sound.lock(); haptic.lock(); } else { sound.tap(); haptic.tap(); }
  btn.classList.add('pressed'); setTimeout(() => btn.classList.remove('pressed'), 180);
  app.act(action);
});

window.addEventListener('resize', () => { if (app._tilt) app.applyRotation(); });

document.addEventListener('focusin', e => {
  if (e.target.matches('.ptext')) setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250);
});
