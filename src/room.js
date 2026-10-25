// ---------------------------------------------------------------------------
// Room lifecycle: create, join, players, presence, phase transitions.
//
// Data model (Realtime Database):
//
//   rooms/{CODE}/meta            { createdAt, hostId, expiresAt }
//   rooms/{CODE}/phase           'lobby' | 'playing' | 'scoreboard' | 'ended'
//   rooms/{CODE}/game            null | 'quiz' | 'promptvote' | 'charades'
//   rooms/{CODE}/settings        { rounds, packId, ... }
//   rooms/{CODE}/players/{pid}   { name, emoji, score, joinedAt, connected }
//   rooms/{CODE}/round           game-specific round state
//   rooms/{CODE}/submissions     game-specific, cleared between rounds
//   rooms/{CODE}/votes           game-specific, cleared between rounds
// ---------------------------------------------------------------------------

import { ROOM_CODE_CHARS, ROOM_CODE_LEN, ROOM_TTL_MS } from './config.js';
import { getTransport } from './transport.js';

export const EMOJI = [
  '🦝','🐸','🍆','💀','🔥','🐍','🦴','👹','🧃','🪳',
  '🦑','🐙','🥴','🤡','👺','🦨','🐀','🧟','👽','🦷'
];

export function randomCode() {
  let out = '';
  const bytes = new Uint32Array(ROOM_CODE_LEN);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    out += ROOM_CODE_CHARS[bytes[i] % ROOM_CODE_CHARS.length];
  }
  return out;
}

export function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/**
 * Per-TAB identity. Survives a refresh (sessionStorage), but two tabs are two
 * different players — which is what you want, since local mode runs several
 * players in one browser and two people on one laptop would otherwise collide
 * into a single scoring record.
 */
export function localPlayerId() {
  let id = sessionStorage.getItem('pg_player_id');
  if (!id) {
    id = newId();
    sessionStorage.setItem('pg_player_id', id);
  }
  return id;
}

export function rememberName(name) {
  localStorage.setItem('pg_player_name', name);
}

export function recalledName() {
  return localStorage.getItem('pg_player_name') || '';
}

export class Room {
  constructor(code, transport) {
    this.code = String(code).toUpperCase();
    this.t = transport;
    this.base = `rooms/${this.code}`;
    this._unsubs = [];
  }

  static async open(code) {
    const t = await getTransport();
    return new Room(code, t);
  }

  /** Create a fresh room. Returns the Room. Retries on code collision. */
  static async create(hostId) {
    const t = await getTransport();
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = randomCode();
      const existing = await t.get(`rooms/${code}/meta`);
      if (existing) continue;
      const room = new Room(code, t);
      await t.set(room.base, {
        meta: {
          createdAt: Date.now(),
          expiresAt: Date.now() + ROOM_TTL_MS,
          hostId
        },
        phase: 'lobby',
        game: null,
        players: {}
      });
      return room;
    }
    throw new Error('Could not allocate a room code. Try again.');
  }

  async exists() {
    return Boolean(await this.t.get(`${this.base}/meta`));
  }

  async isExpired() {
    const meta = await this.t.get(`${this.base}/meta`);
    if (!meta) return true;
    return Date.now() > (meta.expiresAt || 0);
  }

  /* ------------------------------ players ------------------------------ */

  async addPlayer(playerId, name, emoji) {
    const players = (await this.t.get(`${this.base}/players`)) || {};
    const taken = new Set(Object.values(players).map(p => p.emoji));
    const pick = emoji || EMOJI.find(e => !taken.has(e)) || EMOJI[0];

    const existing = players[playerId];
    await this.t.set(`${this.base}/players/${playerId}`, {
      name: name.slice(0, 16),
      emoji: pick,
      score: existing ? (existing.score || 0) : 0,
      joinedAt: existing ? existing.joinedAt : Date.now(),
      connected: true
    });

    await this.t.onDisconnectSet(`${this.base}/players/${playerId}/connected`, false);
    return pick;
  }

  async removePlayer(playerId) {
    await this.t.remove(`${this.base}/players/${playerId}`);
    await this.t.remove(`${this.base}/submissions/${playerId}`);
    await this.t.remove(`${this.base}/votes/${playerId}`);
  }

  async renamePlayer(playerId, name) {
    await this.t.update(`${this.base}/players/${playerId}`, { name: name.slice(0, 16) });
  }

  async addScore(playerId, delta) {
    const cur = (await this.t.get(`${this.base}/players/${playerId}/score`)) || 0;
    await this.t.set(`${this.base}/players/${playerId}/score`, cur + delta);
  }

  async players() {
    return (await this.t.get(`${this.base}/players`)) || {};
  }

  /* ------------------------------- phase ------------------------------- */

  async setPhase(phase)  { await this.t.set(`${this.base}/phase`, phase); }
  async setGame(game)    { await this.t.set(`${this.base}/game`, game); }
  async setRound(data)   { await this.t.set(`${this.base}/round`, data); }
  async patchRound(data) { await this.t.update(`${this.base}/round`, data); }

  async clearRoundData() {
    await this.t.remove(`${this.base}/submissions`);
    await this.t.remove(`${this.base}/votes`);
  }

  async submit(playerId, payload) {
    await this.t.set(`${this.base}/submissions/${playerId}`, payload);
  }

  async vote(playerId, targetId) {
    await this.t.set(`${this.base}/votes/${playerId}`, targetId);
  }

  /* ----------------------------- listeners ----------------------------- */

  on(subpath, cb) {
    const path = subpath ? `${this.base}/${subpath}` : this.base;
    const unsub = this.t.subscribe(path, cb);
    this._unsubs.push(unsub);
    return unsub;
  }

  detach() {
    for (const u of this._unsubs) {
      try { u(); } catch {}
    }
    this._unsubs = [];
  }

  async close() {
    await this.t.set(`${this.base}/phase`, 'ended');
  }

  async destroy() {
    await this.t.remove(this.base);
  }
}
