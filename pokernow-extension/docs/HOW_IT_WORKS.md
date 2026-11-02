# How the PokerNow Bot extension works

This describes version 1.7.0. It covers how the extension is built and loaded into Chrome, which parts run where,
how they talk to each other, and what happens on every turn. The strategy itself is covered in more detail in
the [README](../README.md).

---

## 1. The big picture

A Chrome extension is a bundle of web files (HTML, JavaScript, images) plus a `manifest.json` that tells Chrome
what to run, where, and with what permissions. This one has three parts:

| Part | File in `dist/` | Where it runs | Job |
|---|---|---|---|
| **Content script** | `main.js` | Inside every PokerNow tab | Watches the table, decides, clicks the buttons. This is the bot. |
| **Popup** | `popup.html` + `popup.js` | The small window that opens when you click the extension icon | Start/Kill, settings, log import, status |
| **Background worker** | `background.js` | Chrome's background service worker | Only chooses whether the icon opens the popup. It does nothing during play. |

```
            ┌──────────── Chrome ─────────────────────────────────────────┐
            │                                                              │
 you ──────►│  Popup (popup.html / popup.js)                               │
  click     │     │  start / kill / status messages                         │
  icon      │     ▼                                                        │
            │  PokerNow tab ── content script (main.js) ── the bot          │
            │     │   reads the page (DOM): cards, seats, stacks, bets,    │
            │     │   clicks fold / check / call / raise                   │
            │     ▼                                                        │
            │  chrome.storage.local  ◄── shared by popup and content script │
            │  (your name, Shark mode, opponent profiles, autopilot)       │
            └──────────────────────────────────────────────────────────────┘
```

Everything runs on your computer. The extension makes no network requests at all: **its only input is the screen**
(the page the tab shows).

---

## 2. The manifest (`public/manifest.json`)

```json
"manifest_version": 3,
"version": "1.7.0",
"action":          { "default_popup": "popup.html" },
"content_scripts": [{ "matches": [ ...the sites in sites.json... ], "js": ["main.js"] }],
"permissions":     ["storage", "scripting", "activeTab"],
"host_permissions":[ ...the sites in sites.json... ],
"background":      { "service_worker": "background.js" }
```

- **`manifest_version: 3`**: the current Chrome extension format (MV3).
- **`version`**: shown on `chrome://extensions`. It goes up with every build, so you can check that Chrome loaded the new one.
  The bot also prints `"pokerbot v1.7.0"` in the tab's console when it loads.
- **`content_scripts`** and **`host_permissions`**: filled in at build time from `sites.json` (section 9).
  By default these are PokerNow's two addresses. Chrome injects `main.js` into every page whose address matches PokerNow, as soon as the
  page loads. Content scripts can read and click the page's elements, but they run in their own isolated
  JavaScript world, separate from PokerNow's own code.
- **`permissions`**:
  - `storage`: the `chrome.storage.local` box where settings and opponent profiles are kept.
  - `activeTab` / `scripting`: let the popup message the PokerNow tab you're looking at.
- **`host_permissions`**: access to those sites.
- **`background`**: the small service worker described above.

---

## 3. From source code to the `dist/` folder

```
src/  (TypeScript)  ──►  webpack + ts-loader  ──►  dist/  (what Chrome loads)
public/ (manifest, icons, background.js)  ── copied as-is ──┘
```

- `npm run build` runs webpack (`webpack.config.js`), which has two entry points:
  - `src/main.ts` becomes `dist/main.js`, the content script with the whole bot bundled into one file.
  - `src/pages/popup.ts` becomes `dist/popup.js`. `popup.html` is generated from `src/pages/popup.html`.
  - Everything in `public/` (icons, `background.js`) is copied into `dist/` unchanged. The exception is
    `manifest.json`, whose site list is filled in from `sites.json`. The build prints `[build] bot runs on: …`.
  - `dist/` is wiped before each build.
- Source maps (`*.js.map`) are included, so errors in Chrome's console point to the original TypeScript lines.

