# Retune plan: continuous bet sizing for the cash game

Goal: the smart brain picks **any** bet size (not 4 fixed options), and its settings are re-tuned
for the cash game with those sizes. Ship only if the simulator says it beats both older versions.

## Where we start (100k simulated cash hands, bb/100 ± 95% range)

| Version | smart | shark |
|---|---|---|
| v1.8.1, old button sizes (min-raise opens, ½ / pot bets) | +821 ± 152 | +844 ± 113 |
| v1.9.0, typed fixed sizes (3 bb opens, ⅓ ½ ¾ pot bets) | +668 ± 154 | +672 ± 107 |

## Steps

### Step 1: Fairer tests (less luck) — DONE
Today two versions play different cards, so a 100k-hand test still has a ±150 bb/100 range.
- **Duplicate dealing:** the deck, seats and button come from a seed, so version A and version B
  play the exact same cards from the same seats. Luck mostly cancels out of the difference.
- `npm run cash -- --compare <a>,<b>`: plays both on the same seeds and reports the difference with
  its range. Variants are named settings bundles (old sizes, v1.9.0 sizes, candidate tunings).
- Done when: an A-vs-A test comes out near 0 with a much smaller range than today.
- Result: seeded deck + seats + button, and each player's decisions use its own random stream restarted
  every hand (engine.ts setDecisionRandom). A-vs-A = exactly 0. A-vs-B ranges shrink only ~40%
  (any real change alters many hands), so all-in hands are also scored by expected value
  (engine.ts takeLuck: the runout after the money is in counts as luck).

### Step 2: Find what cost chips in v1.9.0 — DONE
Compare old sizes vs new preflop sizes only vs new postflop sizes only (duplicate tests).
Tells us whether the 3 bb opens / 3x 3-bets or the small postflop bets lost the value.
- Result (30k duplicate hands each, vs old): v1.9.0 -475 ± 270, postflop sizes only -285 ± 246,
  preflop sizes only -90 ± 238. The fixed small postflop bets lost most of it.

### Step 3: Continuous sizing after the flop — DONE (postflopSizing 2)
- Score the EV of bets from 20% to 150% of the pot (overbets allowed) on a grid, then zoom in
  around the best one. Same for raises (from the minimum raise up). All-in stays an option.
- A little random spread on the chosen size (knob) so the size doesn't give the hand away.
- Knobs: maxOverbet, sizeSpread, reverseImplied (cost of growing the pot before the river with a
  hand that's often behind when called: the JJ-into-QQ leak). Tests updated (choices grouped by size).

### Step 4: Continuous sizing before the flop — DONE (preflopSizing 2)
- Open size = base + per limper + more when fish who call too much are behind or in the blinds
  + a bit more from the small blind (out of position).
- 3-bet size = multiple of the raise (in position / out of position) + per caller, bigger vs fish.
- Each part is a knob for the tuner: openSizeCashBB, openPerLimper, openFishBonus, openSbBonus,
  threeBetSize, threeBetOopExtra, threeBetFishBonus.

### Step 5: Cash evolver — BUILT (src/sim/evolveCash.ts, `npm run evolve-cash`)
`npm run evolve-cash`: evolves all knobs (old ones + the new sizing knobs) by playing
cash sessions against the default table (smart, sharks, fish, equity bots, nit), with duplicate
dealing, fitness in bb/100. Keeps a hall of fame and can resume after a stop.
Cash settings are stored separately from the tournament ones (like Shark mode overrides).

### Step 6: Run the evolution
Long background run (hours). Progress reported every generation.

### Step 7: Playoff
Winner vs v1.9.0 vs v1.8.1 on 300k+ duplicate hands. Ship only if it beats both by more than
the range. Also sanity checks: no silly sizes (e.g. 5% pot bets, 10 bb opens) in the test hands.

### Step 8: Ship
Cash settings into `config.ts`, version bump, docs (HOW_IT_WORKS), CONTEXT.md.

## Caveat
The simulated opponents are simpler than real players (the fish call too much, nobody adapts to
our sizes). Tuning can overfit them, e.g. "always bet huge into fish". The size spread knob and the
mix of opponent types in the pool limit that, and live results (step 6 of CASH_GAME_PLAN) are the
final judge.
