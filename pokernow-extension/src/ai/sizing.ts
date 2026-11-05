/**
 * Turns "raise to this many chips" into an Action the clicker can type in.
 *
 * Every amount is a "raise to": the total we have in front of us on this street
 * after the action (what PokerNow's bet box shows). It is kept between the
 * smallest legal raise and all-in; at or above our stack it becomes all-in.
 */
import { TableView } from "../table/tableView";

/** The biggest bet on this street, and the smallest raise-to the rules allow. */
export function raiseLimits(view: TableView): { currentBet: number, minTo: number, maxTo: number } {
    const street = view.actions.filter(a => a.street === view.street);
    let level = view.street === "preflop" ? view.bb : 0;
    let step = view.bb;
    for (const a of street) {
        if ((a.kind === "bet" || a.kind === "raise" || a.kind === "straddle") && a.amount > level) {
            if (a.amount - level >= step) step = a.amount - level;
            level = a.amount;
        }
    }
    const currentBet = Math.max(level, ...view.players.map(p => p.streetBet));
    const maxTo = view.me.streetBet + view.me.stack;
    return { currentBet, minTo: Math.min(maxTo, currentBet + step), maxTo };
}

/** Closest button preset, used only if typing the amount fails. */
function presetFor(to: number, view: TableView): RaiseAmount {
    const { currentBet } = raiseLimits(view);
    const potAfterCall = view.pot + (currentBet - view.me.streetBet);
    const frac = (to - currentBet) / Math.max(1, potAfterCall);
    return frac < 0.3 ? "min" : frac < 0.75 ? "1/2_pot" : "pot";
}

/** A raise (or bet) to `to` chips in total on this street. */
export function raiseTo(view: TableView, to: number): Action {
    const { minTo, maxTo } = raiseLimits(view);
    const amount = Math.round(Math.min(maxTo, Math.max(minTo, to)));
    if (amount >= maxTo) return { type: "raise", raiseAmount: "all_in" };
    return { type: "raise", raiseAmount: presetFor(amount, view), amount };
}

/** How a raise reads in the logs: "raise to 6 (3 bb)". */
export function describeRaise(action: Action, bb: number): string {
    if (action.raiseAmount === "all_in") return "all-in";
    if (action.amount === undefined) return `(${action.raiseAmount ?? "min"} button)`;
    return `to ${action.amount} (${(action.amount / bb).toFixed(1).replace(/\.0$/, "")} bb)`;
}
