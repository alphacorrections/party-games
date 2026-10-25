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
| **Fill In The Blank** | Prompt with a gap. Everyone plays a card from their hand. Everyone votes. | 3+ |
| **Fill In The Blank — Judge** | Same, but one rotating judge picks the winner instead of a group vote. | 3+ |
| **Write Your Own** | Open prompt, everyone types their own answer, funniest wins the votes. | 3+ |
| **Shout It Out** | Word shows huge on the TV. The active player faces away and taps GOT IT / SKIP while everyone screams clues. | 3+ |

All content is original and lives in `content/*.json`. Edit those files to make the
games yours — they are plain JSON, no build step, no code changes needed.

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

Rooms expire six hours after they're made and are deleted when the host closes the tab.

---

## Players and scores

`leaderboard.html` has three tabs:

- **All-time** — total points, games played, wins, and which game each person is best at.
- **Roster** — add people, remove them, or delete them outright. *Remove* hides someone
  but keeps their history; *delete* wipes the record.
- **Recent games** — the last 30 results.

Players are matched by a normalised version of their name, so the same person scores
to the same record whichever phone they use. Spell your name the same way each time.

---

## Editing the content

Four files, all plain JSON:

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
src/host.js         host controller
src/play.js         phone controller
src/games/*.js      one module per game engine
```

`transport.js` is the only file that knows whether Firebase exists. Everything above
it talks to one interface, which is why the whole app still runs with no account.

### Worth knowing

- **The database is readable by anyone playing.** A player who opens devtools can see
  who wrote which answer before the vote, and can see the trivia answer before the
  reveal. Fixing that properly needs server-side logic, which GitHub Pages can't host.
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