**Installing or updating in Chrome:**
1. Open `chrome://extensions` and turn on **Developer mode**.
2. **First time:** click **Load unpacked** and choose the `pokernow-extension/dist` folder.
3. **After each new build:** click the reload ↻ icon on the extension card, check the version number, then
   **press F5 on the PokerNow tab**.
   - A content script is only injected when the page loads, so an open tab keeps running the old bot until it's refreshed.
   - Don't remove and re-add the extension. That deletes `chrome.storage.local`: your name, Shark mode and every opponent profile.

---

## 4. How the parts talk to each other

### Messages: popup to tab

The popup finds the active tab and sends it a one-word message with `chrome.tabs.sendMessage`. The content script
listens with `chrome.runtime.onMessage` (bottom of `src/main.ts`):

| Message | Sent when | What the content script does |
|---|---|---|
| `start_bot` | You press **Start Bot** (only allowed on a PokerNow page) | Starts the turn loop, saves `botEnabled: true` |
| `kill_bot` | You press **Kill Bot** | Stops the loop, saves `botEnabled: false` |
| `get_bot_status` | Every 0.5 s while the popup is open | Replies `off`, or `playing, last decision: smart brain` / `QUICK BOT (reason)` |

### Shared storage: `chrome.storage.local`

Both sides read and write the same storage, which survives restarts:

| Key | Written by | Used for |
|---|---|---|
| `sharkMode` | Popup checkbox | Normal or Shark settings, read before every decision (`src/mode.ts`) |
| `botEnabled` | Start / Kill | Auto-start: turns the bot back on when the game page reloads |
| `autopilot` | Popup checkbox | Auto-start setting (`src/autopilot.ts`) |
| `opponentStore` | Content script and log import | Opponent profiles: counts of every player's actions, up to 20,000 hands remembered |

The content script listens for storage changes (`chrome.storage.onChanged`), so a log import from the popup reaches
a running bot right away.

---

## 5. One turn, step by step

All of this happens in the content script inside the PokerNow tab.

```
 turn appears ─► read screen ─► read seats ─► build table view ─► decide ─► think time ─► click
  (main.ts)       (ui.ts)     (screenReader.ts) (tableView.ts)    (ai/…)    (timing.ts)  (action.ts)
```

### 5.1 Noticing the turn (`src/main.ts`)
When you press Start, three things watch for "my turn", meaning PokerNow's `.action-signal` element is on the page:
- **A page watcher** (`MutationObserver`): fires the moment the page changes, so a turn is seen right away.
  This keeps working when Chrome slows timers in a covered or background window.
- **A 0.5 s check** and **a 1 s safety check**: in case the watcher misses something.
- **Guards:** a `busy` flag so a turn is never played twice, a 1 s pause after each click while the page updates,
  and an 8 s reset if a turn ever gets stuck.
  If anything fails (for example the turn shows a split second before the cards are drawn), the loop logs the error and tries again.

### 5.2 Reading the screen (`src/ui.ts`, `getState`)
It reads, from the page elements: your two cards, the board, the pot, the amount to call, your stack, the big blind,
the street (preflop / flop / turn / river) and a rough count of opponents.

### 5.3 Reading the seats (`src/table/screenReader.ts`)
There is no game log: the bot only sees what the page shows right now.
- **From each seat** (`.table-player`): name, stack, the bet in front of them, folded or not, and which seat has the
  dealer button. Your seat is the one marked `.you-player`.
- **From that it writes a plausible hand history:**
  - the blinds come from the dealer button. Without a button, preflop, they come from who has the big blind in front of them;
  - on this street, bets are taken smallest first: the first above the current level is the bet or raise, equal ones are calls;
  - earlier streets can't be seen, so the players still in are assumed to have put in an equal share of the pot.
- `src/table/tableView.ts` turns that into a **table view**: every seat with position (BTN, SB, BB, UTG…), stack,
  chips invested, and folded or still in.
  The pot on the page replaces the rebuilt pot, because the page's number is exact.
