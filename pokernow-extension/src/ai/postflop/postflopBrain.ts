/**
 * Postflop decisions against each opponent's narrowed range.
 *
 * For every option (check, bet 1/2 pot, bet pot, all-in; or fold, call, raise):
 *   - who folds? Each hand in their range continues only if it's worth it at
 *     that price: made hands by strength, DRAWS by their chance to hit vs the
 *     pot odds (postflopRanges.continueMembership). A bigger bet prices out
 *     more draws, and that's how "bet big so the flush draw has to fold" falls
 *     out of the math.
 *   - if called, how often do we win against the hands that call?
 *   - expected value = fold% x pot + call% x (our share of the bigger pot - our bet)
 * Then pick the best, mixing between near-equal options so we're not predictable.
 */
import { TableView, SeatView, opponentsInHand } from "../../table/tableView";
import { Street } from "../../table/logReader";
import { cardToInt, evaluate } from "../equity/evaluator";
import { Range } from "../preflop/hands";
import { noteStrength } from "../../timing";
import { COMBOS, N, analyzeBoard, comboIndex, sigmoid } from "./board";
import { solveRiver } from "./riverSolver";
import { preflopRange } from "../preflop/playerRanges";
import { continueMembership, drawShares, loosenessOf, postflopWeights } from "./postflopRanges";
import { Profile, fishScore } from "../../table/stats";
import { CONFIG } from "../../config";

type Sample = { combo: number, result: number };

function sampler(weights: number[]) {
    const cum: number[] = new Array(N);
    let total = 0;
    for (let i = 0; i < N; i++) { total += weights[i]; cum[i] = total; }
    return () => {
        const x = Math.random() * total;
        let lo = 0, hi = N - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < x) lo = mid + 1; else hi = mid; }
        return lo;
    };
}

function runout(used: Set<number>, board: number[]): number[] {
    const full = board.slice();
    while (full.length < 5) {
        const c = Math.floor(Math.random() * 52);
        if (!used.has(c)) { used.add(c); full.push(c); }
    }
    return full;
}

/** Heads-up simulations vs one opponent's range: which combo they had, and our result. */
function simulateVs(hole: number[], board: number[], weights: number[], sims = CONFIG.tuning.postflopSims): Sample[] {
    const pick = sampler(weights);
    const out: Sample[] = [];
    for (let s = 0; s < sims; s++) {
        const combo = pick();
        const [a, b] = COMBOS[combo];
        const used = new Set([...hole, ...board, a, b]);
        const full = runout(used, board);
        const me = evaluate(hole.concat(full)), opp = evaluate([a, b, ...full]);
        out.push({ combo, result: me > opp ? 1 : me === opp ? 0.5 : 0 });
    }
    return out;
}

/** Our equity against everyone still in the hand at once. */
function equityVsAll(hole: number[], board: number[], ranges: number[][], sims = CONFIG.tuning.postflopSims): number {
    const picks = ranges.map(sampler);
    let total = 0, done = 0;
    for (let s = 0; s < sims * 3 && done < sims; s++) {
        const used = new Set([...hole, ...board]);
        const hands: number[][] = [];
        let ok = true;
        for (const pick of picks) {
            const [a, b] = COMBOS[pick()];
            if (used.has(a) || used.has(b)) { ok = false; break; }
            used.add(a); used.add(b); hands.push([a, b]);
        }
        if (!ok) continue;
        const full = runout(used, board);
        const me = evaluate(hole.concat(full));
        const best = Math.max(...hands.map(h => evaluate(h.concat(full))));
        total += me > best ? 1 : me === best ? 0.5 : 0;
        done++;
    }
    return done ? total / done : 0.5;
}

function equityAgainst(samples: Sample[], membership?: number[]): number {
    let num = 0, den = 0;
    for (const s of samples) {
        const m = membership ? membership[s.combo] : 1;
        num += m * s.result; den += m;
    }
    return den > 1e-9 ? num / den : samples.reduce((x, s) => x + s.result, 0) / samples.length;
}

/** Postflop acting order is SB, BB, then the rest; the last player left acts last. */
function inPosition(view: TableView): boolean {
    const ps = view.players;
    const order = ps.length === 2 ? [ps[1], ps[0]] : [...ps.slice(-2), ...ps.slice(0, -2)];
    const live = order.filter(p => !p.folded);
    return live[live.length - 1]?.isMe ?? false;
}

export type PostflopContext = {
    preRanges: Map<string, Range>,
    profileOf: (p: SeatView) => Profile,
    callPressure: number,      // extra equity ICM demands before risking our stack
};

/** How opponents see us: a typical player, since they can't see our cards. */
const SELF_PROFILE: Profile = { hands: 0, style: 1, vpip: 0.25, pfr: 0.15, threeBet: 0.07, aggression: 0.35, raiseVsBet: 0.12, foldToBet: 0.45 };

