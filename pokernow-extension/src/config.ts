/**
 * Settings you may want to change. Run `npm run build` and reload the
 * extension after editing.
 */
export const CONFIG = {
    /**
     * Tournament points for 1st, 2nd, 3rd ... 8th place. Only the DIFFERENCES
     * between places matter. These are placeholders: put your league's real numbers here.
     */
    payouts: [15, 9, 4, 2, -2, -4, -9, -15],

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
    },

    /**
     * How players on this site bet: mostly beginners, who rarely bluff.
     * Not tuned by self-play (bots in the simulator don't play like beginners).
     */
    population: {
        bigBetRange: 0.08,       // a deep all-in / 40%+-of-stack raise preflop = top 8% of hands (77+, AJ+, KQs)
        bluffBelief: 0.5,        // share of the game-theory bluffing rate assumed behind their bets after the flop
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
