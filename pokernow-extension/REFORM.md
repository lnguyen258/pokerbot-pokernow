# REFORM: extension fixes + strategy by table size

We work one part at a time. After each part: tests and simulator results, a short report to the
user, then the next part only when they say go. Every part that changes play is checked in the
simulator against the current version (v1.9.1) before it ships.

## Table phases (used by all the strategy parts)

"Players" means players still in the tournament with chips (seated and dealt in), not players
still in the hand.

| Phase | Players | Style |
|---|---|---|
| **Full** | 6–8 | Very tight. Nothing risky. A call or raise from an opponent means a strong hand. |
| **Conservative** | 5 | Tight, solid. Few bluffs. |
| **Normal** | 4 | Standard play (the bubble: 4th pays, 5th loses points, so ICM matters most here). |
| **Creative** | 3 | Wider opens, more steals, semi-bluffs, check-raises. |
| **Heads-up** | 2 | Tight-aggressive with lots of pressure: raise or fold preflop, bet when checked to, including all-in bluffs when the opponent checks after the flop. |

Each phase has its own settings bundle in `config.ts` (like Shark mode does today), so the
simulator can tune each one.

---

## Part 1: Extension start/stop and popup (see [PLAN.md](PLAN.md))
- The popup always opens and only shows the status.
- The bot starts by itself on game pages unless killed.
- A reload means a new bot replaces the old one, and only one bot plays per game.
- **Done when:** the checks in PLAN.md pass. Version 1.10.0.

