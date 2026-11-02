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

export function playTournament(bots: SimBot[], opts: TournamentOptions = DEFAULT_OPTIONS,
    onHand?: (log: string[]) => void): TournamentResult {
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

export function playHand(seats: Seat[], alive: Seat[], buttonSeat: Seat, [sb, bb]: [number, number], n: number, uid: number): string[] {
    const log: string[] = [];
    const say = (p: Seat, what: string) => log.push(`"${p.name} @ ${p.id}" ${what}`);
    for (const s of alive) startStacks.set(s.id, s.stack);

    // Acting order starting left of the button.
    const bi = alive.indexOf(buttonSeat);
    const order = alive.slice(bi + 1).concat(alive.slice(0, bi + 1));     // ... ends with the button
    const deck = Array.from({ length: 52 }, (_, i) => i);
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const players: InHand[] = order.map(p => ({
        p, hole: [deck.pop()!, deck.pop()!], folded: false, allIn: false, streetBet: 0, total: 0, needsToAct: true,
    }));
    const board: number[] = [];

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
            try {
                action = h.p.bot.decide({
                    log: log.slice(), hole: h.hole, board: board.slice(), street, name: h.p.name,
                    stack: h.p.stack, toCall: Math.min(toCall, h.p.stack), pot, bigBlind: bb,
                });
            }
            catch (err) {
                action = { type: "check_or_fold" };
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
        while (board.length < 5) board.push(deck.pop()!);
        for (const h of contenders) say(h.p, `shows a ${cardText(h.hole[0])}, ${cardText(h.hole[1])}.`);
        const score = new Map(contenders.map(h => [h, evaluate(h.hole.concat(board))]));
        // Side pots, from the smallest all-in level up.
        const levels = [...new Set(players.map(h => h.total).filter(t => t > 0))].sort((a, b) => a - b);
        let prev = 0;
        for (const level of levels) {
            const pot = players.reduce((s, h) => s + Math.max(0, Math.min(h.total, level) - prev), 0);
            const eligible = contenders.filter(h => h.total >= level);
            prev = level;
            if (!pot || !eligible.length) continue;
            const best = Math.max(...eligible.map(h => score.get(h)!));
            const winners = eligible.filter(h => score.get(h) === best);
            const share = Math.floor(pot / winners.length);
            winners.forEach((h, k) => {
                const won = share + (k === 0 ? pot - share * winners.length : 0);
                h.p.stack += won;
                say(h.p, `collected ${won} from pot`);
            });
        }
    }
    log.push(`-- ending hand #${n} --`);
    return log;
}
