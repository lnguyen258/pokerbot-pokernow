import { CONFIG } from "../config";

/**
 * ICM (Independent Chip Model): converts chip stacks into expected tournament
 * points. Chips aren't worth the same to everyone: doubling up adds less than
 * busting costs, especially near the paid places. That's why short and medium
 * stacks must fold more, and why big stacks can attack them.
 *
 * Malmuth-Harville model: chance to finish 1st = your share of the chips; then
 * the same for 2nd among the remaining players, and so on.
 */
export function icm(stacks: number[], payouts: number[]): number[] {
    // Cash game: chips ARE the money, so a stack is worth exactly its chips (chip EV).
    if (CONFIG.gameType === "cash") return stacks.map(s => Math.max(s, 0));
    const n = stacks.length;
    const pay = payouts.slice(0, n);
    while (pay.length < n)
        pay.push(pay.length ? pay[pay.length - 1] : 0);

    const memo = new Map<number, number[]>();

    function solve(mask: number): number[] {
        const cached = memo.get(mask);
        if (cached) return cached;
        const res = new Array(n).fill(0);
        const members: number[] = [];
        for (let i = 0; i < n; i++)
            if (mask & (1 << i)) members.push(i);
        const place = n - members.length;
        const total = members.reduce((s, i) => s + Math.max(stacks[i], 0), 0);

        if (total <= 0) {
            // Everyone left has no chips: share the remaining places evenly.
            const avg = pay.slice(place, place + members.length).reduce((a, b) => a + b, 0) / members.length;
            for (const i of members) res[i] = avg;
        }
        else {
            for (const i of members) {
                const p = Math.max(stacks[i], 0) / total;
                if (p === 0) continue;
                res[i] += p * pay[place];
                if (members.length > 1) {
                    const sub = solve(mask & ~(1 << i));
                    for (let k = 0; k < n; k++) res[k] += p * sub[k];
                }
            }
        }
        memo.set(mask, res);
        return res;
    }

    return solve((1 << n) - 1);
}

/**
 * Equity player `a` needs to call an all-in from player `b` (no other money in
 * the pot). In a cash game this is 50%; the excess above 50% is the "risk premium".
 */
export function requiredEquityAllIn(stacks: number[], a: number, b: number, payouts: number[]): number {
    const eff = Math.min(stacks[a], stacks[b]);
    const fold = icm(stacks, payouts)[a];
    const win = stacks.slice(); win[a] += eff; win[b] -= eff;
    const lose = stacks.slice(); lose[a] -= eff; lose[b] += eff;
    const vWin = icm(win, payouts)[a], vLose = icm(lose, payouts)[a];
    if (vWin - vLose <= 1e-9) return 0.5;
    return (fold - vLose) / (vWin - vLose);
}
