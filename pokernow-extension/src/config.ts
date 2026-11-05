/**
 * Settings you may want to change. Run `npm run build` and reload the
 * extension after editing.
 */
export const CONFIG = {
    /**
     * Tournament points for 1st, 2nd, 3rd ... 8th place. Only the DIFFERENCES
     * between places matter. These are placeholders: put your league's real numbers here.
     */
    payouts: [15, 7.5, 5, 3.75, -3.75, -5, -7.5, -15],   // v1.13.0: the reference bot's table (SUMMARY_REFERENCE.md)

    /**
     * "tournament": chips are worth tournament points (ICM, payouts above).
     * "cash": chips are money, every chip is worth the same (no ICM, no bubble pressure).
     * Switched from the popup (storage key "gameType"); this is the default.
     */
    gameType: "tournament" as "tournament" | "cash",

    /**
     * Which brain plays:
     *   "smart"  - table reader + position/stack/ICM-aware preflop + range-based postflop
     *   "equity" - step 3 bot (only its own cards and an opponent count)
     *   "rules"  - the original repo's if-then-else rules
     */
    brain: "smart" as "smart" | "equity" | "rules",

    /** At or below this many big blinds (effective stack), preflop becomes all-in or fold. */
    pushFoldDepthBB: 15,

    /**
     * Think time before acting (see src/timing.ts). maxSeconds is the TOTAL from
     * the moment the bot sees its turn, including the time spent computing.
     * Keep it well under the table's turn timer (10 s): the page check runs every
     * 0.5 s and Chrome can delay timers, so leave a few seconds of margin.
     */
    timing: { enabled: true, minSeconds: 2, maxSeconds: 5 },

    /**
     * Strategy knobs. The simulator's tuner (npm run tune) searches for better
     * values by self-play; copy its suggestions here.
     */
    tuning: {
        // Evolution winner g83 (Nov 2, 2026: 5,200 self-play tournaments + 5,000-tournament playoff,
        // +0.75 ± 0.38 pts/tournament vs the old values 1.0 / 0.58 / 0.03 / 0.07 / 0.9 / 0.04 / 0.35).
        openScale: 0.631,        // x the baseline opening ranges (1.2 = open 20% more hands)
        threeBetEquity: 0.531,   // 3-bet for value with at least this equity vs the raiser's range
        callPenaltyIP: 0.022,    // extra equity needed to call a raise preflop, in position
        callPenaltyOOP: 0.096,   // ... out of position
        realiseOOP: 0.893,       // share of our equity we keep after the flop when out of position
        postflopTemperature: 0.057, // how much it mixes between near-equal options (higher = more)
        postflopSims: 1000,      // simulations per decision after the flop (lower = faster)
        riverSolver: 1,          // 1 = solve heads-up rivers with CFR+, 0 = use the EV rules
        riverIterations: 300,    // CFR+ iterations per river solve (more = closer to perfect, slower)
        isolateFish: 1.0,        // how much wider it raises to isolate limpers who are fish (0 = no extra)
        exploitCutoff: 0.182,    // fish score above which it stops playing balanced (solver) and exploits
        openSizeBB: 2.5,         // tournament opening raise, in big blinds (+1 bb per limper)
        openSizeCashBB: 3,       // cash game opening raise, in big blinds (+1 bb per limper)
        threeBetSize: 3,         // 3-bet to this many times their raise in position (+0.5 out of position)
        preflopSizing: 2,        // 0 = old buttons (min-raise opens, pot 3-bets), 1 = fixed typed sizes above,
                                 // 2 = any size: the fixed sizes plus the adjustments below
        openPerLimper: 1,        // extra big blinds per limper
        openFishBonus: 0.5,      // extra big blinds x average fish score of players behind / limpers
        openSbBonus: 0.5,        // extra big blinds when opening from the small blind
        threeBetOopExtra: 0.5,   // extra x their raise when 3-betting out of position
        threeBetFishBonus: 0.5,  // extra x their raise x the raiser's fish score
        postflopSizing: 2,       // 0 = old (bet 1/2 or pot, raise pot), 1 = bet 1/3, 1/2, 3/4, pot; raise 1/2, pot,
                                 // 2 = any size (best EV from 20% of the pot up to maxOverbet)
        maxOverbet: 1.5,         // biggest bet as a share of the pot (with postflopSizing 2)
        sizeSpread: 0.08,        // random +-share on the chosen size so it doesn't give the hand away
        reverseImplied: 0,       // cost of a called bet before the river when behind (x bet x share behind)
        // Style by players left (src/ai/phaseStyle.ts, REFORM.md Part 3). Full = 6-8 players, cons = 5.
        phaseRules: 1,           // 1 = play by table phase; 0 = same style at every table size (v1.10 and before)
        fullOpen: 0.8,           // x opening share at a full table (tighter)
        fullCallExtra: 0.04,     // extra equity to call a raise preflop at a full table
        fullRespect: 0.7,        // x opponents' calling / raising range sizes at a full table (stronger)
        consOpen: 0.92,          // ... with 5 players
        consCallExtra: 0.02,
        consRespect: 0.85,
        shortTight: 1,           // 1 = tight at 4 and 3 players too (v1.15.0); heads-up unchanged
        normalOpen: 0.9,         // 4 players: x opening share (UTG side; the button gets a third of the cut)
        normalCallExtra: 0.02,   // 4 players: extra equity to call a raise preflop
        normalRespect: 0.85,     // 4 players: x opponents' calling / raising range sizes (stronger)
        creativeOpen: 0.93,      // 3 players: same three
        creativeCallExtra: 0.015,
        creativeRespect: 0.9,
        shortShoveMaxBB: 15,     // 3-4 players: preflop all-in / big commitments only with this many BB or less (or QQ+ / AK)
        positionRules: 1,        // 1 = steal seats open wider, in position realises more equity (v1.13.0)
        stealBonus: 0.25,        // x(1 + this) opening share on the BTN / SB (and CO at 4 players or fewer), unopened
        realiseIP: 1.05,         // share of our equity we realise in position before the river (above 1 = bonus)
        airRule: 1,              // 1 = with nothing (no own pair, no draw): small bets only, no raise / all-in (v1.12.4)
        airMaxBet: 0.5,          // ... biggest such bet, as a share of the pot
        bigBetRule: 1,           // 1 = beginners' big bets / raises / all-ins after the flop are mostly value (v1.12.4)
        checkCallRules: 1,       // 1 = checks are weak signals, callers are sticky, no barrels with nothing (v1.12.3)
        postflopCareful: 1,      // 1 = the 5+ player limits after the flop below (0 = off, v1.12.0)
        fullMaxBet: 0.75,        // 5+ players: biggest bet after the flop, as a share of the pot (no overbets)
        shoveMaxBB: 10,          // 5+ players: preflop all-in only with this many BB or less (or QQ+ / AK)
        guardRealise: 0.7,       // share of equity one pair keeps when calling a raise there (before the river)
        // v1.15.2, from 470 real tournament hands: bets with nothing got a fold 10% of the time and were
        // raised 30%; bets under 35% equity into 2+ players got a fold 14% (2 players) / 0% (3+).
        bluffGate: 1,            // 1 = tournament, not heads-up: with nothing, bet only on the flop, in position, vs one player
        weakMultiwayEq: 0.35,    // ... and no bet / raise into 2+ players below this equity
        maniacRead: 1,           // 1 = players re-raising 35%+ preflop (15+ hands): their big bets include bluffs / thin value (v1.15.3)
        wideRaiseRead: 1,        // 1 = 5+ players: a raise after the flop can be one pair or a draw, not only two pair+ (v1.15.4)
        carefulCallMargin: 0.15, // 5+ players: a call of 40%+ of the stack needs equity >= price + this (or 55%) (v1.15.5)
        overcallFactor: 0.7,     // all-ins: a player behind a caller calls too with this x their own call chance (v1.15.7)
    },

    /**
     * How players on this site bet: mostly beginners, who rarely bluff.
     * Not tuned by self-play (bots in the simulator don't play like beginners).
     */
    population: {
        bigBetRange: 0.08,       // a deep all-in / 40%+-of-stack raise preflop = top 8% of hands (77+, AJ+, KQs)
        bluffBelief: 0.5,        // share of the game-theory bluffing rate assumed behind their bets after the flop
        allInCallFloor: 0.06,    // players always call an all-in with their top 6% (77+, AJs+, AQ+, AK), ICM or not
        // 5+ player tables, a raise after the flop (wideRaiseRead): how likely each kind of hand raises,
        // next to two pair+ (1). Real hands shown down: two pair+ 14, one pair 18, draws 6 (of 41).
        raisePairShare: 0.05,    // one pair (strong top pair / overpair), kept small: top pair weak kicker calls a raise ~5-10% (v1.15.5, user: "relax a little"); data shows 18 / 41
        raiseDrawShare: 0.5,     // strong draws (8+ outs)
    },
};

/**
 * Shark mode (popup toggle): for tables of strong players. Overrides the normal
 * settings above. Strong players shove and bluff at game-theory rates, so the
 * beginner reads are switched off (bigBetRange 1 = no cap on the theory range,
 * bluffBelief 1 = full theory bluffing). `npm run evolve -- --mode shark` tunes these.
 */
// Shark evolution winner g181 (Nov 2, 2026: 10,000 tournaments vs 3 sharks + 5,000-tournament playoff,
// +0.40 ± 0.38 pts/tournament vs the normal settings with theory reads).
export const SHARK_MODE: { tuning: Partial<typeof CONFIG.tuning>, population: Partial<typeof CONFIG.population> } = {
    tuning: {
        openScale: 0.6,          // opens slightly fewer hands than normal mode (0.631)
        callPenaltyIP: 0.023,
        callPenaltyOOP: 0.116,   // much pickier calling raises out of position (normal 0.096)
        realiseOOP: 0.865,       // expects to win less of its equity out of position
        postflopTemperature: 0.048,
        exploitCutoff: 0.243,    // needs more evidence before treating someone as a fish
    },
    population: { bigBetRange: 0.954, bluffBelief: 1 },   // theory reads: wide shoves, full bluffing
};
