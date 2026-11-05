/**
 * Players for the simulator. "smart" is the real extension brain: it reads the
 * PokerNow-format log with the same parser as live play.
 */
import { CONFIG } from "../config";
import { decideWithView } from "../ai/decide";
import { equityAction } from "../ai/equity/equityAi";
import { evaluate } from "../ai/equity/evaluator";
import { classOf, percentile } from "../ai/preflop/hands";
import { parseHand } from "../table/logReader";
import { buildTableView } from "../table/tableView";
import { PreflopPhase, getPhaseFromBoardLength } from "../state";
import { DecisionContext, SimBot, toCard } from "./engine";

export type Tuning = typeof CONFIG.tuning;
export type Population = typeof CONFIG.population;
/** Everything one bot's strategy can differ in: tuning knobs + its read of how opponents bet. */
export type Genes = Tuning & Population;

/** Applies a bot's settings to CONFIG for one decision; returns a function that restores them. */
function applyGenes(genes: Partial<Genes> | undefined): () => void {
    const savedT = { ...CONFIG.tuning }, savedP = { ...CONFIG.population };
    for (const [k, v] of Object.entries(genes ?? {})) {
        if (v === undefined) continue;
        if (k in CONFIG.population) (CONFIG.population as Record<string, number>)[k] = v;
        else (CONFIG.tuning as Record<string, number>)[k] = v;
    }
    return () => { Object.assign(CONFIG.tuning, savedT); Object.assign(CONFIG.population, savedP); };
}

function toState(ctx: DecisionContext): State {
    const hand = ctx.hole.map(toCard), board = ctx.board.map(toCard);
    return {
        phase: getPhaseFromBoardLength(board.length), handRank: { name: "high", code: 0 },
        hand, board, handPlusBoard: [...hand, ...board], bigBlind: ctx.bigBlind,
        stack: ctx.stack, pot: ctx.pot, prevPhasePot: 0, toCall: ctx.toCall, opponents: 1,
    };
}

/** The extension's smart brain, optionally with different strategy settings. */
export function smartBot(label: string, genes?: Partial<Genes>): SimBot {
    return {
        label,
        decide(ctx) {
            const restore = applyGenes(genes);
            try {
                const view = buildTableView(parseHand(ctx.log), ctx.name, ctx.stack);
                const state = toState(ctx);
                if (!view) return equityAction(state);
                return decideWithView(view, state, () => {});
            }
            finally {
                restore();
            }
        },
    };
}

export function equityBot(label: string): SimBot {
    return { label, decide: ctx => equityAction(toState(ctx)) };
}

/** Calls everything, never raises. */
export function stationBot(label: string): SimBot {
    return { label, decide: () => ({ type: "call" }) };
}

/** Raises the pot whenever it can. */
export function maniacBot(label: string): SimBot {
    return { label, decide: () => ({ type: "raise", raiseAmount: "pot" }) };
}

/** Plays only the top 12% of hands, and those very aggressively. */
export function nitBot(label: string): SimBot {
    return {
        label,
        decide(ctx) {
            const strong = percentile(classOf(ctx.hole[0], ctx.hole[1])) <= 0.12;
            if (ctx.street === "preflop")
                return strong ? { type: "raise", raiseAmount: "pot" } : { type: "check_or_fold" };
            return strong ? { type: "raise", raiseAmount: "1/2_pot" } : { type: "check_or_fold" };
        },
    };
}

export function randomBot(label: string): SimBot {
    return {
        label,
        decide() {
            const r = Math.random();
            if (r < 0.3) return { type: "check_or_fold" };
            if (r < 0.75) return { type: "call" };
            return { type: "raise", raiseAmount: (["min", "1/2_pot", "pot"] as RaiseAmount[])[Math.floor(Math.random() * 3)] };
        },
    };
}

const category = (cards: number[]) => Math.floor(evaluate(cards) / 16 ** 5);

/**
 * A loose-passive recreational player, like most of the table in the first real
 * log (VPIP 56-77%, almost never raises): limps and calls with most hands,
 * calls down with any pair or draw, only raises with very strong hands,
 * sometimes "takes a look" with nothing. Not as extreme as the calling station.
 */
