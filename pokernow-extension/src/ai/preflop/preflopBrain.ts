/**
 * Preflop decisions that understand position, stack sizes and tournament payouts.
 *
 *  1. Short stacks (<= 15 BB effective): all-in or fold, using the ICM push/fold
 *     equilibrium (pushFold.ts).
 *  2. Facing an all-in (or a bet that commits a big share of a stack): call only
 *     if our equity vs THEIR all-in range beats the equity ICM requires of us.
 *  3. Deeper, first in: open the share of hands that fits our seat (more players
 *     behind = tighter), adjusted for ICM pressure (see icmOpenFactor).
 *  4. Facing a raise: estimate the raiser's range from their seat, style and bet
 *     size; re-shove, 3-bet, call or fold based on our equity vs that range.
 */
import { CONFIG } from "../../config";
import { requiredEquityAllIn } from "../icm";
import { SeatView, TableView, playersBehind, situationOf } from "../../table/tableView";
import { describe, fishScore, profile } from "../../table/stats";
import { CLASSES, classOf, equityVsRange, fullRange, percentile, rangeSize, topRange, widen } from "./hands";
import { allInAnalysis } from "./pushFold";
import { bigBetShare, isCommitted, openShare, preflopRange, raiseStyle, seatsBehind } from "./playerRanges";
import { cardToInt } from "../equity/evaluator";
import { noteStrength } from "../../timing";
import { describeRaise, raiseTo } from "../sizing";
import { openFactor, phaseStyle, playsWell } from "../phaseStyle";

export type Decision = { action: Action, reason: string };

/** A re-shove must gain at least this share of the payout spread (1st minus 8th). */
const RESHOVE_MARGIN = 0.005;
const spread = (p: number[]) => Math.max(...p) - Math.min(...p);

// Set at the start of each decision so profiles use each player's current stack situation.
let currentView: TableView | null = null;
const profileOf = (p: SeatView) => profile(p.id, p.name, currentView ? situationOf(currentView, p) : undefined);
const styleOf = (p: SeatView) => profileOf(p).style;

/**
 * ICM pressure on opening ranges.
 * - Players behind us who would need a lot of equity to risk their stack
 *   (short/medium stacks near the paid places) fold more: open WIDER.
 * - If a bigger stack behind can bust us and we're under pressure: open TIGHTER.
 */
function icmOpenFactor(view: TableView, behind: SeatView[]): { factor: number, note: string } {
    const stacks = view.players.map(p => p.startStack);
    const me = view.players.indexOf(view.me);
    if (!behind.length) return { factor: 1, note: "" };
    let theirPressure = 0, myPressure = 0;
    for (const p of behind) {
        const j = view.players.indexOf(p);
        theirPressure += requiredEquityAllIn(stacks, j, me, CONFIG.payouts) - 0.5;
        if (p.startStack >= view.me.startStack)
            myPressure = Math.max(myPressure, requiredEquityAllIn(stacks, me, j, CONFIG.payouts) - 0.5);
    }
    theirPressure /= behind.length;
    const factor = Math.max(0.6, Math.min(1.6, 1 + 1.2 * theirPressure - 1.5 * myPressure));
    return {
        factor,
        note: `ICM: players behind need +${(theirPressure * 100).toFixed(0)}% extra equity to call, ` +
            `I need +${(myPressure * 100).toFixed(0)}% -> open x${factor.toFixed(2)}`,
    };
}

/**
 * Opening size in big blinds. Fixed mode: base + 1 per limper. Any-size mode adds:
 * more per limper (knob), more when fish who call too much are behind or limped
 * (they call a bigger raise anyway), and more from the small blind (out of position).
 * The size depends on the spot only, never on our cards, so it gives nothing away.
 */
function openSizeBB(view: TableView, me: SeatView, limpers: number, limperSeats: SeatView[],
    behind: SeatView[], base: number): number {
    const t = CONFIG.tuning;
    if (t.preflopSizing < 2) return base + limpers;
    const others = behind.concat(limperSeats);
    const fish = others.length ? others.reduce((a, p) => a + fishScore(profileOf(p)), 0) / others.length : 0;
    return base + t.openPerLimper * limpers + t.openFishBonus * fish + (me.position === "SB" ? t.openSbBonus : 0);
}

export function preflopDecide(view: TableView, state: State): Decision {
    currentView = view;
    const hand = classOf(cardToInt(state.hand[0]), cardToInt(state.hand[1]));
    noteStrength(1 - percentile(hand));          // top hands near 1, trash near 0
    return decide(view, state, hand);
}

