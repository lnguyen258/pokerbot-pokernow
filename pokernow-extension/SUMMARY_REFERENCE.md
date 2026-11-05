# SUMMARY_REFERENCE: huynq55-v3/poker_tournament

A reference bot shared by the user, described as one of the strongest bots on PokerNow.
Studied on Nov 3, 2026 for ideas, mainly about **position**.
Source: https://github.com/huynq55-v3/poker_tournament (commit `2a888fb`, Nov 3, 2026). About
19,000 lines of Rust; comments are in Vietnamese. Its strength is the user's report, not measured
by us.

---

## 1. What it is

| Part | Files | What it does |
|---|---|---|
| Game engine | `src/environment/` | 2-8 player hold'em. **6 actions only**: fold, check/call, bet 15%, 33% or 75% of the pot, all-in |
| Brain | `src/deep_cfr/`, `src/neural_network/` | **Deep CFR**: neural nets trained by self-play to approximate a game-theory strategy. Input is 177 numbers describing the spot (section 2) |
| Rewards | `src/deep_cfr/trainer.rs`, `src/equity/icm.rs` | Trained on **ICM** (tournament points, Malmuth-Harville), not chips |
| Search | `src/deep_cfr/subgame_solver.rs` | Short look-ahead solve (60 iterations, 3 actions deep) in important spots (section 5) |
| Live bot | `src/bin/tournament_solver.rs` | Receives the table state from a browser script, rebuilds the hand, picks the **best-EV action (no mixing)**, and clicks |
| Test bots | `src/benchmark/mod.rs` | Hand-written bots: TAG, LAG Shark, NashPush, IcmSniper, NitTrap, StickyFish. **This is where its position rules are written in plain logic** (section 3) |
| Browser scripts | `tamplermonkey_script1-3` | Read PokerNow's WebSocket messages and click in the page. Script 1 auto-joins public lobby Sit & Gos. Script 3 targets **PokerStars** |

---

## 2. How it sees position and the tournament (features the network uses)

From `encode_features` in `src/environment/state.rs`:

- **Position = seats after the button, counting only players with chips**: 0 = BTN, 1 = SB, 2 = BB,
  3 = UTG, and so on. Busted players are skipped, so the labels shrink with the table.
  Heads-up, the button is coded as BTN and the other player as BB (not SB).
- Players alive (count, and a heads-up flag).
- **Bubble flag** (exactly 5 alive) and **"in the top 4" flag** (4 or fewer). The table size
  phases in our REFORM.md match this.
- **Stack rank** (0 = shortest at the table, 1 = chip leader) and **share of all chips**.
- Per opponent: stack, chips put in this hand, how aggressive they've been this hand
  (folded / only checked and called / bet on 1-4 streets), current bet as a share of the pot or all-in.
- Effective stack in BB (against the **biggest** opponent still in the hand: same definition that
  made our deep stack shove like a short stack, fixed in our v1.12.0), a push/fold flag (< 12 BB),
  how much of our stack is already in the pot, hand category, equity, board texture (flush and
  straight draws, paired, high card), facing a raise, bet size vs pot.

---

## 3. Position rules in plain numbers (from the hand-written bots)

Hand strength there is a normalized Chen score (a quick formula). Translated to shares of all hands:

### Opening and shoving by seat

| Spot | Their cutoff | Share of hands | Borderline hands |
|---|---|---|---|
| TAG opens, late seat (BTN, CO, SB) | 0.26 | 43% | 22-55, 43s, 54s |
| TAG opens, early or middle seat | 0.32 | 24% | 66, 65s, T9o |
| Push/fold (12-15 BB), SB vs BB | 0.16 | 67% | 32o, 52s, 96o |
| Push/fold, BTN | 0.20 | 52% | 54o, 86o, J7s |
| Push/fold, CO | 0.26 | 43% | 22, 54s |
| Push/fold, other late | 0.30 | 25% | 66, 98o, T9o |
| Push/fold, UTG / early | 0.36 | 17% | 77, 87s, QJo, KJo |

All five push tiers also accept a hand whose equity edge clears a bar that **rises with stack
size**: (SB) 0.95 + BB/55, (BTN) 1.05 + BB/50, (CO) 1.20 + BB/45, (UTG) 1.55 + BB/35.

### Calling an all-in (tighter than shoving: the "gap concept")

| Players in the hand | Their cutoff | Share | Borderline |
|---|---|---|---|
| Heads-up | 0.27 | 41% | 22-55, 64s, 75s |
| 3-4 | 0.35 | 18% | 77, 87s, QJo |
| 5-8 | 0.42 | 10% | 88, KQo, ATs, AJo |

Out of position (not BTN, CO or SB) the calling cutoff gets **+0.05 stricter**.

### "Trash" by players in the hand

5-8 players: Chen below 0.22 is trash. 3-4 players: below 0.16. Heads-up: only below 0.10
(72o, 82o, 32o), because king-high and queen-high are favorites heads-up.

### After the flop

- **LAG bot**: in late position with nobody betting yet, it adds **+10% equity** for position, and
  +14% for a flush or straight draw before the river. It stabs small when checked to in position
  with a near-average hand, and double-barrels the turn 65% of the time when an A or K comes.
- **TAG bot**:
  - Monsters (two pair+): raise or bet 75% (80%), trap (20%).
  - Top pair on a wet board: bets 75% for protection. On a dry board: 33% or 15%.
  - Medium hands: check (pot control).
