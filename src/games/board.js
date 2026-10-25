// ---------------------------------------------------------------------------
// SPIRAL - a board you go around, with the other games bolted onto it.
//
// Sixteen tiles in a ring. On your turn you roll on your phone, your token
// moves, and whatever you land on happens to you. Some tiles fire a single
// round of trivia, fill-in-the-blank or charades, which everyone plays; the
// points from it carry straight back onto the board.
//
// State lives in two places so the board and the minigame never fight over
// the same node:
//   rooms/{code}/board   the board itself (always present)
//   rooms/{code}/round   whatever minigame is running (null between them)
//   rooms/{code}/mini    id of the running minigame, or absent
// ---------------------------------------------------------------------------

import { shuffle, esc, sortedPlayers, playerList, finalScoreboard } from '../util.js';

export const meta = {
  id: 'board',
  name: 'Spiral',
  blurb: 'Go around the board. Land on things. Regret it.',
  minPlayers: 2,
  defaultRounds: 12          // total turns across all players
};

const RESOLVE_MS = 4200;
const ROLL_MS    = 1100;   // matches the token slide duration in CSS
const LAP_BONUS  = 500;

/** Grid-perimeter positions for a 6x4 ring, clockwise from top-left. */
const RING = [
  [1,1],[1,2],[1,3],[1,4],[1,5],[1,6],
  [2,6],[3,6],
  [4,6],[4,5],[4,4],[4,3],[4,2],[4,1],
  [3,1],[2,1]
];

const MINIS = [
  { id: 'quiz',       opts: { rounds: 1 },                            label: 'Trivia' },
  { id: 'promptvote', opts: { rounds: 1, mode: 'pick', judge: 'all' }, label: 'Fill In The Blank' },
  { id: 'promptvote', opts: { rounds: 1, mode: 'type', judge: 'all' }, label: 'Write Your Own' },
  { id: 'charades',   opts: { rounds: 1, pointsPer: 60 },             label: 'Shout It Out', solo: true }
];

const ENGINES = {
  quiz:       () => import('./quiz.js'),
  promptvote: () => import('./promptvote.js'),
  charades:   () => import('./charades.js')
};

function buildTiles() {
  // Index 0 is always Start; the rest is a fixed mix, shuffled, so every board
  // is different but fairly balanced.
  const mix = [
    { t: 'mini',  label: 'Minigame' },
    { t: 'mini',  label: 'Minigame' },
    { t: 'mini',  label: 'Minigame' },
    { t: 'mini',  label: 'Minigame' },
    { t: 'mini',  label: 'Minigame' },
    { t: 'pay',   label: 'Payday',    amount:  600 },
    { t: 'pay',   label: 'Payday',    amount:  400 },
    { t: 'pay',   label: 'Windfall',  amount:  900 },
    { t: 'loss',  label: 'Setback',   amount:  400 },
    { t: 'loss',  label: 'Setback',   amount:  600 },
    { t: 'loss',  label: 'Disaster',  amount:  900 },
    { t: 'swap',  label: 'Swap' },
    { t: 'swap',  label: 'Swap' },
    { t: 'wild',  label: 'Wildcard' },
    { t: 'wild',  label: 'Wildcard' }
  ];
  return [{ t: 'start', label: 'Start' }, ...shuffle(mix)];
}

export class Host {
  constructor(room, opts = {}) {
    this.room = room;
    this.maxTurns = opts.rounds || meta.defaultRounds;
    this.timer = null;
    this.mini = null;        // { mod, engine, id }
    this._busy = false;
  }

  async load() {
    this.tiles = buildTiles();
    return this;
  }

  get base() { return this.room.base; }

