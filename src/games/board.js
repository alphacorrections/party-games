// ---------------------------------------------------------------------------
// SPIRAL. A party board game with the other games bolted on as minigames.
//
// 24 tiles on a winding path through four zones. On your turn: optionally
// use an item, then roll. Land on a tile and it happens to you — or to
// everyone, or to the two of you if someone's already standing there.
//
// What makes it a game rather than a dice loop:
//   items   held (max 2), used before you roll: Steal, Shield, Double, Swap, Mug
//   duels   land on an occupied tile -> one-round head-to-head for a pot
//   the pot setbacks pay in; Jackpot pays out
//   events  tiles that hit the whole table
//   zones   each zone biases which minigame fires and how much tiles pay
//
// State:
//   rooms/{code}/board   the board (persistent through the game)
//   rooms/{code}/round   the running minigame (null between them)
//   rooms/{code}/mini    { id, label, duel?: [pidA, pidB] } while one runs
// ---------------------------------------------------------------------------

import { shuffle, esc, sortedPlayers, playerList, finalScoreboard, highlight } from '../util.js';

export const meta = {
  id: 'board',
  name: 'Spiral',
  blurb: 'Roll. Land. Steal. Duel. Regret.',
  minPlayers: 2,
  defaultRounds: 16          // total turns across all players
};

const RESOLVE_MS = 4200;
const STEP_MS = 560, DICE_MS = 1500;      // one tile per beat
const LAND_MS    = 1300;     // sit on the tile before it resolves
const FORK_MS    = 12000;    // time to pick at a fork
const LAP_BONUS  = 500;
const DUEL_POT   = 800;
const MAX_ITEMS  = 2;

/* ------------------------------- the path -------------------------------- */
// 28 tiles along an Archimedean spiral, outside in, ending at the centre.
// Positions are fractions of the board box; the view places them absolutely.
export const N_TILES = 28;
export const PATH = (() => {
  const out = [], turns = 2.15, stretch = 1.28;
  for (let i = 0; i < N_TILES; i++) {
    const t = i / (N_TILES - 1);
    const ang = t * turns * Math.PI * 2 - Math.PI / 2;
    const r = 0.44 - t * 0.31;
    out.push({ x: 0.5 + r * Math.cos(ang) * stretch, y: 0.5 + r * Math.sin(ang), ang, t });
  }
  return out;
})();

// ---------------------------------------------------------------------------
// The board is a GRAPH, not a line. The spiral is the main road (0..27 then
// back to 0). Three branches hang off it; each is a choice made mid-move.
//
//   SHORTCUT  (from 6)  : 3 tiles cutting inward to 13. Fast, but tile S2 is Bail.
//   DETOUR    (from 12) : 4 tiles looping outward back to 16. All payouts, but
//                         the last one is Sent Back (to Start) unless shielded.
//   BRIDGE    (from 20) : 2 tiles straight to the Jackpot ring at 26. Costs 300
//                         to step onto.
//
// Branch tiles have ids >= 100 and their own positions in PATH_EXTRA.
// ---------------------------------------------------------------------------
export const BRANCHES = {
  shortcut: { from: 6,  tiles: [100, 101, 102], to: 13, label: 'Shortcut', cost: 0,   icon: '↘️' },
  detour:   { from: 12, tiles: [110, 111, 112, 113], to: 16, label: 'Detour', cost: 0, icon: '↗️' },
  bridge:   { from: 20, tiles: [120, 121], to: 26, label: 'Bridge', cost: 300, icon: '🌉' }
};
const BRANCH_FROM = Object.fromEntries(Object.values(BRANCHES).map(b => [b.from, b]));
const BRANCH_LAST = Object.fromEntries(Object.values(BRANCHES).map(b => [b.tiles[b.tiles.length - 1], b]));
const TILE_BRANCH = {}; for (const [k, b] of Object.entries(BRANCHES)) for (const t of b.tiles) TILE_BRANCH[t] = k;

/** Next tile along the main road or inside a branch. */
function nextTile(idx) {
  if (idx >= 100) {
    const br = BRANCHES[TILE_BRANCH[idx]];
    const i = br.tiles.indexOf(idx);
    return i < br.tiles.length - 1 ? br.tiles[i + 1] : br.to;
  }
  return (idx + 1) % N_TILES;
}

// Positions for branch tiles: interpolated between their from/to on the
// spiral, pushed inward (shortcut, bridge) or outward (detour).
function lerpPath(fromIdx, toIdx, n, push) {
  const a = PATH[fromIdx], b = PATH[toIdx], out = {};
  const cx = 0.5, cy = 0.5;
  for (let k = 1; k <= n; k++) {
    const t = k / (n + 1);
    let x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
    // push along the vector from centre
    const dx = x - cx, dy = y - cy, len = Math.hypot(dx / 1.28, dy) || 1;
    x += (dx / len) * push * 1.28; y += (dy / len) * push;
    out[k - 1] = { x, y };
  }
  return out;
}
export const PATH_EXTRA = (() => {
  const m = {};
  const put = (br, pts) => br.tiles.forEach((id, i) => { m[id] = pts[i]; });
  put(BRANCHES.shortcut, lerpPath(6, 13, 3, -0.05));
  put(BRANCHES.detour,   lerpPath(12, 16, 4, +0.11));
  put(BRANCHES.bridge,   lerpPath(20, 26, 2, -0.04));
  return m;
})();
export function posOf(idx) { return idx >= 100 ? PATH_EXTRA[idx] : PATH[idx]; }

// Zones follow the coil: outer loop is loud and cheap, the centre is expensive.
export const ZONES = [
  { name: 'The Bar',        from: 0,  to: 7,  cls: 'z-bar',    mini: ['blindvote-wyr', 'quiz'],                           payMult: 1.0 },
  { name: 'The Courthouse', from: 8,  to: 14, cls: 'z-court',  mini: ['liars', 'quiz'],                                    payMult: 1.3 },
  { name: 'The Clinic',     from: 15, to: 21, cls: 'z-clinic', mini: ['promptvote-pick', 'charades'],                      payMult: 1.2 },
  { name: 'The Afterparty', from: 22, to: 27, cls: 'z-after',  mini: ['promptvote-type', 'blindvote-likely', 'charades'],  payMult: 1.6 }
];
export function zoneOf(i) {
  if (i >= 100) { const br = BRANCHES[TILE_BRANCH[i]]; i = br ? br.from : 0; }
  return ZONES.find(z => i >= z.from && i <= z.to) || ZONES[0];
}