export function fishBot(label: string): SimBot {
    return {
        label,
        decide(ctx) {
            const r = Math.random();
            if (ctx.street === "preflop") {
                const pct = percentile(classOf(ctx.hole[0], ctx.hole[1]));
                if (pct <= 0.04) return { type: "raise", raiseAmount: "pot" };
                const cheap = ctx.toCall <= Math.max(4 * ctx.bigBlind, 0.15 * ctx.stack);
                if (pct <= 0.6 && cheap) return { type: "call" };
                if (pct <= 0.2 && ctx.toCall <= 0.5 * ctx.stack) return { type: "call" };
                return { type: "check_or_fold" };
            }
            const mine = category(ctx.hole.concat(ctx.board)), boardOnly = category(ctx.board);
            const uses = mine > boardOnly;                                   // its hole cards help
            const suits = [0, 0, 0, 0];
            for (const c of ctx.board) suits[c & 3]++;
            const flushDraw = ctx.street !== "river" && ctx.hole.some(c => suits[c & 3] + ctx.hole.filter(h => (h & 3) === (c & 3)).length === 4);
            if (uses && mine >= 2) {                                        // two pair or better
                if (ctx.toCall === 0) return r < 0.4 ? { type: "raise", raiseAmount: "1/2_pot" } : { type: "check_or_fold" };
                return r < 0.25 ? { type: "raise", raiseAmount: "pot" } : { type: "call" };
            }
            if (uses || flushDraw) {                                        // any pair or a flush draw: sticky
                if (ctx.toCall === 0) return r < 0.15 ? { type: "raise", raiseAmount: "1/2_pot" } : { type: "check_or_fold" };
                return ctx.toCall <= 0.6 * ctx.stack || mine >= 1 && r < 0.5 ? { type: "call" } : { type: "check_or_fold" };
            }
            if (ctx.toCall === 0) return r < 0.07 ? { type: "raise", raiseAmount: "1/2_pot" } : { type: "check_or_fold" };
            return ctx.toCall <= 0.35 * ctx.pot && r < 0.35 ? { type: "call" } : { type: "check_or_fold" };
        },
    };
}

export const BOT_TYPES: Record<string, (label: string) => SimBot> = {
    smart: l => smartBot(l), equity: equityBot, station: stationBot, maniac: maniacBot, nit: nitBot, random: randomBot,
    fish: fishBot,
    // The smart brain without the table-phase rules (= v1.10 play), for before/after comparisons.
    oldsmart: l => smartBot(l, { phaseRules: 0 }),
    // v1.11.1: phase rules, but no 5+ player all-in limit and no all-in calling floor.
    prev: l => smartBot(l, { shoveMaxBB: 1000, allInCallFloor: 0 }),
    // v1.12.0: no careful limits after the flop.
    vtwelve: l => smartBot(l, { postflopCareful: 0 }),
    // v1.12.2: checks read as weakness, no sticky callers, barrels allowed.
    vtwelvetwo: l => smartBot(l, { checkCallRules: 0 }),
    // v1.12.3: beginners' big bets read with theory bluff shares (more bluffs the bigger the bet).
    vtwelvethree: l => smartBot(l, { bigBetRule: 0, airRule: 0 }),
    // v1.12.4 play: no steal bonus, no in-position bonus.
    vtwelvefour: l => smartBot(l, { positionRules: 0 }),
    // v1.14.0 play: 4 and 3 players play the standard (looser) style.
    vfourteen: l => smartBot(l, { shortTight: 0 }),
    // v1.15.1 play: no bluff gate (bluffs with nothing out of position / later streets / multiway).
    vfifteen: l => smartBot(l, { bluffGate: 0 }),
    // v1.15.2 play: no maniac read (big bets of 3-bet-happy players read like anyone else's).
    vfifteentwo: l => smartBot(l, { maniacRead: 0 }),
    // v1.15.3 play: a raise after the flop at 5+ players is read as two pair+ only (no draws).
    vfifteenthree: l => smartBot(l, { wideRaiseRead: 0 }),
    // v1.15.6 play: all-in math ignores overcallers.
    vfifteensix: l => smartBot(l, { overcallFactor: 0 }),
};

export { PreflopPhase };