  async begin() {
    await this.room.setGame('board');
    await this.room.setPhase('playing');
    await this.room.setRound(null);
    await this.room.t.remove(`${this.base}/mini`);
    await this.room.clearRoundData();

    const order = playerList(await this.room.players())
      .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0))
      .map(p => p.id);

    const positions = {};
    for (const pid of order) positions[pid] = 0;

    await this.room.t.set(`${this.base}/board`, {
      phase: 'roll',
      tiles: this.tiles,
      positions,
      order,
      turn: 0,
      turnNo: 1,
      maxTurns: this.maxTurns,
      active: order[0] || null,
      message: null,
      lastRoll: null
    });
  }

  async read() {
    return this.room.t.get(`${this.base}/board`);
  }

  /** A player joining or leaving mid-game adjusts the running order. */
  async onPlayers(players) {
    if (this.mini) return this.mini.engine.onPlayers?.(players);
    const b = await this.read();
    if (!b || b.phase === 'final') return;

    const ids = Object.keys(players || {});
    const order = (b.order || []).filter(id => ids.includes(id));
    const positions = { ...(b.positions || {}) };
    for (const id of ids) {
      if (!order.includes(id)) { order.push(id); positions[id] = positions[id] || 0; }
      if (positions[id] === undefined) positions[id] = 0;
    }
    if (!order.length) return;

    const patch = { order, positions };
    if (!order.includes(b.active)) {
      patch.turn = b.turn % order.length;
      patch.active = order[patch.turn];
    }
    await this.room.t.update(`${this.base}/board`, patch);
  }

  /* --------------------------- the turn loop --------------------------- */

  /** The active player tapped ROLL. */
  async onIntent(intent) {
    if (!intent || intent.action !== 'roll') return;
    if (this._busy) return;
    const b = await this.read();
    if (!b || b.phase !== 'roll' || b.active !== intent.by) return;

    this._busy = true;
    try {
      const roll = 1 + Math.floor(Math.random() * 6);
      const from = b.positions[b.active] || 0;
      const raw = from + roll;
      const to = raw % b.tiles.length;
      const positions = { ...b.positions, [b.active]: to };
      const passedStart = raw >= b.tiles.length;

      await this.room.t.update(`${this.base}/board`, {
        phase: 'moving', lastRoll: roll, positions, message: null
      });
      if (passedStart) await this.room.addScore(b.active, LAP_BONUS);
      await new Promise(r => setTimeout(r, ROLL_MS));
      await this.resolve(to, passedStart);
    } finally {
      this._busy = false;
    }
  }

  async resolve(tileIndex, passedStart = false) {
    const b = await this.read();
    if (!b) return;
    let tile = b.tiles[tileIndex];
    const who = (await this.room.players())[b.active] || { name: 'Someone' };
    const lap = passedStart ? ` and banks ${LAP_BONUS} for the lap` : '';

    if (tile.t === 'wild') {
      const roll = Math.random();
      tile = roll < 0.4
        ? { t: 'pay',  label: 'Wildcard', amount: 800 }
        : roll < 0.8
          ? { t: 'loss', label: 'Wildcard', amount: 700 }
          : { t: 'mini', label: 'Wildcard' };
    }

    if (tile.t === 'mini') return this.startMini(who, b.active);

    let message;
    if (tile.t === 'start') {
      message = `${who.name} lands on Start${lap}`;
    } else if (tile.t === 'pay') {
      await this.room.addScore(b.active, tile.amount);
      message = `${who.name} collects ${tile.amount}${lap}`;
    } else if (tile.t === 'loss') {
      await this.room.addScore(b.active, -tile.amount);
      message = `${who.name} loses ${tile.amount}${lap}`;
    } else if (tile.t === 'swap') {
      const others = (b.order || []).filter(id => id !== b.active);
      if (others.length) {
        const target = others[Math.floor(Math.random() * others.length)];
        const players = await this.room.players();
        const mine = players[b.active]?.score || 0;
        const theirs = players[target]?.score || 0;
        await this.room.t.set(`${this.base}/players/${b.active}/score`, theirs);
        await this.room.t.set(`${this.base}/players/${target}/score`, mine);
        message = `${who.name} swaps scores with ${players[target]?.name || 'someone'}`;
      } else {
        message = `${who.name} has nobody to swap with`;
      }
    } else {
      message = `${who.name} lands on nothing at all${lap}`;
    }

    await this.room.t.update(`${this.base}/board`, { phase: 'resolve', message });
    this.timer = setTimeout(() => this.nextTurn(), RESOLVE_MS);
  }

  /* ---------------------------- minigames ------------------------------ */

  async startMini(who, activeId) {
    const pick = MINIS[Math.floor(Math.random() * MINIS.length)];
    const mod = await ENGINES[pick.id]();
    // A charades tile is one 60-second turn for whoever landed on it, not a
    // lap of the whole table.
    const opts = pick.solo ? { ...pick.opts, only: [activeId] } : pick.opts;
    const engine = new mod.Host(this.room, opts);
    await engine.load();

    // When the single round is done, control comes back here.
    engine.onFinish = () => this.endMini();
    this.mini = { mod, engine, id: pick.id, label: pick.label };

    await this.room.t.set(`${this.base}/mini`, { id: pick.id, label: pick.label });
    await this.room.t.update(`${this.base}/board`, {
      phase: 'minigame',
      message: `${who.name} triggered ${pick.label}`
    });
    await engine.begin();
  }

  async endMini() {
    this.mini?.engine?.stop?.();
    this.mini = null;
    await this.room.t.remove(`${this.base}/mini`);
    await this.room.setRound(null);
    await this.room.clearRoundData();
    await this.room.t.remove(`${this.base}/hands`);
    await this.nextTurn();
  }

  /* ----------------------------- plumbing ------------------------------ */

  async nextTurn() {
    clearTimeout(this.timer);
    const b = await this.read();
    if (!b) return;

    if (b.turnNo >= b.maxTurns) return this.finish();

    const order = b.order || [];
    if (!order.length) return this.finish();
    const turn = (b.turn + 1) % order.length;

    await this.room.t.update(`${this.base}/board`, {
      phase: 'roll',
      turn,
      turnNo: b.turnNo + 1,
      active: order[turn],
      message: null,
      lastRoll: null
    });
  }

  async finish() {
    clearTimeout(this.timer);
    await this.room.t.update(`${this.base}/board`, { phase: 'final', message: null });
    // host.js watches round.phase for the leaderboard commit.
    await this.room.setRound({ phase: 'final' });
    await this.room.setPhase('scoreboard');
  }

  /** Forwarded from the host so a running minigame still advances. */
  onSubmissions(subs, players) { return this.mini?.engine?.onSubmissions?.(subs, players); }
  onVotes(votes, players)      { return this.mini?.engine?.onVotes?.(votes, players); }
  charadesResolve(result)      { return this.mini?.engine?.resolve?.(result); }

  stop() {
    clearTimeout(this.timer);
    this.mini?.engine?.stop?.();
    this.mini = null;
  }
}

