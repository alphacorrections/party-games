// ---------------------------------------------------------------------------
// Leaderboard, roster management and game history.
// ---------------------------------------------------------------------------

import { getLeaderboard, getRoster, getHistory, addToRoster,
         deactivateRosterEntry, reactivateRosterEntry, purgePlayer,
         resetAllScores } from './scores.js';
import { getTransport } from './transport.js';
import { esc } from './util.js';

const GAME_NAMES = {
  quiz: 'Trivia',
  promptvote: 'Prompt & Vote',
  charades: 'Shout It Out'
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const panel = document.getElementById('panel');
let tab = 'all';

async function renderAll() {
  const rows = await getLeaderboard();
  if (!rows.length) {
    panel.innerHTML = `<p class="muted">No games finished yet. Go play one.</p>`;
    return;
  }
  const body = rows.map((r, i) => {
    const best = Object.entries(r.byGame || {})
      .sort((a, b) => b[1] - a[1])[0];
    return `
      <div class="srow ${i === 0 ? 'lead' : ''}">
        <span class="rank">${i + 1}</span>
        <span class="emoji">${r.emoji || '🎲'}</span>
        <span class="sname">${esc(r.name)}
          <span class="meta">${plural(r.gamesPlayed || 0, 'game')}, ${plural(r.wins || 0, 'win')}${
            best ? `, best at ${esc(GAME_NAMES[best[0]] || best[0])}` : ''}</span>
        </span>
        <span class="spts">${r.points || 0}</span>
      </div>`;
  }).join('');
  panel.innerHTML = body +
    `<p style="margin-top:2rem"><button class="linkbtn" id="reset">Reset all scores</button></p>`;
}

async function renderRoster() {
  const roster = await getRoster();
  const entries = Object.entries(roster).map(([key, v]) => ({ key, ...v }));
  const active = entries.filter(e => e.active !== false);
  const gone   = entries.filter(e => e.active === false);

  const row = e => `
    <div class="rosterrow">
      <span class="emoji">${e.emoji || '🎲'}</span>
      <span class="rname">${esc(e.name)}</span>
      ${e.active === false
        ? `<button class="linkbtn" data-reactivate="${e.key}">Bring back</button>`
        : `<button class="linkbtn" data-deactivate="${e.key}">Remove</button>`}
      <button class="linkbtn" data-purge="${e.key}">Delete + wipe scores</button>
    </div>`;

  panel.innerHTML = `
    ${active.length ? active.map(row).join('') : '<p class="muted">Roster is empty.</p>'}
    <div class="addrow">
      <input id="newname" maxlength="16" placeholder="Add someone">
      <button id="addbtn">Add</button>
    </div>
    ${gone.length ? `<h3 style="margin-top:2rem">Removed</h3>${gone.map(row).join('')}` : ''}
    <p class="meta" style="margin-top:1.5rem">Removing someone hides them but keeps their
       scores. Deleting wipes the record for good.</p>`;
}

async function renderHistory() {
  const games = await getHistory(30);
  if (!games.length) {
    panel.innerHTML = `<p class="muted">No games on record yet.</p>`;
    return;
  }
  panel.innerHTML = games.map(g => {
    const when = new Date(g.endedAt).toLocaleString(undefined,
      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const podium = (g.results || []).slice(0, 3)
      .map((r, i) => `${i + 1}. ${esc(r.name)} ${r.score}`).join('  ');
    return `
      <div class="rosterrow">
        <span class="rname"><b>${esc(GAME_NAMES[g.game] || g.game)}</b>
          <span class="meta">${podium}</span></span>
        <span class="meta">${when}</span>
      </div>`;
  }).join('');
}

async function render() {
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('on', t.dataset.tab === tab));
  if (tab === 'all')     return renderAll();
  if (tab === 'roster')  return renderRoster();
  return renderHistory();
}

document.addEventListener('click', async e => {
  const t = e.target.closest('.tab');
  if (t) { tab = t.dataset.tab; return render(); }

  const add = e.target.closest('#addbtn');
  if (add) {
    const input = document.getElementById('newname');
    const name = input.value.trim();
    if (name) { await addToRoster(name); input.value = ''; render(); }
    return;
  }

  const d = e.target.closest('[data-deactivate]');
  if (d) { await deactivateRosterEntry(d.dataset.deactivate); return render(); }

  const r = e.target.closest('[data-reactivate]');
  if (r) { await reactivateRosterEntry(r.dataset.reactivate); return render(); }

  const p = e.target.closest('[data-purge]');
  if (p) {
    if (confirm('Delete this player and wipe their scores? This cannot be undone.')) {
      await purgePlayer(p.dataset.purge);
      render();
    }
    return;
  }

  if (e.target.closest('#reset')) {
    if (confirm('Reset every score and clear game history?')) {
      await resetAllScores();
      render();
    }
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'newname') {
    e.preventDefault();
    document.getElementById('addbtn').click();
  }
});

getTransport().then(render);
