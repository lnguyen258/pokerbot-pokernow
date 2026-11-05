/**
 * Board analysis: for every possible opponent hand (all 1,326 two-card combos),
 * how strong it is right now and what it's drawing to.
 *
 *   made     = percentile of the made hand on this board (1 = the best possible)
 *   flushDraw / straightOuts = draws that use at least one hole card
 *   outs     = cards that complete a flush or straight
 *   hitNext  = chance the next card completes the draw
 *   hitByRiver = chance it completes by the river (flop only, else = hitNext)
 */
import { evaluate } from "../equity/evaluator";
import { classOf } from "../preflop/hands";

export const COMBOS: [number, number][] = [];
for (let a = 0; a < 52; a++)
    for (let b = a + 1; b < 52; b++) COMBOS.push([a, b]);
export const N = COMBOS.length;
export const COMBO_CLASS = COMBOS.map(([a, b]) => classOf(a, b));

/** Position of a two-card hand in COMBOS. */
export function comboIndex(x: number, y: number): number {
    const a = Math.min(x, y), b = Math.max(x, y);
    return a * 51 - (a * (a - 1)) / 2 + (b - a - 1);
}

export type BoardInfo = {
    live: boolean[],
    made: number[],
    flushDraw: boolean[],
    straightOuts: number[],
    outs: number[],
    hitNext: number[],
    hitByRiver: number[],
    twoPairPlus: boolean[],    // two pair or better using a hole card (a board pair alone doesn't count)
};

const WHEEL = (1 << 12) | 0b1111;

function isStraight(mask: number): boolean {
    for (let high = 12; high >= 4; high--) {
        const need = 0b11111 << (high - 4);
        if ((mask & need) === need) return true;
    }
    return (mask & WHEEL) === WHEEL;
}

/** Ranks that would complete a straight that isn't already there. */
function straightOutRanks(mask: number): number {
    if (isStraight(mask)) return 0;
    let outs = 0;
    for (let r = 0; r < 13; r++)
        if (!(mask & (1 << r)) && isStraight(mask | (1 << r))) outs |= 1 << r;
    return outs;
}

const bits = (x: number) => { let n = 0; while (x) { n += x & 1; x >>= 1; } return n; };

const cache = new Map<string, BoardInfo>();

export function analyzeBoard(board: number[]): BoardInfo {
    const key = [...board].sort((a, b) => a - b).join(",");
    const hit = cache.get(key);
    if (hit) return hit;

    const dead = new Set(board);
    const unseen = 52 - 2 - board.length;
    const cardsToCome = 5 - board.length;
    let boardMask = 0;
    const boardSuits = [0, 0, 0, 0];
    for (const c of board) { boardMask |= 1 << (c >> 2); boardSuits[c & 3]++; }
    const boardOuts = straightOutRanks(boardMask);

    const live = COMBOS.map(([a, b]) => !dead.has(a) && !dead.has(b));
    const scores = COMBOS.map(([a, b], i) => live[i] ? evaluate([a, b, ...board]) : -1);

    // Percentile of each made hand among all live combos (ties share a value).
    const order = COMBOS.map((_, i) => i).filter(i => live[i]).sort((x, y) => scores[x] - scores[y]);
    const made = new Array(N).fill(0);
    for (let j = 0; j < order.length;) {
        let k = j;
        while (k < order.length && scores[order[k]] === scores[order[j]]) k++;
        const p = (j + k) / 2 / order.length;
        for (let t = j; t < k; t++) made[order[t]] = p;
        j = k;
    }

    const flushDraw = new Array(N).fill(false);
    const straightOuts = new Array(N).fill(0);
    const outs = new Array(N).fill(0);
    const hitNext = new Array(N).fill(0);
    const hitByRiver = new Array(N).fill(0);

    if (cardsToCome > 0) {
        COMBOS.forEach(([a, b], i) => {
            if (!live[i]) return;
            const category = Math.floor(scores[i] / 16 ** 5);
            if (category >= 4) return;                   // already a straight or better
            for (let s = 0; s < 4; s++) {
                const n = boardSuits[s] + ((a & 3) === s ? 1 : 0) + ((b & 3) === s ? 1 : 0);
                if (n === 4 && ((a & 3) === s || (b & 3) === s)) flushDraw[i] = true;
            }
            const mask = boardMask | (1 << (a >> 2)) | (1 << (b >> 2));
            const fromHole = straightOutRanks(mask) & ~boardOuts;
            straightOuts[i] = bits(fromHole) * 4;
            let o = (flushDraw[i] ? 9 : 0) + straightOuts[i];
            if (flushDraw[i] && straightOuts[i]) o -= 2;    // the straight-flush cards are counted twice
            outs[i] = o;
            hitNext[i] = o / unseen;
            hitByRiver[i] = cardsToCome === 2 ? 1 - (1 - o / unseen) * (1 - o / (unseen - 1)) : hitNext[i];
        });
    }

    const boardCategory = Math.floor(evaluate(board) / 16 ** 5);
    const twoPairPlus = scores.map(sc => {
        const c = Math.floor(sc / 16 ** 5);
        return c >= 3 || (c === 2 && boardCategory === 0);
    });
    const info = { live, made, flushDraw, straightOuts, outs, hitNext, hitByRiver, twoPairPlus };
    if (cache.size > 64) cache.clear();
    cache.set(key, info);
    return info;
}

function sigmoid(x: number) {
    return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
}

/** Membership (0..1) of each combo in the strongest fraction q of a weighted range. */
export function softTop(weights: number[], strength: number[], q: number, width = 0.04): number[] {
    if (q >= 0.999) return new Array(N).fill(1);
    const liveIdx = weights.map((w, i) => w > 0 ? i : -1).filter(i => i >= 0);
    if (!liveIdx.length || q <= 0.001) return new Array(N).fill(0);
    liveIdx.sort((x, y) => strength[y] - strength[x]);
    const total = liveIdx.reduce((s, i) => s + weights[i], 0);
    let acc = 0, cut = strength[liveIdx[liveIdx.length - 1]];
    for (const i of liveIdx) {
        acc += weights[i];
        if (acc >= q * total) { cut = strength[i]; break; }
    }
    return strength.map(s => sigmoid((s - cut) / width));
}

export { sigmoid };