/* -------------------------------- items ---------------------------------- */
export const ITEMS = {
  steal:  { name: 'Steal',  emoji: '🫳', blurb: 'Take 500 from whoever has the most.' },
  shield: { name: 'Shield', emoji: '🛡️', blurb: 'Blocks the next thing that would cost you.' },
  double: { name: 'Double', emoji: '🎲', blurb: 'Roll two dice this turn.' },
  swap:   { name: 'Swap',   emoji: '🔁', blurb: 'Trade places with whoever is furthest ahead.' },
  mug:    { name: 'Mug',    emoji: '🔪', blurb: 'Everyone else loses 250. You keep it.' }
};
const ITEM_KEYS = Object.keys(ITEMS);

/* ------------------------------- minigames ------------------------------- */
const MINIS = {
  'quiz':             { id: 'quiz',       opts: { rounds: 1 },                                        label: 'Trivia' },
  'liars':            { id: 'liars',      opts: { rounds: 1 },                                        label: "Liar's Trivia" },
  'promptvote-pick':  { id: 'promptvote', opts: { rounds: 1, mode: 'pick', judge: 'all' },             label: 'Fill In The Blank' },
  'promptvote-type':  { id: 'promptvote', opts: { rounds: 1, mode: 'type', judge: 'all' },             label: 'Write Your Own' },
  'blindvote-wyr':    { id: 'blindvote',  opts: { rounds: 1, mode: 'wyr' },                            label: 'Would You Rather' },
  'blindvote-likely': { id: 'blindvote',  opts: { rounds: 1, mode: 'likely' },                         label: 'Most Likely To' },
  'charades':         { id: 'charades',   opts: { rounds: 1, pointsPer: 60 },                          label: 'Shout It Out', solo: true }
};
// Duels are head-to-head: only games that work with exactly two.
const DUEL_MINIS = ['quiz', 'liars', 'blindvote-wyr'];

const ENGINES = {
  quiz:       () => import('./quiz.js'),
  promptvote: () => import('./promptvote.js'),
  charades:   () => import('./charades.js'),
  liars:      () => import('./liars.js'),
  blindvote:  () => import('./blindvote.js')
};

/* --------------------------------- tiles --------------------------------- */
function buildTiles() {
  const t = {};
  t[0] = { t: 'start', label: 'Start' };
  t[N_TILES - 1] = { t: 'jackpot', label: 'Jackpot' };
  const fill = (zone, mix) => {
    const idxs = [];
    for (let i = zone.from; i <= zone.to; i++) if (!t[i]) idxs.push(i);
    const m = shuffle(mix).slice(0, idxs.length);
    idxs.forEach((i, k) => { t[i] = m[k] || { t: 'rest', label: 'Nothing' }; });
  };
  fill(ZONES[0], [ { t:'mini',label:'Minigame' }, { t:'pay',label:'Found Cash',amount:400 }, { t:'item',label:'Item' },
                   { t:'loss',label:'Bar Tab',amount:400 }, { t:'mini',label:'Minigame' }, { t:'event',label:'Last Call',ev:'lastcall' },
                   { t:'event',label:'Round On You',ev:'roundonyou' } ]);
  fill(ZONES[1], [ { t:'mini',label:'Minigame' }, { t:'loss',label:'Fine',amount:600 }, { t:'event',label:'Audit',ev:'audit' },
                   { t:'item',label:'Item' }, { t:'pay',label:'Settlement',amount:700 }, { t:'loss',label:'Bail',amount:900 },
                   { t:'event',label:'Snitch',ev:'snitch' } ]);
  fill(ZONES[2], [ { t:'mini',label:'Minigame' }, { t:'pay',label:'Copay Back',amount:500 }, { t:'item',label:'Item' },
                   { t:'event',label:'Group',ev:'group' }, { t:'loss',label:'Relapse',amount:700 }, { t:'mini',label:'Minigame' },
                   { t:'event',label:'Urine Test',ev:'uatest' } ]);
  fill(ZONES[3], [ { t:'mini',label:'Minigame' }, { t:'event',label:'Flip',ev:'flip' }, { t:'item',label:'Item' },
                   { t:'pay',label:'Windfall',amount:900 }, { t:'event',label:'Blackout',ev:'blackout' }, { t:'loss',label:'Hangover',amount:500 } ]);
  // Branch tiles live in the same map under their ids.
  t[100] = { t: 'rest',  label: 'Cut Through' };
  t[101] = { t: 'loss',  label: 'Bail', amount: 900 };
  t[102] = { t: 'item',  label: 'Item' };
  t[110] = { t: 'pay',   label: 'Found Cash', amount: 300 };
  t[111] = { t: 'pay',   label: 'Scratch-Off', amount: 500 };
  t[112] = { t: 'item',  label: 'Item' };
  t[113] = { t: 'event', label: 'Sent Back', ev: 'sentback' };
  t[120] = { t: 'event', label: 'Toll', ev: 'toll' };
  t[121] = { t: 'mini',  label: 'Minigame' };
  return t;
}

// Landing on the centre doesn't wrap you to Start: the spiral keeps going.
// Positions are modulo N_TILES, so passing the Jackpot drops you back at the
// top of the outer loop — one full lap of the spiral.

/* ---------------------------------- host --------------------------------- */
export class Host {
  constructor(room, opts = {}) {
    this.room = room;
    this.maxTurns = opts.rounds || meta.defaultRounds;
    this.timer = null;
    this.mini = null;
    this._busy = false;
  }
  get base() { return this.room.base; }
  async load() { this.tiles = buildTiles(); return this; }
  async read() { return this.room.t.get(`${this.base}/board`); }
  async patch(p) { return this.room.t.update(`${this.base}/board`, p); }

