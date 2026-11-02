/**
 * Our step 3 EquityBot (holdem/bots.py), adapted to the extension. Used after
 * the flop by the smart brain, and for everything when the table can't be read.
 *
 * 1. Estimate equity: the chance to win against the opponents still in the hand.
 *    With the table reader, opponents' hands are drawn from their estimated
 *    preflop ranges; without it, from random hands.
 * 2. When facing a BET (not a blind), assume the bettor is stronger than their
 *    range average and discount our equity a bit; bigger bet, bigger discount.
 * 3. Strong -> raise for value. Worth calling (beats pot odds) -> call.
 *    Otherwise check if free, fold if not. Sometimes bluff when checked to,
 *    more often against players who can't afford to call (ICM pressure).
 *
 * PokerNow only offers preset raise sizes, so sizes are rounded to those.
 */
import { PreflopPhase } from "../../state";
import { cardToInt, equity } from "./evaluator";
import { equityVsRanges } from "./rangeEquity";
import { Range } from "../preflop/hands";
import { noteStrength } from "../../timing";

const BLUFF_FREQUENCY = 0.12;
const PREFLOP_VALUE_LINE = 0.62;   // heads-up numbers; scaled down for more opponents
const POSTFLOP_VALUE_LINE = 0.72;
const CHECKED_TO_HU_LINE = 0.58;   // heads-up and checked to: a hand ahead of a random hand bets for value
const CALL_MARGIN = 0.03;          // demand a little more than break-even to call

export type EquityContext = {
    ranges?: Range[],              // one per opponent still in the hand
    callPressure?: number,         // extra equity ICM demands before risking our stack
    bluffPressure?: number,        // how much opponents fear calling (ICM), 0..0.5
};

export function equityAction(state: State, ctx: EquityContext = {}): Action {
    const opponents = Math.max(1, ctx.ranges?.length ?? state.opponents);
    const hole = state.hand.map(cardToInt);
    const board = state.board.map(cardToInt);
    const preflop = state.phase.code === PreflopPhase.code;

    const rawEquity = ctx.ranges?.length
        ? equityVsRanges(hole, board, ctx.ranges)
        : equity(hole, board, opponents);
    let eq = rawEquity;
    const { pot, toCall } = state;
    noteStrength(rawEquity * (opponents + 1) / 2);     // 50% heads-up or 33% three-way = 0.5

    // Preflop, calling just the big blind is not facing a bet.
    const facingBet = toCall > 0 && (!preflop || toCall > state.bigBlind);
    if (facingBet)
        eq -= 0.12 * Math.min(1, toCall / Math.max(pot - toCall, 1));
    const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
    // Risking a big share of our stack in a tournament needs extra equity.
    const pressure = toCall >= 0.5 * state.stack ? (ctx.callPressure ?? 0) : 0;

    // Against more players, the average winning chance drops (1/2, 1/3, ...),
    // so value lines are scaled relative to a fair share.
    const fairShare = 1 / (opponents + 1);
    const scale = fairShare / 0.5;
    const valueLine = (preflop ? PREFLOP_VALUE_LINE : POSTFLOP_VALUE_LINE) * scale;
    const strongLine = 0.85 * scale;
    const bluffFrequency = Math.min(0.3, BLUFF_FREQUENCY * (1 + 2 * (ctx.bluffPressure ?? 0)));

    let action: Action;
    let reason: string;

    if (eq >= valueLine) {
        if (preflop) {
            action = { type: "raise", raiseAmount: "pot" };
            reason = "strong preflop hand";
        }
        else if (eq >= strongLine) {
            action = { type: "raise", raiseAmount: "pot" };
            reason = "very strong: big value bet";
        }
        else {
            action = { type: "raise", raiseAmount: "1/2_pot" };
            reason = "strong: value bet";
        }
    }
    else if (toCall === 0) {
        if (!preflop && opponents === 1 && eq >= CHECKED_TO_HU_LINE) {
            // Their range is mostly air that folds or calls worse; checking gives free cards.
            action = { type: "raise", raiseAmount: "1/2_pot" };
            reason = "heads-up, checked to: ahead of their range, value bet";
        }
        else if (!preflop && Math.random() < bluffFrequency) {
            action = { type: "raise", raiseAmount: "1/2_pot" };
            reason = `checked to us: bluff (${Math.round(bluffFrequency * 100)}% of the time)`;
        }
        else {
            action = { type: "check_or_fold" };
            reason = "not strong enough to bet: check";
        }
    }
    else if (eq >= potOdds + CALL_MARGIN + pressure) {
        action = { type: "call" };
        reason = toCall >= state.stack ? "worth calling all-in" : "equity beats pot odds: call";
    }
    else {
        action = { type: "check_or_fold" };
        reason = "equity below pot odds: fold";
    }

    console.log(
        `[equity bot] opponents ${opponents}${ctx.ranges ? " (vs their ranges)" : ""}  equity ${(rawEquity * 100).toFixed(1)}%` +
        (toCall > 0 ? ` (adjusted ${(eq * 100).toFixed(1)}%, need ${((potOdds + CALL_MARGIN + pressure) * 100).toFixed(1)}%)` : "") +
        `  -> ${reason}`,
    );
    return action;
}
