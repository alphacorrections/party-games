# Party Games

A phone-controller party game site for a small group of friends. One screen hosts
(laptop, or cast to a TV), everyone else plays on their phone, and scores persist
across nights.

Static site — GitHub Pages serves it, Firebase Realtime Database carries the live
state. No server to run.

---

## Games

| Game | What happens | Players |
|---|---|---|
| **Degenerate Trivia** | Question on the TV, four buttons on every phone. Faster correct answers score more. | 1+ |
| **Liar's Trivia** | A real question with the answer blanked. Everyone writes a convincing lie; lies and truth are shuffled; pick what's real. Points for spotting the truth and for fooling people. | 2+ |
| **Fill In The Blank** | Prompt with a gap. Everyone plays a card from their hand. Everyone votes. | 3+ |
| **Fill In The Blank — Judge** | Same, but one rotating judge picks the winner instead of a group vote. | 3+ |
| **Write Your Own** | Open prompt, everyone types their own answer, funniest wins the votes. | 3+ |
| **Would You Rather** | Two bad options, blind vote, the split reveals. The minority has to explain themselves. | 3+ |
| **Most Likely To** | Vote for a player. Whoever gets the most votes earns the title. | 3+ |
| **Shout It Out / Heads Up** | Pick a category — Act It Out, Impressions, Movies, TV, Famous People, Animals, Songs, Accents, Jobs, Drunk & Disorderly — the word shows huge on the TV, the active player faces away, everyone else gives clues. | 3+ |
| **Spiral** | A 3D board: 28 tiles winding into a centre Jackpot through four zones (the Bar, the Courthouse, the Clinic, the Afterparty). Items you hold and use — Steal, Shield, Double, Swap, Mug. Land on someone and it's a duel: a one-round head-to-head for a pot. Setbacks pay into the pot; Jackpot pays it out. Events hit the whole table. Six different minigames, biased by zone. | 2+ |

All content is original and lives in `content/*.json`: 110 trivia questions, 159
fill-in-the-blank prompts with 499 answer cards, 150 open prompts, and 350
charades entries across 10 categories. Edit those files to make the games yours —
plain JSON, no build step, no code changes needed.

**Spiral** reuses the other engines rather than reimplementing them. Landing on a
minigame tile instantiates one of them for a single round, with `onFinish` wired
to hand control back to the board. Board state lives at `rooms/{code}/board` and
the running minigame at `rooms/{code}/round`, so the two never fight over a node.

---

## Setup

The site runs **without any setup** in local mode: open `index.html` and everything
works on that one device. Phones can't join until Firebase is connected.

### Connect Firebase (about 10 minutes)