  async begin() {
    await this.room.setGame('board');
    await this.room.setPhase('playing');
    await this.room.setRound(null);
    await this.room.t.remove(`${this.base}/mini`);
    await this.room.clearRoundData();

    const order = playerList(await this.room.players())
      .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0)).map(p => p.id);
    const positions = {}, items = {}, shields = {};
    for (const pid of order) { positions[pid] = 0; items[pid] = []; }

    await this.room.t.set(`${this.base}/board`, {
      phase: 'turn', tiles: this.tiles, positions, items, shields, order,
      turn: 0, turnNo: 1, maxTurns: this.maxTurns, active: order[0] || null,
      pot: 0, message: null, lastRoll: null, lastRoll2: null, doubled: false, log: []
    });
  }

  async log(b, text) {
    const log = (b.log || []).slice(-7); log.push(text);
    return log;
  }

  async onPlayers(players) {
    if (this.mini) return this.mini.engine.onPlayers?.(players);
    const b = await this.read(); if (!b || b.phase === 'final') return;
    const ids = Object.keys(players || {});
    const order = (b.order || []).filter(id => ids.includes(id));
    const positions = { ...(b.positions || {}) }, items = { ...(b.items || {}) };
    for (const id of ids) {
      if (!order.includes(id)) { order.push(id); positions[id] = positions[id] || 0; items[id] = items[id] || []; }
    }
    if (!order.length) return;
    const p = { order, positions, items };
    if (!order.includes(b.active)) { p.turn = b.turn % order.length; p.active = order[p.turn]; p.phase = 'turn'; }
    await this.patch(p);
  }

  /* -------------------------------- turn --------------------------------- */

  async useItem(pid, key) {
    if (this._busy) return;
    const b = await this.read();
    if (!b || b.phase !== 'turn' || b.active !== pid) return;
    const held = (b.items || {})[pid] || [];
    const at = held.indexOf(key);
    if (at < 0 || !ITEMS[key]) return;
    this._busy = true;
    try {
      const players = await this.room.players();
      const who = players[pid] || { name: '?' };
      const items = { ...b.items, [pid]: held.filter((_, i) => i !== at) };
      let message = null; const patch = { items };

      if (key === 'steal') {
        const target = sortedPlayers(players).find(p => p.id !== pid);
        if (target) {
          const took = await this.charge(target.id, 500, b);     // respects their shield
          if (took) { await this.room.addScore(pid, took); message = `${who.name} steals ${took} from ${target.name}`; }
          else message = `${who.name} tries to steal from ${target.name} — blocked by a Shield`;
        }
      } else if (key === 'shield') {
        patch.shields = { ...(b.shields || {}), [pid]: true };
        message = `${who.name} raises a Shield`;
      } else if (key === 'double') {
        patch.doubled = true;
        message = `${who.name} will roll two dice`;
      } else if (key === 'swap') {
        const far = (b.order || []).filter(id => id !== pid).sort((x, y) => (b.positions[y] || 0) - (b.positions[x] || 0))[0];
        if (far) {
          patch.positions = { ...b.positions, [pid]: b.positions[far] || 0, [far]: b.positions[pid] || 0 };
          message = `${who.name} swaps places with ${players[far]?.name || 'someone'}`;
        }
      } else if (key === 'mug') {
        let total = 0;
        for (const id of (b.order || [])) if (id !== pid) total += await this.charge(id, 250, b);
        if (total) await this.room.addScore(pid, total);
        message = `${who.name} mugs the table for ${total}`;
        if (total >= 500) await highlight(this.room, pid, `mugged the whole table for ${total}`, 3);
      }
      if (message) patch.log = await this.log(b, message);
      patch.message = message; patch.itemFlash = Date.now();
      // Shields consumed by charge() need writing back; charge() tracks on b.
      if (b._shieldPatch) patch.shields = { ...(patch.shields || b.shields || {}), ...b._shieldPatch };
      await this.patch(patch);
    } finally { this._busy = false; }
  }

  /** Take points from a player, honouring a Shield. Returns the amount actually taken. */
  async charge(pid, amount, b) {
    const shields = b._shieldPatch ? { ...(b.shields || {}), ...b._shieldPatch } : (b.shields || {});
    if (shields[pid]) {
      b._shieldPatch = { ...(b._shieldPatch || {}), [pid]: false };
      return 0;
    }
    const cur = (await this.room.t.get(`${this.base}/players/${pid}/score`)) || 0;
    const take = Math.max(0, Math.min(amount, cur));      // can't go below zero
    if (take) await this.room.addScore(pid, -take);
    return take;
  }

  async roll(pid) {
    if (this._busy) return;
    const b = await this.read();
    if (!b || b.phase !== 'turn' || b.active !== pid) return;
    this._busy = true;
    try {
      const d1 = 1 + Math.floor(Math.random() * 6);
      const d2 = b.doubled ? 1 + Math.floor(Math.random() * 6) : 0;
      await this.patch({ phase: 'moving', lastRoll: d1, lastRoll2: d2 || null, doubled: false,
                         stepsLeft: d1 + d2, message: null, forkChoice: null });
      await new Promise(r => setTimeout(r, d2 ? DICE_MS + 900 : DICE_MS));   // let the dice land everywhere first
      await this.walk(pid, d1 + d2);
    } finally { this._busy = false; }
  }

  /**
   * Move one tile per beat so the table can watch. At a fork, stop and wait
   * for the mover to choose on their phone. Lap bonus when crossing Start.
   */
  async walk(pid, steps) {
    let passedStart = false;
    for (let k = 0; k < steps; k++) {
      const b = await this.read(); if (!b || b.phase !== 'moving') return;
      const cur = b.positions[pid] || 0;

      // Fork: standing on a branch mouth with at least one step still to go.
      const br = BRANCH_FROM[cur];
      if (br) {
        if (br.cost && ((await this.room.t.get(`${this.base}/players/${pid}/score`)) || 0) < br.cost) {
          // can't afford the bridge: no choice offered
        } else {
          await this.patch({ phase: 'fork', fork: { key: Object.keys(BRANCHES).find(x => BRANCHES[x] === br), label: br.label, cost: br.cost, icon: br.icon, stepsLeft: steps - k }, stepsLeft: steps - k });
          const choice = await this.awaitFork(pid);
          const b2 = await this.read(); if (!b2) return;
          if (choice === 'branch') {
            if (br.cost) { await this.charge(pid, br.cost, b2); await this.patch({ pot: (b2.pot || 0) + br.cost }); }
            await this.patch({ phase: 'moving', fork: null, positions: { ...b2.positions, [pid]: br.tiles[0] }, stepsLeft: steps - k - 1 });
            await new Promise(r => setTimeout(r, STEP_MS));
            continue;
          }
          await this.patch({ phase: 'moving', fork: null });
        }
      }

      const next = nextTile(cur);
      if (next === 0 && cur !== 0) passedStart = true;
      const b3 = await this.read(); if (!b3) return;
      await this.patch({ positions: { ...b3.positions, [pid]: next }, stepsLeft: steps - k - 1 });
      if (next === 0 && passedStart) { await this.room.addScore(pid, LAP_BONUS); }
      await new Promise(r => setTimeout(r, STEP_MS));
    }
    // Landed. Let it sit so everyone sees where, then resolve.
    await this.patch({ phase: 'landed' });
    await new Promise(r => setTimeout(r, LAND_MS));
    const bl = await this.read(); if (!bl) return;
    await this.resolve(bl.positions[pid], passedStart);
  }

  /** Wait for the mover's fork pick (or time out to the main road). */
  awaitFork(pid) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (done) return; done = true; clearTimeout(t); unsub(); resolve(v); };
      const unsub = this.room.on('forkChoice', v => { if (v && v.by === pid) finish(v.choice); });
      const t = setTimeout(() => finish('main'), FORK_MS);
    });
  }

  async onIntent(intent) {
    if (!intent) return;
    if (intent.action === 'roll')    return this.roll(intent.by);
    if (intent.action === 'useitem') return this.useItem(intent.by, intent.item);
    if (intent.action === 'fork')    return this.room.t.set(`${this.base}/forkChoice`, { by: intent.by, choice: intent.choice, at: Date.now() });
  }

  async resolve(idx, passedStart) {
    const b = await this.read(); if (!b) return;
    const players = await this.room.players();
    const who = players[b.active] || { name: 'Someone' };
    const lap = passedStart ? ` (+${LAP_BONUS} for the lap)` : '';
    const zone = zoneOf(idx);
    let tile = b.tiles[idx];
    const endgame = b.turnNo >= b.maxTurns - 1;            // last two turns: stakes double

    // Duel: someone else is already here.
    const others = (b.order || []).filter(id => id !== b.active && (b.positions[id] || 0) === idx);
    if (others.length && tile.t !== 'start') {
      const opp = others[Math.floor(Math.random() * others.length)];
      return this.startDuel(b, b.active, opp, who, players[opp]);
    }

    let message = null; const patch = {}; let shieldPatch = null;
    const pay = Math.round((tile.amount || 0) * zone.payMult * (endgame ? 2 : 1));
    const stakes = endgame ? ' (double stakes)' : '';

    switch (tile.t) {
      case 'start':  message = `${who.name} lands on Start${lap}`; break;
      case 'pay':    await this.room.addScore(b.active, pay); message = `${who.name} collects ${pay}${stakes}${lap}`; break;
      case 'loss': {
        const took = await this.charge(b.active, pay, b);
        if (took) { patch.pot = (b.pot || 0) + took; message = `${who.name} loses ${took} to the pot${stakes}${lap}`; }
        else message = `${who.name}'s Shield eats the ${tile.label}${lap}`;
        break;
      }
      case 'item': {
        const held = (b.items || {})[b.active] || [];
        if (held.length >= MAX_ITEMS) message = `${who.name} finds an item but has no room${lap}`;
        else {
          const k = ITEM_KEYS[Math.floor(Math.random() * ITEM_KEYS.length)];
          patch.items = { ...b.items, [b.active]: [...held, k] };
          message = `${who.name} picks up ${ITEMS[k].emoji} ${ITEMS[k].name}${lap}`;
        }
        break;
      }
      case 'jackpot': {
        const pot = b.pot || 0;
        if (pot) { await this.room.addScore(b.active, pot); patch.pot = 0; message = `${who.name} hits the Jackpot: ${pot}${lap}`; if (pot >= 1500) await highlight(this.room, b.active, `hit a ${pot} Jackpot`, 4); }
        else message = `${who.name} hits an empty Jackpot${lap}`;
        break;
      }
      case 'event':  message = await this.event(tile.ev, b, who, players, patch); break;
      case 'mini':   return this.startMini(zone, who, b.active);
      default:       message = `${who.name} lands on nothing${lap}`;
    }
    if (b._shieldPatch) patch.shields = { ...(b.shields || {}), ...b._shieldPatch };
    patch.phase = 'resolve'; patch.message = message; patch.log = await this.log(b, message);
    await this.patch(patch);
    this.timer = setTimeout(() => this.nextTurn(), RESOLVE_MS);
  }

  /** Table-wide events. Return the message; mutate `patch` for board changes. */
  async event(ev, b, who, players, patch) {
    const ranked = sortedPlayers(players);
    if (ev === 'audit') {
      const low = ranked[ranked.length - 1];
      if (low) { const took = await this.charge(low.id, 300, b); patch.pot = (b.pot || 0) + took; return `Audit: ${low.name} is lowest and loses ${took}`; }
    }
    if (ev === 'lastcall') {
      for (const p of ranked) { const took = await this.charge(p.id, 150, b); patch.pot = (patch.pot ?? b.pot ?? 0) + took; }
      return `Last Call: everyone pays 150 into the pot`;
    }
    if (ev === 'group') {
      // Group therapy: everyone shares. Pot is split evenly.
      const pot = b.pot || 0, n = ranked.length;
      if (pot && n) { const each = Math.floor(pot / n); for (const p of ranked) await this.room.addScore(p.id, each); patch.pot = pot - each * n; return `Group: the pot (${pot}) is split ${each} each`; }
      return `Group: nothing in the pot to share`;
    }
    if (ev === 'roundonyou') {
      // You buy the round: pay 150 to every other player.
      let paid = 0;
      for (const p of ranked) if (p.id !== b.active) { const took = await this.charge(b.active, 150, b); if (took) { await this.room.addScore(p.id, took); paid += took; } }
      return `${who.name} buys a round: ${paid} spread across the table`;
    }
    if (ev === 'snitch') {
      // Name someone: the player directly ahead of you in score loses 400 to you.
      const me = ranked.findIndex(p => p.id === b.active);
      const target = me > 0 ? ranked[me - 1] : null;
      if (target) { const took = await this.charge(target.id, 400, b); await this.room.addScore(b.active, took); return `${who.name} snitches on ${target.name} and takes ${took}`; }
      return `${who.name} has nobody above them to snitch on`;
    }
    if (ev === 'uatest') {
      // Random: clean = +400, dirty = -400 and you lose your items.
      if (Math.random() < 0.55) { await this.room.addScore(b.active, 400); return `${who.name} pisses clean: +400`; }
      const took = await this.charge(b.active, 400, b); patch.pot = (b.pot || 0) + took;
      patch.items = { ...(b.items || {}), [b.active]: [] };
      return `${who.name} pisses dirty: −${took} and your items are confiscated`;
    }
    if (ev === 'blackout') {
      // Everyone's tokens scatter: each player moves back 1-4 tiles.
      const positions = { ...b.positions };
      for (const id of (b.order || [])) { const p0 = positions[id] || 0; positions[id] = p0 >= 100 ? BRANCHES[TILE_BRANCH[p0]].from : ((p0 - (1 + Math.floor(Math.random() * 4)) + N_TILES) % N_TILES); }
      patch.positions = positions;
      return `Blackout: nobody remembers how they got here. Everyone stumbles back.`;
    }
    if (ev === 'sentback') {
      if ((b.shields || {})[b.active]) { b._shieldPatch = { ...(b._shieldPatch || {}), [b.active]: false }; return `${who.name}'s Shield blocks Sent Back`; }
      patch.positions = { ...b.positions, [b.active]: 0 };
      return `${who.name} gets Sent Back to Start`;
    }
    if (ev === 'toll') {
      return `${who.name} paid the toll and crosses the bridge`;
    }
    if (ev === 'flip') {
      // Reverse the standings. Brutal, rare.
      const scores = ranked.map(p => p.score || 0);
      for (let i = 0; i < ranked.length; i++) await this.room.t.set(`${this.base}/players/${ranked[i].id}/score`, scores[ranked.length - 1 - i]);
      return `Flip: the standings reverse`;
    }
    return `${who.name} triggers nothing`;
  }

  /* ------------------------------ minigames ------------------------------ */

  async startMini(zone, who, activeId) {
    const key = zone.mini[Math.floor(Math.random() * zone.mini.length)];
    return this.launchMini(key, { trigger: who.name, activeId, label: `${who.name} hits ${MINIS[key].label} in ${zone.name}` });
  }

  async startDuel(b, a, c, whoA, whoC) {
    const key = DUEL_MINIS[Math.floor(Math.random() * DUEL_MINIS.length)];
    // Both ante into a duel pot; the winner of the one-round game takes it.
    await this.charge(a, DUEL_POT / 2, b); await this.charge(c, DUEL_POT / 2, b);
    const patch = { duelPot: DUEL_POT, message: `DUEL: ${whoA.name} vs ${whoC?.name || '?'}` };
    if (b._shieldPatch) patch.shields = { ...(b.shields || {}), ...b._shieldPatch };
    await this.patch(patch);
    return this.launchMini(key, { duel: [a, c], activeId: a, label: `Duel: ${whoA.name} vs ${whoC?.name || '?'} — ${MINIS[key].label}` });
  }

  async launchMini(key, { duel, activeId, label }) {
    const spec = MINIS[key];
    const mod = await ENGINES[spec.id]();
    const opts = { ...spec.opts, nested: true };
    if (spec.solo) opts.only = [activeId];
    if (duel) opts.only = duel;                       // engines with `only` scope to these players
    const engine = new mod.Host(this.room, opts);
    await engine.load();
    engine.onFinish = () => this.endMini(duel);
    this.mini = { mod, engine, id: spec.id, key, duel };
    registerMiniMod(mod);
    await this.room.t.set(`${this.base}/mini`, { id: spec.id, label, duel: duel || null });
    await this.patch({ phase: 'minigame', message: label, scoresAtMini: await this.snapshotScores() });
    await engine.begin();
  }

  async snapshotScores() {
    const p = await this.room.players(); const out = {};
    for (const [id, v] of Object.entries(p)) out[id] = v.score || 0;
    return out;
  }

  async endMini(duel) {
    this.mini?.engine?.stop?.();
    this.mini = null;
    const b = await this.read();
    if (duel && b) {
      // Winner = whoever gained more during the minigame. Tie: split.
      const now = await this.snapshotScores(); const was = b.scoresAtMini || {};
      const [a, c] = duel;
      const ga = (now[a] || 0) - (was[a] || 0), gc = (now[c] || 0) - (was[c] || 0);
      const pot = b.duelPot || 0;
      const players = await this.room.players();
      let msg;
      if (ga === gc) { await this.room.addScore(a, pot / 2); await this.room.addScore(c, pot / 2); msg = `Duel drawn. Pot split.`; }
      else { const w = ga > gc ? a : c; const l = w === a ? c : a; await this.room.addScore(w, pot); msg = `${players[w]?.name || '?'} wins the duel and ${pot}`; await highlight(this.room, w, `beat ${players[l]?.name || '?'} in a duel`, 3); }
      await this.patch({ duelPot: 0, message: msg, log: await this.log(b, msg) });
    }
    await this.room.t.remove(`${this.base}/mini`);
    await this.room.setRound(null);
    await this.room.clearRoundData();
    await this.room.t.remove(`${this.base}/hands`);
    await this.patch({ phase: 'resolve' });
    this.timer = setTimeout(() => this.nextTurn(), duel ? RESOLVE_MS : 1200);
  }

  /* ------------------------------- plumbing ------------------------------ */

  async nextTurn() {
    clearTimeout(this.timer);
    const b = await this.read(); if (!b) return;
    if (b.turnNo >= b.maxTurns) return this.finish();
    const order = b.order || []; if (!order.length) return this.finish();
    const turn = (b.turn + 1) % order.length;
    await this.room.t.remove(`${this.base}/forkChoice`);
    await this.patch({ phase: 'turn', turn, turnNo: b.turnNo + 1, active: order[turn], message: null, lastRoll: null, lastRoll2: null, doubled: false, fork: null, stepsLeft: null });
  }

  async finish() {
    clearTimeout(this.timer);
    const b = await this.read();
    // Leftover pot goes to the leader, so it isn't dead money.
    if (b && b.pot) { const lead = sortedPlayers(await this.room.players())[0]; if (lead) await this.room.addScore(lead.id, b.pot); }
    await this.patch({ phase: 'final', pot: 0, message: null });
    await this.room.setRound({ phase: 'final' });
    await this.room.setPhase('scoreboard');
  }

  onSubmissions(s, p) { return this.mini?.engine?.onSubmissions?.(s, p); }
  onVotes(v, p)       { return this.mini?.engine?.onVotes?.(v, p); }
  charadesResolve(r)  { return this.mini?.engine?.resolve?.(r); }
  nudge(k, pid)       { return this.mini?.engine?.nudge?.(k, pid); }
  async resume() {
    const b = await this.read(); if (!b) return;
    if (b.phase === 'resolve') this.timer = setTimeout(() => this.nextTurn(), 1500);
    if (/^(moving|fork|landed)$/.test(b.phase) && b.active) {
      // The previous director died mid-walk. Finish the move where the token stands.
      await this.room.t.remove(`${this.base}/forkChoice`);
      await this.patch({ phase: 'landed', fork: null, stepsLeft: 0 });
      this.timer = setTimeout(() => this.resolve(b.positions?.[b.active] || 0, false), LAND_MS);
    }
    const mini = await this.room.t.get(`${this.base}/mini`);
    if (mini && mini.id && !this.mini) {
      const key = Object.keys(MINIS).find(k => MINIS[k].id === mini.id) || mini.id;
      const spec = MINIS[key] || { id: mini.id, opts: { rounds: 1 } };
      const mod = await ENGINES[spec.id](); const engine = new mod.Host(this.room, { ...spec.opts, nested: true, only: mini.duel || undefined });
      await engine.load(); engine.onFinish = () => this.endMini(mini.duel);
      this.mini = { mod, engine, id: spec.id, key, duel: mini.duel }; registerMiniMod(mod);
      if (engine.resume) await engine.resume();
    }
  }
  stop() { clearTimeout(this.timer); this.mini?.engine?.stop?.(); this.mini = null; }
}