## Part 2: Table phase detection + measuring tools
- `tablePhase(view)` in `table/tableView.ts` returns `full | conservative | normal | creative | headsUp`.
- Every decision log line starts with the phase, e.g. `[full 7p]`.
- Simulator: report points, **top-4 rate**, and win rate per bot. Add a "by phase" breakdown of
  chips won and lost, so we can see where the bot loses (e.g. "loses chips at full tables
  through bluffs").
- Scenario tests (`tools/test.js`) for each behavior below, written first and failing until each
  part makes them pass.
- **Done when:** phase is correct in tests for 8 to 2 players, and baseline numbers are recorded.

### Part 2 results (Nov 2, 2026)
- Phase detection + `[full 7p]` log prefix; tests pass for 8..2 players.
- `npm test` now also runs `npm run smoke` (startup test on fake pages; proven to catch the 1.10.0 crash).
- Baseline: 1,000 Sit & Gos, default table (2 smart, 2 equity, station, maniac, nit, random), saved in
  `tools/sim-results/baseline-v1.10.json`:

| Bot | Points / tournament | Top 4 | Wins | bb/100 full 6-8 | 5 | 4 | 3 | heads-up |
|---|---|---|---|---|---|---|---|---|
| smart | +6.6 ± 0.2 | 92% | 22% | +86 | +100 | +50 | +30 | +26 |
| nit | +4.5 ± 0.4 | 78% | 11% | +213 | +133 | +48 | +10 | −14 |
| equity | −1.0 ± 0.4 | 37% | 16% | +369 | +167 | +1 | −12 | +20 |

- TODO targets found by the new tests: top pair weak kicker calls a full-table flop raise 19/20 (Part 3);
  heads-up air bets only ~9/20 when checked to and never shoves (Part 7). Already right: KJo folds to UTG
  raise at 7 players, no multiway bluff with air, K8o steals BTN / folds UTG, no air shove into a station.

## Part 3: Full table (6+ players) and Conservative (5): tight and careful
Preflop:
- Tighter opening ranges in Full (scale by phase, tuned), and 3-bet bluffs (A2s–A5s) off.
- Facing a raise at a Full table: assume a stronger range (narrow the range estimate further,
  especially for early-position raisers and for calls followed by a re-raise).
- Cold-calling a raise: only with hands that play well (pairs, suited broadways), not offsuit junk.

After the flop:
- No pure bluffs (betting or raising with no made hand and no good draw) when 3+ players are in
  the hand, or in the Full phase.
- When an opponent calls a bet, narrow their range more (they have something). When they raise,
  assume two pair or better unless they're a known maniac.
- Stack-off rule: no all-in with one pair (even top pair) against a Full-table raise unless
  short-stacked.
- **Done when:** scenario tests pass (e.g. "7 players, UTG raises, we hold KJo on the button
  → fold"; "flop raise at a full table, top pair weak kicker → fold") and the simulator shows
  the same or better points at 6+ players.

### Part 3 results (Nov 2, 2026)
- New `src/ai/phaseStyle.ts`; tests: KJo folds to UTG raise, K5 top pair folds to a full-table check-raise 20/20,
  a set never folds, top pair still calls at 4 players, no multiway air bets.
- Simulator, same tables, new vs old (`oldsmart` = phaseRules 0), 1,500 tournaments each:

| Table | Points new | Points old | Top 4 new | Top 4 old |
|---|---|---|---|---|
| Mixed (station, maniac, random...) | +6.7 ± 0.3 | +6.8 ± 0.3 | 93% | 91% |
| Tough (equity, nits, 1 maniac) | +5.8 ± 0.3 | +5.5 ± 0.3 | 87% | 82% |

- Cost: fewer chips won at 5 players against weak bots (+50 vs +111 bb/100). Knobs are in config for Part 9 tuning.

## Part 4: Position
- Check every seat's ranges: UTG tightest, then HJ, CO, BTN widest (blinds special). Print the
  table of opening shares per seat and table size for review.
- Position bonus after the flop: more bluffs and thin value bets in position, more check/call
  and check-raise out of position. Tighter calling out of position.
- Stealing: on the CO, BTN and SB, steal more when the blinds fold a lot (from their stats).
- Defending the BB: wider against a late-position steal than against an UTG open.
- **Done when:** the per-seat range table looks right, scenario tests pass ("K8o folded to us
  on the BTN at 7 players → raise"; "same hand UTG → fold"), and the simulator is no worse.

## Part 5: Check-raise
- Today the bot only raises when facing a bet. It never *plans* a check-raise.
- Add a "check, then raise if they bet" option out of position. Its value is the chance
  they bet into us times the value of the raise, plus the chance they check back times the
  value of the free card.
- Their chance of betting comes from their stats (aggression) and their range.
- For very strong hands, and strong draws as semi-bluffs (Creative and Heads-up only for the
  semi-bluffs).
- The bot remembers the plan for the street, so after checking it really does raise.
- **Done when:** scenario tests show check-raises with sets on wet boards against aggressive
  players, and no check-raise bluffs at Full tables.

## Part 6: Small value bets (luring callers) + range reading
- Value sizing: already continuous (20%–150% of the pot, by EV). Add an "induce" check:
  on the river, against a range that's mostly weak hands and calling stations, prefer the size
  that the most worse hands call (often 25–40% of the pot).
- Against fish: smaller bets to get called (they call too much) with medium hands, and bigger
  ones with the nuts.
- Range reading: print each opponent's estimated range in the log at each street (e.g. "Bob:
  top pair+ 40%, draws 25%, air 35%"), so the user can see what the bot thinks.
- **Done when:** scenario tests show small river value bets with second pair against a
  checked-down weak range, and the range summary appears in logs.

## Part 7: Creative (3 players) and Heads-up (2)
Creative (3):
- Wider opens and steals, 3-bet bluffs on, semi-bluffs and check-raise semi-bluffs on.

Heads-up (2), tight-aggressive with pressure:
- Preflop: raise or fold from the button with a wide range, 3-bet the big blind more. Limping only
  as a trap with strong hands, sometimes.
- After the flop: bet most flops when checked to.
- **The bluff shove:** when the opponent checks after the flop, consider going all-in with
  nothing. The EV uses their checking range, which is weaker because strong hands often bet.
  It is used when the fold chance makes it profitable, and less against calling stations (their
  stats say they don't fold).
- Mixed in so it isn't every time, with a cap per session so it doesn't become predictable.
- **Done when:** the simulator heads-up win rate (from 2 players left) is better than v1.9.1,
  and scenario tests show the shove with air after a check and no shove against a station.

## Part 8: Playing for points (top 4)
- Already using ICM with the payouts (since v1.13.0: 15/7.5/5/3.75/−3.75/−5/−7.5/−15). Check it really changes play:
  - At 5 players (bubble), short and medium stacks avoid risky calls, and the big stack pressures them.
  - Once in the top 4, the bot plays for 1st and 2nd (those are worth a lot more).
- Simulator target: higher average points and top-4 rate than v1.9.1.
- **Done when:** both are better (outside the error range) over 2,000+ tournaments.

## Part 9: Tune each phase, final check, ship
- Evolve each phase's settings bundle (`npm run evolve` with phase bundles).
- Playoff: new vs v1.9.1, 5,000 tournaments. Ship only if it wins clearly.
- Update README / CONTEXT / HOW_IT_WORKS, bump the version.

---

## Progress

| Part | Status | Result |
|---|---|---|
| 1. Extension start/stop + popup | done (code), waiting for the user's browser check | v1.10.0, tests pass |
| 2. Table phase + measuring | done | baseline +6.6 pts, 92% top 4, 22% wins |
| 3. Full / Conservative tight play | done, v1.11.0 | points same, top 4 +2 to +5 pts |
| 4. Position | done, v1.13.0 | steals BTN/SB, in-position bonus: +0.2 / +0.5 pts |
| 5. Check-raise | | |
| 6. Value sizing + range reading | | |
| 7. Creative + Heads-up | | |
| 8. Points / top 4 | | |
| 9. Tune + ship | | |
