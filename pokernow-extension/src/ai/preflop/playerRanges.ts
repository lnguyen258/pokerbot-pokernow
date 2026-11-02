/**
 * Estimates each opponent's preflop range from what they did this hand.
 *
 * Starting point is a game-theory-style baseline (how wide a solid player opens
 * from each seat), then four adjustments:
 *   - style: players who've shown they play lots of hands get wider ranges
 *   - commitment: putting in a big share of your stack (e.g. calling 200 of 400)
 *     is treated like going all-in, which uses the ICM all-in ranges
 *   - action: 3-bets are much narrower than opens, calls drop the hands that
 *     would have re-raised, limps drop most premium hands, and so on
 *   - aggression: a player who raises 90% of hands has a 90% raising range,
 *     no matter what the baseline says (this stops maniacs from bullying us)
 */
import { SeatView, TableView } from "../../table/tableView";
import { Range, fullRange, minus, topRange, widen } from "./hands";
import { Profile } from "../../table/stats";
import { CONFIG } from "../../config";

/**
 * Baseline share of hands to open when first in, by number of players left to
 * act behind you. Roughly what solvers open in 8-handed tournaments at 20-40 BB.
 */
const OPEN_BY_PLAYERS_BEHIND = [1.0, 0.45, 0.45, 0.30, 0.24, 0.20, 0.17, 0.14, 0.12];

export function openShare(playersBehind: number, tableSize: number): number {
    if (tableSize === 2) return 0.80;                    // heads-up: button opens most hands
    return OPEN_BY_PLAYERS_BEHIND[Math.min(playersBehind, 8)];
}

/** How many seats act after `p` preflop (they hadn't acted yet when p acted first). */
export function seatsBehind(view: TableView, p: SeatView): number {
    return view.players.length - 1 - view.players.indexOf(p);
}

/** True if this bet puts in at least 40% of the player's chips: treat it like all-in. */
export function isCommitted(p: SeatView, amount: number): boolean {
    return amount >= 0.4 * p.startStack;
}

/**
 * How much more than typical this player RAISES (not how many hands they play).
 * On this site most loose players limp and call a lot but rarely raise, so when
 * one of them does raise or shove, it's a strong hand: their VPIP must not widen it.
 */
export function raiseStyle(prof: Profile): number {
    return Math.max(0.5, Math.min(2.5, prof.pfr / 0.15));
}

/**
 * Share of hands behind an all-in (or a bet of 40%+ of the stack), by how deep it is.
 * Short shoves (8 BB or less) follow the game-theory range: short stacks really do
 * shove light. From 16 BB up, it's the beginner's value range: top ~8% (77+, AJ+, KQs),
 * wider only for players actually seen raising a lot. In between, a blend.
 */
export function bigBetShare(theoryShare: number, depthBB: number, prof: Profile, reraise: boolean): number {
    const value = CONFIG.population.bigBetRange * (reraise ? 0.6 : 1) * raiseStyle(prof);
    const t = Math.max(0, Math.min(1, (depthBB - 8) / 8));
    return (1 - t) * theoryShare + t * Math.min(theoryShare, value);
}

export function preflopRange(view: TableView, p: SeatView, prof: Profile): Range {
    const style = prof.style;              // VPIP: how many hands they PLAY (limps, calls)
    const aggr = raiseStyle(prof);         // how often they RAISE
    const threeBetAggr = Math.max(0.5, Math.min(2.5, prof.threeBet / 0.07));
    const bb = view.bb || 1;
    let range = fullRange();
    let raises = 0;
    let raiserBehind = 0;
    let limpers = 0;

    for (const a of view.actions) {
        if (a.street !== "preflop") break;
        const mine = a.id === p.id;
        const actor = view.players.find(x => x.id === a.id);

        if (mine) {
            if (a.kind === "raise" || a.kind === "bet") {
                if (a.allIn || isCommitted(p, a.amount)) {
                    const theory = Math.min(1, (raises === 0 ? 0.30 : 0.12) * aggr);
                    range = topRange(bigBetShare(theory, p.startStack / bb, prof, raises > 0));
                }
                else if (raises === 0)
                    range = topRange(Math.min(1, Math.max(
                        openShare(seatsBehind(view, p), view.players.length) * (limpers ? 0.8 : 1) * aggr, prof.pfr)));
                else
                    range = topRange(Math.min(1, raises === 1
                        ? Math.max(0.07 * threeBetAggr, prof.threeBet)
                        : Math.max(0.035 * threeBetAggr, prof.threeBet * 0.6)));
            }
            else if (a.kind === "call") {
                if (raises === 0)                                           // limp
                    range = minus(topRange(Math.min(1, 0.55 * style)), topRange(0.08), 0.8);
                else if (isCommitted(p, a.amount) || a.allIn)
                    range = topRange(Math.min(1, 0.22 * style));
                else if (raises === 1)
                    range = minus(topRange(Math.min(1, openShare(raiserBehind, view.players.length) * 1.5 * style)), topRange(0.06), 0.7);
                else
                    range = topRange(0.08 * style);
            }
            else if (a.kind === "check")                                     // big blind option
                range = minus(fullRange(), topRange(0.12), 0.8);
        }

        if (a.kind === "raise" || a.kind === "bet") {
            raises++;
            if (actor) raiserBehind = seatsBehind(view, actor);
        }
        else if (a.kind === "call" && raises === 0) limpers++;
    }
    return range;
}

export { widen };
