/**
 * TypeScript port of holdem/cards.py (our step 3 Python bot).
 *
 * A card is an int 0..51: rank = card >> 2 (0 = deuce ... 12 = ace), suit = card & 3.
 */

const SUITS: Record<string, number> = {
    c: 0, d: 1, h: 2, s: 3,
    "♣": 0, "♦": 1, "♥": 2, "♠": 3,     // in case PokerNow shows symbols
};

export function cardToInt(card: Card): number {
    const suit = SUITS[String(card.suit).trim().toLowerCase()];
    if (suit === undefined)
        throw new Error("unknown suit: " + card.suit);
    return (card.value.code - 2) * 4 + suit;
}

const WHEEL = (1 << 12) | 0b1111;      // A-2-3-4-5

function straightHigh(mask: number): number {
    for (let high = 12; high >= 4; high--) {
        const need = 0b11111 << (high - 4);
        if ((mask & need) === need)
            return high;
    }
    return (mask & WHEEL) === WHEEL ? 3 : -1;
}

function topRanks(mask: number, n: number, exclude: number[] = []): number[] {
    const out: number[] = [];
    for (let r = 12; r >= 0 && out.length < n; r--)
        if ((mask & (1 << r)) && !exclude.includes(r))
            out.push(r);
    return out;
}

/** Packs category + up to 5 kickers into one comparable number. */
function score(category: number, kickers: number[]): number {
    let v = category;
    for (let i = 0; i < 5; i++)
        v = v * 16 + (kickers[i] ?? 0);
    return v;
}

/**
 * Score 5 to 7 cards; higher is better. Categories: 8 straight flush,
 * 7 quads, 6 full house, 5 flush, 4 straight, 3 trips, 2 two pair, 1 pair, 0 high.
 */
export function evaluate(cards: number[]): number {
    const counts = new Array(13).fill(0);
    const suitMask = [0, 0, 0, 0];
    const suitCount = [0, 0, 0, 0];
    let rankMask = 0;
    for (const c of cards) {
        const r = c >> 2, s = c & 3;
        counts[r]++;
        suitMask[s] |= 1 << r;
        suitCount[s]++;
        rankMask |= 1 << r;
    }

    let flush: number[] | null = null;
    for (let s = 0; s < 4; s++) {
        if (suitCount[s] >= 5) {
            const sf = straightHigh(suitMask[s]);
            if (sf >= 0)
                return score(8, [sf]);
            flush = topRanks(suitMask[s], 5);
        }
    }

    const quads: number[] = [], trips: number[] = [], pairs: number[] = [];
    for (let r = 12; r >= 0; r--) {
        if (counts[r] === 4) quads.push(r);
        else if (counts[r] === 3) trips.push(r);
        else if (counts[r] === 2) pairs.push(r);
    }

    if (quads.length)
        return score(7, [quads[0], topRanks(rankMask, 1, [quads[0]])[0]]);
    if (trips.length && (trips.length > 1 || pairs.length))
        return score(6, [trips[0], trips.length > 1 ? Math.max(trips[1], pairs[0] ?? -1) : pairs[0]]);
    if (flush)
        return score(5, flush);
    const st = straightHigh(rankMask);
    if (st >= 0)
        return score(4, [st]);
    if (trips.length)
        return score(3, [trips[0], ...topRanks(rankMask, 2, [trips[0]])]);
    if (pairs.length >= 2)
        return score(2, [pairs[0], pairs[1], topRanks(rankMask, 1, [pairs[0], pairs[1]])[0]]);
    if (pairs.length)
        return score(1, [pairs[0], ...topRanks(rankMask, 3, [pairs[0]])]);
    return score(0, topRanks(rankMask, 5));
}

/**
 * Chance to win (ties count half) against `opponents` random hands,
 * estimated by dealing out the rest of the board `sims` times.
 */
export function equity(hole: number[], board: number[], opponents: number, sims = 1500): number {
    const dead = new Set([...hole, ...board]);
    const deck: number[] = [];
    for (let c = 0; c < 52; c++)
        if (!dead.has(c)) deck.push(c);

    const boardNeed = 5 - board.length;
    const need = boardNeed + 2 * opponents;
    let total = 0;

    for (let i = 0; i < sims; i++) {
        // Partial shuffle: move `need` random cards to the front of the deck.
        for (let j = 0; j < need; j++) {
            const k = j + Math.floor(Math.random() * (deck.length - j));
            const tmp = deck[j]; deck[j] = deck[k]; deck[k] = tmp;
        }
        const fullBoard = board.concat(deck.slice(0, boardNeed));
        const mine = evaluate(hole.concat(fullBoard));
        let best = -1;
        for (let o = 0; o < opponents; o++) {
            const start = boardNeed + 2 * o;
            best = Math.max(best, evaluate([deck[start], deck[start + 1], ...fullBoard]));
        }
        total += mine > best ? 1 : mine === best ? 0.5 : 0;
    }
    return total / sims;
}
