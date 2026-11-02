/**
 * Turns a parsed hand log into what the brain needs: who sits where, their
 * position, stacks right now, what they put in, and who is still in the hand.
 */
import { HandLog, LogAction, Street } from "./logReader";

export type SeatView = {
    id: string,
    name: string,
    seat: number,
    position: string,          // "UTG", "CO", "BTN", "SB", "BB", ...
    startStack: number,        // chips at the start of the hand
    stack: number,             // chips behind right now
    invested: number,          // put in the pot this hand
    streetBet: number,         // put in on the current street
    folded: boolean,
    actions: LogAction[],      // this player's actions this hand
    isMe: boolean,
};

export type TableView = {
    handNumber: number,
    street: Street,
    sb: number,
    bb: number,
    players: SeatView[],       // in preflop acting order: UTG first ... SB, BB last
    me: SeatView,
    actions: LogAction[],      // everything this hand, in order
    pot: number,
};

/** Position names for the non-blind seats, counting back from the button. */
const LATE_TO_EARLY = ["BTN", "CO", "HJ", "LJ", "MP", "UTG+1"];

export function buildTableView(log: HandLog, myName: string | undefined, myDomStack: number): TableView | null {
    if (log.players.length < 2) return null;
    const bySeat = [...log.players].sort((a, b) => a.seat - b.seat);
    const sbPoster = log.actions.find(a => a.kind === "sb")?.id;
    const bbPoster = log.actions.find(a => a.kind === "bb")?.id;

    // Rotate the seats so the small blind comes first.
    let sbIndex = bySeat.findIndex(p => p.id === sbPoster);
    if (sbIndex < 0) {
        const dealer = bySeat.findIndex(p => p.id === log.dealerId);
        if (dealer < 0) return null;
        sbIndex = bySeat.length === 2 ? dealer : (dealer + 1) % bySeat.length;
    }
    let fromSb = bySeat.slice(sbIndex).concat(bySeat.slice(0, sbIndex));
    // The big blind is whoever posted it (a seat may be skipped, e.g. sitting out).
    const bbIndex = fromSb.findIndex(p => p.id === bbPoster);
    if (bbIndex > 1)
        fromSb = [fromSb[0], fromSb[bbIndex], ...fromSb.slice(bbIndex + 1), ...fromSb.slice(1, bbIndex)];
    const n = fromSb.length;

    const views: SeatView[] = fromSb.map((p, i) => {
        let position: string;
        if (n === 2) position = i === 0 ? "BTN/SB" : "BB";
        else if (i === 0) position = "SB";
        else if (i === 1) position = "BB";
        else {
            const fromButton = n - 1 - i, nonBlind = n - 2;
            position = fromButton === nonBlind - 1 && nonBlind >= 3 ? "UTG" : LATE_TO_EARLY[fromButton] ?? `EP${i}`;
        }
        return {
            id: p.id, name: p.name, seat: p.seat, position,
            startStack: p.stack, stack: p.stack, invested: 0, streetBet: 0,
            folded: false, actions: [], isMe: false,
        };
    });
    const byId = new Map(views.map(v => [v.id, v]));

    let street: Street = "preflop";
    let sb = 0, bb = 0;
    for (const a of log.actions) {
        const v = byId.get(a.id);
        if (!v) continue;
        if (a.street !== street) {
            street = a.street;
            for (const x of views) x.streetBet = 0;
        }
        v.actions.push(a);
        if (a.kind === "ante") {
            v.invested += a.amount; v.stack -= a.amount;
        }
        else if (a.kind === "sb" || a.kind === "bb" || a.kind === "straddle" ||
            a.kind === "call" || a.kind === "bet" || a.kind === "raise") {
            const added = Math.max(0, a.amount - v.streetBet);
            v.invested += added; v.stack -= added; v.streetBet = a.amount;
            if (a.kind === "sb") sb = a.amount;
            if (a.kind === "bb") bb = a.amount;
        }
        else if (a.kind === "fold") v.folded = true;
    }
    // The next card may have been dealt before anyone acted on it: no bets on it yet.
    const lastStreet = log.street ?? street;
    if (lastStreet !== street) for (const x of views) x.streetBet = 0;

    // Preflop acting order: everyone after the big blind, then SB, BB.
    const ordered = n === 2 ? views : views.slice(2).concat(views.slice(0, 2));

    // Which one is me? By name if we know it, otherwise by matching the stack on screen.
    let me = myName ? ordered.find(v => v.name.trim().toLowerCase() === myName.trim().toLowerCase()) : undefined;
    if (!me) {
        const matches = ordered.filter(v => !v.folded && Math.abs(v.stack - myDomStack) < 0.01);
        if (matches.length === 1) me = matches[0];
    }
    if (!me) return null;
    me.isMe = true;

    return {
        handNumber: log.handNumber, street: lastStreet, sb, bb: bb || sb * 2,
        players: ordered, me, actions: log.actions,
        pot: views.reduce((s, v) => s + v.invested, 0),
    };
}

/** Players who still have cards, other than me. */
export function opponentsInHand(view: TableView): SeatView[] {
    return view.players.filter(p => !p.isMe && !p.folded);
}

/** Players who act after me this street and haven't folded (preflop order). */
export function playersBehind(view: TableView): SeatView[] {
    const i = view.players.indexOf(view.me);
    return view.players.slice(i + 1).filter(p => !p.folded && p.stack > 0);
}

/** The stack situation of a player right now, for their profile lookup. */
export function situationOf(view: TableView, p: SeatView) {
    const avg = view.players.reduce((s, x) => s + x.startStack, 0) / Math.max(1, view.players.length);
    return { stack: p.startStack, bb: view.bb, tableAverage: avg };
}
