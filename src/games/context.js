// ---------------------------------------------------------------------------
// OUT OF CONTEXT — your innocent answer, someone else's evil setting.
//
//   answer -> twist -> vote -> reveal -> (next round) ... -> final
//
// 1. Everyone answers a harmless personal question.
// 2. Each answer is handed to someone else with a setting ("this was a
//    1-star review of…", "this was said in a eulogy for…"). They write the
//    context that makes it look as bad as possible.
// 3. The TV shows each one dressed up as the real thing. Everyone votes.
//    The twister scores per vote; the original author gets a cut.
// ---------------------------------------------------------------------------

import { shuffle, esc, playerList, timerHTML, finalScoreboard, isPresent,
         sampleUnseen, highlight, loadJSON, contentURL } from '../util.js';

export const meta = {
  id: 'context',
  name: 'Out of Context',
  blurb: 'Answer a normal question. Someone else decides what it was really about.',
  minPlayers: 3,
  defaultRounds: 3
};

const ANSWER_MS = 60000;
const TWIST_MS  = 75000;
const VOTE_MS   = 50000;
const REVEAL_MS = 12000;
const TWIST_PTS = 500;
const AUTHOR_PTS= 200;

/* The settings an answer can be dropped into. `ask` is what the twister is
   told to write; `fallback` fills in when they write nothing. */
export const FRAMES = {
  comment:   { label: 'Comment',        ask: 'This was a comment on a post. Write the post title.',               fallback: 'My grandma passed this morning' },
  review:    { label: '1-star review',  ask: 'This was a 1-star review. Write what was being reviewed.',          fallback: 'Sunrise Hospice Care' },
  text:      { label: 'Text message',   ask: 'This was a text message. Who was it sent to?',                     fallback: 'Mom' },
  headline:  { label: 'News',           ask: 'A news story quoted this. Write the headline.',                    fallback: 'Local man arrested after standoff with police' },
  eulogy:    { label: 'Eulogy',         ask: 'This was said in a eulogy. Whose funeral was it?',                 fallback: 'my best friend' },
  testimony: { label: 'Testimony',      ask: 'This was said under oath. What did the lawyer ask?',               fallback: 'Where were you on the night of the murder?' },
  dating:    { label: 'Dating profile', ask: 'This is from a dating profile. Write the person\'s headline.',     fallback: 'Recently divorced, looking for fun' },
  toast:     { label: 'Wedding toast',  ask: 'This was the best man\'s toast. Whose wedding was it?',           fallback: 'my brother and my ex' },
  search:    { label: 'Search history', ask: 'Someone googled this at 3am. What happened right before?',         fallback: 'I hit something with my car' },
  hr:        { label: 'HR complaint',   ask: 'This was quoted in an HR complaint. What was it filed about?',      fallback: 'the holiday party' }
};
const FRAME_KEYS = Object.keys(FRAMES);

export class Host {
  constructor(room, opts = {}) {
    this.room = room;
    this.rounds = opts.rounds || meta.defaultRounds;
    this.tag = opts.tag || null;        // 'general' | 'recovery' | null (both)
    this.timer = null;
    this._busy = false;
  }
  get base() { return this.room.base; }
  after(ms, fn) { clearTimeout(this.timer); this.timer = setTimeout(() => fn.call(this), ms); }
  async round() { return this.room.t.get(`${this.base}/round`); }

  async load() {
    const json = await loadJSON(contentURL('outofcontext.json'));
    let pool = json.prompts || [];
    if (this.tag) pool = pool.filter(p => p.tag === this.tag);
    this.pool = pool;
    return this;
  }

  async begin() {
    await this.room.setGame('context');
    await this.room.setPhase('playing');
    await this.ask(0);
  }

  parts(players) { return playerList(players).filter(isPresent); }