- **What it can't know:** who raised on earlier streets, and the exact order of actions on this one.
- **Opponent profiles** (`src/table/stats.ts`) are never updated from these guessed hands, so live play doesn't
  build profiles. Players are treated as typical unless you import past PokerNow CSV logs in the popup.

### 5.4 Deciding (`src/ai/`)
`ai.ts` picks the brain, with fallbacks:

```
smart brain (up to 4 s) ──error or too slow──► equity bot ──error──► original rules bot
```

The **smart brain** (`smartBrain.ts` → `decide.ts`):
1. Loads the mode: **Normal** (beginners, "big bets mean strong hands") or **Shark** (strong players, game-theory reads).
   The settings come from `src/config.ts` (`CONFIG` and `SHARK_MODE`).
2. **Preflop** (`preflop/preflopBrain.ts`):
   - Uses hand strength, position, stack depth in big blinds, and each opponent's likely range from their profile.
   - At 15 big blinds or less it plays all-in or fold (`pushFold.ts`).
   - It weighs tournament points by ICM (`icm.ts`), so busting costs what it really costs.
   - Fish who limp get raised wider.
3. **After the flop** (`postflop/`):
   - Narrows each opponent's range by their actions (`postflopRanges.ts`).
   - Simulates about 1,000 random deals of the remaining cards and scores each option by expected value
     (check, bet ½ pot, bet pot, all-in, fold, call, raise). Draws, who folds to which bet size, and position are
     taken into account (`postflopBrain.ts`).
   - Heads-up on the river it solves the spot with a CFR+ game-theory solver (`riverSolver.ts`).
     Against a fish it uses the expected-value rules instead, to exploit their habits.

The **equity bot** (`equity/equityAi.ts`) is the simple fallback. It looks only at your cards and how many
opponents are left. The popup status shows when it was used and why.

### 5.5 Think time (`src/timing.ts`)
The whole turn, including the decision, is fitted into **2–5 s** (`CONFIG.timing`):
- **Preflop:** about 2.0–2.7 s for every action.
- **After the flop:** it varies with the hand, and long thinks are mixed between strong hands and bluffs so timing says nothing.

### 5.6 Clicking (`src/action.ts`, `src/ui.ts`)
- **Fold, check or call:** clicks PokerNow's matching button. "Check or fold" checks when it can and folds otherwise.
- **A raise:** opens the raise menu, clicks the preset (min, ½ pot, pot, all-in) and submits.
- Then the loop goes back to waiting for the next turn.
  Between turns it also clicks **Show hand** when PokerNow offers it.

---

## 6. Autopilot (`src/autopilot.ts`)

One optional setting in the popup:
- **Auto-start:** if the bot was on when the page closed or reloaded, it starts again by itself when a game page opens.

You register and take your seat yourself (auto-seat was removed in 1.7.0). The extension never registers for
tournaments, takes seats or moves between games by itself.

---

## 7. Where to look when something goes wrong

Open the PokerNow tab, press **F12**, and open **Console**. Useful lines:

| Line | Meaning |
|---|---|
| `"pokerbot v1.7.0"` | Which version this tab is running. If it's old, press F5 on the tab. |
| `[table] (normal mode): …` | The seats were read from the page; shows positions and stacks |
| `[preflop] …` / `[postflop] …` | The decision and the numbers behind it |
| `[timing] think …, decided in …, waiting …` / `acting X s after the turn started` | Where the time went |
| `[smart brain] error, using the equity bot instead` | The fallback was used, with the reason |
| `[table reader] … couldn't find my seat` | Your popup name doesn't match your table name |
| `bot loop error, trying again` | A bad page read; the bot recovers by itself |

The popup's status line shows the same thing in short form: which brain made the last decision.

---

## 8. Offline tools (not part of the extension)