/* ------------------------------ live maps ------------------------------- */
const miniMods = new Set();
export function registerMiniMod(m) { if (m) miniMods.add(m); }
export function setSubmissions(s) { miniMods.forEach(m => m.setSubmissions?.(s)); }
export function setVotes(v) { miniMods.forEach(m => m.setVotes?.(v)); }

/* --------------------------------- views --------------------------------- */

const TILE_ICON = { mini: '🎲', pay: '💸', loss: '💀', item: '🎁', event: '⚡', jackpot: '💰', rest: '·', start: '🏁' };

export function hostView(board, players, round, miniMod) {
  if (!board) return '<div class="big">Setting up the board…</div>';
  if (board.phase === 'minigame' && miniMod && round) {
    // A duel's round carries `only` (the two combatants); that's the reliable signal.
    const isDuel = Array.isArray(round.only) && round.only.length === 2;
    return `<div class="miniwrap">
      <div class="minibadge ${isDuel ? 'duel' : ''}">${esc(board.message || 'Minigame')}</div>
      ${miniMod.hostView(round, players)}
    </div>`;
  }
  if (board.phase === 'final') return finalScoreboard(players, 'Final scores');

  const tiles = Object.entries(board.tiles || {}).map(([k, t]) => {
    const i = Number(k);
    const p = posOf(i) || { x: .5, y: .5, ang: 0 }; const z = zoneOf(i);
    const isBranch = i >= 100, brKey = isBranch ? TILE_BRANCH[i] : null;
    const baseT = isBranch ? (PATH[BRANCHES[brKey].from].t) : p.t;
    const size = ((1 - baseT * 0.22) * (isBranch ? 0.82 : 1)).toFixed(3);   // smaller toward the centre; branches smaller still
    const isCentre = i === N_TILES - 1;
    const fork = BRANCH_FROM[i];
    return `<div class="tile t-${t.t} ${z.cls} ${isCentre ? 'centre' : ''} ${isBranch ? `branch b-${brKey}` : ''} ${fork ? 'mouth' : ''}" data-tile="${i}"
                 style="--x:${(p.x * 100).toFixed(2)}%;--y:${(p.y * 100).toFixed(2)}%;--rot:0deg;--sz:${isCentre ? 1.35 : size}">
      <div class="tface">
        <span class="ticon">${TILE_ICON[t.t] || ''}</span>
        <span class="tlabel">${esc(t.label)}</span>
        ${t.amount ? `<span class="tamt">${t.t === 'loss' ? '−' : '+'}${Math.round(t.amount * z.payMult)}</span>` : ''}
      </div><div class="tside"></div>
      ${fork ? `<span class="forkbadge" title="${esc(fork.label)}">${fork.icon}</span>` : ''}
    </div>`;
  }).join('');
  // The road: the spiral through the tile centres, plus a dashed lane per branch.
  const pt = q => `${(q.x * 1000).toFixed(1)},${(q.y * 1000).toFixed(1)}`;
  const d = PATH.map((q, i) => `${i ? 'L' : 'M'}${pt(q)}`).join(' ');
  const lanes = Object.entries(BRANCHES).map(([k, b]) => {
    const pts = [PATH[b.from], ...b.tiles.map(id => PATH_EXTRA[id]), PATH[b.to]];
    return `<path class="lane lane-${k}" d="${pts.map((q, i) => `${i ? 'L' : 'M'}${pt(q)}`).join(' ')}"/>`;
  }).join('');
  const road = `<svg class="road" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/>${lanes}</svg>`;
  const laneLabels = Object.entries(BRANCHES).map(([k, b]) => {
    const mid = PATH_EXTRA[b.tiles[Math.floor((b.tiles.length - 1) / 2)]];
    const off = k === 'detour' ? 0.055 : -0.05;
    return `<div class="lanelabel b-${k}" style="--x:${(mid.x*100).toFixed(1)}%;--y:${((mid.y + off)*100).toFixed(1)}%">${b.icon} ${esc(b.label)}${b.cost ? ` · ${b.cost}` : ''}</div>`;
  }).join('');
  const zoneLabels = ZONES.map(z => {
    const mid = PATH[Math.floor((z.from + z.to) / 2)];
    // Push the label outward from the spiral so it sits beside its arc.
    const ox = mid.x + Math.cos(mid.ang) * 0.10 * 1.28, oy = mid.y + Math.sin(mid.ang) * 0.10;
    return `<div class="zlabel ${z.cls}" data-zone="${z.cls}" style="--x:${(ox*100).toFixed(1)}%;--y:${(oy*100).toFixed(1)}%">${esc(z.name)}</div>`;
  }).join('');

  return `
    <div class="bscene">
      <div class="btable" data-table>
        <div class="boardgrid spiral" data-board>
          ${road}${tiles}${zoneLabels}${laneLabels}
          <div class="bcentre" data-centre></div>
          <div class="tokenlayer" data-tokens></div>
        </div>
      </div>
    </div>
    <div class="bstrip">
      <div class="bpot" data-pot>Pot <b>0</b></div>
      <div class="bscores" data-bscores></div>
      <div class="blog" data-log></div>
    </div>`;
}