  /* ------------------------------ answer -------------------------------- */
  async ask(index) {
    clearTimeout(this.timer);
    if (index >= this.rounds) return this.finish();
    const players = await this.room.players();
    const ids = this.parts(players).map(p => p.id);
    const picks = await sampleUnseen(this.room, 'context', this.pool, Math.max(1, ids.length), p => p.text);
    const prompts = {};
    ids.forEach((id, i) => { prompts[id] = (picks[i % picks.length] || {}).text || 'What\'s in your fridge right now?'; });
    await this.room.clearRoundData();
    await this.room.setRound({
      phase: 'answer', index, total: this.rounds, final: index === this.rounds - 1,
      prompts, deadline: Date.now() + ANSWER_MS
    });
    this.after(ANSWER_MS, this.toTwist);
  }

  async onSubmissions(subs, players) {
    const r = await this.round(); if (!r) return;
    if (r.phase === 'answer') {
      const need = Object.keys(r.prompts || {}).filter(id => isPresent(players[id]));
      if (need.length && need.every(id => subs && subs[id])) { clearTimeout(this.timer); return this.toTwist(); }
    }
    if (r.phase === 'twist') {
      const need = Object.keys(r.twists || {}).filter(id => isPresent(players[id]));
      if (need.length && need.every(id => subs && subs[id])) { clearTimeout(this.timer); return this.toVote(); }
    }
  }

  /* ------------------------------- twist -------------------------------- */
  async toTwist() {
    if (this._busy) return; this._busy = true;
    try {
      const r = await this.round(); if (!r || r.phase !== 'answer') return;
      const subs = (await this.room.t.get(`${this.base}/submissions`)) || {};
      const answers = {};
      for (const id of Object.keys(r.prompts || {})) {
        const t = subs[id] && String(subs[id].text || '').trim();
        answers[id] = t || 'I plead the fifth.';
      }
      // Hand every answer to someone else: rotate a shuffled order by one.
      const ids = shuffle(Object.keys(answers));
      const frames = shuffle(FRAME_KEYS);
      const twists = {};
      ids.forEach((twister, i) => {
        const src = ids.length > 1 ? ids[(i + 1) % ids.length] : twister;
        twists[twister] = { src, answer: answers[src], prompt: r.prompts[src], frame: frames[i % frames.length] };
      });
      await this.room.clearRoundData();
      await this.room.patchRound({ phase: 'twist', answers, twists, deadline: Date.now() + TWIST_MS });
      this.after(TWIST_MS, this.toVote);
    } finally { this._busy = false; }
  }

  /* -------------------------------- vote -------------------------------- */
  async toVote() {
    if (this._busy) return; this._busy = true;
    try {
      const r = await this.round(); if (!r || r.phase !== 'twist') return;
      const subs = (await this.room.t.get(`${this.base}/submissions`)) || {};
      const items = shuffle(Object.entries(r.twists || {}).map(([twister, tw]) => {
        const ctx = subs[twister] && String(subs[twister].text || '').trim();
        return { twister, src: tw.src, frame: tw.frame, answer: tw.answer, context: ctx || FRAMES[tw.frame].fallback, lazy: !ctx };
      })).map((it, slot) => ({ ...it, slot }));
      await this.room.clearRoundData();
      await this.room.patchRound({ phase: 'vote', items, deadline: Date.now() + VOTE_MS });
      this.after(VOTE_MS, this.reveal);
    } finally { this._busy = false; }
  }

  async onVotes(votes, players) {
    const r = await this.round(); if (!r || r.phase !== 'vote') return;
    const need = this.parts(players).map(p => p.id);
    if (need.length && need.every(id => votes && votes[id] !== undefined)) { clearTimeout(this.timer); return this.reveal(); }
  }