function decide(view: TableView, state: State, hand: number): Decision {
    const me = view.me;
    const handName = CLASSES[hand];
    const bb = view.bb || state.bigBlind;
    const behind = playersBehind(view);
    const opponents = view.players.filter(p => !p.isMe && !p.folded);
    const biggestOpp = Math.max(...opponents.map(p => p.startStack), 0);
    const effBB = Math.min(me.startStack, biggestOpp) / bb;
    const toCall = state.toCall;

    const preflop = view.actions.filter(a => a.street === "preflop");
    const raises = preflop.filter(a => a.kind === "raise" || a.kind === "bet");
    const lastRaise = raises[raises.length - 1];
    const raiser = lastRaise ? view.players.find(p => p.id === lastRaise.id) : undefined;
    const style = phaseStyle(view);
    const rangeOf = (p: SeatView) => preflopRange(view, p, profileOf(p));
    // Full / 5-handed tables: an opponent who raised or called is assumed stronger.
    const respected = (p: SeatView) => style.respect < 1 ? widen(rangeOf(p), style.respect) : rangeOf(p);

    const tag = `${handName} in ${me.position}, ${effBB.toFixed(1)} BB effective`;

    // 5+ players: no all-in before the flop unless we're short (shoveMaxBB or less) or hold
    // QQ+ / AK. Calling someone else's all-in is decided separately (section 2).
    const myBB = me.startStack / bb;
    const premium = /^(AA|KK|QQ|AKs|AKo)$/.test(handName);
    const shoveOK = !style.limitShoves || myBB <= style.shoveMaxBB || premium;
    const noShoveNote = `no all-in at a ${style.phase} table with ${myBB.toFixed(0)} BB and ${handName}`;

    // ---- 2. Facing an all-in or a commitment-sized bet
    if (raiser && !raiser.isMe && (lastRaise!.allIn || isCommitted(raiser, lastRaise!.amount) || toCall >= me.stack)) {
        const after = view.players.slice(view.players.indexOf(raiser) + 1).filter(p => !p.folded || p.isMe);
        const analysis = allInAnalysis(view, raiser, after, rangeOf, styleOf, CONFIG.payouts,
            raises.length > 1 ? topRange(0.25) : fullRange());
        // Theory range for this shove, widened only if they're seen raising a lot (not by VPIP),
        // then capped by the beginner read for deep shoves (see bigBetShare).
        const theory = rangeSize(widen(analysis.actorRange, raiseStyle(profileOf(raiser))));
        // Depth = their whole stack: a raise of 40%+ of it is an all-in in all but name.
        const depthBB = raiser.startStack / bb;
        const theirRange = topRange(bigBetShare(theory, depthBB, profileOf(raiser), raises.length > 1));
        const mine = analysis.callers.find(c => c.seat.isMe);
        const overcallers = preflop.filter(a => a.kind === "call" && preflop.indexOf(a) > preflop.indexOf(lastRaise!)).length;
        const required = (mine?.required ?? 0.5) + 0.04 * overcallers + 0.02 * behind.length;
        const eq = equityVsRange(hand, theirRange) - 0.05 * overcallers;
        const verdict = eq >= required ? "call" : "fold";
        return {
            action: { type: verdict === "call" ? "call" : "check_or_fold" },
            reason: `${tag}. Facing all-in from ${raiser.name} (${describe(raiser.id, raiser.name)}), ` +
                `their range ~${(rangeSize(theirRange) * 100).toFixed(0)}% of hands. ` +
                `My equity ${(eq * 100).toFixed(1)}% vs ICM-required ${(required * 100).toFixed(1)}% -> ${verdict}`,
        };
    }

    // ---- 1. Short stack, nobody has raised: all-in or fold
    if (!raises.length && effBB <= CONFIG.pushFoldDepthBB && (!style.limitShoves || myBB <= style.shoveMaxBB)) {
        // Players behind act first; anyone who limped in front of us gets to act again after.
        const limpers = view.players.filter(p => !p.isMe && !p.folded && !behind.includes(p) &&
            p.actions.some(a => a.kind === "call"));
        const analysis = allInAnalysis(view, me, behind.concat(limpers), rangeOf, styleOf, CONFIG.payouts);
        const gain = analysis.evShove[hand] - analysis.evFold;
        const shove = gain > 0;
        const callers = analysis.callers.map(c =>
            `${c.seat.name} calls ${(c.pCall * 100).toFixed(0)}% (needs ${(c.required * 100).toFixed(0)}%)`).join(", ");
        return {
            action: shove ? { type: "raise", raiseAmount: "all_in" } : { type: "check_or_fold" },
            reason: `${tag}. Push/fold: all-in range ${(rangeSize(analysis.actorRange) * 100).toFixed(0)}%, ` +
                `everyone folds ${(analysis.pAllFold * 100).toFixed(0)}%. ${callers}. ` +
                `All-in ${gain >= 0 ? "+" : ""}${gain.toFixed(2)} pts vs folding -> ${shove ? "ALL-IN" : toCall ? "fold" : "check"}`,
        };
    }

    // ---- 3. Deeper, nobody has raised: open by seat
    if (!raises.length) {
        const limperSeats = view.players.filter(p => !p.isMe && preflop.some(a => a.id === p.id && a.kind === "call"));
        const limpers = limperSeats.length;
        // Limpers usually mean tighten up, but limping fish are the best target at
        // the table: raise wider to play them heads-up, with position, for value.
        // Only as fishy as the least fishy limper (one solid limper spoils it).
        const fish = limpers ? Math.min(...limperSeats.map(p => fishScore(profileOf(p)))) : 0;
        const limpFactor = limpers ? 0.6 + 0.8 * fish * CONFIG.tuning.isolateFish : 1;
        const base = openShare(seatsBehind(view, me), view.players.length) * limpFactor;
        const { factor, note: icmNote } = icmOpenFactor(view, behind);
        const note = fish >= 0.2 ? `Target the fish: limper${limpers > 1 ? "s are" : " is"} loose-passive ` +
            `(fish score ${fish.toFixed(2)}), isolating x${limpFactor.toFixed(2)}. ${icmNote}` : icmNote;
        // Steals (v1.13.0): nobody in yet and only the blinds (or fewer) behind: open wider from the
        // button and small blind; at 4 players or fewer also from the cutoff (3 behind).
        const behindN = seatsBehind(view, me);
        const stealSeat = CONFIG.tuning.positionRules && !limpers && view.players.length > 2 &&
            (behindN <= 2 || (behindN === 3 && view.players.length <= 4 && !CONFIG.tuning.shortTight));
        const steal = stealSeat ? 1 + CONFIG.tuning.stealBonus : 1;
        const share = Math.min(1, base * factor * CONFIG.tuning.openScale *
            openFactor(style, behindN, view.players.length) * steal);
        const rank = percentile(hand);
        // v1.15.8: 5+ players with 10-15 BB (too deep to shove there, too short for a normal
        // open): raise to at most a quarter of the stack. Isolation raises of 35-45% of the stack
        // got 2-3 callers and busted / crippled the bot (T9o, QTs), with no fold equity left.
        const gap = style.limitShoves && effBB <= CONFIG.pushFoldDepthBB;
        const gapCap = (to: number) => gap ? Math.max(2 * bb, Math.min(to, 0.25 * me.startStack)) : to;
        if (rank <= share) {
            // Open to 2.5-3 bb, plus 1 bb for every limper (they make the pot bigger).
            const openBB = CONFIG.gameType === "cash" ? CONFIG.tuning.openSizeCashBB : CONFIG.tuning.openSizeBB;
            const action: Action = CONFIG.tuning.preflopSizing === 0
                ? { type: "raise", raiseAmount: limpers ? "pot" : "min" }          // old button sizes
                : raiseTo(view, gapCap(openSizeBB(view, me, limpers, limperSeats, behind, openBB) * bb));
            return {
                action,
                reason: `${tag}. Hand is top ${(rank * 100).toFixed(0)}%, opening top ${(share * 100).toFixed(0)}%${stealSeat ? " (steal seat)" : ""} ` +
                    `from here${limpers ? ` (isolating ${limpers} limper${limpers > 1 ? "s" : ""})` : ""}. ${note} -> raise ${describeRaise(action, bb)}`,
            };
        }
        // Completing the small blind: cheap, but out of position in a multiway pot, so
        // only hands just below the opening range (not K6o / Q7o "because it's cheap").
        const completeSb = me.position === "SB" && toCall > 0 && toCall <= bb / 2 + 1e-9 &&
            rank <= share + (limpers ? 0.05 : 0.15);
        return {
            action: completeSb ? { type: "call" } : { type: "check_or_fold" },
            reason: `${tag}. Hand is top ${(rank * 100).toFixed(0)}%, opening only top ${(share * 100).toFixed(0)}% ` +
                `from here. ${note} -> ${completeSb ? "complete small blind" : toCall ? "fold" : "check"}`,
        };
    }

    // ---- 4. Facing a normal raise (or re-raise)
    const villain = raiser!;
    const theirRange = respected(villain);
    const eq = equityVsRange(hand, theirRange);
    const pot = view.pot;
    const potOdds = toCall / (pot + toCall);
    const inPosition = !["SB", "BB"].includes(me.position) &&
        view.players.indexOf(me) > view.players.indexOf(villain);
    const stacks = view.players.map(p => p.startStack);
    const myPressure = villain.startStack >= me.startStack
        ? requiredEquityAllIn(stacks, view.players.indexOf(me), view.players.indexOf(villain), CONFIG.payouts) - 0.5 : 0;
    // Players who already called the raise are in the pot too: their chips make the price
    // look cheap, but we must beat them as well. ~6% less equity per extra caller.
    const coldCallers = preflop.filter(a => a.kind === "call" && preflop.indexOf(a) > preflop.indexOf(lastRaise!)).length;
    const eqMulti = eq - 0.06 * coldCallers;
    const needToCall = potOdds + (inPosition ? CONFIG.tuning.callPenaltyIP : CONFIG.tuning.callPenaltyOOP) +
        0.5 * Math.max(0, myPressure) + style.callExtra;
    const info = `${tag}. ${villain.name} raised from ${villain.position} (${describe(villain.id, villain.name)}), ` +
        `range ~${(rangeSize(theirRange) * 100).toFixed(0)}%. My equity vs it ${(eq * 100).toFixed(1)}%` +
        (coldCallers ? `, ${(eqMulti * 100).toFixed(1)}% with ${coldCallers} caller${coldCallers > 1 ? "s" : ""} in` : "");

    if (effBB <= 25) {
        const callers = behind.concat(view.players.filter(p => !p.folded && !p.isMe && !behind.includes(p)));
        const analysis = allInAnalysis(view, me, callers, rangeOf, styleOf, CONFIG.payouts);
        const gain = analysis.evShove[hand] - analysis.evFold;
        // Re-shoving risks the tournament: only for a clear gain. Players who already called
        // the raise (beginners especially) rarely fold, so multiway it needs real equity too.
        // Gains are in points (tournament) or chips (cash: at least 0.1 big blind).
        const minGain = CONFIG.gameType === "cash" ? 0.1 * view.bb : RESHOVE_MARGIN * spread(CONFIG.payouts);
        if (shoveOK && gain > minGain && (effBB <= 20 || eq >= 0.5) && (coldCallers === 0 || eq >= 0.45))
            return {
                action: { type: "raise", raiseAmount: "all_in" },
                reason: `${info}. Re-shove gains ${gain.toFixed(2)} pts (they fold ${(analysis.pAllFold * 100).toFixed(0)}%) -> ALL-IN`,
            };
    }
    // 3-bet to 3x their raise in position (a bit more out of position), plus 1x per caller.
    // If that's 40%+ of our stack, just go all-in: we'd never fold after putting that much in.
    const threeBet = (): Action => {
        if (CONFIG.tuning.preflopSizing === 0) return { type: "raise", raiseAmount: "pot" };   // old button size
        const t = CONFIG.tuning, any = t.preflopSizing >= 2;
        // Any-size mode: bigger out of position and against fish who call too much.
        const mult = t.threeBetSize + (inPosition ? 0 : any ? t.threeBetOopExtra : 0.5) + coldCallers +
            (any ? t.threeBetFishBonus * fishScore(profileOf(villain)) : 0);
        const to = lastRaise!.amount * mult;
        return to >= 0.4 * (me.streetBet + me.stack) ? { type: "raise", raiseAmount: "all_in" } : raiseTo(view, to);
    };
    if (raises.length === 1 && eq >= CONFIG.tuning.threeBetEquity) {
        const action = threeBet();
        // A 3-bet that would be all-in follows the same 5+ player rule (else call or fold below).
        if (action.raiseAmount !== "all_in" || shoveOK)
            return { action, reason: `${info} -> 3-bet for value ${describeRaise(action, bb)}` };
    }
    if (raises.length >= 2 && eq >= 0.55 && shoveOK)
        return { action: { type: "raise", raiseAmount: "all_in" }, reason: `${info} -> 4-bet all-in` };
    // A bluff 3-bet must stay a small raise we can fold. When the stack is short enough that it
    // would be all-in, skip it: the all-in check above already decided shoving isn't worth it.
    if (style.bluffs && raises.length === 1 && inPosition && /^A[2-5]s$/.test(handName) && Math.random() < 0.3) {
        const action = threeBet();
        if (action.raiseAmount !== "all_in")
            return { action, reason: `${info} -> 3-bet bluff (ace blocker, in position) ${describeRaise(action, bb)}` };
    }
    // Full / 5-handed: call raises only with hands that play well after the flop.
    const playable = !style.playableCalls || playsWell(handName, me.position === "BB");
    if (eqMulti >= needToCall && !playable)
        return { action: { type: "check_or_fold" }, reason: `${info}, need ${(needToCall * 100).toFixed(1)}%, ` +
            `but ${handName} plays badly after the flop at a ${style.phase} table -> fold` };
    const shoveNote = shoveOK ? "" : ` (${noShoveNote})`;
    if (eqMulti >= needToCall)
        return { action: { type: "call" }, reason: `${info}, need ${(needToCall * 100).toFixed(1)}%${shoveNote} -> call` };
    return { action: { type: "check_or_fold" }, reason: `${info}, need ${(needToCall * 100).toFixed(1)}%${shoveNote} -> fold` };
}