const SOLVER_ACTIONS: Record<string, Action> = {
    "check": { type: "check_or_fold" }, "fold": { type: "check_or_fold" }, "call": { type: "call" },
    "bet 0.5": { type: "raise", raiseAmount: "1/2_pot" }, "bet 1": { type: "raise", raiseAmount: "pot" },
    "all-in": { type: "raise", raiseAmount: "all_in" }, "raise all-in": { type: "raise", raiseAmount: "all_in" },
};

/**
 * Heads-up river: solve the remaining betting with CFR+ and play our hand's
 * equilibrium strategy (including its mixes). Returns null to fall back.
 */
function riverBySolver(view: TableView, state: State, villain: SeatView, villainWeights: number[],
    hole: number[], board: number[]): { action: Action, reason: string } | null {
    const ip = inPosition(view);
    const me: 0 | 1 = ip ? 1 : 0;
    const players: [SeatView, SeatView] = ip ? [villain, view.me] : [view.me, villain];
    const heroWeights = postflopWeights(view, view.me, preflopRange(view, view.me, SELF_PROFILE), board, [], SELF_PROFILE);
    const river = view.actions.filter(a => a.street === "river");
    const bets: [number, number] = [players[0].streetBet, players[1].streetBet];
    const raises = river.filter(a => a.kind === "bet" || a.kind === "raise").length;
    const solution = solveRiver({
        board,
        pot: view.pot - bets[0] - bets[1],
        ranges: me === 0 ? [heroWeights, villainWeights] : [villainWeights, heroWeights],
        bets,
        stacks: [players[0].stack, players[1].stack],
        toAct: me,
        checked: bets[0] === 0 && bets[1] === 0 && river.some(a => a.kind === "check"),
        raisesLeft: raises === 0 ? 1 : raises === 1 ? 1 : 0,
    }, CONFIG.tuning.riverIterations);
    if (solution.exploitability > 0.15) return null;

    const strategy = solution.strategyFor(comboIndex(hole[0], hole[1])).filter(s => s.prob > 0.005);
    let x = Math.random(), pick = strategy[strategy.length - 1];
    for (const s of strategy) { if (x < s.prob) { pick = s; break; } x -= s.prob; }
    const action = SOLVER_ACTIONS[pick.action] ?? (pick.action.startsWith("bet") ? { type: "raise", raiseAmount: "pot" } as Action : { type: "call" } as Action);
    return {
        action,
        reason: `river, heads-up: solved ${solution.iterations} CFR+ iterations ` +
            `(${(solution.exploitability * 100).toFixed(1)}% of pot from perfect). My hand's strategy: ` +
            strategy.map(s => `${s.action} ${Math.round(s.prob * 100)}%`).join(", ") + ` -> ${pick.action}`,
    };
}

