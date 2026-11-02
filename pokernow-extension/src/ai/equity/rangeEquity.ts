/**
 * Equity against opponents' estimated ranges (instead of random hands):
 * each simulation deals every opponent a hand drawn from their range.
 */
import { CLASS_CARDS, COMBOS, Range } from "../preflop/hands";
import { evaluate } from "./evaluator";

function sampler(range: Range) {
    const cumulative: number[] = [];
    let total = 0;
    for (let i = 0; i < 169; i++) {
        total += range[i] * COMBOS[i];
        cumulative.push(total);
    }
    return () => {
        const x = Math.random() * total;
        let lo = 0, hi = 168;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cumulative[mid] < x) lo = mid + 1; else hi = mid;
        }
        return lo;
    };
}

export function equityVsRanges(hole: number[], board: number[], ranges: Range[], sims = 1500): number {
    const pickers = ranges.map(sampler);
    let total = 0, done = 0;
    for (let s = 0; s < sims * 3 && done < sims; s++) {
        const used = new Set([...hole, ...board]);
        const oppHands: number[][] = [];
        let ok = true;
        for (const pick of pickers) {
            let hand: number[] | undefined;
            for (let tries = 0; tries < 10 && !hand; tries++) {
                const combos = CLASS_CARDS[pick()];
                const c = combos[Math.floor(Math.random() * combos.length)];
                if (!used.has(c[0]) && !used.has(c[1])) hand = c;
            }
            if (!hand) { ok = false; break; }
            used.add(hand[0]); used.add(hand[1]);
            oppHands.push(hand);
        }
        if (!ok) continue;
        const deck: number[] = [];
        for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
        const full = board.slice();
        while (full.length < 5) {
            const k = Math.floor(Math.random() * deck.length);
            full.push(deck[k]);
            deck[k] = deck[deck.length - 1];
            deck.pop();
        }
        const mine = evaluate(hole.concat(full));
        let best = -1;
        for (const h of oppHands) best = Math.max(best, evaluate(h.concat(full)));
        total += mine > best ? 1 : mine === best ? 0.5 : 0;
        done++;
    }
    return done ? total / done : 0.5;
}
