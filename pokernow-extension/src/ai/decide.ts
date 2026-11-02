/**
 * The smart brain's decision, given a table view. No page access, so the
 * simulator (src/sim/) can call it too.
 *   - preflop: position / stack / ICM-aware decisions (preflop/preflopBrain.ts)
 *   - postflop: range-based decisions with draw-aware bet sizing (postflop/postflopBrain.ts)
 */
import { CONFIG } from "../config";
import { TableView, opponentsInHand, situationOf } from "../table/tableView";
import { profile } from "../table/stats";
import { requiredEquityAllIn } from "./icm";
import { equityAction } from "./equity/equityAi";
import { preflopDecide } from "./preflop/preflopBrain";
import { preflopRange } from "./preflop/playerRanges";
import { postflopDecide } from "./postflop/postflopBrain";

export function decideWithView(view: TableView, state: State, log: (msg: string) => void = console.log): Action {
    if (state.phase.name === "preflop") {
        const d = preflopDecide(view, state);
        log(`[preflop] ${d.reason}`);
        return d.action;
    }

    const opps = opponentsInHand(view);
    const stacks = view.players.map(p => p.startStack);
    const me = view.players.indexOf(view.me);
    // Extra equity we need to risk our stack against the biggest opponent still in.
    const coverer = opps.filter(p => p.startStack >= view.me.startStack)
        .sort((a, b) => b.startStack - a.startStack)[0];
    const callPressure = coverer
        ? Math.max(0, requiredEquityAllIn(stacks, me, view.players.indexOf(coverer), CONFIG.payouts) - 0.5) : 0;
    // How much the opponents we cover fear calling.
    const covered = opps.filter(p => p.startStack < view.me.startStack);
    const bluffPressure = covered.length === opps.length && covered.length
        ? Math.min(0.5, Math.min(...covered.map(p =>
            requiredEquityAllIn(stacks, view.players.indexOf(p), me, CONFIG.payouts) - 0.5)))
        : 0;

    const preRanges = new Map(opps.map(p => [p.id, preflopRange(view, p, profile(p.id, p.name, situationOf(view, p)))] as const));
    try {
        const d = postflopDecide(view, state, {
            preRanges,
            profileOf: p => profile(p.id, p.name, situationOf(view, p)),
            callPressure,
        });
        log(`[postflop] ${d.reason}`);
        return d.action;
    }
    catch (err) {
        console.error("[postflop] error, using the equity bot instead:", err);
        return equityAction(state, {
            ranges: opps.map(p => preRanges.get(p.id)!),
            callPressure,
            bluffPressure: Math.max(0, bluffPressure),
        });
    }
}
