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
import { Range, continuingRange, equityVsRange, fullRange, intersect, rangeSize, topRange } from "./hands";
import { CONFIG } from "../../config";

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

    // Three-way all-in that the actor wins: takes the effective stack from both callers.
    const showdown3 = (k: number, m: number) => {
        const j1 = ps.indexOf(callers[k]), j2 = ps.indexOf(callers[m]);
        const e1 = Math.min(start[a], start[j1]), e2 = Math.min(start[a], start[j2]);
        const dead = totalPot - inv[a] - inv[j1] - inv[j2];
        return start.map((s, x) => x === a ? s + e1 + e2 + dead : x === j1 ? s - e1 : x === j2 ? s - e2 : s - inv[x]);
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

    // Real players don't follow tournament math when they hold a big hand: they call an all-in
    // with their strongest hands (77+, AJs+, AQ+, AK by default) whatever their stack says.
    // 3-4 players (v1.15.0): players here keep playing good hands, and call with more of them.
    const shortHanded = CONFIG.tuning.shortTight && ps.length >= 3 && ps.length <= 4;
    const alwaysCall = topRange(CONFIG.population.allInCallFloor * (shortHanded ? 1.5 : 1));

    for (let iter = 0; iter < 12; iter++) {
        const info: CallerInfo[] = callerData.map(c => {
            const icmCalls = continuingRange(c.base, actorRange, c.required - c.shift);
            const floor = intersect(c.base, alwaysCall);
            const callRange = icmCalls.map((x, i) => Math.max(x, floor[i]));
            const size = rangeSize(c.base);
            return { seat: c.seat, required: c.required, callRange, pCall: size > 0 ? rangeSize(callRange) / size : 0 };
        });

        // Probability that caller j is the first to call.
        let noneYet = 1;
        const first = info.map(c => {
            const p = noneYet * c.pCall;
            noneYet *= 1 - c.pCall;
            return p;
        });

        // v1.15.7: after a call, players still to act can call too (real games: K4s and K3s all-ins
        // into 3 players got 2 callers). Overcall chance = their call chance x overcallFactor; a 3-way
        // all-in is won with roughly (equity vs one) x (equity vs the other).
        const over = CONFIG.tuning.overcallFactor;
        const eqs = info.map(c => new Array(169).fill(0).map((_, i) => equityVsRange(i, c.callRange)));
        const threeWayWin = info.map((_, k) => info.map((__, m) => m > k ? value(showdown3(k, m), a) : 0));

        const evShove = new Array(169).fill(0).map((_, i) => {
            let ev = noneYet * evAllFold;
            info.forEach((c, k) => {
                if (first[k] <= 0) return;
                const e = eqs[k][i];
                const headsUp = e * callerData[k].vaWin + (1 - e) * callerData[k].vaLose;
                // First overcaller after k (only one is modelled).
                let notYet = 1, evOver = 0, pOver = 0;
                for (let m = k + 1; m < info.length && over > 0; m++) {
                    const p = notYet * over * info[m].pCall;
                    if (p > 0) {
                        const e3 = e * eqs[m][i];
                        evOver += p * (e3 * threeWayWin[k][m] + (1 - e3) * callerData[k].vaLose);
                        pOver += p;
                    }
                    notYet *= 1 - over * info[m].pCall;
                }
                ev += first[k] * ((1 - pOver) * headsUp + evOver);
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