/* -------------------------------- views -------------------------------- */

const TILE_CLASS = {
  mini: 'tmini', pay: 'tpay', loss: 'tloss', swap: 'tswap', wild: 'twild', rest: 'trest', start: 'tstart'
};
const TILE_ICON = {
  mini: '🎲', pay: '💸', loss: '💀', swap: '🔁', wild: '❓', rest: '·', start: '🏁'
};

/**
 * The board is rendered ONCE per game into a persistent scene; later updates
 * patch tokens, the centre panel and tile highlights in place. That is what
 * lets tokens slide instead of teleport. host.js calls hostView on every
 * change; it returns the same shell and the patcher does the real work.
 */
export function hostView(board, players, round, miniMod) {
  if (!board) return '<div class="big">Setting up the board…</div>';

  if (board.phase === 'minigame' && miniMod && round) {
    return `<div class="miniwrap">
      <div class="minibadge">${esc(board.message || 'Minigame')}</div>
      ${miniMod.hostView(round, players)}
    </div>`;
  }

  if (board.phase === 'final') return scoreboard(players, 'Final scores');

  // Shell only; patchBoard() fills it.
  const tiles = (board.tiles || []).map((t, i) => {
    const [r, c] = RING[i] || [1, 1];
    return `<div class="tile ${TILE_CLASS[t.t] || ''}" data-tile="${i}"
                 style="grid-row:${r};grid-column:${c}">
      <div class="tface">
        <span class="ticon">${TILE_ICON[t.t] || ''}</span>
        <span class="tlabel">${esc(t.label)}</span>
        ${t.amount ? `<span class="tamt">${t.t === 'loss' ? '−' : '+'}${t.amount}</span>` : ''}
      </div>
      <div class="tside"></div>
    </div>`;
  }).join('');

  return `
    <div class="bscene">
      <div class="btable">
        <div class="boardgrid" data-board>
          ${tiles}
          <div class="bcentre" data-centre></div>
          <div class="tokenlayer" data-tokens></div>
        </div>
      </div>
    </div>
    <div class="bscores" data-bscores></div>`;
}