export function patchBoard(stage, board, players, fx) {
  const grid = stage.querySelector('[data-board]'); if (!grid || !board) return;
  const byId = Object.fromEntries(playerList(players).map(p => [p.id, p]));
  const order = board.order || [], positions = board.positions || {};
  const layer = grid.querySelector('[data-tokens]');
  const gr = grid.getBoundingClientRect();
  // Tokens use the SAME fractional coordinates as the tiles, so they sit on
  // them exactly regardless of the table's 3D transform.
  const centre = idx => { const p = posOf(idx) || { x: .5, y: .5 }; return { x: p.x * 100, y: p.y * 100 }; };
  const walking = board.phase === 'moving' || board.phase === 'fork';
  grid.classList.toggle('walking', walking);

  const onTile = {}; for (const pid of order) { const i = positions[pid] || 0; (onTile[i] = onTile[i] || []).push(pid); }
  for (const pid of order) {
    let tok = layer.querySelector(`[data-token="${pid}"]`);
    if (!tok) { tok = document.createElement('div'); tok.className = 'ptoken'; tok.dataset.token = pid;
      tok.innerHTML = `<span class="pt-emoji">${byId[pid]?.emoji || '🎲'}</span><span class="pt-base"></span><span class="pt-items"></span>`; layer.appendChild(tok); }
    const i = positions[pid] || 0, g = onTile[i], k = g.indexOf(pid);
    const spread = g.length > 1 ? (k - (g.length - 1) / 2) * 1.6 : 0;      // percent of board width
    const { x, y } = centre(i);
    const prev = tok.dataset.at;
    tok.style.left = `${x + spread}%`; tok.style.top = `${y}%`; tok.style.transform = '';
    tok.classList.toggle('active', pid === board.active);
    tok.classList.toggle('shielded', Boolean((board.shields || {})[pid]));
    const held = (board.items || {})[pid] || [];
    tok.querySelector('.pt-items').textContent = held.map(k2 => ITEMS[k2]?.emoji || '').join('');
    if (prev !== undefined && prev !== String(i)) { tok.classList.remove('hop'); void tok.offsetWidth; tok.classList.add('hop'); if (fx && pid === board.active && walking) fx.sound.tick(); }
    tok.dataset.at = i;
  }
  layer.querySelectorAll('[data-token]').forEach(n => { if (!order.includes(n.dataset.token)) n.remove(); });

  // Camera: tilt toward the active token's zone.
  const table = stage.querySelector('[data-table]');
  if (table) {
    const ai = positions[board.active] || 0, z = zoneOf(ai);
    table.dataset.focus = z.cls;
    const { x, y } = centre(ai);
    const pan  = ((x / 100) - 0.5) * -5;    // yaw toward the token
    const tilt = ((y / 100) - 0.5) * 6;     // lean in as it heads to the centre
    table.style.setProperty('--pan', `${pan.toFixed(2)}deg`);
    table.style.setProperty('--tilt', `${tilt.toFixed(2)}deg`);
    // Zoom in a touch as the token nears the centre.
    const tAi = ai >= 100 ? PATH[BRANCHES[TILE_BRANCH[ai]].from].t : (PATH[ai] ? PATH[ai].t : 0);
    const zoom = 1 + tAi * 0.08;
    table.style.setProperty('--zoom', zoom.toFixed(3));
  }

  grid.querySelectorAll('.tile.lit').forEach(n => n.classList.remove('lit'));
  if (/^(resolve|moving|landed|fork)$/.test(board.phase)) { const t = grid.querySelector(`[data-tile="${positions[board.active] || 0}"]`); if (t) t.classList.add('lit'); }
  grid.querySelectorAll('.tile.offer').forEach(n => n.classList.remove('offer'));
  if (board.phase === 'fork' && board.fork) { const b = BRANCHES[board.fork.key]; if (b) b.tiles.forEach(id => grid.querySelector(`[data-tile="${id}"]`)?.classList.add('offer')); }
  grid.querySelectorAll('.zlabel').forEach(n => n.classList.toggle('on', n.dataset.zone === zoneOf(positions[board.active] || 0).cls));

  // Centre panel
  const who = byId[board.active] || {};
  const c = grid.querySelector('[data-centre]');
  let html;
  if (board.phase === 'turn') {
    const held = (board.items || {})[board.active] || [];
    const endgame = board.turnNo >= board.maxTurns - 1;
    html = `<div class="bturn ${endgame ? 'hot' : ''}">${board.turnNo >= board.maxTurns ? 'FINAL TURN · double stakes' : endgame ? `Turn ${board.turnNo} of ${board.maxTurns} · double stakes` : `Turn ${board.turnNo} of ${board.maxTurns}`}</div>
      <div class="bname">${who.emoji || '🎲'} ${esc(who.name || '')}</div>
      <div class="bhint">${held.length ? `Holding ${held.map(k2 => ITEMS[k2]?.emoji || '').join(' ')} — use one or roll` : 'Roll on your phone'}</div>`;
  } else if (board.phase === 'moving') {
    const left = board.stepsLeft ?? 0;
    html = `<div class="bdie">${board.lastRoll || ''}${board.lastRoll2 ? ` + ${board.lastRoll2}` : ''}</div>
      <div class="bname small">${who.emoji || '🎲'} ${esc(who.name || '')}</div>
      <div class="bsteps">${left > 0 ? `<b>${left}</b> ${left === 1 ? 'step' : 'steps'} to go` : 'Landing…'}</div>`;
  } else if (board.phase === 'fork') {
    const f = board.fork || {};
    html = `<div class="bdie">${board.lastRoll || ''}${board.lastRoll2 ? ` + ${board.lastRoll2}` : ''}</div>
      <div class="bname small">${who.emoji || '🎲'} ${esc(who.name || '')}</div>
      <div class="bfork">${f.icon || '↔️'} <b>${esc(f.label || 'Fork')}</b>${f.cost ? ` · costs ${f.cost}` : ''}</div>
      <div class="bhint">Choosing a path on their phone…</div>`;
  } else if (board.phase === 'landed') {
    const t = (board.tiles || {})[positions[board.active] || 0] || {};
    html = `<div class="bdie">${board.lastRoll || ''}${board.lastRoll2 ? ` + ${board.lastRoll2}` : ''}</div>
      <div class="bmsg">${TILE_ICON[t.t] || ''} ${esc(t.label || '')}</div>
      <div class="bhint">${esc(who.name || '')} lands here</div>`;
  } else {
    const kind = /collects|Jackpot|steals|wins the duel|split/.test(board.message || '') ? 'good' : /loses|pays|Audit|mugs|Flip/.test(board.message || '') ? 'bad' : '';
    html = `${board.lastRoll ? `<div class="bdie">${board.lastRoll}${board.lastRoll2 ? ` + ${board.lastRoll2}` : ''}</div>` : ''}<div class="bmsg ${kind}">${esc(board.message || '…')}</div>`;
  }
  const key = `${board.phase}|${board.turnNo}|${board.message || ''}|${board.itemFlash || ''}|${board.phase === 'moving' ? board.stepsLeft : ''}`;
  if (c.dataset.key !== key) {
    c.dataset.key = key; c.classList.remove('pop'); c.innerHTML = html; void c.offsetWidth; c.classList.add('pop');
    if (fx && board.phase === 'landed') fx.sound.land();
    if (fx && board.phase === 'fork') fx.sound.reveal();
    if (fx && (board.phase === 'resolve' || board.itemFlash)) {
      const m = board.message || '';
      if (/collects|Jackpot|wins the duel/.test(m)) fx.sound.coin();
      else if (/loses|pays|Audit|mugs|Flip/.test(m)) fx.sound.loss();
      else if (/steals|Shield|swaps|Double|mugs/.test(m)) fx.sound.reveal();
    }
  }

  // Pot, scores, log
  const potEl = stage.querySelector('[data-pot] b'); if (potEl && fx) fx.countUp(potEl, board.pot || 0); else if (potEl) potEl.textContent = board.pot || 0;
  const sc = stage.querySelector('[data-bscores]');
  if (sc) {
    const sorted = sortedPlayers(players);
    for (const p of sorted) {
      let chip = sc.querySelector(`[data-chip="${p.id}"]`);
      if (!chip) { chip = document.createElement('span'); chip.className = 'bchip'; chip.dataset.chip = p.id;
        chip.innerHTML = `<span>${p.emoji || '🎲'}</span>${esc(p.name)}<i class="citems"></i><b>0</b>`; sc.appendChild(chip); }
      chip.classList.toggle('active', p.id === board.active);
      chip.querySelector('.citems').textContent = ((board.items || {})[p.id] || []).map(k2 => ITEMS[k2]?.emoji || '').join('') + (((board.shields || {})[p.id]) ? '🛡️' : '');
      const b = chip.querySelector('b'); if (fx) fx.countUp(b, p.score || 0); else b.textContent = p.score || 0;
    }
    sorted.forEach(p => { const ch = sc.querySelector(`[data-chip="${p.id}"]`); if (ch) sc.appendChild(ch); });
  }
  const log = stage.querySelector('[data-log]');
  if (log) { const lines = (board.log || []).slice(-4).reverse(); const h = lines.map(l => `<div>${esc(l)}</div>`).join(''); if (log.innerHTML !== h) log.innerHTML = h; }
}

