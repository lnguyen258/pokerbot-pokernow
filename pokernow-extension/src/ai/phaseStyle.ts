/**
 * How the bot's style changes with the number of players left (REFORM.md).
 *   full (6-8):        very tight, no bluffs, respects calls and raises
 *   conservative (5):  tight, few bluffs
 *   normal (4) / creative (3) / headsUp (2): standard for now (Parts 4-7 change these)
 * The numbers are knobs in CONFIG.tuning so the simulator can tune them.
 */
import { CONFIG } from "../config";
import { TablePhase, TableView, tablePhase } from "../table/tableView";
import { evaluate } from "./equity/evaluator";

export type PhaseStyle = {
    phase: TablePhase,
    open: number,          // x opening share for UTG; later seats are cut less (see openFactor)
    callExtra: number,     // extra equity needed to call a raise preflop
    respect: number,       // x size of opponents' calling/raising ranges (below 1 = assume stronger)
    bluffs: boolean,       // pure bluffs (no made hand, no good draw) and 3-bet bluffs allowed
    playableCalls: boolean,// cold-call raises only with hands that play well after the flop
    stackOffGuard: boolean,// no raise / all-in with one pair against a raise after the flop
    limitShoves: boolean,  // preflop all-in only when short (shoveMaxBB) or with QQ+ / AK
    shoveMaxBB: number,    // ... "short" = this many big blinds or less at the start of the hand
};

export function phaseStyle(view: TableView): PhaseStyle {
    const t = CONFIG.tuning;
    const phase = tablePhase(view);
    const loose = { phase, open: 1, callExtra: 0, respect: 1, bluffs: true, playableCalls: false, stackOffGuard: false, limitShoves: false, shoveMaxBB: t.shoveMaxBB };
    if (!t.phaseRules) return loose;
    if (phase === "full")
        return { phase, open: t.fullOpen, callExtra: t.fullCallExtra, respect: t.fullRespect,
            bluffs: false, playableCalls: true, stackOffGuard: true, limitShoves: true, shoveMaxBB: t.shoveMaxBB };
    if (phase === "conservative")
        return { phase, open: t.consOpen, callExtra: t.consCallExtra, respect: t.consRespect,
            bluffs: false, playableCalls: true, stackOffGuard: true, limitShoves: true, shoveMaxBB: t.shoveMaxBB };
    // 4 and 3 players (v1.15.0, user: "players here mostly play good hands even 4-handed"): tight too,
    // with a higher all-in line (stacks are shorter by then). Heads-up stays as it was.
    if (t.shortTight && phase === "normal")
        return { phase, open: t.normalOpen, callExtra: t.normalCallExtra, respect: t.normalRespect,
            bluffs: false, playableCalls: true, stackOffGuard: true, limitShoves: true, shoveMaxBB: t.shortShoveMaxBB };
    if (t.shortTight && phase === "creative")
        return { phase, open: t.creativeOpen, callExtra: t.creativeCallExtra, respect: t.creativeRespect,
            bluffs: false, playableCalls: true, stackOffGuard: true, limitShoves: true, shoveMaxBB: t.shortShoveMaxBB };
    return loose;
}

/**
 * Opening share multiplier for a seat: the full cut for the first seat to act, shrinking
 * to a third of it on the button. Tight early, still stealing late.
 */
export function openFactor(style: PhaseStyle, playersBehind: number, tableSize: number): number {
    const share = Math.min(1, Math.max(0, playersBehind / Math.max(1, tableSize - 1)));
    return 1 - (1 - style.open) * (1 / 3 + (2 / 3) * share);
}

const RANKS = "23456789TJQKA";
/**
 * Hands that play well after the flop when calling a raise: pairs, suited hands, two
 * broadway cards (T+). In the big blind also any ace (we already have chips in).
 */
export function playsWell(handName: string, bigBlind: boolean): boolean {
    const hi = RANKS.indexOf(handName[0]), lo = RANKS.indexOf(handName[1]);
    if (hi === lo || handName.endsWith("s")) return true;
    if (lo >= RANKS.indexOf("T")) return true;
    return bigBlind && handName[0] === "A";
}

/** Made-hand category from the evaluator: 0 high card, 1 pair, 2 two pair, 3 trips, ... */
const category = (cards: number[]) => Math.floor(evaluate(cards) / 16 ** 5);

/**
 * One pair or worse using our hole cards. Two pair where one pair is the board's counts
 * as one pair (everyone has the board pair).
 */
export function onePairOrWorse(hole: number[], board: number[]): boolean {
    const mine = category(hole.concat(board));
    if (mine <= 1) return true;
    if (mine === 2) return category(board) >= 1;
    return false;
}

/**
 * Strong enough to put a big part of the stack in at a full / 5-handed table: two pair or
 * better using our cards. With three or more cards of one suit on the board, only a flush or
 * better (anyone with two of that suit already beats sets and straights).
 */
export function strongMade(hole: number[], board: number[]): boolean {
    if (onePairOrWorse(hole, board)) return false;
    const suits = [0, 0, 0, 0];
    for (const c of board) suits[c & 3]++;
    return Math.max(...suits) >= 3 ? category(hole.concat(board)) >= 5 : true;
}

/** Our cards make no pair (or better) beyond what the board already has: ace-high, or the board's pair only. */
export function noOwnPair(hole: number[], board: number[]): boolean {
    return category(hole.concat(board)) <= category(board);
}

/** Pure air: weak made hand (bottom ~40% of all hands on this board) and no real draw. */
export function isAir(made: number, outs: number): boolean {
    return made < 0.4 && outs < 8;
}
