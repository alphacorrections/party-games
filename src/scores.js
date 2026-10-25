// ---------------------------------------------------------------------------
// Persistent roster + leaderboard, independent of any single room.
//
//   roster/{key}      { name, emoji, active, createdAt }
//   leaderboard/{key} { name, points, gamesPlayed, wins, lastPlayed, byGame{} }
//   history/{id}      { endedAt, game, roomCode, results:[{key,name,score}] }
//
// Keyed by a normalised name so the same person scores to the same record even
// if they rejoin from a different phone.
// ---------------------------------------------------------------------------

import { getTransport } from './transport.js';
import { newId } from './room.js';

export function keyFor(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'player';
}

/* ------------------------------- roster -------------------------------- */

export async function getRoster() {
  const t = await getTransport();
  return (await t.get('roster')) || {};
}

export async function addToRoster(name, emoji) {
  const t = await getTransport();
  const key = keyFor(name);
  const existing = await t.get(`roster/${key}`);
  await t.set(`roster/${key}`, {
    name: name.slice(0, 16),
    emoji: emoji || (existing && existing.emoji) || '🎲',
    active: true,
    createdAt: existing ? existing.createdAt : Date.now()
  });
  return key;
}

/** Soft-remove: keeps their score history, hides them from the roster UI. */
export async function deactivateRosterEntry(key) {
  const t = await getTransport();
  await t.update(`roster/${key}`, { active: false });
}

export async function reactivateRosterEntry(key) {
  const t = await getTransport();
  await t.update(`roster/${key}`, { active: true });
}

/** Hard-remove: wipes the roster entry AND their leaderboard record. */
export async function purgePlayer(key) {
  const t = await getTransport();
  await t.remove(`roster/${key}`);
  await t.remove(`leaderboard/${key}`);
}

/* ----------------------------- leaderboard ------------------------------ */

export async function getLeaderboard() {
  const t = await getTransport();
  const raw = (await t.get('leaderboard')) || {};
  return Object.entries(raw)
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => (b.points || 0) - (a.points || 0));
}

/**
 * Commit one finished game.
 * results: [{ name, score }] — highest score wins; ties all count as wins.
 */
export async function commitGame(game, roomCode, results) {
  const t = await getTransport();
  if (!results || !results.length) return;

  const top = Math.max(...results.map(r => r.score || 0));
  const stamped = [];

  for (const r of results) {
    const key = keyFor(r.name);
    const prev = (await t.get(`leaderboard/${key}`)) || {
      name: r.name, points: 0, gamesPlayed: 0, wins: 0, byGame: {}
    };
    const byGame = prev.byGame || {};
    byGame[game] = (byGame[game] || 0) + (r.score || 0);

    await t.set(`leaderboard/${key}`, {
      name: r.name,
      points: (prev.points || 0) + (r.score || 0),
      gamesPlayed: (prev.gamesPlayed || 0) + 1,
      wins: (prev.wins || 0) + ((r.score || 0) === top && top > 0 ? 1 : 0),
      lastPlayed: Date.now(),
      byGame
    });

    // Make sure everyone who played shows up on the roster.
    const inRoster = await t.get(`roster/${key}`);
    if (!inRoster) await addToRoster(r.name);

    stamped.push({ key, name: r.name, score: r.score || 0 });
  }

  await t.set(`history/${newId()}`, {
    endedAt: Date.now(),
    game,
    roomCode: roomCode || null,
    results: stamped.sort((a, b) => b.score - a.score)
  });
}

export async function getHistory(limit = 25) {
  const t = await getTransport();
  const raw = (await t.get('history')) || {};
  return Object.entries(raw)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))
    .slice(0, limit);
}

export async function resetAllScores() {
  const t = await getTransport();
  await t.remove('leaderboard');
  await t.remove('history');
}