- **IcmSniper (their strongest test bot)**:
  - **Equity discount when the opponent keeps betting**: -6.5% per street they've bet, up to -22%.
  - **ICM "tax"** when facing a bet on the bubble (5 left): needs +8% extra equity to call if short
    or medium, +5% if upper-middle, +1% if chip leader.
  - **Chip leader pressure**: with nobody in yet, it lowers its own bar by 5%, and attacks
    constantly as chip leader on the bubble.
  - **Isolating short stacks**: a big stack facing a short stack's shove lowers its calling bar by 4%.

---

## 4. Their points table and when it searches

- 8 players: **+0.48 / +0.24 / +0.16 / +0.12 / -0.12 / -0.16 / -0.24 / -0.48** (sums to zero).
  Scaled to ours: 15 / 7.5 / 5 / 3.75 / -3.75 / -5 / -7.5 / -15.
- **Ours**: 15 / 9 / 4 / 2 / -2 / -4 / -9 / -15.
- The big difference is the **bubble jump (4th vs 5th): 7.5 points for them, 4 for us**. If the
  real league uses theirs, our ICM undervalues surviving the bubble. **Ask the user for the
  actual points table.**
- They also use smaller tables for 2-7 players; their 5-player table is +0.48 / +0.20 / 0 / -0.20 / -0.48.
- Search runs when:
  - the pot is at least 12 BB
  - the opponent overbets (a bet of 1.1× the pot or more)
  - the call costs at least 35% of our stack
  - it's the turn or river
  - or the tournament is heads-up
- Otherwise the network answers directly.

---

## 5. Compared with our bot

| Topic | Them | Us (v1.12.4) |
|---|---|---|
| Position definition | Seats after the button (alive players) | Seats after us preflop (`playersBehind`), equivalent |
| Opening ranges | Two tiers (late 43%, early 24%), wide | Per number of players behind, x openScale 0.631 x full-table cut: about 7% UTG, 27% BTN at 8 players. **Much tighter** |
| Push/fold by seat | 5 hand-tuned tiers | ICM Nash equilibrium solver, position follows from players behind |
| Calling all-ins | Fixed cutoffs by table size, stricter out of position | ICM-required equity vs their range, plus a call floor (77+, AJs+, AQ+, AK) |
| Position after the flop | +10% equity in late position unopened | We keep less equity out of position (`realiseOOP` 0.89); in position gets no bonus |
| Opponent keeps betting | -6.5% equity per barrel | Range narrowing per action; big bets read as value (v1.12.4) |
| Bubble | Flag + stack-rank ICM tax | Full ICM on every decision |
| Bet sizes | 15%, 33%, 75%, all-in | Any size, capped by table phase |
| River / big pots | Look-ahead search in many spots | CFR+ river solver heads-up only |
| Mixing | Best EV only (no mixing) live | Mixes near-equal options |

---

## 6. Ideas to borrow (ranked), mapped to REFORM.md

1. **Part 8, points:** get the real points table. If the bubble jump is bigger than our config,
   update `CONFIG.payouts`. One-line change, affects every ICM decision.
2. **Part 4, position:**
   - Add an **in-position bonus** (their +10% when unopened, late). Ours only penalizes out of position.
   - **Steal more** on the BTN, CO and SB when unopened (their late range 43% vs our ~27% at 8 players).
     The user wants tight at 6+ players, so mainly at 3-5 players. Test in the simulator.
   - Make **all-in calls stricter out of position** (their +0.05), on top of our ICM math.
3. **Part 8, bubble:**
   - **Chip leader pressure**: open and steal wider as chip leader when 5 are left.
   - **Isolate short stacks**: call short stacks' shoves a bit lighter when we cover them.
   - Our ICM partly does both already. Check that it does in tests before adding anything.
4. **Part 6, opponent keeps betting:** consider an explicit per-barrel strength boost. Already
   partly done by range narrowing plus the v1.12.3 and v1.12.4 rules.
5. **Later:** run our solver on big pots, not only heads-up rivers (their triggers: pot ≥ 12 BB,
   call ≥ 35% of the stack, overbets).
6. **Heads-up, Part 7:** their heads-up trash line (only 72o-type hands are trash) and calling
   shoves with 41% of hands. Ours folds J4o in the small blind heads-up at 6-15 BB, which is tighter
   than both theirs and the push/fold solver's own heads-up range. Worth checking.

## 7. Not to borrow

- **Browser scripts that auto-join public lobby games** (script 1). We declined that earlier
  (CONTEXT.md, "Position on where the bot plays"), and that still stands.
- **The PokerStars script** (script 3): a real-money site. Running a bot there breaks its rules and
  takes money from people. Not something to use or adapt.
- Simulated keyboard input (`enigo`): we click inside the page, which is enough.
- Their hand-tuned Chen cutoffs as-is: Chen is a rough formula. Use them as a sanity check against
  our equity-based ranges, not as replacements.

## 8. How to come back to it

- Re-clone into a scratch folder (don't run anything from it): `git clone --depth 1 https://github.com/huynq55-v3/poker_tournament`
- Position features: `src/environment/state.rs` → `encode_features`, `chen_score`, `effective_stack_bb`
- Position rules: `src/benchmark/mod.rs` → `TightAggressive`, `LagShark`, `NashPushBot`, `IcmSniper`,
  `anti_shove_chen_threshold`, `trash_chen_threshold`, `normalized_edge`
- Search triggers: `src/deep_cfr/subgame_solver.rs` → `should_trigger_search`, `SubgameSolverConfig`
- Points: `src/equity/icm.rs` → `SNG_PAYOUTS_*`
- Live decision: `src/bin/tournament_solver.rs` → `run_gto_evaluation`
