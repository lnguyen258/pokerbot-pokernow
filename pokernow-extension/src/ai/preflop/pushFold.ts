/**
 * All-in decisions with tournament math (ICM).
 *
 * For a player who goes all-in ("the actor"):
 *   - each player still to act calls only with hands whose equity against the
 *     actor's range beats what THEIR stack situation requires (ICM). A short or
 *     medium stack near the paid places needs much more than 50%, so it folds more.
 *   - the actor's EV for every hand type = (everyone folds) x win the pot
 *     + (someone calls) x (win or lose the all-in), all in tournament points.
 *   - the actor's range is then "hands where all-in beats folding".
 * Repeating this until the ranges stop changing gives the push/fold equilibrium:
 * neither side can do better by changing their range. This is the game-theory
 * (GTO) answer for short stacks, adjusted for the payouts.
 */
import { icm } from "../icm";
import { SeatView, TableView } from "../../table/tableView";
import { Range, continuingRange, equityVsRange, fullRange, rangeSize } from "./hands";

export type CallerInfo = { seat: SeatView, required: number, callRange: Range, pCall: number };

export type AllInResult = {
    evShove: number[],        // actor's tournament points for each of the 169 hand types
    evFold: number,
    actorRange: Range,        // equilibrium all-in range
    callers: CallerInfo[],
    pAllFold: number,
};

export function allInAnalysis(
    view: TableView,
    actor: SeatView,
    callers: SeatView[],
    rangeOf: (p: SeatView) => Range,
    styleOf: (p: SeatView) => number,
    payouts: number[],
    startRange: Range = fullRange(),
): AllInResult {
    const ps = view.players;
    const a = ps.indexOf(actor);
    const start = ps.map(p => p.startStack);
    const inv = ps.map(p => p.invested);
    const totalPot = inv.reduce((x, y) => x + y, 0);
    const value = (stacks: number[], who: number) => icm(stacks, payouts)[who];

    // Everyone folds to the all-in: actor wins everything in the pot.
    const foldAround = start.map((s, k) => k === a ? s + totalPot - inv[a] : s - inv[k]);
    // Actor folds instead: pot goes to whoever has the most in it (usually the big blind).
    const others = ps.map((_, k) => k).filter(k => k !== a && !ps[k].folded);
    const taker = others.reduce((best, k) => inv[k] > inv[best] ? k : best, others[0] ?? a);
    const actorFolds = start.map((s, k) => k === taker ? s - inv[k] + totalPot : s - inv[k]);
    const evFold = value(actorFolds, a);
    const evAllFold = value(foldAround, a);

    // Showdown between actor and caller j.
    const showdown = (j: number, actorWins: boolean) => {
        const eff = Math.min(start[a], start[j]);
        const dead = totalPot - inv[a] - inv[j];
        return start.map((s, k) => {
            if (k === a) return actorWins ? s + eff + dead : s - eff;
            if (k === j) return actorWins ? s - eff : s + eff + dead;
            return s - inv[k];
        });
    };

    const callerData = callers.map(seat => {
        const j = ps.indexOf(seat);
        const win = showdown(j, true), lose = showdown(j, false);
        const vjFold = value(foldAround, j), vjWin = value(lose, j), vjLose = value(win, j);
        const required = vjWin - vjLose > 1e-9 ? (vjFold - vjLose) / (vjWin - vjLose) : 0.5;
        return {
            seat, required, base: rangeOf(seat),
            // Loose players call a bit lighter than the math says, tight ones tighter.
            shift: Math.max(-0.06, Math.min(0.06, 0.04 * (styleOf(seat) - 1))),
            vaWin: value(win, a), vaLose: value(lose, a),
        };
    });

    let actorRange = startRange.slice();
    let result: AllInResult | null = null;

    for (let iter = 0; iter < 12; iter++) {
        const info: CallerInfo[] = callerData.map(c => {
            const callRange = continuingRange(c.base, actorRange, c.required - c.shift);
            const size = rangeSize(c.base);
            return { seat: c.seat, required: c.required, callRange, pCall: size > 0 ? rangeSize(callRange) / size : 0 };
        });

        // Probability that caller j is the first to call (we ignore 3-way all-ins).
        let noneYet = 1;
        const first = info.map(c => {
            const p = noneYet * c.pCall;
            noneYet *= 1 - c.pCall;
            return p;
        });

        const evShove = new Array(169).fill(0).map((_, i) => {
            let ev = noneYet * evAllFold;
            info.forEach((c, k) => {
                if (first[k] <= 0) return;
                const e = equityVsRange(i, c.callRange);
                ev += first[k] * (e * callerData[k].vaWin + (1 - e) * callerData[k].vaLose);
            });
            return ev;
        });

        result = { evShove, evFold, actorRange, callers: info, pAllFold: noneYet };

        // New actor range: hand types where all-in beats folding (soft edge), damped.
        const scale = Math.max(1e-6, Math.abs(evAllFold - evFold) * 0.15);
        const next = evShove.map((ev, i) =>
            startRange[i] * Math.max(0, Math.min(1, 0.5 + (ev - evFold) / scale)));
        const change = next.reduce((s, x, i) => s + Math.abs(x - actorRange[i]), 0);
        actorRange = actorRange.map((x, i) => 0.5 * x + 0.5 * next[i]);
        if (change < 0.5) break;
    }
    result!.actorRange = actorRange;
    return result!;
}