  async reveal() {
    if (this._busy) return; this._busy = true;
    try {
      const r = await this.round(); if (!r || r.phase !== 'vote') return;
      const votes = (await this.room.t.get(`${this.base}/votes`)) || {};
      const mult = r.final ? 2 : 1;
      const tally = {}; for (const it of r.items) tally[it.slot] = 0;
      for (const [voter, slot] of Object.entries(votes)) {
        const it = r.items.find(x => String(x.slot) === String(slot));
        if (it && it.twister !== voter) tally[it.slot]++;
      }
      const gained = {};
      for (const it of r.items) {
        const n = tally[it.slot] || 0; if (!n) continue;
        gained[it.twister] = (gained[it.twister] || 0) + n * TWIST_PTS * mult;
        gained[it.src] = (gained[it.src] || 0) + n * AUTHOR_PTS * mult;
      }
      for (const [pid, n] of Object.entries(gained)) await this.room.addScore(pid, n);
      const top = Math.max(0, ...Object.values(tally));
      const best = r.items.filter(it => top > 0 && tally[it.slot] === top);
      for (const it of best) if (top >= 2) await highlight(this.room, it.twister, `turned an answer into a ${FRAMES[it.frame].label.toLowerCase()} and won the room`, 3);
      await this.room.patchRound({ phase: 'reveal', tally, gained, best: best.map(it => it.slot), deadline: Date.now() + REVEAL_MS });
      this.after(REVEAL_MS, async function () { const r2 = await this.round(); return this.ask((r2 ? r2.index : 0) + 1); });
    } finally { this._busy = false; }
  }

  async finish() {
    clearTimeout(this.timer);
    if (this.onFinish) return this.onFinish();
    await this.room.patchRound({ phase: 'final' });
    await this.room.setPhase('scoreboard');
  }

  async nudge(kind, pid) {
    const r = await this.round(); if (!r) return;
    if (kind === 'next' && r.phase === 'reveal') return this.ask(r.index + 1);
    if (kind === 'skip' && pid) {
      if (r.phase === 'answer' || r.phase === 'twist') await this.room.submit(pid, { text: '', skipped: true });
      if (r.phase === 'vote') await this.room.vote(pid, '-');
    }
  }

  async resume() {
    const r = await this.round(); if (!r) return;
    const left = Math.max(800, (r.deadline || Date.now()) - Date.now());
    const map = { answer: this.toTwist, twist: this.toVote, vote: this.reveal,
                  reveal: async function () { return this.ask(r.index + 1); } };
    if (map[r.phase]) this.after(left, map[r.phase]);
  }
  stop() { clearTimeout(this.timer); }
}

/* -------------------------------- views -------------------------------- */
let subsCache = {}, votesCache = {};
export function setSubmissions(s) { subsCache = s || {}; }
export function setVotes(v) { votesCache = v || {}; }

const nameOf = (players, id) => (players[id] || {}).name || '?';
const emojiOf = (players, id) => (players[id] || {}).emoji || '🙂';

/** One answer dressed up as the real thing. */
export function mockHTML(it, players, opts = {}) {
  const author = esc(nameOf(players, it.src)), ctx = esc(it.context), ans = esc(it.answer), em = emojiOf(players, it.src);
  const n = opts.num !== undefined ? `<span class="oc-num">${opts.num}</span>` : '';
  const cls = `oc-card f-${it.frame} ${opts.best ? 'best' : ''} ${opts.small ? 'small' : ''}`;
  let body;
  switch (it.frame) {
    case 'comment':   body = `<div class="oc-post"><div class="oc-ptitle">${ctx}</div><div class="oc-pmeta">412 comments · sorted by top</div></div>
                              <div class="oc-cmt"><b>${em} ${author}</b><p>${ans}</p><i>▲ 2.1k · Reply</i></div>`; break;
    case 'review':    body = `<div class="oc-rv-head"><b>${ctx}</b><span class="oc-stars">★☆☆☆☆</span></div><p>“${ans}”</p><i>— ${author}, verified customer</i>`; break;
    case 'text':      body = `<div class="oc-to">From: <b>${em} ${author}</b> &nbsp;·&nbsp; To: <b>${ctx}</b></div><div class="oc-bubble">${ans}</div><i class="oc-read">Read 2:14 AM</i>`; break;
    case 'headline':  body = `<div class="oc-mast">THE DAILY REGRET</div><div class="oc-hl">${ctx}</div><p class="oc-quote">“${ans}” — ${author}, witness</p>`; break;
    case 'eulogy':    body = `<div class="oc-kick">In loving memory of</div><div class="oc-hl serif">${ctx}</div><p class="oc-quote serif">“${ans}”</p><i>— spoken by ${author}</i>`; break;
    case 'testimony': body = `<div class="oc-kick">Court transcript · page 41</div><p class="oc-q"><b>Q.</b> ${ctx}</p><p class="oc-a"><b>A.</b> ${ans}</p><i>Witness: ${author}</i>`; break;
    case 'dating':    body = `<div class="oc-dp"><span class="oc-avatar">${em}</span><div><b>${author}, 34</b><div class="oc-dh">${ctx}</div></div></div><p>${ans}</p><div class="oc-swipe">✕ &nbsp; ♥</div>`; break;
    case 'toast':     body = `<div class="oc-kick">Best man's toast</div><div class="oc-hl serif">The wedding of ${ctx}</div><p class="oc-quote serif">“${ans}”</p><i>— ${author}, raising a glass</i>`; break;
    case 'search':    body = `<div class="oc-kick">Context: ${ctx}</div><div class="oc-sbar">🔍 ${ans}</div><i>Searched by ${author} · 3:07 AM</i>`; break;
    case 'hr':        body = `<div class="oc-kick">HR Incident Report</div><p class="oc-q"><b>Re:</b> ${ctx}</p><p class="oc-a">Employee ${author} stated: “${ans}”</p><i>Status: under review</i>`; break;
    default:          body = `<p>${ctx}</p><p>${ans}</p>`;
  }
  return `<div class="${cls}">${n}<div class="oc-frame">${esc(FRAMES[it.frame]?.label || '')}</div>${body}${opts.footer || ''}</div>`;
}

