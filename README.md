# Pokerbot

A poker bot built step by step, following the roadmap in [techniques.md](techniques.md).
It plays no-limit Texas hold'em tournaments on [PokerNow](https://www.pokernow.com) through a Chrome extension.

*Last updated: Nov 1, 2026*

---

## The big picture

```
   PokerNow game page
      |                         \
      | your cards, buttons      \ seats on screen: names, stacks, bets, dealer
      v                           v
  +---------------------------------------------+
  | Chrome extension  (pokernow-extension/)      |
  |   table reader -> who sits where, positions, |
  |                   stacks, what everyone did  |
  |   brain        -> fold / call / raise        |
  |   clicker      -> presses the button         |
  +---------------------------------------------+
```

- **Hands** (read + click): [pokernow-extension/](pokernow-extension/), originally
  [EsawAdhana/pokernow-bot](https://github.com/EsawAdhana/pokernow-bot), patched for pokernow.com.
- **Table reader**: the screen is the only input (since v1.6.0, no game log). It reads every seat's name, stack,
  bet and fold from the page, plus the dealer button, and rebuilds the hand from that
  (`pokernow-extension/src/table/screenReader.ts`).
- **Brain**: developed and tested offline in Python ([holdem/](holdem/)), where thousands of
  hands take minutes, then ported to the extension.

---

## Where we are

| Step | What                                                             | Status                                                                         |
| ---- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1    | CFR on a 3-card toy game (Kuhn)                                  | ✅ Found the known perfect strategy                                            |
| 2    | CFR+ on a 6-card game (Leduc)                                    | ✅ ~36x better than plain CFR                                                  |
| 3    | Hold'em equity bot                                               | ✅ Beats all test bots                                                         |
| 4    | PokerNow extension                                               | ✅ Installed and playing                                                       |
| 5    | **Smart brain: table reader + position/stack/ICM preflop** | ✅ Built and tested offline, **not yet tested live**                     |
| 6    | Range-based postflop (RangeBot)                                  | 🟡 In the Python lab: big gains vs weak bots, not yet proven vs the equity bot |
| 7    | Real-time postflop solver (CFR on the current hand)              | 🟡 River, heads-up: done and tested. Turn/flop not yet                         |
| 8    | Sit & Go simulator + self-play tuning                            | ✅                                                                             |

---

## How the smart brain thinks

### 1. It reads the whole table

From the screen (the only input): every player's seat, stack, the bet in front of them, folds and the
dealer button, giving positions (UTG ... CO, BTN, SB, BB) and this street's bets and raises. Earlier
streets aren't visible, so they're estimated. Opponent profiles come from imported past logs: **VPIP** = how often they put
money in preflop. A typical player is ~25%; a player at 50% is "loose" and gets wider ranges.

### 2. Short stacks (15 big blinds or less): all-in or fold, solved

For all-in decisions it computes the **push/fold equilibrium**: the all-in range and the
calling ranges where neither side can do better by changing. It repeats "who would call
this? then which hands should shove?" until the ranges settle. Heads-up at 10 BB it shoves
58% and the caller calls 38%, matching the known equilibrium (58% / 37%).

### 3. Tournament pressure (ICM)

Your tournament pays 1st > 2nd > 3rd > 4th, and 5th–8th lose points. So **chips aren't worth
the same to everyone**: losing your stack costs more points than doubling it gains, most
of all near the cutoff. ICM converts stacks into expected points, which gives:

- a short or medium stack near the cutoff needs much more than 50% equity to call an
  all-in. In a test, two players needed **67–68%**, so they almost never called.
- the big stack can therefore attack them: it opens and shoves wider when the players
  behind it are under pressure, and tightens when a bigger stack could bust it.
- every decision prints the numbers, e.g.
  `ICM: players behind need +11% extra equity to call, I need +12% -> open x0.95`.

### 4. Position and opening ranges

How many hands it opens depends on how many players are left to act behind it: about 14%
first to act at a full table, 30% three from the button, 45% on the button, 80% heads-up.
Then the ICM adjustment above. Example from the tests, 4 players left, 40 BB deep:
K7o on the button → raise; K2o first to act → fold; K2o on the button → just misses.

### 4b. Style by players left (v1.11.0)

([src/ai/phaseStyle.ts](pokernow-extension/src/ai/phaseStyle.ts), plan in
[REFORM.md](pokernow-extension/REFORM.md)). Every decision line starts with the phase, e.g. `[full 7p]`.

- **6-8 players (full) and 5 players:** tight and careful.
  - Before the flop: opens fewer hands (cut most in early seats, least on the button), needs more
    equity to call a raise, and calls raises only with pairs, suited hands or two cards T+
    (plus any ace in the big blind). No 3-bet bluffs.
  - After the flop: an opponent who calls or bets is read as stronger. A raise is read as two pair
    or better unless that player is known to raise a lot. No bluffing with nothing. With one pair
    against a raise: never re-raise or go all-in (unless 15 BB or less), usually fold.
  - **No all-in before the flop at 5+ players** (v1.12.0) unless the bot has 10 BB or less, or holds
    QQ+ / AK. It raises normally, calls or folds instead. Calling someone else's all-in is still allowed.
- **All tables:** the all-in math assumes opponents always call with their best hands (77+, AJs+, AQ+, AK),
  whatever their stack. Before, it assumed short stacks under tournament pressure almost never call
  ("BTN calls 3%"), so it shoved too light: A9 into a HJ raiser's 77, AT into the button's AK.
- **Position (v1.13.0):** opens wider from the button and small blind when nobody is in (and from the
  cutoff at 4 players or fewer): at 8 players UTG 7%, CO 15%, BTN 30%. In position it counts a little more
  than its raw equity after the flop, since it acts last on every street.
- **4 and 3 players (v1.15.0):** tight as well, since players here keep playing good hands: same rules
  as above, but all-in before the flop is allowed up to 15 BB (stacks are shorter by then).
- **Heads-up:** unchanged (Part 7 of REFORM.md).
- Simulator, 1,500 Sit & Gos each, new vs old at the same tables: same points
  (+6.7 vs +6.8 mixed table, +5.8 vs +5.5 tougher table) and more top-4 finishes (93% vs 91%, 87% vs 82%).

### 5. Reading opponents' ranges

Each opponent's range is narrowed by what they did:

| They...                                                                              | Assumed range                                            |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| open from early position                                                             | tight (top ~14–20%)                                     |
| open from the button                                                                 | wide (top ~45%), wider if they're loose                  |
| 3-bet                                                                                | top ~7%                                                  |
| limp                                                                                 | middle hands (strong hands would raise)                  |
| **put in 40%+ of their stack** without going all-in, e.g. calling 200 with 400 | treated like an all-in: top ~22%                         |
| go all-in short                                                                      | the push/fold equilibrium range for their stack and seat |

Game theory and psychology pull in different directions here: by the math, a 2 BB stack
should play almost **any** hand, while many humans tighten up when short. The bot starts from
the math and shifts toward each player's observed VPIP as hands accumulate.

### 6. After the flop: reading draws and sizing bets

([src/ai/postflop/](pokernow-extension/src/ai/postflop/))

- **Their range, street by street:** all 1,326 possible hands, narrowed by preflop, then
  by every postflop action. A **call** keeps made hands strong enough for the price *and*
  draws whose chance to hit (plus a bit for future winnings) beats the pot odds. A **bet**
  means strong hands plus some bluffs (draws first). A **check** removes most strong hands.
- **Draws:** for every hand they might hold: flush draw? straight outs? chance to hit next card?
- **Bet sizing by expected value:** for check, ½ pot, pot and all-in it estimates who folds
  (draws fold when the price beats their odds), who raises (their strongest hands), and our
  equity against the hands that call, then picks the best, mixing near-equal options.

A draw that hits ~20% next card needs a bet of at most ~⅓ pot to call profitably
(price = bet / (pot + 2 × bet)). Bigger bets make it a losing call. Test results with QQ
(opponent called preflop, then checked):

| Board                                        | What the bot does                 | Why                                                                |
| -------------------------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| 9♠ 6♠ 2♦                                  | **bets pot** (20/20 runs)   | ½ pot folds 55% of their draws, pot folds 79%: +664 vs +596 chips |
| K♣ 7♦ 2♥ (dry)                            | mixes ½ pot and pot              | no draws to deny, sizes are nearly equal                           |
| 9♠ 6♠ 2♦ 3♣ after a called bet           | all-in                            | still 26% draws in their range, stack is ~2× pot                  |
| 9♠ 6♠ 2♦ **A♠** after a called bet | mixes check and ½ pot, never big | the flush and an ace arrived; their flushes would raise            |

It also needs more equity before risking its stack under ICM pressure.

### Real-time river solver (step 7)

([riverSolver.ts](pokernow-extension/src/ai/postflop/riverSolver.ts))

On a heads-up river, the bot no longer uses rules: it **solves** the rest of the hand.

1. It estimates both ranges over all 1,326 hands: the opponent's from their actions,
   and its own the way the opponent sees it.
2. It builds the tree of what can still happen from the exact current betting: check,
   bet ½ pot / pot / all-in, fold, call, raise all-in.
3. It runs **CFR+** (the step 2 algorithm) for every hand of both players at once,
   ~300 iterations, under a second.
4. It plays its own hand's solved strategy, mixes included: balanced value bets and
   bluffs, and calling just often enough that bluffing it doesn't pay.

Each solve reports how far it is from perfect play (exploitability). If it's above 15%
of the pot, the bot falls back to the EV rules. Multiway rivers and earlier streets
still use the EV rules. It stops as soon as it is within 0.5% of the pot of perfect
(usually ~100 iterations), and only loops over hands possible on this board:
a typical solve went from ~0.8 s to ~0.2 s with the same answers.

**Mixing safety:** when options have nearly equal EV, the bot mixes between them so it
isn't predictable. Options more than 8% of the pot worse than the best are never picked.
(Before this limit, it once called a −782-chip spot 1 time in 20.)

**Textbook check:** strong hands (KK) or air (QJ) vs bluff-catchers (AT), pot-size bet.
Theory says bet all strong hands, bluff with half the air, call half the time. The solver:
KK bets 100%, QJ bluffs 50%, AT calls 50%, 0.02% of the pot from perfect.

**Simulator result:** no measurable difference (400 Sit & Gos: +32.1 ± 2.9 points with
the solver vs +32.5 ± 2.9 without). Rivers are only ~5% of decisions in these fast-blind
Sit & Gos (per tournament the smart bots made ~153 preflop decisions vs ~9 on the river),
and the test bots never adapt, so balanced river play has little to win against them.
Kept on: it matches theory and matters more against people who adjust. The bigger levers
are preflop and the flop, where most decisions are.

### Not getting bullied by aggressive players

Early versions assumed every bet came from a typical player's range (mostly strong hands),
so a player raising 72o every hand pushed the bot off its hands, especially heads-up.
Now each player's betting range is as wide as **their own betting frequency**:

| Learned per player                   | Used for                                                    |
| ------------------------------------ | ----------------------------------------------------------- |
| raises preflop (PFR), 3-bets         | their raising ranges are at least that wide                 |
| bets when checked to, raises vs bets | how wide their postflop betting range is (90% = mostly air) |
| folds to bets                        | how much fold equity our bets and bluffs really have        |

Each number starts at a typical value worth 8 hands and moves toward what the player
actually does. Two refinements:

- **By stack situation:** every number is also counted separately for when the player is
  short (under 15 BB or well below average), normal, or the big stack. Many players bully
  with a big stack and tighten up when short; the bot uses the numbers for their *current*
  situation (borrowing from their overall numbers while there's little data).
- **Recency:** older hands fade (half weight after ~27 hands), so the profile follows a
  player who changes gears. Test: a player tight for 60 hands, then raising every hand for
  30, is read as raising 51%, not the 33% average.

Heads-up test, they raise preflop and bet pot on K♣ 8♦ 3♠:

| Our hand             | vs typical player | vs maniac (bets 90%, folds 20%)                           |
| -------------------- | ----------------- | --------------------------------------------------------- |
| 8♥7♥ (middle pair) | calls 17/20       | raises or shoves 20/20 (equity vs their range 45% → 71%) |
| A♥5♣ (ace high)    |                   | calls 18/20                                               |

### Big bets from beginners are strong hands

Players on this site are mostly beginners: they limp and call a lot but rarely bluff with
big bets. A live hand showed the cost of ignoring that: 7 players left, a player shoved
~20 BB, the bot called with KQo and lost to 99. The bot had assumed the shover could hold
**any hand**: in theory, when everyone else is under heavy point pressure, shoving anything
pays. It also widened the range because the player was loose (played many hands), which
says nothing about how they raise.

Now ([playerRanges.ts](pokernow-extension/src/ai/preflop/playerRanges.ts), settings in
`population` in config.ts):

| Situation                                | Assumed range                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| all-in or 40%+ of stack, 16 BB or deeper | top 8% (77+, AJ+, KQs); half that for a re-raise all-in                     |
| all-in of 8 BB or less                   | the game-theory range (short stacks really do shove light)                  |
| in between                               | a blend                                                                     |
| raises and 3-bets                        | widened only by how often they *raise*, never by how many hands they play |
| bets after the flop                      | half the theory's bluffs; bets of 3/4 pot or more are narrower              |

A player seen betting or raising far more than typical gets the theory ranges back
(the maniac tests still pass). And a player with 40%+ of their stack already in the pot
is assumed never to fold a decent hand or a draw to a re-raise.

The live spot as a test (7 left, 20 BB shove, payouts 15/9/4/2/−2/−4/−9/−15, bot in the big blind):

| Hand | Before                              | Now vs unknown player           | Now vs a beginner who never raises |
| ---- | ----------------------------------- | ------------------------------- | ---------------------------------- |
| KQo  | fold by 1% (call with other stacks) | fold (33% equity vs 63% needed) | fold                               |
| AQo  | **call**                      | fold                            | fold                               |
| QQ   | call                                | call                            | fold                               |
| KK   | call                                | call                            | call                               |

A second live complaint, "calls trash preflop for 5 BB, then folds the flop", found three more leaks:

- a 12 BB player raising to 5 BB (40%+ of their stack) was treated as an all-in but judged by
  the 5 BB size, so again "any hand": K6o came within 1% of calling. Now the depth is their whole stack.
- completing the small blind in limped pots with hands like K6o / Q7o. Now only hands just
  below its opening range.
- when others had already called a raise, it compared its equity with the raiser alone
  while counting everyone's chips in the pot. Now ~6% less equity per extra caller, and
  re-shoves need a clear gain (it once shoved T8o for "+0.00 points").

Test: 18 trash-hand spots like these all fold; AJo still calls the 12 BB player's raise.

KQo still calls a 5 BB shove. In the simulator the smart bots *do* shove wide, so this read
can look slightly worse in self-play; it's set for the real players, not for bots.

### Target the fish

Balanced (game-theory) play only protects you against opponents who adapt. Against a weak
player who calls too much and rarely raises, it leaves money on the table: it bluffs them
at a "balanced" rate they never fold to. So the bot gives every opponent a **fish score**
(0 to 1) from their profile: plays far too many hands (VPIP well above 30%), mostly
passively (limps and calls rather than raising), or rarely folds to bets. A typical player
scores 0; the loose-passive regulars in the first real log score ~0.8–0.9.

| Against a fish, the bot...                    | Why                                               |
| --------------------------------------------- | ------------------------------------------------- |
| raises wider to isolate them when they limp   | heads-up with position against the weakest player |
| skips the river solver and plays their habits | value bets bigger and thinner, bluffs less        |

Tests: K4o on the button folds after an unknown player limps, but raises pot after a fish
limps (fish score 0.99, opening x1.39). On the river with top pair, weak kicker vs a fish:
the solver is skipped and it bets pot 20/20 (they call too wide).

How hard to target them (`isolateFish`, `exploitCutoff` in config.ts) is left to the
evolution run below to tune.

### 7. Learning from past games

In the extension popup, **Import past game logs** takes PokerNow log downloads
(`poker_now_log_<game>.csv`) and builds a profile for every opponent: hands played, VPIP,
PFR, 3-bet %, and the cards they showed at showdown with how they played them preflop.
Each hand is counted once, even if a log is imported twice. Profiles are matched by
PokerNow player ID, falling back to the name.

From the first log (13 hands): the table is very loose and passive. Most players put money
in 56–77% of hands but rarely raise. The bot (lnguyen258, on the old rules) played only 8%.

### 8. Think time as a weapon

The bot no longer acts instantly. In the first log it always took 1.1s, an obvious tell,
while hu	mans took a median of 2–4s and up to 27s on hard spots. Now ([timing.ts](pokernow-extension/src/timing.ts)):

- **strong hand + call:** usually a long think (5–10s), so the call looks reluctant
- **strong hand + bet:** often a long tank, so the bet can look like a bluff
- **bluffs and marginal hands also tank sometimes**, so "long think = strong" never becomes
  a reliable read against it
- folds are usually quick; big all-in decisions take a little longer
- **2 to 5 seconds in total** (`timing.minSeconds` / `maxSeconds` in config.ts), counted
  from the moment it sees its turn, *including* the time spent computing. The table's timer
  is 10 s. All thinks are scaled into that window rather than cut off, so a quick fold stays
  near 2 s, a long tank near 5 s, and they still vary (lots of thinks lasting exactly the cap
  would be a tell). Earlier caps of 12 s, then 6 s, were too slow at the table.

### 9. Auto-start

([src/main.ts](pokernow-extension/src/main.ts))

- The bot starts by itself on every PokerNow game page. **Kill Bot** keeps it off on that
  page until you press Start or reload the page; a reload always starts a fresh bot.
- Only one bot plays a game: if the same game is open in two tabs, the newest tab plays.
- Clicking the extension icon only shows the status.
- You register and take your seat yourself (auto-seat was removed in v1.7.0; the popup's
  name box went with it, since the bot finds its own seat on screen by `.you-player`).
- **Keep the PokerNow tab visible** (e.g. in its own window). Chrome slows down timers in
  hidden tabs, sometimes to once a minute, and the bot would miss its turns.

### 9b. Learning from every game (v1.14.0)

([docs/LEARNING_PIPELINE.md](pokernow-extension/docs/LEARNING_PIPELINE.md))

1. **Record:** on game pages the extension writes down every hand as it's played, from the screen: blinds,
   folds, calls, bets, raises, checks, the board, cards shown at showdown, stacks before and after, and the
   bot's own decisions with its reasons.
2. **Learn:** hands where every chip adds up update the opponent profiles, so the bot spots fish, maniacs
   and nits during the game and remembers them next time.
3. **Export:** popup → Recorded games → **Download games** (a JSON file).
4. **Review:** `npm run review` (newest download) writes a report in `tools/reviews/`: results by seat and
   by table size, biggest losses, our all-ins, showdowns, and how each opponent plays. Send it to Claude
   to turn bad hands into tests and fixes.

### 10. Sit & Go simulator and self-improvement

([src/sim/](pokernow-extension/src/sim/))

An offline 8-player Sit & Go: 1000-chip stacks, blinds from 10/20 rising every 10 hands,
side pots, busting, and your payout table. The dealer writes **PokerNow-format log lines**,
and the smart bot reads them with its real parser, so the simulator tests the same code
that plays live. About 5 tournaments per second.

```
cd pokernow-extension
npm run sim -- --tournaments 500                  # mixed table (default seats)
npm run sim -- --tournaments 200 --seats smart,smart,smart,smart,smart,smart,smart,smart
npm run tune -- --rounds 8 --tournaments 300      # self-play tuning of CONFIG.tuning
```

Opponent memory is reset each tournament (strangers); add `--memory` to keep it (regulars).

**Baseline, 500 tournaments** (default seats; points with your placeholder payouts):

| Bot                | Points / tournament    | Avg place | Top 4 | Wins |
| ------------------ | ---------------------- | --------- | ----- | ---- |
| smart              | **+47.5 ± 2.3** | 2.73      | 90%   | 25%  |
| nit (top 12% only) | +36.1 ± 3.1           | 3.17      | 81%   | 9%   |
| equity (step 3)    | +7.2 ± 2.9            | 4.89      | 37%   | 15%  |
| random             | −7.1 ± 2.4           | 5.33      | 26%   | 1%   |
| maniac             | −11.7 ± 3.5          | 6.02      | 21%   | 7%   |
| calling station    | −16.8 ± 2.8          | 6.24      | 19%   | 2%   |

**How the tuner improves the bot:** each round the current best settings play 3 slightly
changed versions plus a field (original settings, equity bot, nit, maniac). A change is kept
only if it scores more than one standard error better. At the end, a separate 1000-tournament
match against the original settings checks the gain is real, not luck. Results are saved to
`tools/sim-results/tuning.json`. Copy good settings into `tuning` in config.ts.

**First tuning run** (8 rounds × 300 tournaments + 1000-tournament check): only one change
passed a round (realiseOOP 0.9 → 0.865), and the final check found **no clear difference**
(+30.5 ± 1.9 vs +29.2 ± 1.9 points). So the defaults are already close to the best values
of these knobs against this field; config.ts is unchanged. Bigger gains need new
abilities, not knob tweaks.

What it tunes: how wide it opens, the equity needed to 3-bet, extra equity to call raises
in/out of position, how much equity it keeps out of position, how much it mixes,
how hard it targets fish.

### 11. Evolution: 100,000 tournaments of self-play

([src/sim/evolve.ts](pokernow-extension/src/sim/evolve.ts))

The tuner above changes one setting at a time. Evolution searches more broadly:

1. A **population of 16 smart bots**, each with its own settings. The original settings
   stay in the population as a fixed yardstick.
2. Each **generation** plays 520 Sit & Gos, 8 of them per table, everyone seated equally often.
3. The 6 best scorers survive. The other 9 slots go to **children**: settings mixed from two
   survivors plus small random changes (smaller changes as the run goes on).
4. Scores are weighted toward recent generations, because the field keeps getting stronger.
5. At the end, a **playoff**: the best bots of the whole run plus the original sit at
   the same tables for 5,000 tournaments. The winner is compared with the original
   tournament by tournament (same tables, so far less luck in the comparison).

```
npm run evolve -- --tournaments 100000                # 8 evolving bots per table
npm run evolve -- --tournaments 100000 --fish 2       # 6 evolving + 2 fish (like the real tables)
npm run evolve -- --resume                            # continue after a stop
```

Runs on all CPU cores but two (~5 tournaments/s with 26 workers, so 100,000 takes ~5.5 h).
Progress is saved every generation in `tools/sim-results/evolution.json`.

**First run (Nov 2, 2026):** stopped early at 5,200 tournaments (10 generations), then the
5,000-tournament playoff. Winner **g83: +0.75 ± 0.38 points per tournament vs the original**
(clear). Now in config.ts:

| Setting             | Before | g83   | Meaning                                             |
| ------------------- | ------ | ----- | --------------------------------------------------- |
| openScale           | 1.0    | 0.631 | opens about a third fewer hands                     |
| threeBetEquity      | 0.58   | 0.531 | 3-bets for value a bit more often                   |
| callPenaltyIP       | 0.03   | 0.022 | calls raises slightly lighter in position           |
| callPenaltyOOP      | 0.07   | 0.096 | needs more to call raises out of position           |
| realiseOOP          | 0.9    | 0.893 | (about the same)                                    |
| postflopTemperature | 0.04   | 0.057 | mixes a little more between near-equal options      |
| exploitCutoff       | 0.35   | 0.182 | switches from balanced to exploiting players sooner |

Caveat: this was learned against copies of itself, not against real players.

### Shark mode

A second set of settings for tables of strong players, switched on with **Shark mode** in
the popup. Normal mode (the default) stays tuned for beginners and fish. The console shows
which mode each hand is played in.

Strong players shove and bluff at game-theory rates, so shark mode switches off the
beginner reads ("big bet = strong hand", half the bluffs). Its settings come from their own
evolution run:

```
npm run evolve -- --mode shark --tournaments 10000    # 5 evolving bots + 3 sharks per table
```

The fixed "sharks" are the current bot with theory reads. The evolution also tunes how much
bluffing and how wide a shove range to expect (`bluffBelief`, `bigBetRange`). Results go to
`tools/sim-results/evolution-shark.json`; the winner goes into `SHARK_MODE` in config.ts.

**First shark run (Nov 2, 2026):** 10,000 tournaments + 5,000-tournament playoff. Winner
**g181: +0.40 ± 0.38 points per tournament** over the starting point (just clear). Compared
with normal mode it opens slightly fewer hands (0.60 vs 0.63), is much pickier calling raises
out of position, expects to win less of its equity out of position, and keeps the theory
reads (wide shoves, full bluffing). It finished just ahead of the sharks themselves
(+0.22 vs +0.06 to −0.16), so against strong opponents expect a small edge, not a big one.

The simulator also has a **fish** opponent now (`--seats ...,fish`): limps and calls with
60% of hands, calls down with any pair or draw, raises only with very strong hands, like
most of the table in the first real log.
Limits: the field is still bots, so the tuner can learn to beat bots rather than people;
keep the verification step, and check changes against your real logs.

### Example output (browser console, F12)

```
[table] hand #42: P0 CO 2600 | *Me BTN 3000 | P3 SB 1800 | P4 BB 2200
[preflop] A9o in BTN, 11.0 BB effective. Push/fold: all-in range 43%, everyone folds 0%.
          P3 calls 2% (needs 67%), P4 calls 2% (needs 68%), P1 calls 100% (needs 24%).
          All-in +2.45 pts vs folding -> ALL-IN
```

---

## Setup (after editing code)

1. **Check your payouts** in [src/config.ts](pokernow-extension/src/config.ts)
   (now 15/7.5/5/3.75/−3.75/−5/−7.5/−15 since v1.13.0, the reference bot's table: a bigger jump
   between 4th and 5th, so surviving the bubble is worth more).
2. `cd pokernow-extension`, then `npm test` (checks the math), then `npm run build`.
3. In `chrome://extensions`, click reload ↻ on the extension, then reload the PokerNow tab.
4. Click the extension icon and **type your PokerNow name exactly as shown at the table**.
   That's how it finds your seat in the log.
5. Start the bot and watch the console (F12). You should see `[table]` and `[preflop]` lines.
   If you see `table not readable, using the plain equity bot`, the log couldn't be read:
   send me the console lines.

To switch brains, set `brain` in [config.ts](pokernow-extension/src/config.ts) to `"smart"`,
`"equity"` or `"rules"`.

---

## Test results

### Extension math (`npm test`)

| Check                                                                               | Result                   |
| ----------------------------------------------------------------------------------- | ------------------------ |
| ICM example worked by hand (stacks 5000/3000/2000)                                  | ✅ 38.39 / 32.75 / 28.86 |
| PokerNow log parsing: hand number, seats, actions, positions, stacks                | ✅                       |
| Real log download: 13 hands, every hand's ending stacks match the next hand's start | ✅                       |
| Log import counts each hand once                                                    | ✅                       |
| QQ bets big on a two-spade flop; slows down when the flush card comes               | ✅                       |
| Heads-up push/fold at 10 BB vs known equilibrium                                    | ✅ 58% shove / 38% call  |
| K7o button 4-handed deep opens, K2o first to act folds                              | ✅                       |
| Calls a 2 BB all-in from the small blind with Q9o in the big blind                  | ✅ (needs only 26%)      |
| 55 folds to a flop raise on Q-J-9 after its 3-bet was called                        | ✅ 20/20                 |
| Fish score: typical player 0, loose-passive caller 0.94                             | ✅                       |
| K4o on the button: folds vs an unknown limper, isolates a fish limper               | ✅                       |
| River top pair vs a fish: no solver, bets for value                                 | ✅ 20/20                 |
| Think time never exceeds 6 s in total, computing time included                      | ✅                       |

**Not yet verified live:** the log endpoint and message format come from pokernow-gpt's code,
not from my own access to PokerNow. Watch the first hands.

### Python lab (heads-up, bb/100 with 95% confidence interval)

| Matchup                       | Equity bot (step 3) | Range bot (step 6)                                                  |
| ----------------------------- | ------------------- | ------------------------------------------------------------------- |
| vs calling station            | +269 ± 44          | **+858 ± 124**                                               |
| vs random                     | +744 ± 133         | +531 ± 209                                                         |
| vs maniac (raises everything) | +1072 ± 205        | **+1043 ± 299** (was −69 ± 424 before learning aggression) |
| range bot vs equity bot       |                     | +85 ± 85 (was +52 ± 80; right at the edge of proven)              |

Learning each opponent's raise and re-raise frequencies fixed the maniac problem: it no
longer assumes "a raise = a strong hand" for a player who raises everything.

---

## What's in each folder

| Path                                                                                     | What it is                                                        |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [techniques.md](techniques.md)                                                            | Research notes: how top poker AIs work                            |
| [step1_kuhn_cfr.py](step1_kuhn_cfr.py), [step2_leduc_cfr_plus.py](step2_leduc_cfr_plus.py) | CFR learning steps                                                |
| [holdem/](holdem/)                                                                        | Python lab: dealer, bots, match runner                            |
| [holdem/ranges.py](holdem/ranges.py), [holdem/range_bot.py](holdem/range_bot.py)           | Range model + range bot                                           |
| [pokernow-extension/src/table/](pokernow-extension/src/table/)                            | Table reader: log parsing, seats/positions, opponent stats        |
| [pokernow-extension/src/ai/icm.ts](pokernow-extension/src/ai/icm.ts)                      | Tournament math                                                   |
| [pokernow-extension/src/ai/preflop/](pokernow-extension/src/ai/preflop/)                  | Hand ranges, push/fold solver, opponent ranges, preflop decisions |
| [pokernow-extension/src/ai/smartBrain.ts](pokernow-extension/src/ai/smartBrain.ts)        | Puts it together                                                  |
| [pokernow-extension/tools/](pokernow-extension/tools/)                                    | Equity table builder, tests                                       |

---

## Do we need a GPU?

No. Everything here runs on a laptop CPU. Pluribus beat pros at six-player tables using CPUs
only. A GPU only matters if we later replace tables with neural networks (Deep CFR).

---

## Next steps to a new level

1. **Test the smart brain live** and fix whatever the real log does differently.
2. **Real-time postflop solving:** at each postflop decision, solve the current hand with
   CFR from both players' estimated ranges, with a few bet sizes (techniques.md's
   "blueprint + real-time search"). This replaces the rough equity-vs-pot-odds rules with
   balanced bluffs, value bets, check-raises and checking with strong hands. Two-player
   pots first, written in TypeScript to run inside the extension.
3. **Learn from showdowns:** when an opponent shows cards, check them against the range we
   assigned and adjust that player's model. This is the most direct "read" we can get.
4. **Stats beyond VPIP:** raise frequency, fold to c-bet, fold to 3-bet, and how each player
   changes when short-stacked, to separate a tight player from a desperate one.
5. **Tournament simulator:** 8 players, rising blinds and your payouts, to measure the
   smart brain in points per tournament before changes go live.
6. **Fix the range bot vs maniacs**, then use its EV-based postflop logic in the extension
   until the solver is ready.

---

## Limits to keep in mind

- PokerNow can change its page or log format; [ui.ts](pokernow-extension/src/ui.ts) and
  [logReader.ts](pokernow-extension/src/table/logReader.ts) are what to fix.
- Raises use PokerNow's preset buttons only: min, ½ pot, pot, all-in.
- Opponent stats only count hands the bot was dealt into, and may miss actions that happen
  after the bot's last decision in a hand.
- **Rules:** I couldn't load PokerNow's terms. Only run the bot in games you host, with
  everyone knowing it's a bot.
