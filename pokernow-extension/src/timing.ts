/**
 * How long the bot "thinks" before acting: timing as a weapon.
 *
 * People read timing: a long think followed by a call looks like a tough,
 * marginal call; a quick bet looks automatic. So with strong hands the bot
 * usually takes its time (the call looks reluctant, the bet looks like a
 * hard decision or a bluff).
 *
 * The catch: if long thinks ALWAYS meant strength, an observant player would
 * learn that and read us perfectly. So the bot also tanks with some bluffs and
 * marginal hands, and sometimes acts at normal speed with strong ones. Timing
 * then hints at nothing reliable, while still baiting players who believe
 * "long think = weak".
 */
import { CONFIG } from "./config";

let strength = 0.5;

/** Brains call this with how strong our hand is right now (0 = hopeless, 1 = the nuts). */
export function noteStrength(s: number) {
    strength = Math.max(0, Math.min(1, s));
}

const between = (a: number, b: number) => a + Math.random() * (b - a);
const chance = (p: number) => Math.random() < p;

export function thinkTime(action: Action, state: State): { ms: number, why: string } {
    if (!CONFIG.timing.enabled) return { ms: 300, why: "timing off" };
    const strong = strength >= 0.75, weak = strength < 0.4;
    const bigPot = state.toCall >= 0.3 * state.stack || action.raiseAmount === "all_in";
    let s: number, why: string;

    if (action.type === "check_or_fold" && state.toCall > 0) {
        // Folding gives nothing away. Usually quick, sometimes a "considered" fold.
        [s, why] = chance(0.2) ? [between(3, 5), "considered fold"] : [between(0.8, 2.2), "routine fold"];
    }
    else if (action.type === "check_or_fold") {
        [s, why] = strong && chance(0.3)
            ? [between(4, 8), "strong hand: pondering a bet, then checking (trap)"]
            : [between(1, 3), "routine check"];
    }
    else if (action.type === "call") {
        if (strong)
            [s, why] = chance(0.65) ? [between(5, 10), "strong hand: acting out a hard call"] : [between(2, 4), "strong hand: normal-speed call"];
        else if (weak)
            [s, why] = chance(0.3) ? [between(4, 8), "marginal: long think (keeps timing unreadable)"] : [between(1.5, 3.5), "light call"];
        else
            [s, why] = chance(0.4) ? [between(4, 8), "medium hand: thinking it over"] : [between(1.5, 3.5), "standard call"];
    }
    else {
        if (strong)
            [s, why] = chance(0.55) ? [between(5, 10), "strong hand: long tank then bet (looks like a bluff)"] : [between(2, 4), "strong hand: confident bet"];
        else if (weak)
            [s, why] = chance(0.35) ? [between(5, 9), "bluff: long tank (balances the strong-hand tanks)"] : [between(1.5, 3.5), "bluff: quick, confident"];
        else
            [s, why] = [between(2, 5), "standard bet"];
    }
    if (bigPot) s += between(1, 3);                          // big decisions take longer for everyone
    return { ms: fitToBudget(s) * 1000, why };
}

/** The shortest and longest thinks above (quick fold; 10 s tank + 3 s big pot). */
const SHORTEST = 0.8;
const LONGEST = 13;

/**
 * Squeezes the think time into [minSeconds, maxSeconds]. Scaled, not clipped:
 * a routine fold stays near the minimum, a long tank near the maximum, and the
 * order and variety between them are kept (so timing still says nothing reliable).
 */
export function fitToBudget(s: number): number {
    const { minSeconds, maxSeconds } = CONFIG.timing;
    const x = (Math.min(Math.max(s, SHORTEST), LONGEST) - SHORTEST) / (LONGEST - SHORTEST);
    return minSeconds + x * (maxSeconds - minSeconds);
}

/**
 * How long to still wait, given how long we already spent since the turn started
 * (reading the log, simulating, solving). Never pushes past the budget.
 */
export function remainingWait(thinkMs: number, spentMs: number): number {
    const budgetMs = CONFIG.timing.maxSeconds * 1000;
    return Math.max(0, Math.min(thinkMs - spentMs, budgetMs - spentMs));
}
