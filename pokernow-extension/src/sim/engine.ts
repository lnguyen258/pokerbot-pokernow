/**
 * An 8-player no-limit hold'em Sit & Go dealer for self-play.
 *
 * It writes the hand history in PokerNow's own log format ("raises to 60",
 * "calls 20 and go all in", "Flop:  [..]" ...), so bots read the table with
 * the same parser they use live. Handles blinds going up, side pots,
 * uncalled bets, busting and finishing places.
 */
import { evaluate } from "../ai/equity/evaluator";

export type DecisionContext = {
    log: string[],            // this hand so far, oldest first (public information only)
    hole: number[],           // our two cards, 0..51
    board: number[],
    street: "preflop" | "flop" | "turn" | "river",
    name: string,
    stack: number,            // chips behind
    toCall: number,
    pot: number,              // everything in the middle, including this street's bets
    bigBlind: number,
};

export type SimBot = { label: string, decide(ctx: DecisionContext): Action };

const RANKS = "23456789TJQKA";
const SUIT_SYMBOLS = "♣♦♥♠";
export const cardText = (c: number) => (RANKS[c >> 2] === "T" ? "10" : RANKS[c >> 2]) + SUIT_SYMBOLS[c & 3];
export const toCard = (c: number): Card => {
    const r = RANKS[c >> 2];
    return { value: { name: (r === "T" ? "10" : r) as CardValueName, code: ((c >> 2) + 2) as CardValueCode }, suit: "cdhs"[c & 3] as CardSuit };
};

export type Seat = { seat: number, name: string, id: string, bot: SimBot, stack: number, place?: number };

type InHand = {
    p: Seat, hole: number[], folded: boolean, allIn: boolean,
    streetBet: number, total: number, needsToAct: boolean,
};

export type TournamentOptions = {
    startStack: number,
    blinds: [number, number][],   // levels: [small, big]
    handsPerLevel: number,
};

export const DEFAULT_OPTIONS: TournamentOptions = {
    startStack: 1000,
    blinds: [[10, 20], [15, 30], [20, 40], [30, 60], [40, 80], [50, 100], [75, 150], [100, 200],
        [150, 300], [200, 400], [300, 600], [400, 800], [600, 1200], [800, 1600], [1000, 2000]],
    handsPerLevel: 10,
};

export type TournamentResult = { places: Map<string, number>, hands: number };

/** One hand's result: how many players were dealt in, the big blind, and each player's chip change. */
export type HandResult = { players: number, bb: number, deltas: { label: string, chips: number }[] };

export function playTournament(bots: SimBot[], opts: TournamentOptions = DEFAULT_OPTIONS,
    onHand?: (log: string[]) => void, onResult?: (r: HandResult) => void): TournamentResult {
    const seats: Seat[] = bots.map((bot, i) => ({
        seat: i + 1, name: bot.label, id: `id-${bot.label}`, bot, stack: opts.startStack,
    }));
    let button = Math.floor(Math.random() * seats.length);
    let handNumber = 0;

    while (seats.filter(s => s.stack > 0).length > 1) {
        handNumber++;
        const level = opts.blinds[Math.min(opts.blinds.length - 1, Math.floor((handNumber - 1) / opts.handsPerLevel))];
        const alive = seats.filter(s => s.stack > 0);
        // Move the button to the next player who still has chips.
        do button = (button + 1) % seats.length; while (seats[button].stack <= 0);
        const log = playHand(seats, alive, seats[button], level, handNumber, ++globalHandId);
        onHand?.(log);
        onResult?.({
            players: alive.length, bb: level[1],
            deltas: alive.map(s => ({ label: s.name, chips: s.stack - (startStacks.get(s.id) ?? s.stack) })),
        });

        const busted = alive.filter(s => s.stack <= 0);
        if (busted.length) {
            // Several busting in one hand: the one who started the hand with fewer chips finishes lower.
            const remaining = seats.filter(s => s.stack > 0).length;
            busted.sort((a, b) => (startStacks.get(a.id) ?? 0) - (startStacks.get(b.id) ?? 0));
            busted.forEach((s, i) => { s.place = remaining + busted.length - i; });
        }
    }
    const winner = seats.find(s => s.stack > 0);
    if (winner) winner.place = 1;
    return { places: new Map(seats.map(s => [s.name, s.place ?? seats.length])), hands: handNumber };
}

