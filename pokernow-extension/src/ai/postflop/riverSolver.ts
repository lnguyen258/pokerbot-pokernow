/**
 * Real-time river solver (heads-up): CFR+ over the betting left on the river.
 *
 * Inputs: the board, both players' ranges (1,326 combo weights each), the pot,
 * stacks and where we are in the betting. It builds the tree of remaining
 * actions (check, bet 1/2 pot / pot / all-in, fold, call, raise all-in), then
 * runs CFR+ (step 2 of the roadmap) for every hand of both players at once.
 * The average strategy converges to an equilibrium of this river subgame:
 * balanced value bets and bluffs, and calling just often enough.
 *
 * Utilities are chips won from the river onward:
 *   win at showdown = pot + opponent's river chips, lose = -our river chips.
 */
import { evaluate } from "../equity/evaluator";
import { COMBOS, N } from "./board";

type Node =
    | { kind: "act", player: 0 | 1, actions: string[], children: Node[], id: number,
        regret: Float64Array[], avg: Float64Array[] }
    | { kind: "fold", folder: 0 | 1, bets: [number, number] }
    | { kind: "showdown", bets: [number, number] };

export type RiverSpot = {
    board: number[],
    pot: number,                    // in the middle before this river's betting
    ranges: [number[], number[]],   // player 0 = first to act on the river (out of position)
    // The betting right now (exact amounts, so odd bet sizes are handled exactly):
    bets: [number, number],         // chips each put in on the river so far
    stacks: [number, number],       // chips each has behind right now
    toAct: 0 | 1,
    checked: boolean,               // player 0 checked and nobody has bet yet
    raisesLeft?: number,            // re-raises still allowed (default: 1 if nobody bet, else 1 - raises so far)
    sizes?: number[],               // bet sizes as pot fractions (default 0.5, 1)
};

export type RiverSolution = {
    root: Node & { kind: "act" },
    exploitability: number,         // as a share of the pot: 0 = perfect
    iterations: number,
    strategyFor(combo: number): { action: string, prob: number }[],
};

let nextId = 0;

function buildTree(pot: number, stacks: [number, number], toAct: 0 | 1, bets: [number, number],
    raisesLeft: number, sizes: number[], checked: boolean): Node {
    const other = (1 - toAct) as 0 | 1;
    const facing = bets[other] - bets[toAct];
    const actions: string[] = [];
    const children: Node[] = [];
    const add = (name: string, child: Node) => { actions.push(name); children.push(child); };

    if (facing > 0) {
        add("fold", { kind: "fold", folder: toAct, bets: [...bets] as [number, number] });
        const called: [number, number] = [...bets] as [number, number];
        called[toAct] = Math.min(bets[other], bets[toAct] + stacks[toAct]);
        add("call", { kind: "showdown", bets: called });
        if (raisesLeft > 0 && stacks[toAct] > facing && stacks[other] > 0) {
            const allIn: [number, number] = [...bets] as [number, number];
            allIn[toAct] = bets[toAct] + stacks[toAct];
            add("raise all-in", buildTree(pot, [stacks[0] - (allIn[0] - bets[0]), stacks[1] - (allIn[1] - bets[1])] as [number, number],
                other, allIn, raisesLeft - 1, sizes, false));
        }
    }
    else {
        add("check", checked
            ? { kind: "showdown", bets: [...bets] as [number, number] }
            : buildTree(pot, stacks, other, bets, raisesLeft, sizes, true));
        const options = new Set<number>();
        for (const f of sizes) options.add(Math.min(stacks[toAct], Math.round(f * pot)));
        options.add(stacks[toAct]);
        for (const amount of [...options].sort((a, b) => a - b)) {
            if (amount <= 0) continue;
            const nb: [number, number] = [...bets] as [number, number];
            nb[toAct] += amount;
            const ns: [number, number] = [...stacks] as [number, number];
            ns[toAct] -= amount;
            const label = amount >= stacks[toAct] ? "all-in" : `bet ${Math.round(amount / pot * 100) / 100}`;
            add(label, buildTree(pot, ns, other, nb, raisesLeft, sizes, false));
        }
    }
    const regret = actions.map(() => new Float64Array(N));
    const avg = actions.map(() => new Float64Array(N));
    return { kind: "act", player: toAct, actions, children, id: nextId++, regret, avg };
}

/**
 * `target`: stop early once the solution is within this share of the pot from
 * perfect (checked every 25 iterations). 0 = always run all iterations.
 */