function waitingChips(players, ids, done) {
  const left = ids.filter(id => isPresent(players[id]) && !(done || {})[id]);
  if (!left.length) return '<div class="waiting done">Everyone\'s in</div>';
  return `<div class="waiting"><span class="wlabel">Waiting on</span>${left.map(id =>
    `<button class="wchip" data-skip="${id}">${emojiOf(players, id)} ${esc(nameOf(players, id))}</button>`).join('')}</div>`;
}

export function hostView(r, players) {
  players = players || {};
  if (!r) return '…';
  if (r.phase === 'final') return finalScoreboard(players, 'Final scores');
  const head = `<div class="qmeta">Out of Context · Round ${r.index + 1} of ${r.total}${r.final ? ' · double points' : ''}</div>`;
  if (r.phase === 'answer') {
    return `<div class="oc">${head}${timerHTML(r.deadline, ANSWER_MS)}
      <h1 class="question">Answer the question on your phone.</h1>
      <p class="phint big">Be honest. Be normal. It won't matter.</p>
      ${waitingChips(players, Object.keys(r.prompts || {}), subsCache)}</div>`;
  }
  if (r.phase === 'twist') {
    return `<div class="oc">${head}${timerHTML(r.deadline, TWIST_MS)}
      <h1 class="question">Someone else's answer is on your phone.</h1>
      <p class="phint big">Give it the worst possible context.</p>
      ${waitingChips(players, Object.keys(r.twists || {}), subsCache)}</div>`;
  }
  if (r.phase === 'vote' || r.phase === 'reveal') {
    const reveal = r.phase === 'reveal';
    const cards = (r.items || []).map((it, i) => {
      const n = reveal ? (r.tally || {})[it.slot] || 0 : null;
      const footer = reveal ? `<div class="oc-foot">${n} vote${n === 1 ? '' : 's'} · context by ${esc(nameOf(players, it.twister))}${it.lazy ? ' (didn\'t write one)' : ''}</div>` : '';
      return mockHTML(it, players, { num: i + 1, best: reveal && (r.best || []).includes(it.slot), footer });
    }).join('');
    const nv = Object.keys(votesCache || {}).length;
    return `<div class="oc">${head}${reveal ? '' : timerHTML(r.deadline, VOTE_MS)}
      <div class="oc-grid n${Math.min(6, (r.items || []).length)}">${cards}</div>
      ${reveal ? '<button class="nextbtn" data-next="1">Next</button>' : `<p class="phint">Vote on your phone for the best one. ${nv} in.</p>`}</div>`;
  }
  return '';
}

