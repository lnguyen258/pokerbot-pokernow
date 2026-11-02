import { CONFIG } from "../config";
import { equityAction } from "./equity/equityAi";
import { ifThenElseAction } from "./ifThenElse/ifThenElseAi";
import { smartAction } from "./smartBrain";

/** Longest the smart brain may take (log read + thinking) before the quick bot decides instead. */
const DECIDE_LIMIT_MS = 4000;

/** Which brain made the last decision, and why if it wasn't the smart one (shown in the popup). */
export let lastBrain = "no decision yet";
const short = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 80);

/**
 * Picks the strategy set in src/config.ts (CONFIG.brain).
 * If a brain throws an error, falls back to the next simpler one.
 */
export async function getAction(state: State): Promise<Action> {
    if (CONFIG.brain === "smart") {
        try {
            // Hard limit: if reading the table or thinking takes too long, play the quick bot.
            let timer: ReturnType<typeof setTimeout> | undefined;
            const deadline = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`took over ${DECIDE_LIMIT_MS / 1000} s`)), DECIDE_LIMIT_MS);
            });
            try {
                const action = await Promise.race([smartAction(state), deadline]);
                lastBrain = "smart brain";
                return action;
            }
            finally { clearTimeout(timer); }
        }
        catch (err) {
            console.error("[smart brain] error, using the equity bot instead:", err);
            lastBrain = `QUICK BOT (smart brain: ${short(err)})`;
        }
    }
    if (CONFIG.brain !== "rules") {
        try {
            const action = equityAction(state);
            if (CONFIG.brain !== "smart") lastBrain = "equity bot";
            return action;
        }
        catch (err) {
            console.error("[equity bot] error, using rules instead:", err);
            lastBrain = `RULES BOT (equity bot: ${short(err)})`;
        }
    }
    return ifThenElseAction(state);
}
