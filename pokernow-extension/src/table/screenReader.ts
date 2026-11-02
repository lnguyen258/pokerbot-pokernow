/**
 * Screen-only table reading, for sites without PokerNow's game log.
 *
 * The smart brain normally rebuilds the hand from the log (every action, in order).
 * Without it, this reads what the page shows right now: each seat's name, stack, the bet
 * in front of them, who folded and where the dealer button is. Then it writes a plausible
 * hand history from that, so the same brains can run on it:
 *   - blinds from the dealer button (or from who has the big blind in front of them),
 *   - this street's bets in increasing order: the first is a bet/raise, equal ones are calls,
 *   - earlier streets: the players still in called an equal share of the pot so far.
 * What the page can't show (who raised on earlier streets, the exact order) is guessed,
 * so these hands are NEVER added to the opponent profiles.
 */
import { HandLog, LogAction, LogPlayer, Street } from "./logReader";

export type ScreenSeat = {
    name: string,
    stack: number,       // chips behind now
    bet: number,         // chips in front of them on this street
    folded: boolean,
    isMe: boolean,
    dealer: boolean,
};

export type ScreenInfo = {
    street: Street,
    bb: number,
    prevPot: number,     // pot from earlier streets (0 preflop)
};

/** Builds a hand history from the seats on screen (in seat order, clockwise). Null if it can't. */
export function handFromScreen(seats: ScreenSeat[], info: ScreenInfo): HandLog | null {
    const n = seats.length;
    const meIndex = seats.findIndex(s => s.isMe);
    if (n < 2 || meIndex < 0 || !(info.bb > 0)) return null;

    // The dealer: the button on screen, else whoever has the big blind in front of them
    // preflop, else a seat that puts us in a middle position.
    let dealer = seats.findIndex(s => s.dealer);
    if (dealer < 0 && info.street === "preflop") {
        const bbSeat = seats.findIndex(s => s.bet === info.bb);
        if (bbSeat >= 0) dealer = (bbSeat - (n === 2 ? 1 : 2) + n) % n;
    }
    if (dealer < 0) dealer = (meIndex + Math.floor(n / 2)) % n;
    const sbIndex = n === 2 ? dealer : (dealer + 1) % n;
    const bbIndex = (sbIndex + 1) % n;

    const id = (i: number) => `screen:${seats[i].name}`;
    const live = seats.map((s, i) => i).filter(i => !seats[i].folded);
    const earlierShare = info.street === "preflop" ? 0 : info.prevPot / Math.max(1, live.length);

    const players: LogPlayer[] = seats.map((s, i) => ({
        id: id(i), name: s.name, seat: i + 1,
        stack: s.stack + s.bet + (s.folded ? 0 : earlierShare),
    }));

    const actions: LogAction[] = [];
    const act = (i: number, street: Street, kind: LogAction["kind"], amount: number) =>
        actions.push({ id: id(i), street, kind, amount, allIn: kind !== "fold" && seats[i].stack <= 0 });

    // Preflop acting order: first seat after the big blind, around to the big blind.
    const order = Array.from({ length: n }, (_, k) => (bbIndex + 1 + k) % n);
    const sbAmount = info.bb / 2;

    act(sbIndex, "preflop", "sb", info.street === "preflop" ? Math.min(sbAmount, seats[sbIndex].bet || sbAmount) : sbAmount);
    act(bbIndex, "preflop", "bb", info.bb);

    /** One street's bets, smallest first: the first above the current level bets/raises, equal ones call. */
    function streetBets(street: Street, level: number, bets: { i: number, amount: number }[]) {
        const sorted = bets.filter(b => b.amount > 0).sort((a, b) => a.amount - b.amount);
        for (const b of sorted) {
            if (b.amount > level) {
                act(b.i, street, level === 0 ? "bet" : "raise", b.amount);
                level = b.amount;
            }
            else act(b.i, street, "call", b.amount);
        }
    }

    if (info.street === "preflop") {
        // Everyone's bet in front of them now; the blinds only count if they put in more.
        const bets = order
            .filter(i => !seats[i].folded && !(i === sbIndex && seats[i].bet <= sbAmount) && !(i === bbIndex && seats[i].bet <= info.bb))
            .map(i => ({ i, amount: seats[i].bet }));
        streetBets("preflop", info.bb, bets);
    }
    else {
        // Earlier streets are hidden: the players still in each put in an equal share preflop.
        const preflopEach = Math.max(info.bb, earlierShare);
        const bets = order.filter(i => !seats[i].folded && i !== bbIndex).map(i => ({ i, amount: preflopEach }));
        if (!seats[bbIndex].folded && preflopEach > info.bb) bets.push({ i: bbIndex, amount: preflopEach });
        streetBets("preflop", info.bb, bets);
        streetBets(info.street, 0, live.map(i => ({ i, amount: seats[i].bet })));
    }
    for (const i of order) if (seats[i].folded) act(i, "preflop", "fold", 0);

    return {
        handNumber: 0, street: info.street, players, actions, shown: [], collected: [],
        dealerId: id(dealer),
    };
}

const number = (el: Element | null | undefined) => {
    const v = parseFloat((el?.textContent ?? "").replace(/[^\d.]/g, ""));
    return isNaN(v) ? 0 : v;
};

/** Reads the seats from the page (PokerNow's class names; your site must use the same ones). */
export function readScreenSeats(): ScreenSeat[] {
    const dealerClass = document.querySelector(".dealer-button-ctn")?.className.match(/dealer-position-(\d+)/)?.[1];
    const seatNumber = (el: Element) => parseInt(el.className.match(/table-player-(\d+)/)?.[1] ?? "") || 0;
    const els = [...document.querySelectorAll(".table-player")]
        .filter(el => !/standing|empty|offline|away/i.test(el.className))
        .sort((a, b) => seatNumber(a) - seatNumber(b));
    return els.map(el => ({
        name: el.querySelector(".table-player-name")?.textContent?.trim() ?? "",
        stack: number(el.querySelector(".table-player-stack .chips-value") ?? el.querySelector(".table-player-stack")),
        bet: number(el.querySelector(".table-player-bet-value .chips-value") ?? el.querySelector(".table-player-bet-value")),
        folded: /fold/i.test(el.className),
        isMe: el.classList.contains("you-player"),
        dealer: !!dealerClass && String(seatNumber(el)) === dealerClass,
    })).filter(s => s.name);
}