export function playerView(r, me, submitted, voted, players, extra = {}) {
  players = players || {};
  const mirror = extra.mirror;
  if (!r) return '<div class="pcard">…</div>';
  if (r.phase === 'answer') {
    const q = (r.prompts || {})[me.id];
    if (!q) return '<div class="pcard"><h2>Sit this one out</h2><p>You joined mid-round. Next round.</p></div>';
    if (submitted) return `<div class="pcard"><h2>Got it</h2><p>Your answer is about to have a terrible life.</p></div>`;
    return `<div class="pcard">${mirror ? timerHTML(r.deadline, ANSWER_MS) : ''}
      <p class="phint">Answer honestly. Short is fine.</p><h2 class="small-h">${esc(q)}</h2>
      <textarea class="ptext" data-role="answer" maxlength="140" placeholder="Your answer"></textarea>
      <button class="pbtn primary" data-action="submittext">Send</button></div>`;
  }
  if (r.phase === 'twist') {
    const tw = (r.twists || {})[me.id];
    if (!tw) return '<div class="pcard"><h2>Hang tight</h2></div>';
    if (submitted) return `<div class="pcard"><h2>Done</h2><p>Waiting on the others.</p></div>`;
    const f = FRAMES[tw.frame];
    return `<div class="pcard">${mirror ? timerHTML(r.deadline, TWIST_MS) : ''}
      <p class="phint">${esc(nameOf(players, tw.src))} was asked “${esc(tw.prompt)}” and said:</p>
      <div class="oc-src">“${esc(tw.answer)}”</div>
      <h2 class="small-h">${esc(f.ask)}</h2>
      <textarea class="ptext" data-role="answer" maxlength="120" placeholder="${esc(f.fallback)}"></textarea>
      <button class="pbtn primary" data-action="submittext">Send</button></div>`;
  }
  if (r.phase === 'vote') {
    if (voted) return `<div class="pcard"><h2>Voted</h2><p>${mirror ? 'Waiting on the others.' : 'Eyes on the TV.'}</p></div>`;
    const items = r.items || [];
    if (mirror) {
      return `<div class="pcard">${timerHTML(r.deadline, VOTE_MS)}<p class="phint">Tap the best one. Not your own.</p>
        ${items.map((it, i) => it.twister === me.id
          ? mockHTML(it, players, { num: i + 1, small: true, footer: '<div class="oc-foot">yours</div>' })
          : `<button class="oc-pick" data-action="vote" data-slot="${it.slot}">${mockHTML(it, players, { num: i + 1, small: true })}</button>`).join('')}</div>`;
    }
    return `<div class="pcard"><p class="phint">Which one wins? Not your own.</p>
      ${items.map((it, i) => `<button class="pbtn" data-action="vote" data-slot="${it.slot}" ${it.twister === me.id ? 'disabled' : ''}>
        <span class="letter">${i + 1}</span>${esc(FRAMES[it.frame].label)}: ${esc(it.context).slice(0, 48)}</button>`).join('')}</div>`;
  }
  if (r.phase === 'reveal') {
    const g = (r.gained || {})[me.id] || 0;
    const best = (r.items || []).filter(it => (r.best || []).includes(it.slot));
    return `<div class="pcard ${g ? 'win' : ''}"><h2>${g ? `+${g}` : 'Nothing'}</h2>
      ${mirror && best.length ? `<p class="phint">Winner:</p>${best.map(it => mockHTML(it, players, { small: true })).join('')}` : ''}</div>`;
  }
  return '<div class="pcard">…</div>';
}

export function scoreboard(players, title = 'Scores') { return finalScoreboard(players, title); }

export async function handleAction(room, me, action, r) {
  if (!r) return;
  if (action.action === 'submittext' && (r.phase === 'answer' || r.phase === 'twist')) {
    const max = r.phase === 'answer' ? 140 : 120;
    await room.submit(me.id, { text: String(action.text || '').trim().slice(0, max), at: Date.now() });
    return { rerender: true };
  }
  if (action.action === 'vote' && r.phase === 'vote') {
    const it = (r.items || []).find(x => String(x.slot) === String(action.slot));
    if (!it || it.twister === me.id) return;
    await room.vote(me.id, it.slot);
    return { rerender: true };
  }
}