const startStacks = new Map<string, number>();
let globalHandId = 0;          // unique across tournaments, like PokerNow's hand ids

/** Random numbers for dealing. Seed it to deal the same cards again (duplicate tests). */
let dealRandom: () => number = Math.random;
export function setDealRandom(r: () => number) { dealRandom = r; }

/**
 * Random numbers for each player's decisions, restarted every hand (duplicate tests).
 * With it, two runs only differ where a bot really decides differently, and only in
 * that hand. Null = plain Math.random.
 */
let decisionRandom: ((name: string, hand: number) => () => number) | null = null;
export function setDecisionRandom(f: ((name: string, hand: number) => () => number) | null) { decisionRandom = f; }

/**
 * All-in luck, for fairer scoring. When the money goes in before the river and nobody
 * can act any more, the cards still to come are pure luck. For each such hand this adds
 * (what the player was expected to win, averaged over possible runouts) minus (what they
 * actually won). Adding it to a player's result scores them by their decisions, not by
 * the runout. Play itself is unchanged. Cleared by the caller (takeLuck).
 */
const luck = new Map<string, number>();
export function takeLuck(): Map<string, number> {
    const copy = new Map(luck);
    luck.clear();
    return copy;
}

/** A number from a string (FNV-1a), to build seeds from names. */
export function hashSeed(...parts: (string | number)[]): number {
    let h = 2166136261;
    for (const ch of parts.join("|")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

/** A small fast seeded generator (mulberry32): same seed, same numbers. */
export function seededRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function playHand(seats: Seat[], alive: Seat[], buttonSeat: Seat, [sb, bb]: [number, number], n: number, uid: number): string[] {
    const log: string[] = [];
    const say = (p: Seat, what: string) => log.push(`"${p.name} @ ${p.id}" ${what}`);
    for (const s of alive) startStacks.set(s.id, s.stack);

    // Acting order starting left of the button.
    const bi = alive.indexOf(buttonSeat);
    const order = alive.slice(bi + 1).concat(alive.slice(0, bi + 1));     // ... ends with the button
    const deck = Array.from({ length: 52 }, (_, i) => i);
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(dealRandom() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const players: InHand[] = order.map(p => ({
        p, hole: [deck.pop()!, deck.pop()!], folded: false, allIn: false, streetBet: 0, total: 0, needsToAct: true,
    }));
    const board: number[] = [];
    let lastDecisionBoard = 0;                 // board size at the last decision anyone made
    const streams = new Map<string, () => number>();
    const randomFor = (name: string) => {
        if (!decisionRandom) return null;
        let r = streams.get(name);
        if (!r) { r = decisionRandom(name, n); streams.set(name, r); }
        return r;
    };

    log.push(`-- starting hand #${n} (id: sim${uid})  No Limit Texas Hold'em (dealer: "${buttonSeat.name} @ ${buttonSeat.id}") --`);
    log.push("Player stacks: " + [...alive].sort((a, b) => a.seat - b.seat)
        .map(p => `#${p.seat} "${p.name} @ ${p.id}" (${p.stack})`).join(" | "));

    const put = (h: InHand, amount: number) => {
        const a = Math.min(amount, h.p.stack);
        h.p.stack -= a; h.streetBet += a; h.total += a;
        if (h.p.stack === 0) h.allIn = true;
        return a;
    };
    const allInText = (h: InHand) => h.allIn ? " and go all in" : "";

    // Blinds. Heads-up the button posts the small blind.
    const sbPlayer = players.length === 2 ? players[1] : players[0];
    const bbPlayer = players.length === 2 ? players[0] : players[1];
    put(sbPlayer, sb); say(sbPlayer.p, `posts a small blind of ${sbPlayer.streetBet}${allInText(sbPlayer)}`);
    put(bbPlayer, bb); say(bbPlayer.p, `posts a big blind of ${bbPlayer.streetBet}${allInText(bbPlayer)}`);

    const live = () => players.filter(h => !h.folded);
    const canAct = () => players.filter(h => !h.folded && !h.allIn);

    const bettingRound = (street: DecisionContext["street"], first: number) => {
        let currentBet = Math.max(...players.map(h => h.streetBet));
        let lastRaise = bb;
        for (const h of players) h.needsToAct = !h.folded && !h.allIn;
        if (canAct().length <= 1 && players.every(h => h.folded || h.allIn || h.streetBet >= currentBet)) return;

        let i = first;
        let guard = 0;
        while (players.some(h => h.needsToAct) && live().length > 1 && guard++ < 1000) {
            const h = players[i % players.length];
            i++;
            if (!h.needsToAct) continue;
            h.needsToAct = false;
            const toCall = Math.max(0, currentBet - h.streetBet);
            const pot = players.reduce((s, x) => s + x.total, 0);
            const others = players.filter(x => x !== h && !x.folded && !x.allIn);
            let action: Action;
            lastDecisionBoard = board.length;
            const ownRandom = randomFor(h.p.name), savedRandom = Math.random;
            if (ownRandom) Math.random = ownRandom;
            try {
                action = h.p.bot.decide({
                    log: log.slice(), hole: h.hole, board: board.slice(), street, name: h.p.name,
                    stack: h.p.stack, toCall: Math.min(toCall, h.p.stack), pot, bigBlind: bb,
                });
            }
            catch (err) {
                action = { type: "check_or_fold" };
            }
            finally {
                Math.random = savedRandom;
            }

            let kind = action.type;
            if (kind === "raise" && (others.length === 0 || h.p.stack <= toCall)) kind = "call";
            if (kind === "check_or_fold") {
                if (toCall === 0) say(h.p, "checks");
                else { h.folded = true; say(h.p, "folds"); }
            }
            else if (kind === "call") {
                if (toCall === 0) say(h.p, "checks");
                else { put(h, toCall); say(h.p, `calls ${h.streetBet}${allInText(h)}`); }
            }
            else {
                const potAfterCall = pot + toCall;
                const minTarget = currentBet + Math.max(lastRaise, bb);
                const maxTarget = h.streetBet + h.p.stack;
                let target = action.raiseAmount === "all_in" ? maxTarget
                    : action.amount !== undefined ? Math.round(action.amount)       // exact "raise to"
                    : action.raiseAmount === "pot" ? currentBet + potAfterCall
                    : action.raiseAmount === "1/2_pot" ? currentBet + Math.round(potAfterCall / 2)
                    : minTarget;
                target = Math.min(Math.max(target, minTarget), maxTarget);
                if (target <= currentBet) {                                  // can't raise: just call
                    put(h, toCall); say(h.p, `calls ${h.streetBet}${allInText(h)}`);
                }
                else {
                    const verb = currentBet === 0 ? "bets" : "raises to";
                    put(h, target - h.streetBet);
                    say(h.p, `${verb} ${h.streetBet}${allInText(h)}`);
                    if (target - currentBet >= lastRaise) lastRaise = target - currentBet;
                    currentBet = target;
                    for (const x of players) if (x !== h && !x.folded && !x.allIn) x.needsToAct = true;
                }
            }
        }
    };

    // Preflop: first to act is after the big blind (heads-up: the button).
    bettingRound("preflop", players.length === 2 ? 1 : 2 % players.length);
    const streets: [DecisionContext["street"], number][] = [["flop", 3], ["turn", 1], ["river", 1]];
    for (const [street, cards] of streets) {
        if (live().length <= 1) break;
        for (const h of players) h.streetBet = 0;
        const before = board.map(cardText);
        for (let k = 0; k < cards; k++) board.push(deck.pop()!);
        const shown = board.map(cardText);
        log.push(street === "flop" ? `Flop:  [${shown.join(", ")}]`
            : `${street === "turn" ? "Turn" : "River"}: ${before.join(", ")} [${shown[shown.length - 1]}]`);
        // After the flop the first player left of the button acts first (heads-up: the big blind).
        bettingRound(street, 0);
    }

    // Uncalled bet: the biggest contributor gets back what nobody matched.
    const byTotal = [...players].sort((a, b) => b.total - a.total);
    const excess = byTotal[0].total - (byTotal[1]?.total ?? 0);
    if (excess > 0) {
        byTotal[0].total -= excess; byTotal[0].p.stack += excess;
        log.push(`Uncalled bet of ${excess} returned to "${byTotal[0].p.name} @ ${byTotal[0].p.id}"`);
    }

    const contenders = live();
    if (contenders.length === 1) {
        const pot = players.reduce((s, h) => s + h.total, 0);
        contenders[0].p.stack += pot;
        say(contenders[0].p, `collected ${pot} from pot`);
    }
    else {
        // Side pots, from the smallest all-in level up. Returns what each player wins.
        const levels = [...new Set(players.map(h => h.total).filter(t => t > 0))].sort((a, b) => a - b);
        const payout = (fullBoard: number[]) => {
            const score = new Map(contenders.map(h => [h, evaluate(h.hole.concat(fullBoard))]));
            const won = new Map<InHand, number>();
            let prev = 0;
            for (const level of levels) {
                const pot = players.reduce((s, h) => s + Math.max(0, Math.min(h.total, level) - prev), 0);
                const eligible = contenders.filter(h => h.total >= level);
                prev = level;
                if (!pot || !eligible.length) continue;
                const best = Math.max(...eligible.map(h => score.get(h)!));
                const winners = eligible.filter(h => score.get(h) === best);
                const share = Math.floor(pot / winners.length);
                winners.forEach((h, k) => won.set(h, (won.get(h) ?? 0) + share + (k === 0 ? pot - share * winners.length : 0)));
            }
            return won;
        };
        const known = board.slice(0, lastDecisionBoard);          // cards seen when the last decision was made
        while (board.length < 5) board.push(deck.pop()!);
        for (const h of contenders) say(h.p, `shows a ${cardText(h.hole[0])}, ${cardText(h.hole[1])}.`);
        const actual = payout(board);
        for (const h of contenders) {
            const won = actual.get(h) ?? 0;
            if (won > 0) { h.p.stack += won; say(h.p, `collected ${won} from pot`); }
        }
        if (known.length < 5) {
            // Average over runouts of the cards that came after the last decision.
            const used = new Set([...known, ...contenders.flatMap(h => h.hole)]);
            const rest = Array.from({ length: 52 }, (_, i) => i).filter(c => !used.has(c));
            const expected = new Map<InHand, number>();
            const need = 5 - known.length;
            const samples = need === 1 ? rest.map(c => [c]) : Array.from({ length: 200 }, () => {
                const pick: number[] = [];
                while (pick.length < need) {
                    const c = rest[Math.floor(Math.random() * rest.length)];
                    if (!pick.includes(c)) pick.push(c);
                }
                return pick;
            });
            for (const extra of samples)
                for (const [h, w] of payout(known.concat(extra))) expected.set(h, (expected.get(h) ?? 0) + w / samples.length);
            for (const h of contenders)
                luck.set(h.p.name, (luck.get(h.p.name) ?? 0) + (expected.get(h) ?? 0) - (actual.get(h) ?? 0));
        }
    }
    log.push(`-- ending hand #${n} --`);
    return log;
}