export function playerView(board, me, round, miniMod, hand, submitted, voted, draft, extra = {}) {
  if (!board) return `<div class="pcard"><h2>Setting up</h2></div>`;

  if (board.phase === 'minigame' && miniMod && round) {
    const duel = extra.duel;
    if (duel && !duel.includes(me.id)) {
      return `<div class="pcard"><h2>Duel</h2><p>${esc(board.message || '')}</p><p class="phint">Sit back. This one's not yours.</p></div>`;
    }
    const ex = { mirror: extra.mirror, players: extra.players, mulliganed: extra.mulliganed };
    if (miniMod.meta?.id === 'promptvote') return miniMod.playerView(round, me, hand, submitted, voted, draft, ex);
    if (miniMod.meta?.id === 'charades') return miniMod.playerView(round, me, null, null, null, ex);
    return miniMod.playerView(round, me, submitted, voted, extra.players, ex);
  }
  if (board.phase === 'final') return `<div class="pcard"><h2>Game over</h2><p>Check the big screen.</p></div>`;

  const isMe = board.active === me.id;
  const held = (board.items || {})[me.id] || [];
  const itemsHTML = held.length ? `<div class="items">${held.map(k => `
      <button class="itembtn" data-action="useitem" data-item="${k}" ${isMe && board.phase === 'turn' ? '' : 'disabled'}>
        <span class="iemoji">${ITEMS[k].emoji}</span><b>${ITEMS[k].name}</b><span class="iblurb">${ITEMS[k].blurb}</span>
      </button>`).join('')}</div>` : '';

  const whoName = (extra.players || {})[board.active]?.name || 'They';
  if (!isMe) {
    let line = board.message || 'Somebody else is busy ruining their run.';
    if (board.phase === 'moving') line = `${whoName} rolled ${board.lastRoll || ''}${board.lastRoll2 ? ` + ${board.lastRoll2}` : ''} and is on the move.`;
    else if (board.phase === 'fork') line = `${whoName} is choosing a path: ${board.fork?.icon || ''} ${board.fork?.label || ''} or the main road.`;
    else if (board.phase === 'landed') { const t = (board.tiles || {})[(board.positions || {})[board.active] || 0] || {}; line = `${whoName} landed on ${t.label || '…'}.`; }
    return `<div class="pcard">
      <h2>${board.phase === 'turn' ? 'Not your turn' : esc(whoName) + (board.phase === 'fork' ? ' is choosing' : ' is moving')}</h2>
      <p>${esc(line)}</p>
      ${held.length ? `<p class="phint small">You're holding:</p>${itemsHTML}` : ''}
      ${board.pot ? `<p class="phint">Pot: <b>${board.pot}</b></p>` : ''}
    </div>`;
  }
  if (board.phase === 'turn') {
    return `<div class="pcard tall dicecard">
      <div class="diehost" data-die></div>
      ${held.length ? `<p class="phint small">Use an item first, or just roll.</p>${itemsHTML}` : ''}
      <button class="hugebtn roll" data-action="roll">ROLL${board.doubled ? ' ×2' : ''}</button>
    </div>`;
  }
  if (board.phase === 'fork' && board.fork) {
    const f = board.fork, b = BRANCHES[f.key] || {};
    const blurb = f.key === 'shortcut' ? `Cut inward: ${b.tiles?.length} tiles straight to the Courthouse. One of them is Bail.`
      : f.key === 'detour' ? `Loop the long way: ${b.tiles?.length} tiles of cash and an item. The last one sends you back to Start unless you're shielded.`
      : `Pay ${f.cost} into the pot to cross straight to the Jackpot ring.`;
    return `<div class="pcard tall forkcard">
      <div class="forkhead"><span class="fbig">${f.icon || '↔️'}</span><h2>Fork in the road</h2></div>
      <p class="phint">${f.stepsLeft} ${f.stepsLeft === 1 ? 'step' : 'steps'} left to spend. ${esc(blurb)}</p>
      <button class="pbtn primary big" data-action="fork" data-choice="branch">${f.icon || ''} Take the ${esc(f.label)}${f.cost ? ` (−${f.cost})` : ''}</button>
      <button class="pbtn big" data-action="fork" data-choice="main">Stay on the road</button>
      <p class="phint small center">Decide in time or the road decides for you.</p>
    </div>`;
  }
  const landedTile = board.phase === 'landed' ? ((board.tiles || {})[(board.positions || {})[me.id] || 0] || null) : null;
  return `<div class="pcard tall dicecard">
    <div class="diehost" data-die data-result="${board.lastRoll || ''}" data-result2="${board.lastRoll2 || ''}"></div>
    <h2 class="rolled">${board.lastRoll ? `You rolled ${board.lastRoll}${board.lastRoll2 ? ` + ${board.lastRoll2}` : ''}` : 'Rolling'}</h2>
    ${board.phase === 'moving' ? `<p class="psteps" data-live="steps"></p>` : ''}
    ${landedTile ? `<p class="psteps landed">${TILE_ICON[landedTile.t] || ''} ${esc(landedTile.label)}</p>` : ''}
    <p class="phint">${esc(board.message || '')}</p>
  </div>`;
}

/** In-place updates between full re-renders (the die must survive each step). */
export function patchPlayer(stage, board) {
  if (!board) return;
  const st = stage.querySelector('[data-live="steps"]');
  if (st && board.phase === 'moving') { const left = board.stepsLeft ?? 0; st.innerHTML = left > 0 ? `<b>${left}</b> to go` : 'Landing…'; }
}

export function scoreboard(players, title = 'Scores') { return finalScoreboard(players, title); }

export async function handleAction(room, me, action, board, state, round, miniMod) {
  if (action.action === 'roll' || action.action === 'useitem') {
    if (!board || board.phase !== 'turn' || board.active !== me.id) return;
    await room.t.set(`${room.base}/intent`, { by: me.id, action: action.action, item: action.item || null, at: Date.now() });
    return { rerender: true };
  }
  if (action.action === 'fork') {
    if (!board || board.phase !== 'fork' || board.active !== me.id) return;
    await room.t.set(`${room.base}/intent`, { by: me.id, action: 'fork', choice: action.choice === 'branch' ? 'branch' : 'main', at: Date.now() });
    return { rerender: true };
  }
  if (miniMod && round) return miniMod.handleAction(room, me, action, round, state);
}