export function solveRiver(spot: RiverSpot, iterations = 400, target = 0.005): RiverSolution {
    const { board, pot, stacks } = spot;
    const sizes = spot.sizes ?? [0.5, 1];
    const dead = new Set(board);
    const live = COMBOS.map(([a, b]) => !dead.has(a) && !dead.has(b));
    const ranges = spot.ranges.map(r => Float64Array.from(r, (w, i) => live[i] ? w : 0)) as [Float64Array, Float64Array];
    // Loops only visit hands that are possible on this board; others stay 0.
    const L = Int32Array.from(COMBOS.map((_, i) => i).filter(i => live[i]));
    const c0 = Int32Array.from(COMBOS.map(c => c[0])), c1 = Int32Array.from(COMBOS.map(c => c[1]));

    // Hand strengths on this board, sorted once (with tie groups) for the showdown sweeps.
    const score = new Float64Array(N);
    COMBOS.forEach(([a, b], i) => { score[i] = live[i] ? evaluate([a, b, ...board]) : -1; });
    const order = Int32Array.from(Array.from(L).sort((x, y) => score[x] - score[y]));
    const groupEnd = new Int32Array(order.length);          // first index after this hand's tie group
    for (let j = order.length - 1; j >= 0; j--)
        groupEnd[j] = j + 1 < order.length && score[order[j + 1]] === score[order[j]] ? groupEnd[j + 1] : j + 1;
    const groupStart = new Int32Array(order.length);        // first index of this hand's tie group
    for (let j = 0; j < order.length; j++)
        groupStart[j] = j > 0 && score[order[j - 1]] === score[order[j]] ? groupStart[j - 1] : j;

    nextId = 0;
    const root = buildTree(pot, stacks, spot.toAct, [...spot.bets] as [number, number],
        spot.raisesLeft ?? 1, sizes, spot.checked);
    if (root.kind !== "act") throw new Error("river betting is already over");

    /** Opponent reach that doesn't share a card with each of our hands. */
    function blockedMass(opp: Float64Array): Float64Array {
        const card = new Float64Array(52);
        let total = 0;
        for (let k = 0; k < L.length; k++) {
            const i = L[k], r = opp[i];
            if (!r) continue;
            total += r; card[c0[i]] += r; card[c1[i]] += r;
        }
        const out = new Float64Array(N);
        for (let k = 0; k < L.length; k++) { const i = L[k]; out[i] = total - card[c0[i]] - card[c1[i]] + opp[i]; }
        return out;
    }

    /** For each of our hands: opponent reach we beat, and reach that beats us. */
    function winLose(opp: Float64Array): [Float64Array, Float64Array] {
        const win = new Float64Array(N), lose = new Float64Array(N);
        let below = 0;
        const cardBelow = new Float64Array(52);
        for (let j = 0; j < order.length;) {                     // ascending strength
            const k = groupEnd[j];
            for (let t = j; t < k; t++) { const i = order[t]; win[i] = below - cardBelow[c0[i]] - cardBelow[c1[i]]; }
            for (let t = j; t < k; t++) { const i = order[t], r = opp[i]; below += r; cardBelow[c0[i]] += r; cardBelow[c1[i]] += r; }
            j = k;
        }
        let above = 0;
        const cardAbove = new Float64Array(52);
        for (let j = order.length - 1; j >= 0;) {               // descending strength
            const k = groupStart[j] - 1;
            for (let t = j; t > k; t--) { const i = order[t]; lose[i] = above - cardAbove[c0[i]] - cardAbove[c1[i]]; }
            for (let t = j; t > k; t--) { const i = order[t], r = opp[i]; above += r; cardAbove[c0[i]] += r; cardAbove[c1[i]] += r; }
            j = k;
        }
        return [win, lose];
    }

    /** Value of each of `me`'s hands at a terminal, given opponent reach. */
    function terminal(node: Node, me: 0 | 1, opp: Float64Array): Float64Array {
        const out = new Float64Array(N);
        if (node.kind === "fold") {
            const mass = blockedMass(opp);
            const u = node.folder === me ? -node.bets[me] : pot + node.bets[1 - me];
            for (let k = 0; k < L.length; k++) { const i = L[k]; out[i] = u * mass[i]; }
        }
        else if (node.kind === "showdown") {
            const mass = blockedMass(opp);
            const [win, lose] = winLose(opp);
            const mine = node.bets[me], theirs = node.bets[1 - me];
            const wv = pot + theirs, tv = (pot + theirs - mine) / 2;
            for (let k = 0; k < L.length; k++) {
                const i = L[k];
                out[i] = win[i] * wv - lose[i] * mine + (mass[i] - win[i] - lose[i]) * tv;
            }
        }
        return out;
    }

    function currentStrategy(node: Node & { kind: "act" }): Float64Array[] {
        const n = node.actions.length;
        const strat = node.actions.map(() => new Float64Array(N));
        for (let k = 0; k < L.length; k++) {
            const i = L[k];
            let sum = 0;
            for (let a = 0; a < n; a++) sum += node.regret[a][i];
            for (let a = 0; a < n; a++) strat[a][i] = sum > 0 ? node.regret[a][i] / sum : 1 / n;
        }
        return strat;
    }

    const scaled = (reach: Float64Array, s: Float64Array) => {
        const out = new Float64Array(N);
        for (let k = 0; k < L.length; k++) { const i = L[k]; out[i] = reach[i] * s[i]; }
        return out;
    };

    function cfr(node: Node, me: 0 | 1, reach: [Float64Array, Float64Array], t: number): Float64Array {
        if (node.kind !== "act") return terminal(node, me, reach[1 - me]);
        const strat = currentStrategy(node);
        const value = new Float64Array(N);
        const n = node.actions.length;
        if (node.player === me) {
            const childValues = node.children.map((c, a) => {
                const r: [Float64Array, Float64Array] = [reach[0], reach[1]];
                r[me] = scaled(reach[me], strat[a]);
                return cfr(c, me, r, t);
            });
            const myReach = reach[me];
            for (let k = 0; k < L.length; k++) {
                const i = L[k];
                let v = 0;
                for (let a = 0; a < n; a++) v += strat[a][i] * childValues[a][i];
                value[i] = v;
                for (let a = 0; a < n; a++) {
                    node.regret[a][i] = Math.max(0, node.regret[a][i] + childValues[a][i] - v);   // CFR+
                    node.avg[a][i] += t * myReach[i] * strat[a][i];                               // linear averaging
                }
            }
        }
        else {
            for (let a = 0; a < n; a++) {
                const r: [Float64Array, Float64Array] = [reach[0], reach[1]];
                r[node.player] = scaled(reach[node.player], strat[a]);
                const v = cfr(node.children[a], me, r, t);
                for (let k = 0; k < L.length; k++) { const i = L[k]; value[i] += v[i]; }
            }
        }
        return value;
    }

    function averageStrategy(node: Node & { kind: "act" }, i: number): number[] {
        const sums = node.avg.map(a => a[i]);
        const total = sums.reduce((x, y) => x + y, 0);
        if (total > 0) return sums.map(s => s / total);
        // A hand we never "hold" in our modelled range (weight 0, e.g. 98o after a button raise) has no
        // average strategy: the old 1/n default made the nut straight fold 50% to an all-in (v1.12.2 fix).
        // Its regrets are still learned against the opponent's range: play by those instead.
        const regrets = node.regret.map(a => Math.max(0, a[i]));
        const rTotal = regrets.reduce((x, y) => x + y, 0);
        return rTotal > 0 ? regrets.map(r => r / rTotal) : sums.map(() => 1 / sums.length);
    }

    /** Average strategy of a node for every hand at once. */
    function averageStrategies(node: Node & { kind: "act" }): Float64Array[] {
        const n = node.actions.length;
        const out = node.actions.map(() => new Float64Array(N));
        for (let k = 0; k < L.length; k++) {
            const i = L[k];
            let total = 0;
            for (let a = 0; a < n; a++) total += node.avg[a][i];
            for (let a = 0; a < n; a++) out[a][i] = total > 0 ? node.avg[a][i] / total : 1 / n;
        }
        return out;
    }

    /** Best-response value: `me` plays perfectly against the other's average strategy. */
    function bestResponse(node: Node, me: 0 | 1, opp: Float64Array): Float64Array {
        if (node.kind !== "act") return terminal(node, me, opp);
        if (node.player === me) {
            const vals = node.children.map(c => bestResponse(c, me, opp));
            const out = new Float64Array(N);
            for (let k = 0; k < L.length; k++) {
                const i = L[k];
                let best = -Infinity;
                for (const v of vals) if (v[i] > best) best = v[i];
                out[i] = best;
            }
            return out;
        }
        const out = new Float64Array(N);
        const avg = averageStrategies(node);
        node.children.forEach((c, a) => {
            const v = bestResponse(c, me, scaled(opp, avg[a]));
            for (let k = 0; k < L.length; k++) { const i = L[k]; out[i] += v[i]; }
        });
        return out;
    }

    // Exploitability: how much both players could gain by best-responding, per unit of
    // range mass, as a share of the pot. Values are constant-sum (total = pot).
    const norm = (me: 0 | 1) => {
        const br = bestResponse(root, me, ranges[1 - me]);
        let v = 0, mass = 0;
        const m = blockedMass(ranges[1 - me]);
        for (let i = 0; i < N; i++) { v += ranges[me][i] * br[i]; mass += ranges[me][i] * m[i]; }
        return mass > 0 ? v / mass : 0;
    };
    const measure = () => (norm(0) + norm(1) - pot) / 2 / pot;

    const start: [Float64Array, Float64Array] = [ranges[0], ranges[1]];
    let t = 1, exploitability = Infinity;
    for (; t <= iterations; t++) {
        cfr(root, 0, start, t);
        cfr(root, 1, start, t);
        if (target > 0 && t >= 50 && t % 25 === 0 && t < iterations) {
            exploitability = measure();
            if (exploitability <= target) { t++; break; }
        }
    }
    if (!(exploitability <= target)) exploitability = measure();

    return {
        root, exploitability, iterations: t - 1,
        strategyFor(combo: number) {
            return root.actions.map((action, a) => ({ action, prob: averageStrategy(root, combo)[a] }));
        },
    };
}
