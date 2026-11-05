# PLAN: extension start/stop and popup fix

This is Part 1 of [REFORM.md](REFORM.md).

## What the user wants

1. Clicking the extension icon only opens the popup and shows the status. It never starts or
   changes anything by itself.
2. The bot starts by itself on a game page, unless the user pressed **Kill**.
3. Reloading the page creates a new bot, and the old one is stopped. Only one bot ever clicks.

## Why the popup sometimes doesn't open (causes found in the code)

| # | Cause | Where |
|---|---|---|
| A | `chrome.action.onClicked` calls `setPopup({ popup: '' })` when the `showPopup` flag is missing or false. That removes the popup, so clicking the icon does nothing until the next click sets it back. | `public/background.js` |
| B | The built popup loads `popup.js` twice: the template has its own `<script>` tag, and webpack adds a second one. Every button and timer runs twice (Start is sent twice, two status timers, CSV import runs twice). | `src/pages/popup.html` + `webpack.config.js` |
| C | The popup calls `alert()` (e.g. "No active tab found"). An alert inside a popup closes the popup. | `src/pages/popup.ts` |
| D | The popup asks the tab for status every 0.5 s even when the bot isn't on that tab. Each try fails with an unhandled error, and the status never says *why* nothing is shown. | `src/pages/popup.ts` |
| E | Icon paths say `icons/` but the folder is `Icons/`. Windows doesn't mind, but other systems would show no icon. | `public/manifest.json` |

## Why auto-start was unreliable

- Auto-start only happened if the bot was **on the last time** (stored `botEnabled` flag), and
  only if the "turn back on" checkbox was ticked. Pressing Kill once, or the flag getting lost,
  meant later games never started on their own.
- PokerNow can move from the lobby to a game without reloading the page, so a check that only
  runs when the page loads would miss it.

## Changes

### 1. `public/background.js`
- Remove the `onClicked` / `setPopup` code and the `showPopup` flag (fixes A). The manifest's
  `default_popup` always opens the popup.
- Keep "add the bot to open tables after an update".

### 2. `src/main.ts`: bot lifecycle
- **Game page check:** on PokerNow, a game page is a URL path starting with `/games/`. On other
  sites listed in `sites.json`, every page counts.
- **Auto-start watcher:** every second, if this is a game page, the bot is off, and the user
  hasn't killed it on this page, start it. This also works when PokerNow switches pages
  without reloading.
- **Kill:** sets a "killed" flag for this page. The bot stays off until **Start** is pressed or
  the page is reloaded. (A reload is a fresh start, as asked in point 3.)
- **One bot per game:**
  - Same page (extension updated or reloaded): the existing "takeover" message stops the old copy.
  - Page reload: Chrome removes the old copy with the old page.
  - Same game open in two tabs: the newest bot writes `activeBot = {game, id}` to storage. Older
    bots for the same game see this, stop, and don't restart. The newest tab plays.
- Status answer now covers more cases: `playing`, `off: killed (press Start)`,
  `off: stopped because this game is open in another tab`, `waiting: not a game page`.
- Remove the `botEnabled` flag.

### 3. Popup (`src/pages/popup.html`, `popup.ts`)
- Remove the extra `<script>` tag (fixes B).
- Status sits at the top: version, bot status for the current tab, game type and mode.
- Opening the popup only reads the status. Start / Kill still work, but only when clicked.
- No `alert()`. Errors appear in the status line (fixes C), e.g.:
  - "Not a PokerNow tab"
  - "Bot not loaded on this tab: reload the page (F5)", when the tab was opened before the
    extension was installed or reloaded and the content script can't be reached
- Every message checks `chrome.runtime.lastError` (fixes D).
- Remove the "turn back on" checkbox. Auto-start is now always on, and Kill is the off switch.

### 4. `public/manifest.json`
- Icon paths become `Icons/...` (fixes E).
- Version 1.9.1 → **1.10.0**.

### 5. `src/autopilot.ts`
- Delete it (nothing is left in it once `botEnabled` and the checkbox are gone).

## How we check it works

Automated:
- `npx tsc --noEmit -p .` passes.
- `npm test` passes.
- `npm run build` passes, and `dist/popup.html` has exactly one `popup.js` script tag.

By hand (user, after reloading the extension in `chrome://extensions` and pressing F5 on the game):
1. Click the icon 10 times, on the game tab and on another tab. The popup opens every time and
   nothing starts or stops.
2. Open a game: the console shows `[autostart] game page: starting` and the popup says `playing`.
3. Press Kill. The popup says `off: killed`, and the bot doesn't come back by itself.
4. Press F5. A new bot starts by itself (console prints `pokerbot v1.10.1` once).
5. Open the same game in a second tab. The new tab plays, and the first tab's popup says
   `stopped because this game is open in another tab`.
6. Reload the extension mid-game. The bot in the open tab is replaced by the new version, with
   only one bot playing.