These run with Node on your computer and never touch PokerNow:
- `npm test`: checks the math, the screen reader, the CSV log parser and known poker spots (`tools/test.js`).
- `npm run sim` / `tune` / `evolve`: a full tournament simulator (`src/sim/`) that plays thousands of bot-vs-bot
  Sit & Gos to tune the settings in `src/config.ts`.

---

## 9. Running on your own site

### 9.1 Telling the extension about the site
Edit `sites.json` in `pokernow-extension/`, replace the placeholder with your site, and build:

```json
"sites": [
    "https://www.pokernow.club/*",
    "https://www.pokernow.com/*",
    "https://my-poker.example.com/*"
]
```

```
npm run build
```

- **Patterns** are Chrome match patterns:
  - `https://my-poker.example.com/*` covers one site.
  - `https://*.example.com/*` covers all its subdomains.
  - `http://localhost/*` covers a local server on any port.
  - A plain address like `https://my-poker.example.com` gets `/*` added automatically.
- **Placeholders:** entries containing `YOUR-SITE` are skipped, so the file can keep the placeholder.
- **One-off build** without editing the file: `npm run build -- --env site=https://my-poker.example.com`.
  Separate several sites with commas.
- **Updating Chrome:** reload the extension in `chrome://extensions`. Chrome may ask to approve access to the new site.
- **The popup's Start button** only works on the sites in the build, and tells you which those are.

### 9.2 What your site's page must provide
The bot reads and clicks the page by PokerNow's CSS class names (`src/ui.ts`). Your table page needs the same
class names and text formats, or `src/ui.ts` must be changed to match your page.

| What | Selector the bot uses | Expected content |
|---|---|---|
| It's my turn | `.action-signal` | Present only while it's your turn |
| My cards | `.you-player .card` (two of them) | Each has `.value` (`A K Q J 10 9 … 2`) and `.suit` (`c d h s`) |
| Board | `.table-cards .card` | Same card format; 0, 3, 4 or 5 of them |
| Big blind | `.blind-value .chips-value` | The **second** match is the big blind, as a number |
| My stack | `.table-player.you-player .table-player-stack` | Number |
| Pot | `.table-pot-size .add-on .chips-value` (total), `.table-pot-size .main-value .chips-value` (before this street) | Numbers |
| Amount to call | text of `button.call` | `Call 200` (word, space, number) |
| Players | `.table-player` | Your seat also has `.you-player`. Folded or empty seats have `fold`, `empty`, etc. in their class |
| My name | `.you-player .table-player-name` | Used if no name is set in the popup |
| Buttons | `button.fold`, `button.check`, `button.call`, `button.raise` | Clickable; `button.check` is `disabled` when you can't check |
| Raise menu | after clicking `button.raise`: `.default-bet-buttons button` (min, ½ pot, ¾ pot, pot, all-in, in that order) and `.raise-controller-form input[type="submit"]` | Presets then submit |
| Show hand (optional) | `button.show-your-hand` | |

### 9.3 The seats (smart brain)
The bot downloads nothing: the smart brain's table comes from the page (section 5.3). For it to work, each seat
must look like PokerNow's:

| What | Selector | Expected content |
|---|---|---|
| A seat | `.table-player`, ideally with class `table-player-N` (seat number, used for seat order) | Seats with `standing`, `empty`, `offline` or `away` in the class are skipped |
| Name | `.table-player-name` | Text; seats without a name are skipped |
| Stack | `.table-player-stack` (or `.chips-value` inside it) | Number; commas are fine |
| Bet in front | `.table-player-bet-value` (or `.chips-value` inside it) | Number, only while they have a bet out |
| Folded | `fold` in the seat's class | |
| Me | `you-player` in my seat's class | |
| Dealer button | `.dealer-button-ctn` with class `dealer-position-N` | N = the dealer's `table-player-N` number (optional) |

If the seats can't be read (none found, or none marked `you-player`), the simple equity bot plays that turn, and the
popup shows `QUICK BOT (smart brain: couldn't read the seats on the page)`.
