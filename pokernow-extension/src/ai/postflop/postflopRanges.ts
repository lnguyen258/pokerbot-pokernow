/**
 * Narrows an opponent's range street by street after the flop.
 *
 * Starts from their preflop range (spread over all 1,326 combos), removes cards
 * we can see, then re-weights after each of their actions:
 *   - CALL a bet: they continue with made hands strong enough for the price,
 *     AND with draws whose chance to hit (plus a little for future winnings)
 *     beats the pot odds. On a two-spade board, flush draws stay in.
 *   - BET / RAISE: as wide as this player's real betting frequency: strong made
 *     hands, plus bluffs (draws first, then air). A player who bets 90% of the
 *     time is mostly bluffing, so we call them down much lighter.
 *   - CHECK: most of their strongest hands would have bet, so those go down.
 * Weights never reach zero, so surprises stay possible.
 */
import { TableView, SeatView } from "../../table/tableView";
import { Street } from "../../table/logReader";
import { Range } from "../preflop/hands";
import { Profile } from "../../table/stats";
import { CONFIG } from "../../config";
import { BoardInfo, COMBOS, COMBO_CLASS, N, analyzeBoard, sigmoid, softTop } from "./board";

const FLOOR = 0.03;
const BOARD_CARDS: Record<Street, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };

/** Extra equity callers allow for winning more later when they hit. */
export function impliedBonus(street: Street, allIn: boolean): number {
    if (allIn) return 0;
    return street === "flop" ? 0.07 : street === "turn" ? 0.04 : 0;
}

/** How much of each combo keeps playing when facing a bet of `toCall` into `potWithBet`. */
export function continueMembership(
    w: number[], info: BoardInfo, toCall: number, potWithBet: number,
    street: Street, looseness: number, allIn: boolean,
): number[] {
    const needed = toCall / (potWithBet + toCall);
    const balanced = 1 - toCall / Math.max(potWithBet, 1);       // share a balanced player defends
    const madeCont = softTop(w, info.made, Math.max(0.05, Math.min(1, balanced * looseness)));
    // Strong-enough hands continue whatever the rest of their range is: a range of
    // only strong hands (e.g. after they raised) does not fold its bottom share to a bet.
    const strongEnough = Math.min(0.95, 0.55 + needed);
    return info.made.map((_, i) => {
        if (!w[i]) return 0;
        const drawOdds = (allIn ? info.hitByRiver[i] : info.hitNext[i]) + impliedBonus(street, allIn);
        const drawCont = info.outs[i] ? sigmoid((drawOdds - needed) / 0.03) : 0;
        return Math.max(madeCont[i], drawCont, sigmoid((info.made[i] - strongEnough) / 0.04));
    });
}

function apply(w: number[], m: number[]) {
    for (let i = 0; i < N; i++) w[i] *= FLOOR + (1 - FLOOR) * m[i];
}

/** How much more (or less) than a balanced player they continue vs bets, from their fold rate. */
export function loosenessOf(prof: Profile): number {
    return Math.max(0.5, Math.min(1.8, (1 - prof.foldToBet) / 0.55));
}

export function postflopWeights(
    view: TableView, p: SeatView, preRange: Range, board: number[], myHole: number[], prof: Profile,
): number[] {
    const dead = new Set([...myHole, ...board]);
    const w = COMBOS.map(([a, b], i) => dead.has(a) || dead.has(b) ? 0 : preRange[COMBO_CLASS[i]]);
    const looseness = loosenessOf(prof);

    // Replay the hand to know the pot and the price at each action.
    let street: Street = "preflop";
    let pot = 0;
    const bets = new Map<string, number>();
    let maxBet = 0;

    for (const a of view.actions) {
        if (a.street !== street) {
            street = a.street;
            bets.clear();
            maxBet = 0;
        }
        const before = bets.get(a.id) ?? 0;
        const toCall = Math.max(0, maxBet - before);
        const isAmount = ["sb", "bb", "straddle", "call", "bet", "raise"].includes(a.kind);

        if (a.id === p.id && street !== "preflop" && board.length >= BOARD_CARDS[street]) {
            const info = analyzeBoard(board.slice(0, BOARD_CARDS[street]));
            if (a.kind === "call" && toCall > 0) {
                const cont = continueMembership(w, info, toCall, pot, street, looseness, a.allIn);
                const wouldRaise = softTop(w, info.made, 0.08);
                apply(w, cont.map((c, i) => c * (1 - 0.6 * wouldRaise[i])));
            }
            else if (a.kind === "bet" || a.kind === "raise") {
                const added = a.amount - before - toCall;
                const r = added / Math.max(pot + toCall, 1);
                // How often THIS player bets/raises here: an aggressive player's bets are mostly air.
                const freq = toCall > 0 ? prof.raiseVsBet : prof.aggression;
                // Theory bluffs more with bigger bets; beginners do the opposite: they bluff
                // less overall (bluffBelief), and a big bet (3/4 pot or more) is their strongest hands.
                // A player SEEN betting far more than typical has shown they bluff: back to theory.
                const typical = toCall > 0 ? 0.12 : 0.35;
                const proven = Math.max(0, Math.min(1, (freq - typical) / 0.3));
                const belief = CONFIG.population.bluffBelief + (1 - CONFIG.population.bluffBelief) * proven;
                const bluffShare = belief * r / (1 + 2 * r);
                const sizeTight = r >= 0.75 ? 0.7 + 0.3 * proven : 1;
                const value = softTop(w, info.made, Math.min(1, freq * sizeTight * (1 - bluffShare)));
                const cand = info.made.map((m, i) =>
                    info.outs[i] >= 8 ? 1 : info.outs[i] > 0 ? 0.6 : m < 0.3 ? 0.3 : 0);
                let valueMass = 0, candMass = 0;
                for (let i = 0; i < N; i++) {
                    valueMass += w[i] * value[i];
                    candMass += w[i] * (1 - value[i]) * cand[i];
                }
                const k = candMass > 0 ? valueMass * bluffShare / (1 - bluffShare) / candMass : 0;
                apply(w, value.map((v, i) => v + (1 - v) * Math.min(1, k * cand[i])));
            }
            else if (a.kind === "check") {
                const strong = softTop(w, info.made, 0.2);
                apply(w, strong.map(s => 1 - 0.6 * s));
            }
        }

        if (isAmount) {
            const added = Math.max(0, a.amount - before);
            pot += added;
            bets.set(a.id, a.amount);
            maxBet = Math.max(maxBet, a.amount);
        }
        else if (a.kind === "ante") pot += a.amount;
    }
    return w;
}

/** Share of a weighted range that is drawing (flush draw / straight draw). */
export function drawShares(w: number[], info: BoardInfo) {
    let total = 0, flush = 0, straight = 0;
    for (let i = 0; i < N; i++) {
        total += w[i];
        if (info.flushDraw[i]) flush += w[i];
        else if (info.straightOuts[i]) straight += w[i];
    }
    return { flush: total ? flush / total : 0, straight: total ? straight / total : 0 };
}
