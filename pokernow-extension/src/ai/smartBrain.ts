/**
 * The "smart" brain. Its only input is the screen:
 *   - the table from the page (seats, stacks, bets, dealer button): table/screenReader.ts
 *   - preflop: position / stack / ICM-aware decisions (preflop/preflopBrain.ts)
 *   - postflop: equity against each opponent's estimated range, with ICM pressure
 * Falls back to the plain equity bot if the seats can't be read.
 */
import { TableView, buildTableView } from "../table/tableView";
import { loadStats } from "../table/stats";
import { getStack } from "../ui";
import { handFromScreen, readScreenSeats } from "../table/screenReader";
import { decideWithView } from "./decide";
import { loadMode } from "../mode";
import { CONFIG } from "../config";

/** The table from the page (seats, stacks, bets, dealer button). This is the only input: there is no game log. */
export function readTable(state: State): TableView | null {
    const seats = readScreenSeats();
    const hand = handFromScreen(seats, {
        street: state.board.length === 0 ? "preflop" : state.board.length === 3 ? "flop" : state.board.length === 4 ? "turn" : "river",
        bb: state.bigBlind,
        prevPot: state.board.length ? state.prevPhasePot ?? 0 : 0,
    });
    if (!hand) {
        console.warn(`[table reader] found ${seats.length} seats on the page` +
            (seats.length && !seats.some(s => s.isMe) ? ", none marked as mine (.you-player)" : ""));
        return null;
    }
    const view = buildTableView(hand, seats.find(s => s.isMe)!.name, getStack());
    if (view && state.pot > 0) view.pot = state.pot;      // the page's pot is exact; the rebuilt one is a guess
    return view;
}

export async function smartAction(state: State): Promise<Action> {
    const mode = await loadMode();
    await loadStats();
    const view = readTable(state);
    if (!view) {
        // ai.ts catches this, plays the plain equity bot and shows the reason in the popup.
        throw new Error("couldn't read the seats on the page");
    }
    console.log(`[table] (${CONFIG.gameType}, ${mode} mode): ` +
        view.players.map(p => `${p.isMe ? "*" : ""}${p.name} ${p.position} ${p.stack}${p.folded ? " (folded)" : ""}`).join(" | "));

    return decideWithView(view, state);
}