export function postflopDecide(view: TableView, state: State, ctx: PostflopContext): { action: Action, reason: string } {
    const hole = state.hand.map(cardToInt);
    const board = state.board.map(cardToInt);
    const street = state.phase.name as Street;
    const info = analyzeBoard(board);
    const opps = opponentsInHand(view);
    const weights = opps.map(p => postflopWeights(view, p, ctx.preRanges.get(p.id)!, board, hole, ctx.profileOf(p)));
    // Balanced play only protects us against opponents who adapt. Against a fish
    // (calls too much, rarely raises) it leaves money behind: the solver would
    // bluff them at a "balanced" rate they never fold to and value bet too thin.
    // So against fish, the EV rules below play their actual habits.
    const fish = opps.length === 1 ? fishScore(ctx.profileOf(opps[0])) : 0;
    let exploitNote = "";
    if (street === "river" && opps.length === 1 && CONFIG.tuning.riverSolver && fish >= CONFIG.tuning.exploitCutoff)
        exploitNote = `Target the fish: ${opps[0].name} fish score ${fish.toFixed(2)}, exploiting instead of solving. `;
    else if (street === "river" && opps.length === 1 && CONFIG.tuning.riverSolver) {
        try {
            const solved = riverBySolver(view, state, opps[0], weights[0], hole, board);
            if (solved) {
                noteStrength(info.made[comboIndex(hole[0], hole[1])]);
                return solved;
            }
        }
        catch (err) {
            console.warn("[river solver] failed, using EV rules:", err);
        }
    }
    const samples = weights.map(w => simulateVs(hole, board, w));
    const eqAll = opps.length === 1 ? equityAgainst(samples[0]) : equityVsAll(hole, board, weights);
    noteStrength(eqAll * (opps.length + 1) / 2);

    const pot = view.pot > 0 ? view.pot : state.pot;
    const toCall = Math.min(state.toCall, view.me.stack);
    const myStack = view.me.stack;
    const ip = inPosition(view);
    const realise = street === "river" ? 1 : ip ? 1 : CONFIG.tuning.realiseOOP;
    const river = street === "river";

    type Option = { action: Action, ev: number, label: string };
    const options: Option[] = [];

    if (toCall === 0) options.push({ action: { type: "check_or_fold" }, ev: realise * eqAll * pot, label: "check" });
    else {
        options.push({ action: { type: "check_or_fold" }, ev: 0, label: "fold" });
        let ev = (toCall >= myStack ? 1 : realise) * eqAll * (pot + toCall) - toCall;
        if (toCall >= 0.5 * myStack) ev -= ctx.callPressure * (pot + toCall);
        options.push({ action: { type: "call" }, ev, label: "call" });
    }

    const sizes: [number, RaiseAmount][] = [[0.5, "1/2_pot"], [1, "pot"]];
    if (myStack <= 2.5 * (pot + toCall)) sizes.push([Infinity, "all_in"]);
    if (toCall > 0) sizes.shift();                 // facing a bet: raise pot-size or all-in

    for (const [frac, preset] of sizes) {
        const x = Math.min(myStack, frac === Infinity ? myStack : toCall + frac * (pot + toCall));
        if (x <= toCall) continue;
        const allIn = x >= myStack;
        let noneYet = 1, calledEv = 0;
        const notes: string[] = [];
        opps.forEach((p, k) => {
            const theirCall = Math.min(x - toCall, p.stack);       // what they must add to continue
            let cont = continueMembership(weights[k], info, theirCall, pot + x, street, loosenessOf(ctx.profileOf(p)),
                allIn || theirCall >= p.stack);
            // Already 40%+ of their stack in: they don't fold a decent hand or a draw.
            if (p.invested >= 0.4 * p.startStack)
                cont = cont.map((c, i) => info.made[i] >= 0.5 || info.outs[i] ? Math.max(c, 0.95) : c);
            // Their strongest hands raise instead of calling (if they have chips left to raise with).
            const canRaise = p.stack > theirCall && !allIn;
            const raises = cont.map((c, i) => canRaise ? c * 0.6 * sigmoid((info.made[i] - 0.9) / 0.02) : 0);
            const calls = cont.map((c, i) => c - raises[i]);
            let wSum = 0, cSum = 0, rSum = 0, dSum = 0, dCont = 0;
            for (let i = 0; i < N; i++) {
                const w = weights[k][i];
                wSum += w; cSum += w * calls[i]; rSum += w * raises[i];
                if (info.outs[i]) { dSum += w; dCont += w * cont[i]; }
            }
            const pCall = wSum ? cSum / wSum : 0, pRaise = wSum ? rSum / wSum : 0;
            const eqCalled = equityAgainst(samples[k], calls);
            const r = river || allIn ? 1 : realise;
            // If they raise: fold (lose our bet), unless we're strong enough to get it all in.
            const risk = Math.min(myStack, p.stack + theirCall);
            const eqVsRaise = pRaise > 0.001 ? equityAgainst(samples[k], raises) : 0;
            const raisedEv = Math.max(-x, eqVsRaise * (pot + 2 * risk) - risk);
            calledEv += noneYet * (pCall * (r * eqCalled * (pot + x + theirCall) - x) + pRaise * raisedEv);
            noneYet *= 1 - pCall - pRaise;
            notes.push(`${p.name} folds ${Math.round((1 - pCall - pRaise) * 100)}%` +
                (pRaise > 0.02 ? `, raises ${Math.round(pRaise * 100)}%` : "") +
                (dSum / Math.max(wSum, 1e-9) > 0.05 ? ` (draws fold ${Math.round((1 - dCont / dSum) * 100)}%)` : "") +
                `, my equity if called ${Math.round(eqCalled * 100)}%`);
        });
        let ev = noneYet * pot + calledEv;
        if (x >= 0.5 * myStack) ev -= ctx.callPressure * (pot + 2 * x);
        const name = preset === "all_in" ? "all-in" : `${toCall ? "raise" : "bet"} ${preset.replace("_", " ")}`;
        options.push({ action: { type: "raise", raiseAmount: preset }, ev, label: `${name} [${notes.join("; ")}]` });
    }

    // Mostly the best EV; options within a few % of the pot get mixed.
    // Clearly worse options (more than 8% of the pot below the best) are never picked.
    const best = Math.max(...options.map(o => o.ev));
    const scale = Math.max(1, pot) * CONFIG.tuning.postflopTemperature;
    const probs = options.map(o => o.ev < best - 0.08 * Math.max(1, pot) ? 0 : Math.exp((o.ev - best) / scale));
    let x = Math.random() * probs.reduce((a, b) => a + b, 0), choice = 0;
    while (x > probs[choice] && choice < probs.length - 1) x -= probs[choice++];

    const draws = drawShares(weights[0], info);
    const drawNote = draws.flush + draws.straight > 0.03
        ? `${opps[0].name}'s range: ${Math.round(draws.flush * 100)}% flush draws, ${Math.round(draws.straight * 100)}% straight draws. `
        : "";
    const reason = `${street}, equity vs their ranges ${Math.round(eqAll * 100)}%, pot ${pot}, ${ip ? "in" : "out of"} position. ` +
        exploitNote + drawNote + options.map(o => `${o.label}: ${o.ev >= 0 ? "+" : ""}${o.ev.toFixed(0)}`).join(" | ") +
        ` -> ${options[choice].label.split(" [")[0]}`;
    return { action: options[choice].action, reason };
}
