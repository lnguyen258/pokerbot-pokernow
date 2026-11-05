/**
 * Reads one snapshot of the table for the hand recorder (PokerNow's class names, same as screenReader.ts).
 * Never throws: anything it can't read is left empty.
 */
import { getBigBlindValue, parseCard } from "../ui";
import { cardText } from "../history";
import type { Snapshot } from "./recorder";

const number = (el: Element | null | undefined) => {
    const v = parseFloat((el?.textContent ?? "").replace(/[^\d.]/g, ""));
    return isNaN(v) ? 0 : v;
};

function cardsIn(el: Element | null | undefined): string[] {
    if (!el) return [];
    const out: string[] = [];
    for (const c of Array.from(el.querySelectorAll(".card"))) {
        try { out.push(cardText(parseCard(c))); }
        catch { /* face down or not a card */ }
    }
    return out;
}

export function readSnapshot(): Snapshot {
    const empty: Snapshot = { at: Date.now(), seats: [], board: [], myCards: [], bb: 0 };
    try {
        const dealerClass = document.querySelector(".dealer-button-ctn")?.className.match(/dealer-position-(\d+)/)?.[1];
        const seatNumber = (el: Element) => parseInt(el.className.match(/table-player-(\d+)/)?.[1] ?? "") || 0;
        const els = Array.from(document.querySelectorAll(".table-player"))
            .filter(el => !/standing|empty|offline|away/i.test(el.className))
            .sort((a, b) => seatNumber(a) - seatNumber(b));
        const seats = els.map(el => ({
            name: el.querySelector(".table-player-name")?.textContent?.trim() ?? "",
            seat: seatNumber(el),
            stack: number(el.querySelector(".table-player-stack .chips-value") ?? el.querySelector(".table-player-stack")),
            bet: number(el.querySelector(".table-player-bet-value .chips-value") ?? el.querySelector(".table-player-bet-value")),
            folded: /fold/i.test(el.className),
            dealer: !!dealerClass && String(seatNumber(el)) === dealerClass,
            isMe: el.classList.contains("you-player"),
            cards: cardsIn(el),
        })).filter(s => s.name);
        const me = seats.find(s => s.isMe);
        let bb = 0;
        try { bb = getBigBlindValue() || 0; } catch { /* not drawn yet */ }
        return {
            at: Date.now(),
            seats,
            board: cardsIn(document.querySelector(".table-cards")),
            myCards: me && me.cards.length === 2 ? me.cards : [],
            bb,
        };
    }
    catch { return empty; }
}