/**
 * Patch the live board in place. Called by host.js after hostView has been
 * mounted (and on every subsequent board change while the shell is present).
 */
export function patchBoard(stage, board, players, fx) {
  const grid = stage.querySelector('[data-board]');
  if (!grid || !board) return;

  const byId = Object.fromEntries(playerList(players).map(p => [p.id, p]));
  const order = board.order || [];
  const positions = board.positions || {};

  // ---- tokens: create once, then move by transform
  const layer = grid.querySelector('[data-tokens]');
  const gridRect = grid.getBoundingClientRect();

  const tileCentre = idx => {
    const t = grid.querySelector(`[data-tile="${idx}"]`);
    if (!t) return { x: 0, y: 0 };
    const r = t.getBoundingClientRect();
    return { x: r.left - gridRect.left + r.width / 2, y: r.top - gridRect.top + r.height * 0.42 };
  };

  // Several tokens on one tile fan out a little so they don't stack exactly.
  const onTile = {};
  for (const pid of order) {
    const idx = positions[pid] || 0;
    (onTile[idx] = onTile[idx] || []).push(pid);
  }

  for (const pid of order) {
    let tok = layer.querySelector(`[data-token="${pid}"]`);
    if (!tok) {
      tok = document.createElement('div');
      tok.className = 'ptoken';
      tok.dataset.token = pid;
      tok.innerHTML = `<span class="pt-emoji">${byId[pid]?.emoji || '🎲'}</span><span class="pt-base"></span>`;
      layer.appendChild(tok);
    }
    const idx = positions[pid] || 0;
    const group = onTile[idx];
    const k = group.indexOf(pid);
    const spread = group.length > 1 ? (k - (group.length - 1) / 2) * 18 : 0;
    const { x, y } = tileCentre(idx);
    const prev = tok.dataset.at;
    tok.style.transform = `translate(${x + spread}px, ${y}px)`;
    tok.classList.toggle('active', pid === board.active);
    if (prev !== undefined && prev !== String(idx)) {
      tok.classList.remove('hop'); void tok.offsetWidth; tok.classList.add('hop');
    }
    tok.dataset.at = idx;
  }
  // Remove tokens for anyone who left.
  layer.querySelectorAll('[data-token]').forEach(n => {
    if (!order.includes(n.dataset.token)) n.remove();
  });

  // ---- tile highlight for the active player's square
  grid.querySelectorAll('.tile.lit').forEach(n => n.classList.remove('lit'));
  if (board.phase === 'resolve' || board.phase === 'moving') {
    const idx = positions[board.active];
    const t = grid.querySelector(`[data-tile="${idx}"]`);
    if (t) t.classList.add('lit');
  }

  // ---- centre panel
  const who = byId[board.active] || {};
  const centre = grid.querySelector('[data-centre]');
  let html;
  if (board.phase === 'roll') {
    html = `
      <div class="bturn">Turn ${board.turnNo} of ${board.maxTurns}</div>
      <div class="bname">${who.emoji || '🎲'} ${esc(who.name || '')}</div>
      <div class="bhint">Roll on your phone</div>`;
  } else if (board.phase === 'moving') {
    html = `<div class="bdie">${board.lastRoll || ''}</div><div class="bhint">Moving…</div>`;
  } else {
    const kind = /collects|Wildcard.*collects/.test(board.message || '') ? 'good'
               : /loses|swaps/.test(board.message || '') ? 'bad' : '';
    html = `
      ${board.lastRoll ? `<div class="bdie">${board.lastRoll}</div>` : ''}
      <div class="bmsg ${kind}">${esc(board.message || '…')}</div>`;
  }
  const key = `${board.phase}|${board.turnNo}|${board.message || ''}`;
  if (centre.dataset.key !== key) {
    centre.dataset.key = key;
    centre.classList.remove('pop'); centre.innerHTML = html; void centre.offsetWidth; centre.classList.add('pop');
    if (fx && board.phase === 'resolve') {
      if (/collects/.test(board.message || '')) fx.sound.coin();
      else if (/loses/.test(board.message || '')) fx.sound.loss();
      else if (/swaps/.test(board.message || '')) fx.sound.reveal();
    }
  }

  // ---- running scores with count-up
  const sc = stage.querySelector('[data-bscores]');
  if (sc) {
    const sorted = sortedPlayers(players);
    for (const p of sorted) {
      let chip = sc.querySelector(`[data-chip="${p.id}"]`);
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'bchip'; chip.dataset.chip = p.id;
        chip.innerHTML = `<span>${p.emoji || '🎲'}</span>${esc(p.name)}<b>0</b>`;
        sc.appendChild(chip);
      }
      chip.classList.toggle('active', p.id === board.active);
      const b = chip.querySelector('b');
      if (fx) fx.countUp(b, p.score || 0); else b.textContent = p.score || 0;
    }
    // keep DOM order = score order
    sorted.forEach(p => { const c = sc.querySelector(`[data-chip="${p.id}"]`); if (c) sc.appendChild(c); });
  }
}

