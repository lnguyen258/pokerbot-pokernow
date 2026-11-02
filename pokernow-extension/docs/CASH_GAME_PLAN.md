# Cash game version: plan

**Goal:** win the most chips over a long run of hands, measured in **big blinds won per 100 hands (bb/100)**.

## How a cash game differs from a Sit & Go

| | Sit & Go (today) | Cash game |
|---|---|---|
| What a chip is worth | Tournament points (ICM): losing chips hurts more than winning them helps | Money: every chip is worth the same (chip EV) |
| Stacks | Start ~40–100 bb and shrink as blinds rise; push/fold below 15 bb | Usually 100 bb, often deeper. Blinds never rise, and you can top up |
| Survival | Busting ends your tournament | Busting just means rebuying. Only the long-run average matters |
| Opponents | 7 others for ~30–80 hands | The same regulars and fish for hundreds or thousands of hands, so **reading players pays off far more** |
| Where the money comes from | Not busting near the paid places, stealing blinds | Fish: value-betting them hard, isolating them, not paying off strong players |
| Costs | Entry fee | **Rake** (a cut of each pot), if the site takes one |

So the cash version needs three things:
1. **Chip value** instead of ICM.
2. **Deep-stack play:** planning across several streets, implied odds, and bigger pots with bigger hands.
3. **Much better opponent reading,** built over many hands.

## What already carries over

- Hand evaluation, range estimation, simulating the remaining cards, and the river solver.
- The "beginners don't bluff" reads (`CONFIG.population`), the fish score, isolating limpers, and timing.
- Everything tournament-specific goes through one function, `icm()`. Cash mode (step 0) makes it return plain chip
  counts, which removes all bubble and survival pressure in one place.

## The plan

### Step 0: Cash mode switch (done, v1.8.0)
- The popup has **Game: Tournament / Cash game**.
- In cash mode a stack is worth its chips, so calling an all-in needs exactly 50% plus pot odds, with no bubble fear.
  Push/fold (≤15 bb) uses chip value.
- Tests: the math check passes. In the same spot, a tournament call needs 71.8%, the cash call 50.0%.

### Step 1: Cash game simulator (done)
- **Running it:** `npm run cash -- --hands 60000`, code in `src/sim/cash.ts`.
- **The table** matches yours: 10 seats, blinds 1/2, 200-chip (100 bb) buy-ins, no rake. Players top up to 200
  whenever they're below it.
- **Sessions:** play is split into 300-hand sessions with the same opponents. The smart bots build profiles during a
  session, as at a real table. Seats are shuffled each session.
- **Default table** (`--pool` to change): smart (the extension, normal mode), 2 × shark (the extension in Shark mode,
  standing in for strong players), 4 × fish (weak players), 2 × equity (simple bots), nit (a very tight bot).
  `station`, `maniac` and `random` are also available.
- **Speed:** about 260 hands/s on 24 workers, so 1M hands takes about an hour.
- **Baseline** (v1.8.0, cash mode, 60,000 hands):

  | Player | bb/100 | 95% range |
  |---|---|---|
  | shark | +709 | ±132 |
  | smart | +659 | ±176 |
  | nit | −79 | ±137 |
  | fish | −166 | ±92 |
  | equity | −667 | ±200 |

  - **These numbers are far bigger than real winners** (+5 to +15 bb/100), because the simulated weak players and
    simple bots make huge, repeated mistakes. Use them only to **compare versions of the bot at the same table**,
    never as a forecast.
  - **Smart vs Shark settings:** within noise of each other here. Telling them apart needs paired comparisons
    (step 5).

### Step 2: Deep-stack preflop
- **Ranges for 100 bb by position,** with open sizes around 2.5 bb, and bigger (3–4 bb plus 1 bb per limper) when
  fish are in.
- **3-bet and 4-bet ranges:** for value against loose players, as light re-raises against players who fold too much,
  and almost never bluffing beginners.
- **Implied odds:** small pairs and suited connectors call raises when the stacks behind are deep enough. Pairs need
  about 15–20× the call to hit a set and get paid.
- **Fewer dominated hands:** stop calling raises with hands like KJo or AT out of position. They lose big pots when
  they hit.

### Step 3: Deep-stack play after the flop
- **Plan by stack-to-pot ratio (SPR, stack size compared with the pot):** with a low SPR, top pair is ready to go
  all-in. With a high SPR, one pair keeps the pot small, and only two pair or better builds a big one.
- **Implied odds for draws,** and pricing in reverse implied odds (making a hand that loses big pots).
- **Bet sizing:** add a ¾-pot option (PokerNow has the button). Bet bigger for value against players who call too
  much, and smaller or check against players who fold.
- **Heads-up turn solver:** extend the river solver one street back, so turn and river are planned together. This is
  the biggest gain in strategy quality.

### Step 4: Live opponent reading from the screen (the most important step for cash)
- **The problem:** there is no game log, so today the bot learns nothing about players during play.
- **The fix:**
  - A recorder watches the page the whole hand, not only on our turn. Each change in a player's bet, and each fold, is
    one action, in the real order.
  - At the end of the hand, these real actions are added to the player's profile: how many hands they play, raise and
    3-bet, bet when checked to, fold to bets, and what they showed down.
- **Bonus:** the smart brain then sees the true action history of earlier streets instead of guessing it.

### Step 5: Evolve the cash settings
- Same method as the tournament evolution: the settings play against the fish-heavy pool and keep the winners.
- A final playoff checks the winner against the step 1 baseline, with confidence ranges.

### Step 6: Results tracking
- **Popup:** hands played, chips won, bb/100 and the confidence range, updated from what's on screen.
- **Losses:** a short list of where it lost the most, such as calling big river bets or playing out of the blinds,
  to feed the next round of fixes.

## Order and why

```
0 switch (done) → 1 simulator → 4 screen recorder → 2 preflop → 3 postflop → 5 evolve → 6 tracking
```

- **The simulator first:** without it, nothing can be measured.
- **The screen recorder next:** cash profit comes from knowing the fish, and every other step works better with real
  reads.
- **Preflop before postflop:** it's cheaper, and its mistakes cost more often.

## Your table (confirmed Nov 2)
- **10 seats**, blinds **1/2** (never change), average stack **200** (100 bb), **no rake**.
- **Opponents:** a mix of bots, weak players and strong players.
