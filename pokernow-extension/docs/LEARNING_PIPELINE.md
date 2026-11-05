# Learning pipeline: record every hand, learn from it, review it

## Why

Your games have no game log the extension can read (confirmed in v1.6.0), so the bot works from the screen
only. Until now it recorded nothing: opponent profiles stayed "typical" unless you imported a CSV by
hand, and there was no history to review except copied console lines.

## The pipeline

```
 play ──► 1. RECORD (automatic)   ──► 2. LEARN (automatic)          ──► 3. EXPORT (1 click) ──► 4. REVIEW (1 command)
          every hand, from the        clean hands update the             popup: Download          npm run review
          screen, as it happens       opponent profiles used live        games (JSON)            -> report (.md)
                                                                                                    -> send to Claude
                                                                                                    -> tests + fixes
```

### 1. Record (src/table/recorder.ts, wired in main.ts)
- On every change on the page (and once a second), the recorder takes a snapshot: each seat's name, stack,
  bet, folded or not, dealer button, cards shown at showdown, the board, our cards.
- It compares each snapshot with the one before and writes down what happened: blinds, folds, calls,
  bets, raises, checks (a street that ends with no bet = everyone still in checked), the board, showdown
  cards, everyone's stack before and after.
- The bot's own decisions and reasons are attached to the hand they were made in.
- A hand ends when the next one starts (dealer button moves, board clears, or new cards).
- **Clean check:** chips add up (total before = total after), and everyone who lost chips lost exactly what
  they put in. Hands that fail are kept but marked, and not used for learning.
- Runs whether the bot is on or killed, on game pages only. It never clicks anything, and an error in it
  never stops the bot.

### 2. Learn (automatic)
- Each clean hand is added to the opponent profiles (how often each player plays, raises, bets and folds).
  The bot already uses those profiles in every decision, matched by player name.
- So it adapts live to fish, maniacs and nits it meets, and remembers them in later games.

### 3. Export (popup)
- "Recorded games: N games, M hands (K clean)" and a **Download games** button: one JSON file with every
  recorded game (last 50 games kept in the browser).

### 4. Review (npm run review)
- `npm run review -- <file.json>` (or without a file: the newest `pokerbot-games*.json` in Downloads).
- Writes `tools/reviews/review-<date>.md`:
  - totals: hands, chips won or lost, big blinds per 100 hands
  - results by **seat** (UTG ... BTN, SB, BB) and by **players at the table**
  - **biggest losses** and **all our all-ins**, with cards, board, every action and the bot's reason
  - **showdowns**: what opponents had
  - **opponents**: how loose and aggressive each one played
- Send the report (or the JSON) to Claude: bad hands become tests, then fixes, as with the hands you've
  sent so far.

## Steps
1. Recorder, clean check, storage, tests with made-up snapshot sequences, startup test still passing.
2. Learning from clean hands.
3. Popup export.
4. Review script.

## Limits
- Actions are seen as they happen. If two players act faster than the page updates (bots can), their
  order is guessed in seat order. The clean check still holds because only amounts matter for it.
- A check is only visible when a street ends with no bet; checks before a bet on the same street aren't
  recorded.
- The last hand of a game is saved when the next hand starts, so the hand you bust on, or the final hand
  you win, may be missing.
