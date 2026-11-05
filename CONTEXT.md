# Handoff context: PokerNow poker bot

For the next agent picking up this project. Written Nov 1, 2026. [README.md](README.md) explains
the bot for the user; this file covers state, decisions, gotchas and open work.

## The user and how they work

- Building their first poker bot and wants it to keep improving. Comfortable running commands
  and loading the Chrome extension; prefers plain explanations, results first.
- Plays 8-player Sit & Go tournaments on PokerNow (8 players, 1000 chips, blinds 10/20 rising).
  Points: 1st > 2nd > 3rd > 4th positive, 5thâ€“8th negative. The user set
  `CONFIG.payouts` in [config.ts](pokernow-extension/src/config.ts) to 15/9/4/2/âˆ’2/âˆ’4/âˆ’9/âˆ’15.
- They ask for something, then come back with live observations ("it folds K2", "it got
  bullied by 72o", "lost with 55"). Reproduce each one as a scenario test before fixing.

## Position on where the bot plays (keep it)

- The user's log (`poker_now_log_*.csv`) is from the **public PokerNow network Sit & Go lobby**
  (network.pokernow.com/sng_tournaments), with strangers and a season leaderboard. The user
  says that lobby is a "bot training ground"; this is unverified and the lobby page doesn't say so.
- I **declined to build auto-registration for that public lobby** and recommended not running
  the bot there (strangers haven't agreed to play a bot; ranked points come from real people;
  PokerNow's terms page 404'd, so the rule is unknown). Auto-start and auto-seat (host must
  approve) were built for **private games**. Don't add lobby automation or bot-detection evasion.

## Project layout

| Path | What |
|---|---|
| `techniques.md` | User's research notes on poker AI (CFR, Libratus, Pluribus...). The roadmap source |
| `step1_kuhn_cfr.py`, `step2_leduc_cfr_plus.py` | CFR learning steps (pure Python, verified) |
| `holdem/` | Python lab: heads-up dealer, EquityBot, RangeBot, `match.py` (bb/100 with 95% CI) |
| `pokernow-extension/` | **The live bot**: Chrome extension (MV3, TypeScript, webpack), originally github.com/EsawAdhana/pokernow-bot |
| `poker_now_log_pglAXBOT3xEA2PCEteO7Cq5_i.csv` | Real PokerNow log (13 hands). Used by tests |
| `README.md` | User-facing explanation and results |
| `pokernow-extension/docs/LEARNING_PIPELINE.md` | Record every hand from the screen -> learn opponent profiles -> export JSON -> `npm run review` report |
| `pokernow-extension/SUMMARY_REFERENCE.md` | Study of huynq55-v3/poker_tournament (Rust Deep CFR bot the user says is top on PokerNow): position features, seat thresholds, ICM tax, payouts, ideas ranked by REFORM part. Don't adopt its lobby auto-join or PokerStars scripts |

Extension source (`pokernow-extension/src/`):

| Path | Role |
|---|---|
| `main.ts` | Content-script loop (500 ms), think-time delay, auto-start on game pages, Kill, one bot per game |
| `ui.ts` | DOM reading and clicking (selectors from the original repo) |
| `action.ts` | Executes `check_or_fold` / `call` / `raise` with presets `min`, `1/2_pot`, `pot`, `all_in` |
| `config.ts` | Payouts, brain choice, push/fold depth, timing, `tuning` knobs (incl. river solver) |
| `timing.ts` | Think time by hand strength, deliberately mixed so timing isn't readable |
| `table/logReader.ts` | Parses PokerNow log lines; fetches `/api/games/<id>/log_v3` |
| `table/csvLog.ts` | Parses log CSV downloads (columns `entry,at,order`, newest first) |
| `table/tableView.ts` | Seats, positions, stacks, invested, `situationOf()` |
| `table/stats.ts` | Player profiles: overall + by stack situation (short/normal/big), shrinkage, recency decay 0.975 |
| `ai/decide.ts` | `decideWithView()`: pure decision, no DOM (used live and in the simulator) |
| `ai/smartBrain.ts` | Live: read table, then `decideWithView`; falls back to the equity bot |
| `ai/icm.ts` | Malmuth-Harville ICM, `requiredEquityAllIn` |
| `ai/preflop/` | 169-hand ranges + equity table, push/fold fixed-point solver, opponent preflop ranges, preflop brain |
| `ai/postflop/` | Board/draw analysis, postflop range narrowing, EV-based bet sizing, **river CFR+ solver** |
| `ai/equity/` | Hand evaluator, Monte Carlo equity, step-3 equity bot (fallback) |
| `sim/` | 8-player Sit & Go dealer (writes PokerNow-format logs), sim bots, runner, tuner |
| `pages/popup.*` | Popup: status first, start/kill, game type, shark mode, log import, profile list |

Data: `src/ai/data/equity169.json` (169Ã—169 preflop equities, built by `tools/buildEquityTable.js`).

## Commands (from `pokernow-extension/`)

- `npm test`: math, parser and scenario tests (`tools/test.js`), incl. the real CSV, then `npm run smoke`
  (`tools/smoke.js`: loads the built main.js into fake empty pages; catches load-time crashes, popup answer,
  auto-start, Kill, one bot per game, takeover). `TODO [part N]` lines are REFORM targets, not failures
- `npm run build`: builds `dist/` (what Chrome loads). **The user's Chrome runs `dist/`**: to
  verify a build without touching it, use `npx webpack --output-path <scratch dir>`
- `npm run sim -- --tournaments 500 [--seats smart,equity,...] [--memory] [--save name]`: about 2 tournaments/sec now;
  also prints bb/100 by table phase; `--save` writes tools/sim-results/<name>.json
- `npm run tune -- --rounds 8 --tournaments 300`: self-play random local search over `CONFIG.tuning`
- `npx tsc --noEmit -p .`: type-check
- Python lab: `cd holdem && python match.py range equity 2000`

User reload steps: `chrome://extensions` â†’ reload â†» on PokerNow Bot â†’ F5 the game tab.

## Verified results

- Kuhn CFR: exploitability 0.0016, matches the known equilibrium. Leduc: CFR+ ~36Ã— better than CFR after 300 iterations.
- Parser on the real log: all 12 hand transitions reconcile stacks exactly (`calls X` = street total).
- Heads-up push/fold at 10 BB: 58% shove / 38% call (known: 58% / 37%).
- River solver textbook spot: KK bets 100%, QJ bluffs 50%, AT calls 50%, 0.02% of the pot from perfect. Real solve ~0.9 s at 300 iterations.
- Simulator, 500 Sit & Gos: smart +47.5 Â± 2.3 points, 90% top 4 (nit +36, equity +7, random âˆ’7, maniac âˆ’12, station âˆ’17).
- River solver on vs off: no measurable difference (+32.1 vs +32.5 Â± 2.9). Rivers are ~5% of decisions (per tournament: ~153 preflop, 47 flop, 21 turn, 9 river).
- Tuner: no clear gain over the defaults (+30.5 vs +29.2 Â± 1.9); config left unchanged.
- Python lab: range bot vs maniac went from âˆ’69 to +1043 bb/100 after learning aggression; vs equity bot +85 Â± 85 (borderline).

## State at handoff (updated Nov 1, 2026, second session)

- All tests pass (`npm test`), `dist/` rebuilt with everything below.
- Payouts: since v1.13.0 `CONFIG.payouts` = 15/7.5/5/3.75/-3.75/-5/-7.5/-15 (user adopted the reference bot's table,
  SUMMARY_REFERENCE.md; before: 15/9/4/2/-2/-4/-9/-15). Sim points before/after v1.13.0 are on different scales.
- **Turn timer is 10 s.** The bot nearly timed out: think time was capped at 12 s *plus* compute.
  Now `timing.minSeconds = 2`, `maxSeconds = 5` (user: 6 s still too slow) is a total budget from when the turn is seen (`remainingWait`
  in timing.ts subtracts compute time; `fitToBudget` compresses long thinks instead of clipping).
- **Target the fish** (user's request): `fishScore(profile)` in stats.ts (loose Ã— passive/sticky).
  Preflop isolates fish limpers wider (`tuning.isolateFish`); river solver skipped vs fish
  (`tuning.exploitCutoff`), EV rules exploit instead. Sim has a `fish` bot (loose-passive).
- River solver ~3.5Ã— faster: loops over live combos only, precomputed tie groups, early stop at
  0.5% pot exploitability (`solveRiver(spot, iters, target)`). Same answers in tests.
- **Evolution** (`npm run evolve`, src/sim/evolve.ts): user asked for 100,000 self-play tournaments
  with 8 smart bots and picking the best. Population 16, 520 tournaments/gen, 6 elites + original
  anchor, crossover + mutation, recency-weighted fitness, then a 5,000-tournament playoff with paired
  comparison vs original. worker_threads, ~5/s. Checkpoint + `--resume` in tools/sim-results/evolution.json.
  A run was started Nov 1 (~5.5 h, 24 workers, log in tools/sim-results/evolution.log).
  Pure self-play can't measure the fish knobs (no fish at the table); `--fish 2` is the follow-up.
  Don't copy the winner into config.ts unless the playoff says it's clearly better.
- **Beginner read** (user: "players here rarely bluff; big bet = good hand"; they'd only call a
  deep preflop all-in with 5+ players left with AA/KK). Live leak: called a 20 BB shove with KQo, 7 left.
  Cause: push/fold equilibrium gave the shover ~100% of hands (ICM pressure on callers), widened by VPIP.
  Fix: `bigBetShare` / `raiseStyle` in playerRanges.ts (deep shoves = top 8% x raise frequency, never VPIP),
  `CONFIG.population` (bigBetRange 0.08, bluffBelief 0.5; not self-play tuned on purpose), postflop bets
  value-heavier unless the player is proven aggressive, plus "strong enough for the price continues"
  and "40%+ of stack in = doesn't fold" in the continue model (needed to keep 55-on-QJ9 folding).
  Evolution was restarted on this code (first run stopped at 3,640 tournaments).
- Live complaint "calls trash preflop for 5 BB then folds the flop": committed raises used the raise
  size as depth (now the raiser's stack), SB completes too wide (share + 0.05 multiway), cold callers
  ignored in call equity (now âˆ’6% each), re-shove needed only gain > 0 (now 0.5% of payout spread).
  Evolution restarted again on this code; stopped early at 5,200 (user asked), playoff winner g83
  +0.75 ± 0.38 pts/tournament vs original (paired, 5,000 tournaments) -> applied to CONFIG.tuning
  (openScale 0.631, threeBetEquity 0.531, callPenaltyIP 0.022, callPenaltyOOP 0.096, realiseOOP 0.893,
  postflopTemperature 0.057, exploitCutoff 0.182). Tests K7o->K9o and fish-isolation hand adjusted to the tighter range. User asked for lobby auto-join + auto re-register:
  declined again (public lobby, see above).
- **Shark mode** (user request): popup toggle (storage key sharkMode) -> src/mode.ts applies SHARK_MODE
  (config.ts) over CONFIG.tuning/population per decision. Normal mode stays default. evolve --mode shark:
  5 evolving + 3 fixed sharks (= normal tuning + theory reads bigBetRange 1, bluffBelief 1), also evolves
  bigBetRange/bluffBelief; saves evolution-shark.json. smartBot now takes tuning+population genes.
  Shark run done Nov 2: winner g181 +0.40 ± 0.38 vs base (just clear) -> applied to SHARK_MODE.
- The user said the first (equity) bot felt better. No live comparison exists; offline the smart bot
  wins big, but the sim field isn't like real players. Real-log leak report is the way to settle it.
- The user lost an all-in on the river with the Aâ™¦ flush (4 diamonds on board) to a slow-played
  straight flush. That's a cooler, not a leak; no change made. Ask for the log to confirm.
- Nothing has been validated in a live game since the smart brain was added; all evidence is offline.

## Gotchas learned

- When editing TS/JS through Python heredocs, `\n`, `\d` and similar escapes broke files
  several times. Prefer the Edit tool for anything with backslashes or template literals.
- The simulator once reused hand IDs and seat-based player IDs, which silently froze
  learning. Hand IDs must be unique across tournaments and player IDs come from labels.
- The sim dealer swallows bot exceptions as folds; instrument when results look odd.
- The dead-button case in logs has no `(dealer: ...)`; the table view keys off the blind posters.
- Mixing (softmax) must not pick clearly bad options; it once called a âˆ’782-chip spot 1 time in 20.
- The extension can only use PokerNow's preset raise sizes.
- Chrome slows timers in hidden tabs; the user should keep the game tab visible.

## Recommended next steps (agreed direction, not started)

1. **Leak report from real logs**: points/chips lost by position, stack depth, street, decision type.
2. **Stronger simulator opponents**: all-smart tables plus an exploiter bot that learns the
   smart bot's habits. The current field is too weak to show improvements.
3. **Learning from showdowns**: compare shown hands with the assumed range and update that player's model.
4. **Flop/turn solver** (depth-limited, estimated leaf values). Biggest strategic jump; build after 1â€“2 can measure it.
5. Later, optional: preflop strategy from MCCFR self-play, custom bet sizes via the raise input, neural nets.

- v1.1.0 (Nov 2): turn-speed fixes. Chrome throttles timers in covered/background tabs (down to 1/min), so main.ts now
  also wakes on page changes (MutationObserver) with busy/lastActed guards; log fetch aborts after 2 s; ai.ts gives
  the smart brain 3 s total, then falls back to the equity bot. Decisions themselves take < 0.1 s (measured).
- v1.1.1 (Nov 2): preflop think time is now the same short 2.0-2.7 s for every action (strong-hand tanks and the
  all-in "big pot" bonus made preflop push/fold hit the 5 s cap). Postflop timing unchanged.
- v1.2.0 (Nov 2): "checks down 552 with a 2" = the equity FALLBACK bot (smart brain bets K2/72 there every street; the
  fallback needed 72% vs a random hand). Popup status now shows the last decision's brain + fallback reason (ai.ts
  lastBrain; smartBrain throws when the table can't be read). Fallback bets 1/2 pot heads-up when checked to with
  58%+. Log fetch timeout 3 s, smart-brain limit 4 s.
- v1.2.1 (Nov 2): "bot doesn't play anymore" fix. The 1.1.0 page watcher fires the instant the turn appears, often
  before the cards are drawn -> getState threw -> busy stayed true forever and nothing restarted the loop. botLoop
  now catches every error and retries; a 1 s heartbeat calls botLoop; a stuck turn resets after 8 s. Tested with a
  fake page (scratch harness): bad card reads recover, 8/8 turns played.
- v1.3.0 (Nov 2): site list is configurable. sites.json (+ `npm run build -- --env site=<url>`) -> webpack writes
  manifest content_scripts.matches + host_permissions; YOUR-SITE placeholder entries skipped. Popup Start checks the
  tab against the manifest's patterns. The user runs their own bot-vs-bot site; it must mirror PokerNow's DOM classes
  and /api/games/<id>/log_v3 (see docs/HOW_IT_WORKS.md section 9) or needs an adapter in ui.ts / logReader.ts.
- Nov 2: `autoplay-helper/` = "Bot Table Helper" extension (plain JS MV3, no build) for the USER'S OWN bot site:
  lobby Join -> Go to the room -> start PokerNow Bot -> game-over text -> stop bot -> Back to tournaments, repeat.
  Refuses PokerNow hosts. Site saved in popup (optional host permission + scripting.registerContentScripts); one
  "driver" tab tracked in background.js (follows tabs it opens). Talks to PokerNow Bot (v1.4.0 hook in main.ts,
  non-PokerNow hosts only) via document CustomEvents pokerbot-helper (start/stop/ping) / pokerbot-status
  (running/off). Flow tested with jsdom fake pages (2 full loops). Zip: autoplay-helper-1.0.0.zip.
- v1.5.0 (Nov 2): smart brain works without PokerNow's game log (user's own site). src/table/screenReader.ts reads
  seats from the page (name, stack, bet, fold, dealer button; PokerNow class names) and writes a plausible HandLog
  (blinds from button or BB bet, this street's bets ascending = bet/raise then calls, earlier streets = equal calls);
  never recorded into profiles; page pot overrides the rebuilt pot. smartBrain: log first (<=1.5 s of retries), then
  page. Popup: "smart brain (page only: no game log)". 5 new tests + jsdom check of the DOM reader.
  NOTE: user edited autoplay-helper/shared.js isPokerNow() to return false (helper on PokerNow). I declined to support
  that; PokerNow Bot's helper hook still ignores PokerNow hosts.
- v1.6.0 (Nov 2): user confirmed THERE IS NO GAME LOG. Live input = screen only. Removed fetchCurrentHand /
  gameIdFromUrl / the log path from smartBrain (bundle has no fetch). logReader.ts stays as the CSV-import parser and
  HandLog type. Consequence: live play builds no opponent profiles (screen hands are guesses, never recorded);
  players are "typical" unless CSV logs are imported. Docs (HOW_IT_WORKS 5.3, 9.3) and README updated.
- v1.7.0 (Nov 2): auto-seat REMOVED at the user's request (they register and sit themselves). autopilot.ts = auto-start
  only; popup name box removed too (only auto-seat used it; seat found by .you-player). Docs/README updated.
- v1.8.0 (Nov 2): CASH GAME project started. Plan: pokernow-extension/docs/CASH_GAME_PLAN.md (steps 0-6:
  switch -> cash simulator -> screen action recorder (live profiles) -> deep preflop -> deep postflop/turn solver ->
  evolve -> results tracking). Step 0 DONE: CONFIG.gameType "tournament"|"cash" (popup radio, storage "gameType",
  applied in mode.ts loadMode). icm() returns chips in cash -> requiredEquityAllIn = 0.5, push/fold chip EV;
  re-shove margin 0.1 bb in cash. Test added. Waiting on user: table size, buy-in depth, rake, opponent mix.
- Cash step 1 DONE: src/sim/cash.ts (`npm run cash -- --hands N [--pool ...]`), 10 seats 1/2, buy-in 200, top-up,
  no rake, 300-hand sessions, worker pool, bb/100 +-95%. Baseline 60k hands: shark +709, smart +659, nit -79,
  fish -166, equity -667 (cartoon opponents -> only for comparing versions). ~260 hands/s. engine.ts now exports
  playHand/Seat. User's table: 10-max, 1/2 fixed, avg stack 200, no rake, mix of bots/weak/strong.
  Next: step 4 screen action recorder (live profiles), then deep preflop.
- Nov 2: pushed to https://github.com/lnguyen258/pokerbot-pokernow (branch main), repo root = Quant/pokerbot.
  Not pushed (.gitignore): node_modules, dist, tools/.build*, __pycache__, poker_now_log_*.csv (real players' names),
  autoplay-helper/ + zip (user's edit enables it on PokerNow; declined to publish). pokernow-extension's old upstream
  .git (EsawAdhana, 1 commit, none of ours) moved to Quant/pokernow-bot-upstream.git as a backup.
- v1.8.1 (Nov 2): user asked for "thinking time as a strategy" back on preflop. Removed the v1.1.1 flat preflop
  timing: preflop now uses the same strength-based acting-out as postflop (still squeezed into the 2-5 s budget).
- v1.9.0 (Nov 2): exact bet sizes. Raises TYPE the amount ("raise to" = our street total) into the first text/number
  input of .raise-controller-form (native value setter + input/change events), verify, submit; preset button is the
  backup. Action.amount; src/ai/sizing.ts raiseTo()/raiseLimits(). Preflop opens 3 bb cash / 2.5 bb tourney (+1 bb per
  limper), 3-bets 3x IP / 3.5x OOP (+1x per caller, all-in if 40%+ of stack); knobs openSizeBB, openSizeCashBB,
  threeBetSize (also in tune.ts SPACE). Postflop bets 1/3, 1/2, 3/4, pot; raises 1/2 or pot of pot-after-call.
  Trigger: user lost with JJ (one pair) betting pot UTG into QQ. Tuned knobs were evolved with old sizes -> re-tune.
  Bet-box selector UNVERIFIED on the live site: check "[raise] typed N" in the console.
- v1.9.1 (Nov 2): updating mid-game. background.js re-injects main.js into open table tabs on install/update; the new
  copy fires "pokerbot-takeover" on document and older copies stop; a copy whose chrome.runtime.id is gone stops too.
  Auto-start (botEnabled + autoStart) restarts the new copy. Copies from <= 1.9.0 lack the takeover listener: reload
  the page once after installing 1.9.1.
- v1.10.0 (Nov 2): extension lifecycle (pokernow-extension/PLAN.md, Part 1 of REFORM.md). Popup sometimes didn't
  open: background.js onClicked/setPopup('') could remove it; popup.js was loaded twice; alert() closed the popup.
  All removed. Popup = status at top (version, "Not a PokerNow tab", "Bot not loaded: F5"), Start/Kill only on click.
  Auto-start: always on for /games/<id> pages (watched every 1 s, SPA navigation), off only after Kill (page-life
  flag `offReason`, cleared by Start or reload). autopilot.ts, botEnabled and the checkbox deleted. One bot per game:
  newest bot writes storage `activeBot {game,id}`, older tabs on that game stop (offReason "other-tab").
  Manifest icon paths fixed to Icons/. Strategy roadmap: pokernow-extension/REFORM.md (Parts 2-9 by table size).
- v1.10.1 (Nov 2): popup always said "Bot not loaded": auto-start ran at script load, getBigBlindValue() threw
  before the table was drawn, and the script died before registering onMessage. Listener now registered before
  auto-start; auto-start is deferred and wrapped in try/catch (retries every 1 s).
- REFORM Part 2 (no version, no dist change): tablePhase()/phaseTag() in tableView.ts; decide.ts logs "[full 7p]";
  sim engine onResult hook -> run.ts bb/100 by phase, --save; tools/smoke.js; test.js `todo(part, ...)` targets.
  Baseline tools/sim-results/baseline-v1.10.json (smart +6.6, 92% top 4).
- v1.11.0 (Nov 2): REFORM Part 3, src/ai/phaseStyle.ts. Full (6-8) / conservative (5): openFactor (cut by seats
  behind, button gets 1/3 of the cut), callExtra, `respected` ranges (widen(range, respect)), playsWell() for calls
  vs raises, no A2s-A5s 3-bet bluffs. Postflop: postflopRanges looseness/bluffShare/value x respect; a raise there
  = board.ts twoPairPlus only, floor 0.005 instead of 0.03 (floor dominated: 15 combos vs hundreds); no bets/raises
  with air (isAir: made < 0.4, outs < 8) at full/5 tables or into 2+ opponents (solver skipped then); one-pair guard
  vs a raise: no raise/all-in if > 15 BB, guardRealise 0.7, temperature x0.25. Knobs fullOpen/CallExtra/Respect,
  cons*, guardRealise, phaseRules (0 = v1.10 play; sim bot "oldsmart"). Sim: points tie (+6.7/+6.8 mixed,
  +5.8/+5.5 tough), top 4 93/91% and 87/82%. Loses chips at 5 players vs fish (+50 vs +111 bb/100): tune in Part 9.
- v1.11.1 (Nov 2): user saw A2 go all-in preflop. Bug: the A2s-A5s 3-bet bluff went through threeBet(), which
  turns 40%+-of-stack raises into all-in, so at 8-15 BB a 'bluff' shoved after the re-shove EV check had said no.
  Bluff now skipped when it would be all-in (test added). Still by design: heads-up BB re-shoves A2 vs a button
  open at <= 20-25 BB (re-shove EV vs an 80% opening range).
- v1.12.0 (Nov 2): user lost deepest stack with A9o re-shove vs HJ 2 BB raise (77) and ATo open-shove (BTN AK).
  Causes: (1) push/fold uses EFFECTIVE stack, so the deepest player at 22 BB shoved as if 15 BB; (2) allInAnalysis
  callers only called above their ICM-required equity, so short stacks "called 2-3%" -> shoves looked free.
  Fixes: population.allInCallFloor 0.06 (callers always call with top 6%, pushFold.ts); phaseStyle.limitShoves at
  5+ players: preflop all-in (push/fold, re-shove, 3-bet that would be all-in, 4-bet) only if own stack <=
  tuning.shoveMaxBB (10) or QQ+/AK. Sim vs v1.11.1 (bot "prev"): +6.9/+6.8 mixed, +6.0/+6.0 tough, top 4 95/93,
  88/87. Tests for both user hands. Known: shortest stack (8 BB) folds ATo in CO at 7 players (ICM, pre-existing).
- v1.12.1 (Nov 2): user: "plays really risky at 8 players", all-in on a K-7-2 three-club flop holding one club,
  called by a made flush. Part 3 rules only blocked air bets and one-pair raises; the sizing grid offered all-in
  whenever stack <= 2.5 pots and overbets to 150%. New `careful` mode (phaseStyle.limitShoves, start-of-hand stack
  > shoveMaxBB, knob postflopCareful): no option (bet/raise/call) putting in 40%+ of the stack unless strongMade()
  (two pair+ with a hole card; flush+ on a 3-suited board), calls allowed at 55%+ equity; bets capped at fullMaxBet
  0.75 pot; river solver skipped when not strong. Audit (tough table, 300 tournaments): all-ins without a strong
  hand 87 -> 0, overbets 330 -> 3. Tests for the user's flop. Sim bot `vtwelve` = postflopCareful 0.
  Sim vs vtwelve, 1,500 each: points -0.3 (+6.7/+7.0 mixed, +6.0/+6.2 tough, ~1 CI), top 4 better (96/95, 91/88),
  wins lower (20/23, 19/23). Trade-off shipped at the user's request (conservative); retune in Part 9.
- v1.12.2 (Nov 2): user: bot FOLDED the nut straight to a river all-in. Cause: riverSolver averageStrategy() returned
  1/n when our real combo had 0 weight in our modelled range (heroWeights from SELF_PROFILE, e.g. 98o after a BTN
  raise): avg is reach-weighted, regrets are not. Old since the solver was added; also made river value bets coin
  flips. Fix: fall back to regret-matching for that combo; plus postflopBrain safety net: solver fold vs a bet with
  riverEquity() >= 0.9 of their weighted range -> call. Tests: nut straight never folds at 8/4/2 players.
- v1.12.3 (Nov 2): user: bot barrels bigger with no pair into a UTG check-caller (88). Causes: postflopRanges
  check = drop 60% of top-20% hands (checks read as weakness); evOfRaise assumed callers re-fold each street.
  Fixes (knob checkCallRules, sim bot vtwelvetwo = off): check drop x (aggression/0.35, min 0.3) x 0.5 if checking
  to the preflop raiser x 0.5 after calling a postflop bet; sticky looseness x (1 + 0.3 x their postflop calls);
  noBarrel: no own pair (noOwnPair) and outs < 8 vs someone who called 1 (5+ players) / 2 (fewer) postflop bets ->
  no bet/raise, solver skipped. NOTE: user had SHARK MODE on during the risky v1.12.x sessions (bluffBelief 1,
  bigBetRange 0.954 = calls lighter); advise normal mode for their beginner games.
- v1.12.4 (Nov 2): (a) kickers: user asked if it knows top pair can be outkicked. Equity did fall with the kicker,
  but vs a typical check-raise all-in on K72 even K3 called (46%): theory bluffShare GROWS with size and FLOOR 0.03
  dominated. bigBetRule: bluffShare x belief^2 (bets >= 3/4 pot) / belief^3 (raises, all-ins), floor x belief^2 for
  big raises. Now AK/KQ/KT call, K5/K3/QQ fold; vs maniac all call. (b) user saw a big bet with king high at 4 players:
  airRule: nothing (noOwnPair, outs < 8) and not heads-up -> bets <= airMaxBet 0.5 pot, no raise, no all-in.
  Sim bot vtwelvethree = both off. Tests [kicker] and [air]. Sim vs v1.12.3: points equal (+6.8/+7.0, +6.2/+6.2),
  wins lower (22/24, 19/23).
- v1.13.0 (Nov 3): from SUMMARY_REFERENCE.md. payouts -> 15/7.5/5/3.75/-3.75/-5/-7.5/-15. positionRules: stealBonus
  0.25 (open x1.25 when unopened with <= 2 behind = BTN/SB; CO too at <= 4 players), realiseIP 1.05 (in position
  before the river). Opening chart 8p: UTG 7%, CO 15%, BTN 30% (was 24%). Sim vs v1.12.4 (bot vtwelvefour) under
  new payouts: +7.4/+7.2 mixed, +6.7/+6.2 tough, wins 24/22, 24/20. Popup: Shark-mode warning banner; decision
  history (src/history.ts, storage recentDecisions, last 15, Copy button; smartBrain.lastDecision). User asked to
  copy the reference bot's auto-join lobby script: declined again (public ranked lobby), not built.
- v1.14.0 (Nov 3): LEARNING PIPELINE (pokernow-extension/docs/LEARNING_PIPELINE.md). src/table/recorder.ts
  (HandRecorder: pure, fed Snapshots; new hand = dealer moved / board shrank / new hole cards; a bet counts only if
  the stack dropped (pot-sweep animation) and all-in players can't act; checks inferred at street end; clean =
  chips conserved + every loser lost exactly what they put in), tableSnapshot.ts (DOM, never throws),
  gameRecords.ts (storage gameRecords, 50 games x 600 hands, unlimitedStorage permission). main.ts recordTick:
  MutationObserver (150 ms throttle) + 1 s tick, game pages, bot on or off; clean hands -> addHand(toHandLog)
  -> opponent profiles (ids screen:<name>, same as the live screen reader, so profiles finally work live);
  decisions attached to the hand. Popup: Recorded games summary, Download games (JSON), Clear (click twice).
  tools/review.js (`npm run review [-- file]`, default newest ~/Downloads/pokerbot-games*.json) ->
  tools/reviews/review-<date>.md: by seat, by table size, biggest losses, our all-ins, showdowns, opponents.
  Tests: [recorder] x6 incl. fast multi-action snapshots and all-in bets left on screen.
- v1.15.0 (Nov 3): user: "too risky at 4 left, finishes 4th every time; players here play good hands 4-handed".
  shortTight: phases normal (4) and creative (3) get the full-table rule set (respect 0.85 / 0.9, open 0.9 / 0.93,
  callExtra 0.02 / 0.015, no pure bluffs, playable calls, one-pair guard, careful postflop, preflop all-in only
  <= shortShoveMaxBB 15 or QQ+/AK; PhaseStyle.shoveMaxBB per phase), no extra CO steal at 4, all-in call floor
  x1.5 at 3-4 players (pushFold). Heads-up unchanged. Sim vs v1.14.0 (bot vfourteen): points +7.3/+7.2 mixed,
  +6.2/+6.5 tough, +5.4/+5.5 nits (all ~noise); avg place 2.51/2.65 mixed; wins DOWN 19/24, 18/23, 22/23;
  bb/100 at 4 players +21 vs +71 (mixed). Shipped at user request; sim opponents are looser than the user's.
  v1.14.1 was the USER's own edit (kept): HandRecorder.attachDecision() + pending list, so a decision made on a new
  hand before the recorder saw it start joins that hand (matched by our cards), not the previous one.