1. **Make a project** at [console.firebase.google.com](https://console.firebase.google.com).
   Analytics is not needed — skip it.

2. **Create a Realtime Database.** Build → Realtime Database → Create database. Pick
   the region closest to you and choose **locked mode** (the rules in step 5 replace it).

   It must be Realtime Database, not Firestore. They are different products and this
   app uses the former.

3. **Turn on anonymous sign-in.** Build → Authentication → Get started → Sign-in
   method → Anonymous → Enable.

   Without this every write fails, because the rules require a signed-in user.

4. **Register a web app.** Project settings (gear icon) → General → Your apps → Web
   (`</>`). Copy the `firebaseConfig` object it shows you and paste the values into
   `src/config.js`.

   These values are **not secrets**. Firebase web config is a public identifier and
   is meant to ship in client code. What protects the data is the rules file, not
   hiding these.

5. **Paste the rules.** Realtime Database → Rules tab → replace everything with the
   contents of `firebase-rules.json` → Publish.

6. **Authorize your domain.** Authentication → Settings → Authorized domains → Add
   domain → your Pages hostname (for example `alphacorrections.github.io`).

   Miss this one and sign-in fails on the live site while working fine locally.

Reload the site. The badge in the top corner of the host screen should read **live**
instead of **local only**.

---

## Playing

1. Open `host.html` on the TV or the laptop you're casting from.
2. Everyone scans the QR code, or goes to the site and types the four-letter room code.
3. Host picks a game. It runs itself from there.
4. Scores land on the leaderboard when the game ends.

### No TV? Host from a phone

Open `play.html`, type your name, tap **Start a party on this phone**. You get a room
code, your friends join with it, and your phone runs the game while you play. Every
game except Spiral works this way — the phones show the question, the cards, the
votes and the reveal themselves. Shout It Out becomes **Heads Up**: the word shows on
the active player's phone held to their forehead, and they tilt down for got-it,
up for skip (or tap the buttons). iPhones ask once for motion permission.

If the hosting phone dies, the next phone by join order takes over within about
fifteen seconds and the round continues from where it was.

### Before a game

- **Game length** — Quick / Standard / Long in the lobby scales every game's round
  count (and Spiral's turn count). Pick once; it sticks for the room.

### During a game

- Score changes float up the TV as **+600 Jake** the moment they land.
- The last round of any game is labelled **Final round**.
- **Waiting on…** shows who hasn't answered. The host can tap a name to skip them
  so one person on the phone doesn't stall the room.
- **Next** on every reveal (or Enter/OK on a TV remote) advances when everyone's
  done laughing. Otherwise reveals auto-advance on a timer scaled to how much is
  on screen.
- **Hand's garbage? Swap it.** Once per game of Fill In The Blank you can replace
  your whole hand.
- Nothing repeats within a room. Questions, prompts and words a room has seen are
  tracked; when a pack runs out it starts over.
- If a phone drops, a **Reconnecting…** bar shows and inputs lock until it's back.
- Joining with a name someone's actively using is refused; reloading your own
  phone is recognised and lets you straight back in.

**End game** in the top corner drops everyone back to the menu without closing the
room or kicking anyone out. An abandoned game isn't written to the leaderboard.

Rooms expire six hours after they're made and are deleted when the host closes the tab.

---

## Players and scores

`leaderboard.html` has three tabs:

- **All-time** — total points, games played, wins, and which game each person is best at.
- **Roster** — add people, remove them, or delete them outright. *Remove* hides someone
  but keeps their history; *delete* wipes the record.
- **Recent games** — the last 30 results.

Players are matched by a normalised version of their name — both on the leaderboard
and inside a room. That matters more than it sounds: phones get backgrounded, the OS
discards the tab, and the page silently reloads. Keying off the name means that phone
rejoins as the same player with its hand and score intact instead of showing up as a
stranger. Spell your name the same way each time.

---

## Content

The packs live in Firebase, not in this repo. **Content** on the home page opens an
editor where anyone in your group can add, disable or delete trivia, prompts, answer
cards, Would-You-Rather pairs, Most-Likely prompts and charades words. The repo
carries only a small tame sample in `content/` so a fresh clone runs in local mode.

To seed a new Firebase project: put your full packs in `content-private/` (same
file names and shapes as `content/`), open `manage.html` on the live site and tap
**Seed**. It only adds what's missing, so it's safe to run again. `content-private/`
is gitignored.

The sample files in `content/`, all plain JSON:

- `content/trivia.json` — `answer` is the 0-based index into `options`.
- `content/fillblank.json` — `____` marks each blank. `blanks` must match how many
  `____` the prompt contains.
- `content/quiplash.json` — a flat list of open prompts.
- `content/charades.json` — words grouped into categories.

To add a meme-caption game, create `content/memes.json` in the same shape as
`quiplash.json` with an `image` field per prompt, and add a `mode: 'meme'` entry to
`GAME_MENU` in `src/host.js`. The engine already handles it.

---

## How it's put together

```
index.html          landing
host.html           the big screen
play.html           phone controller
leaderboard.html    standings, roster, history

src/config.js       Firebase config + tunables
src/transport.js    Firebase or localStorage, same interface
src/room.js         rooms, players, presence
src/scores.js       roster, leaderboard, history
src/director.js     runs a game: owns the engine, forwards room events, failover
src/host.js         the TV screen (a Director + a renderer)
src/play.js         the phone (a controller, or a Director + full renderer with no TV)
src/viewport.js     TV fitting: --vh fallback, overscan inset, scale-to-fit
src/tilt.js         forehead tilt gestures for Heads Up
src/games/*.js      one module per game engine
```

`director.js` is what separates "a screen" from "the thing running the game". Both
the TV and a hosting phone own one; it claims `rooms/{code}/director` with a
heartbeat, and a phone that sees the heartbeat go stale takes over, re-arming the
current round's timer from its stored deadline.

TV browsers are handled in `viewport.js`: `100dvh` is unsupported on most of them,
so `--vh` is published from JS; TV user agents get a default 4% overscan inset that
the remote's arrow keys adjust; and if a screen's content is still taller than the
viewport it's scaled to fit rather than scrolled.

`fx.js` is the sound, haptics and motion layer — the cues are synthesised in
WebAudio (layered voices, filtered noise for hits, a chord for the win) so there
are no files to load or license, DOM transitions keyed so a re-render of the same screen doesn't
flicker, and everything degrades to nothing under `prefers-reduced-motion`.
Sound is off until someone taps the speaker, because browsers won't start audio
without a gesture anyway. `dice.js` is a six-faced CSS cube; the tumble is a real
rotation that lands on the rolled value.

The board is CSS 3D rather than WebGL on purpose: tiles stay HTML (crisp text at
any size), nothing heavy loads, and it works on the kind of TV browser you
actually cast to. If tokens ever need to be meshes that physically hop, that is
the moment to reach for Three.js; the board data model won't need to change.

`transport.js` is the only file that knows whether Firebase exists. Everything above
it talks to one interface, which is why the whole app still runs with no account.

### Worth knowing

- **The database is readable by anyone playing.** A player who opens devtools can see
  who wrote which answer before the vote, the trivia answer before the reveal, and the
  true answer in Liar's Trivia during the writing phase. Fixing that properly needs server-side logic, which GitHub Pages can't host.
  For a group of friends in one room this is a social problem, not a technical one.
- **Anonymous auth keeps strangers out**, not your own players.
- The free Firebase plan allows 100 simultaneous connections — far more than this needs.
- The QR code loads a library from a CDN. If it fails the join URL is still printed.

---

## Content

Everything in `content/` is original, written for this repo. None of it is taken from
Cards Against Humanity, What Do You Meme, Jackbox or any other published deck — those
are copyrighted, and copying them into a public repo is how a public repo gets a
takedown notice.