export function playerView(board, me, round, miniMod, hand, submitted, voted, draft) {
  if (!board) return `<div class="pcard"><h2>Setting up</h2></div>`;

  if (board.phase === 'minigame' && miniMod && round) {
    if (miniMod.meta?.id === 'promptvote') {
      return miniMod.playerView(round, me, hand, submitted, voted, draft);
    }
    if (miniMod.meta?.id === 'charades') return miniMod.playerView(round, me);
    return miniMod.playerView(round, me, submitted);
  }

  if (board.phase === 'final') {
    return `<div class="pcard"><h2>Game over</h2><p>Check the big screen.</p></div>`;
  }

  const isMe = board.active === me.id;
  if (!isMe) {
    return `<div class="pcard">
      <h2>Not your turn</h2>
      <p>${esc(board.message || 'Somebody else is busy ruining their run.')}</p>
    </div>`;
  }

  if (board.phase === 'roll') {
    return `<div class="pcard tall dicecard">
      <div class="diehost" data-die></div>
      <button class="hugebtn roll" data-action="roll">ROLL</button>
      <p class="phint small">Tap to roll</p>
    </div>`;
  }

  // Keep the die on screen through the move so it can land, then show result.
  return `<div class="pcard tall dicecard">
    <div class="diehost" data-die data-result="${board.lastRoll || ''}"></div>
    <h2 class="rolled">${board.lastRoll ? `You rolled ${board.lastRoll}` : 'Rolling'}</h2>
    <p class="phint">${esc(board.message || '')}</p>
  </div>`;
}

export function scoreboard(players, title = 'Scores') {
  return finalScoreboard(players, title);
}

/** Roll taps and minigame taps both arrive here. */
export async function handleAction(room, me, action, board, state, round, miniMod) {
  if (action.action === 'roll') {
    if (!board || board.phase !== 'roll' || board.active !== me.id) return;
    await room.t.set(`${room.base}/intent`, {
      by: me.id, action: 'roll', at: Date.now()
    });
    return { rerender: true };
  }
  if (miniMod && round) {
    return miniMod.handleAction(room, me, action, round, state);
  }
}
