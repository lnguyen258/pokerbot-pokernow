/**
 * Postflop decisions against each opponent's narrowed range.
 *
 * For every option (check, bet any size from 20% of the pot to an overbet, all-in; or fold, call, raise):
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
import { raiseTo } from "../sizing";
import { isAir, noOwnPair, onePairOrWorse, phaseStyle, strongMade } from "../phaseStyle";

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
    // After the flop the blinds act first (only the big blind when no small blind was posted).
    const blind = (p: SeatView) => p.position === "SB" || p.position === "BB";
    const order = ps.length === 2 ? [ps[1], ps[0]] : [...ps.filter(blind), ...ps.filter(p => !blind(p))];
    const live = order.filter(p => !p.folded);
    return live[live.length - 1]?.isMe ?? false;
}

/** River: share of the opponent's weighted range our hand beats (ties count half). */
function riverEquity(hole: number[], board: number[], weights: number[]): number {
    const mine = evaluate(hole.concat(board));
    const used = new Set([...hole, ...board]);
    let won = 0, total = 0;
    for (let i = 0; i < N; i++) {
        const w = weights[i];
        if (!w) continue;
        const [a, b] = COMBOS[i];
        if (used.has(a) || used.has(b)) continue;
        const theirs = evaluate([a, b, ...board]);
        total += w;
        won += w * (mine > theirs ? 1 : mine === theirs ? 0.5 : 0);
    }
    return total > 0 ? won / total : 0.5;
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
    // Solver bets are pot fractions ("bet 0.5"): type the exact amount.
    const betFrac = /^bet ([\d.]+)$/.exec(pick.action);
    const action = betFrac ? raiseTo(view, view.me.streetBet + parseFloat(betFrac[1]) * view.pot)
        : SOLVER_ACTIONS[pick.action] ?? (pick.action.startsWith("bet") ? { type: "raise", raiseAmount: "pot" } as Action : { type: "call" } as Action);
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

    // Table-phase rules (REFORM.md Part 3):
    //  - no pure bluffs (nothing made, no real draw) at full / 5-handed tables, or into 2+ opponents
    //  - no raise or all-in with one pair against a raise at those tables (unless short: 15 BB or less)
    const style = phaseStyle(view);
    const mine = comboIndex(hole[0], hole[1]);
    // Bets each opponent has already called after the flop (a check-caller has a hand).
    const callsOf = (p: SeatView) => view.actions.filter(a => a.id === p.id && a.street !== "preflop" && a.kind === "call").length;
    const maxCalls = Math.max(0, ...opps.map(callsOf));
    // No barrels with nothing (v1.12.3): no pair of our own and no real draw, against someone who
    // already called after the flop (5+ players: one call; fewer players: two calls).
    const nothing = noOwnPair(hole, board) && info.outs[mine] < 8;
    const noBarrel = !!CONFIG.tuning.checkCallRules && nothing && maxCalls >= (style.limitShoves ? 1 : 2);
    // Bluff gate (v1.15.2, real games: these opponents call or raise our bluffs): in a tournament,
    // not heads-up, a bet with nothing only on the flop, in position, against one player.
    const bluffGate = !!CONFIG.tuning.bluffGate && CONFIG.gameType === "tournament" && style.phase !== "headsUp";
    const noAirBet = bluffGate && nothing && (!inPosition(view) || opps.length >= 2 || street !== "flop");
    const noBluff = (isAir(info.made[mine], info.outs[mine]) && (!style.bluffs || opps.length >= 2)) || noBarrel || noAirBet;
    // Bluffs stay small (v1.12.4): with nothing, bet at most airMaxBet x pot, never all-in, never raise.
    // Heads-up is the exception (REFORM Part 7 decides heads-up pressure).
    const airLimit = !!CONFIG.tuning.airRule && nothing && style.phase !== "headsUp";
    const lastAggr = [...view.actions].reverse().find(a => a.street === street && (a.kind === "bet" || a.kind === "raise"));
    const facingRaise = state.toCall > 0 && lastAggr?.kind === "raise" && lastAggr.id !== view.me.id;
    const guard = style.stackOffGuard && facingRaise && onePairOrWorse(hole, board) &&
        view.me.stack / Math.max(1, view.bb) > 15;
    //  - (v1.12.1) no all-in and no bet, raise or call of 40%+ of the stack without a strong made hand
    //    (two pair+, a flush+ on a three-suited board), and no overbets: bets up to fullMaxBet x pot.
    //    Unless short (style.shoveMaxBB or less). Calls are allowed with 55%+ equity.
    const strong = strongMade(hole, board);
    // Short = at the START of the hand (like the preflop rule), not after the chips we put in this hand.
    const careful = !!CONFIG.tuning.postflopCareful && style.limitShoves && view.me.startStack / Math.max(1, view.bb) > style.shoveMaxBB;
    const ruleNote = (noBarrel ? `No barrel: no pair, no draw, and they already called ${maxCalls} bet${maxCalls > 1 ? "s" : ""}. `
        : noAirBet ? `No bluff with nothing (only a flop bet, in position, vs one player). `
        : noBluff ? `No bluff: nothing made${opps.length >= 2 ? ` into ${opps.length} players` : ` at a ${style.phase} table`}. `
        : guard ? `One pair vs a raise at a ${style.phase} table: call or fold only. ` : "") +
        (airLimit && !noBluff ? `Bluff with nothing: small bets only (up to ${Math.round(CONFIG.tuning.airMaxBet * 100)}% pot), no raise or all-in. ` : "") +
        (careful ? `Careful (${style.phase} table): ${strong ? "strong hand, may commit" : "no all-in or big commitment"}, bets up to ${Math.round(CONFIG.tuning.fullMaxBet * 100)}% pot. ` : "");

    let exploitNote = "";
    if (street === "river" && opps.length === 1 && CONFIG.tuning.riverSolver && (noBluff || guard || (careful && !strong)))
        exploitNote = "Solver skipped (it may bluff or raise). ";
    else if (street === "river" && opps.length === 1 && CONFIG.tuning.riverSolver && fish >= CONFIG.tuning.exploitCutoff)
        exploitNote = `Target the fish: ${opps[0].name} fish score ${fish.toFixed(2)}, exploiting instead of solving. `;
    else if (street === "river" && opps.length === 1 && CONFIG.tuning.riverSolver) {
        try {
            let solved = riverBySolver(view, state, opps[0], weights[0], hole, board);
            // Safety net: never fold a river hand that beats nearly all of their range.
            const riverEq = riverEquity(hole, board, weights[0]);
            if (solved && solved.action.type === "check_or_fold" && state.toCall > 0 && riverEq >= 0.9)
                solved = { action: { type: "call" }, reason: solved.reason + ` -> overridden: I beat ${Math.round(riverEq * 100)}% of their range, call` };
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
    // One pair calling a full-table raise before the river: they keep betting on later streets,
    // so we keep less of our equity (guardRealise), in position or not.
    // In position we act last on every later street and realise MORE than our raw equity (v1.13.0, realiseIP).
    const ipRealise = CONFIG.tuning.positionRules ? CONFIG.tuning.realiseIP : 1;
    const realise = street === "river" ? 1 : Math.min(ip ? ipRealise : CONFIG.tuning.realiseOOP, guard ? CONFIG.tuning.guardRealise : 1);
    const river = street === "river";

    type Option = { action: Action, ev: number, label: string, x?: number };   // x = chips we put in
    const options: Option[] = [];

    if (toCall === 0) options.push({ action: { type: "check_or_fold" }, ev: realise * eqAll * pot, label: "check" });
    else {
        options.push({ action: { type: "check_or_fold" }, ev: 0, label: "fold" });
        let ev = (toCall >= myStack ? 1 : realise) * eqAll * (pot + toCall) - toCall;
        if (toCall >= 0.5 * myStack) ev -= ctx.callPressure * (pot + toCall);
        options.push({ action: { type: "call" }, ev, label: "call", x: toCall });
    }

    /** EV of putting in `x` more chips now (a bet, or a raise when facing one). */
    const evOfRaise = (x: number): { ev: number, notes: string[] } => {
        const allIn = x >= myStack;
        let noneYet = 1, calledEv = 0;
        const notes: string[] = [];
        opps.forEach((p, k) => {
            const theirCall = Math.min(x - toCall, p.stack);       // what they must add to continue
            // Sticky: each bet they already called after the flop makes them fold less now.
            const sticky = Math.min(1.8, loosenessOf(ctx.profileOf(p)) * (CONFIG.tuning.checkCallRules ? 1 + 0.3 * callsOf(p) : 1));
            let cont = continueMembership(weights[k], info, theirCall, pot + x, street, sticky,
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
            // Reverse implied odds: before the river, a called bet with a hand that's often behind
            // grows a pot we'll keep paying into on later streets. Costs more the bigger the bet.
            const later = river || allIn ? 0 : CONFIG.tuning.reverseImplied * (1 - eqCalled) * x;
            calledEv += noneYet * (pCall * (r * eqCalled * (pot + x + theirCall) - x - later) + pRaise * raisedEv);
            noneYet *= 1 - pCall - pRaise;
            notes.push(`${p.name} folds ${Math.round((1 - pCall - pRaise) * 100)}%` +
                (pRaise > 0.02 ? `, raises ${Math.round(pRaise * 100)}%` : "") +
                (dSum / Math.max(wSum, 1e-9) > 0.05 ? ` (draws fold ${Math.round((1 - dCont / dSum) * 100)}%)` : "") +
                `, my equity if called ${Math.round(eqCalled * 100)}%`);
        });
        let ev = noneYet * pot + calledEv;
        if (x >= 0.5 * myStack) ev -= ctx.callPressure * (pot + 2 * x);
        return { ev, notes };
    };

    // Sizes are shares of the pot after our call: bet 0.5 = half the pot; facing a bet,
    // raise 0.5 = call, then add half the new pot (about 3x their bet).
    const chipsFor = (frac: number) => toCall + frac * (pot + toCall);
    const scored = new Map<number, { action: Action, ev: number, notes: string[] }>();   // by chips added
    const score = (frac: number) => {
        const sized = frac === Infinity ? { type: "raise", raiseAmount: "all_in" } as Action
            : raiseTo(view, view.me.streetBet + chipsFor(frac));
        const x = sized.amount !== undefined ? sized.amount - view.me.streetBet : myStack;
        if (x <= toCall) return null;
        let hit = scored.get(x);
        if (!hit) { hit = { action: sized, ...evOfRaise(x) }; scored.set(x, hit); }
        return { x, ...hit };
    };
    const label = (x: number, notes: string[]) => (x >= myStack ? "all-in"
        : `${toCall ? "raise" : "bet"} ${Math.round((x - toCall) / (pot + toCall) * 100)}% pot, to ${x + view.me.streetBet}`) +
        ` [${notes.join("; ")}]`;
    const canShove = myStack <= 2.5 * (pot + toCall);

    if (CONFIG.tuning.postflopSizing >= 2) {
        // Any size: scan 20% of the pot up to an overbet, then zoom in around the best.
        let top = careful ? CONFIG.tuning.fullMaxBet : Math.max(1, CONFIG.tuning.maxOverbet);
        if (airLimit) top = Math.min(top, CONFIG.tuning.airMaxBet);
        // v1.15.6: the careful rule below drops bets of 40%+ of the stack. Search only sizes under that,
        // else the best size was dropped and no smaller bet was left (real game: 87% equity, checked).
        if (careful && !strong) top = Math.min(top, (0.4 * myStack - toCall) / Math.max(1, pot + toCall) - 0.01);
        const grid = (toCall > 0 ? [0.35, 0.5, 0.7, 1, 1.3] : [0.2, 0.33, 0.5, 0.66, 0.8, 1, 1.25, 1.5])
            .filter(f => f <= top + 1e-9);
        if (top >= 0.1 && !(grid[grid.length - 1] >= top)) grid.push(top);
        if (grid.length) {
        const evAt = (f: number) => score(f)?.ev ?? -Infinity;
        let bi = 0;
        grid.forEach((f, i) => { if (evAt(f) > evAt(grid[bi])) bi = i; });
        // Golden-section search between the neighbours of the best grid point.
        let lo = grid[Math.max(0, bi - 1)], hi = grid[Math.min(grid.length - 1, bi + 1)];
        const g = 0.618;
        for (let it = 0; it < 4 && hi - lo > 0.02; it++) {
            const a = hi - g * (hi - lo), b = lo + g * (hi - lo);
            if (evAt(a) >= evAt(b)) hi = b; else lo = a;
        }
        let bestFrac = grid[bi];
        for (const f of [lo, hi, (lo + hi) / 2]) if (evAt(f) > evAt(bestFrac)) bestFrac = f;
        // A little random spread so the exact size doesn't give our hand away.
        const spread = CONFIG.tuning.sizeSpread * (2 * Math.random() - 1);
        const pick = score(Math.min(top, bestFrac * (1 + spread))) ?? score(bestFrac);
        if (pick && pick.x < myStack)
            options.push({ action: pick.action, ev: pick.ev, label: label(pick.x, pick.notes), x: pick.x });
        }
        if (canShove) {
            const shove = score(Infinity);
            if (shove) options.push({ action: shove.action, ev: shove.ev, label: label(shove.x, shove.notes), x: shove.x });
        }
    }
    else {
        // Fixed sizes. Old: bet 1/2 or pot, raise pot. v1.9.0: bet 1/3, 1/2, 3/4, pot; raise 1/2 or pot.
        const sizes: number[] = CONFIG.tuning.postflopSizing === 0 ? (toCall > 0 ? [1] : [0.5, 1])
            : toCall > 0 ? [0.5, 1] : [1 / 3, 0.5, 0.75, 1];
        if (canShove) sizes.push(Infinity);
        const seen = new Set<number>();
        for (const frac of sizes) {
            const s = score(frac);
            if (!s || seen.has(s.x)) continue;
            seen.add(s.x);
            options.push({ action: s.action, ev: s.ev, label: label(s.x, s.notes), x: s.x });
        }
    }

    const commit = 0.4 * myStack;
    // Weak hand into 2+ players (bluff gate): they rarely all fold, so check / call / fold only.
    const weakMultiway = bluffGate && opps.length >= 2 && eqAll < CONFIG.tuning.weakMultiwayEq;
    const allowed = (o: Option) => {
        if ((noBluff || guard || weakMultiway) && o.action.type === "raise") return false;
        if (airLimit && o.action.type === "raise" && (toCall > 0 || (o.x !== undefined && o.x >= myStack))) return false;
        if (!careful || strong || o.x === undefined || o.x < commit) return true;
        // Big calls need 55% equity, or (v1.15.5, user: "relax a little") a clear margin over the price.
        const need = toCall / Math.max(1, pot + toCall);
        return o.action.type === "call" && eqAll >= Math.min(0.55, need + CONFIG.tuning.carefulCallMargin);
    };
    if (options.some(o => !allowed(o))) {
        const kept = options.filter(allowed);
        options.length = 0;
        options.push(...kept);
    }

    // Mostly the best EV; options within a few % of the pot get mixed.
    // Clearly worse options (more than 8% of the pot below the best) are never picked.
    const best = Math.max(...options.map(o => o.ev));
    // Under the one-pair guard the choice is firm (little mixing): no "sometimes call" there.
    const scale = Math.max(1, pot) * CONFIG.tuning.postflopTemperature * (guard ? 0.25 : 1);
    // v1.15.7 (real game: an all-in call scored -96 vs fold 0 was picked by the mixing, and busted us):
    // no mixing into big commitments (40%+ of the stack). Those are only played when they're the best.
    const bigCommit = (o: Option) => o.x !== undefined && o.x >= 0.4 * myStack;
    // Nor into calls that lose chips vs folding (real games: calls at -9 / -17 / -20 / -96 were picked).
    const losingCall = (o: Option) => o.action.type === "call" && o.ev < 0;
    const probs = options.map(o => o.ev < best - 0.08 * Math.max(1, pot) || (bigCommit(o) && o.ev < best) || losingCall(o) ? 0
        : Math.exp((o.ev - best) / scale));
    let x = Math.random() * probs.reduce((a, b) => a + b, 0), choice = 0;
    while (x > probs[choice] && choice < probs.length - 1) x -= probs[choice++];

    const draws = drawShares(weights[0], info);
    const drawNote = draws.flush + draws.straight > 0.03
        ? `${opps[0].name}'s range: ${Math.round(draws.flush * 100)}% flush draws, ${Math.round(draws.straight * 100)}% straight draws. `
        : "";
    const reason = `${street}, equity vs their ranges ${Math.round(eqAll * 100)}%, pot ${pot}, ${ip ? "in" : "out of"} position. ` +
        ruleNote + (weakMultiway ? `Weak (${Math.round(eqAll * 100)}%) into ${opps.length} players: no bet or raise. ` : "") +
        exploitNote + drawNote + options.map(o => `${o.label}: ${o.ev >= 0 ? "+" : ""}${o.ev.toFixed(0)}`).join(" | ") +
        ` -> ${options[choice].label.split(" [")[0]}`;
    return { action: options[choice].action, reason };
}
