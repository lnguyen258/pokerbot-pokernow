/**
 * The 169 starting-hand types (AA, AKs, AKo, ...) and ranges over them.
 *
 * A Range is one weight (0..1) per hand type: 1 = always in the range,
 * 0 = never. Equities come from the precomputed 169 x 169 table
 * (tools/buildEquityTable.js).
 */
import table from "../data/equity169.json";

const RANKS = "23456789TJQKA";
export const CLASSES: string[] = table.classes;
export const COMBOS: number[] = table.combos;            // 6 for pairs, 4 suited, 12 offsuit
const EQ: number[][] = table.equity;
const INDEX = new Map(CLASSES.map((c, i) => [c, i]));

export type Range = number[];

export function classOf(a: number, b: number): number {
    const ra = a >> 2, rb = b >> 2;
    const hi = Math.max(ra, rb), lo = Math.min(ra, rb);
    let name = RANKS[hi] + RANKS[lo];
    if (hi !== lo) name += (a & 3) === (b & 3) ? "s" : "o";
    return INDEX.get(name)!;
}

/** Every concrete two-card combo for each hand type (cards as 0..51 ints). */
export const CLASS_CARDS: number[][][] = CLASSES.map(cls => {
    const hi = RANKS.indexOf(cls[0]), lo = RANKS.indexOf(cls[1]);
    const out: number[][] = [];
    for (let s1 = 0; s1 < 4; s1++)
        for (let s2 = 0; s2 < 4; s2++) {
            if (cls.length === 2 ? s2 <= s1 : cls[2] === "s" ? s1 !== s2 : s1 === s2) continue;
            out.push([hi * 4 + s1, lo * 4 + s2]);
        }
    return out;
});

/** Strength order used to build "top X%" ranges: equity against a random hand. */
const VS_RANDOM = CLASSES.map((_, i) => EQ[i].reduce((s, e, j) => s + e * COMBOS[j], 0) / 1326);
const ORDER = CLASSES.map((_, i) => i).sort((a, b) => VS_RANDOM[b] - VS_RANDOM[a]);
const START = new Array(169).fill(0);     // share of all hands stronger than this type
{
    let acc = 0;
    for (const i of ORDER) {
        START[i] = acc;
        acc += COMBOS[i] / 1326;
    }
}

/** Where a hand type ranks: 0 = best (AA), 1 = worst. */
export function percentile(i: number): number {
    return START[i] + COMBOS[i] / 1326 / 2;
}

export function fullRange(): Range {
    return new Array(169).fill(1);
}

/** The strongest `frac` of all hands (0.2 = top 20%). */
export function topRange(frac: number): Range {
    const f = Math.max(0, Math.min(1, frac));
    return CLASSES.map((_, i) => Math.max(0, Math.min(1, (f - START[i]) / (COMBOS[i] / 1326))));
}

/** Share of all 1,326 combos the range contains. */
export function rangeSize(r: Range): number {
    let s = 0;
    for (let i = 0; i < 169; i++) s += r[i] * COMBOS[i];
    return s / 1326;
}

export function equityVsRange(i: number, r: Range): number {
    let num = 0, den = 0;
    for (let j = 0; j < 169; j++) {
        const w = r[j] * COMBOS[j];
        num += w * EQ[i][j];
        den += w;
    }
    return den > 0 ? num / den : 0.5;
}

export function intersect(a: Range, b: Range): Range {
    return a.map((x, i) => x * b[i]);
}

/** Removes (part of) `s` from `r`: r * (1 - k * s). */
export function minus(r: Range, s: Range, k = 1): Range {
    return r.map((x, i) => x * (1 - k * s[i]));
}

/** The part of `base` whose equity vs `vs` is at least `required` (soft edge). */
export function continuingRange(base: Range, vs: Range, required: number): Range {
    return base.map((w, i) => {
        if (w === 0) return 0;
        const margin = equityVsRange(i, vs) - required;
        return w * Math.max(0, Math.min(1, 0.5 + margin / 0.04));
    });
}

/** Scales a range's width by `factor` (>1 looser, <1 tighter), keeping its shape. */
export function widen(r: Range, factor: number): Range {
    const size = rangeSize(r);
    if (size <= 0) return r;
    return intersect(topRange(Math.min(1, size * factor)), factor >= 1 ? fullRange() : r)
        .map((x, i) => factor >= 1 ? Math.max(x, r[i]) : x);
}
