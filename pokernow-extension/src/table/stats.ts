/**
 * Player profiles: how each opponent plays, and how that changes with their
 * situation. Saved in the extension's storage across hands, sessions and
 * imported logs.
 *
 * Counted per player, overall AND separately by stack situation:
 *   short  = under 15 big blinds, or well below the table average
 *   normal
 *   big    = well above the table average (the player who can bully)
 *
 *   VPIP  = voluntarily puts money in preflop (typical ~25%)
 *   PFR   = raises preflop;  3-bet = re-raises a single raise
 *   bets when checked to / raises a bet / folds to a bet (after the flop)
 *
 * Judgement with little data ("shrinkage"): a situation with few hands borrows
 * from the player's overall numbers, and the overall numbers borrow from a
 * typical player. As hands come in, each moves toward what the player really does.
 * Recency: every new hand makes older hands count a bit less (half-weight after
 * ~27 hands, about half a Sit & Go), so the profile follows players who change gears.
 */
import { HandLog } from "./logReader";

export type StackClass = "short" | "normal" | "big";

type Counts = {
    hands: number, vpip: number, pfr: number,
    threeBetChances: number, threeBets: number,
    checkedToChances: number, checkedToBets: number,
    facingBetChances: number, facingBetFolds: number, facingBetRaises: number,
};

export type PlayerStats = {
    name: string,
    overall: Counts,
    byStack: Partial<Record<StackClass, Counts>>,
    shown: { cards: string, preflop: string, stack?: StackClass }[],
};

/** What the brain uses. */
export type Profile = {
    hands: number,          // how much evidence (recency-weighted hands)
    stackClass?: StackClass,
    style: number,          // VPIP vs a typical 25%: 1 typical, 2 = plays twice as many hands
    vpip?: number,          // puts money in preflop
    pfr: number,            // raises preflop
    threeBet: number,       // re-raises a single raise preflop
    aggression: number,     // bets when checked to after the flop
    raiseVsBet: number,     // raises when facing a bet after the flop
    foldToBet: number,      // folds when facing a bet after the flop
};

type Store = { players: Record<string, PlayerStats>, counted: string[] };

let store: Store = { players: {}, counted: [] };
let countedSet = new Set<string>();
let loaded = false;
let lastHand: HandLog | null = null;

const PRIOR = 8;            // a typical player's numbers count as 8 hands of evidence
const SITUATION_PRIOR = 6;  // the player's overall numbers count as 6 hands for each situation
const DECAY = 0.975;        // weight kept by older hands each time the player plays a new one (half after ~27 hands)
const TYPICAL = { vpip: 0.25, pfr: 0.15, threeBet: 0.07, aggression: 0.35, raiseVsBet: 0.12, foldToBet: 0.45 };
const MAX_COUNTED = 20000;
const MAX_SHOWN = 30;

const emptyCounts = (): Counts => ({
    hands: 0, vpip: 0, pfr: 0, threeBetChances: 0, threeBets: 0,
    checkedToChances: 0, checkedToBets: 0, facingBetChances: 0, facingBetFolds: 0, facingBetRaises: 0,
});

/** Older saved profiles had the counts at the top level. */
function migrate(p: any): PlayerStats {
    if (p.overall) return p;
    const overall = emptyCounts();
    for (const k of Object.keys(overall) as (keyof Counts)[]) overall[k] = p[k] ?? 0;
    return { name: p.name, overall, byStack: {}, shown: p.shown ?? [] };
}

function setStore(s: Store | undefined) {
    store = s ?? { players: {}, counted: [] };
    for (const id of Object.keys(store.players)) store.players[id] = migrate(store.players[id]);
    countedSet = new Set(store.counted);
}

export async function loadStats(force = false) {
    if (loaded && !force) return;
    loaded = true;
    try { setStore((await chrome.storage.local.get("opponentStore")).opponentStore); }
    catch { /* storage unavailable: start fresh */ }
}

// Pick up imports done from the popup while the bot is running.
try {
    chrome.storage.onChanged.addListener((changes) => {
        if (changes.opponentStore?.newValue) setStore(changes.opponentStore.newValue);
    });
}
catch { /* not running inside the extension (tests, simulator) */ }

/** Forget everything (the simulator does this between tournaments: new opponents). */
export function resetStats() {
    setStore(undefined);
}

export async function saveStats() {
    if (store.counted.length > MAX_COUNTED) store.counted = store.counted.slice(-MAX_COUNTED);
    try { await chrome.storage.local.set({ opponentStore: store }); }
    catch { /* ignore */ }
}

export function stackClassOf(stack: number, bb: number, tableAverage: number): StackClass {
    const bbs = bb > 0 ? stack / bb : 100;
    const ratio = tableAverage > 0 ? stack / tableAverage : 1;
    if (bbs < 15 || ratio < 0.6) return "short";
    if (ratio > 1.5 && bbs >= 20) return "big";
    return "normal";
}

/** Adds one finished hand to the profiles. Returns false if it was already counted. */
export function addHand(hand: HandLog): boolean {
    const key = hand.handId ?? `#${hand.handNumber}:${hand.players.map(p => p.id + p.stack).join(",")}`;
    if (countedSet.has(key)) return false;
    countedSet.add(key);
    store.counted.push(key);

    const bb = hand.actions.find(a => a.kind === "bb")?.amount ?? 0;
    const avg = hand.players.reduce((s, p) => s + p.stack, 0) / Math.max(1, hand.players.length);
    // The two count tables each action updates: overall, and this stack situation.
    const tables = new Map<string, Counts[]>();
    const situation = new Map<string, StackClass>();

    for (const p of hand.players) {
        const s = store.players[p.id] ??= { name: p.name, overall: emptyCounts(), byStack: {}, shown: [] };
        s.name = p.name;
        const cls = stackClassOf(p.stack, bb, avg);
        situation.set(p.id, cls);
        const bucket = s.byStack[cls] ??= emptyCounts();
        for (const c of [s.overall, bucket]) {
            for (const k of Object.keys(c) as (keyof Counts)[]) c[k] *= DECAY;   // older hands fade
            c.hands++;
        }
        tables.set(p.id, [s.overall, bucket]);
    }
    const bump = (id: string, field: keyof Counts) => { for (const c of tables.get(id) ?? []) c[field]++; };

    const preflop = hand.actions.filter(a => a.street === "preflop");
    const line = new Map<string, string>();
    let raises = 0;
    const vpipCounted = new Set<string>(), pfrCounted = new Set<string>();
    for (const a of preflop) {
        if (!tables.has(a.id) || a.kind === "sb" || a.kind === "bb" || a.kind === "ante" || a.kind === "straddle") continue;
        if (raises === 1 && a.kind !== "check") {
            bump(a.id, "threeBetChances");
            if (a.kind === "raise" || a.kind === "bet") bump(a.id, "threeBets");
        }
        // Count each player at most once per hand.
        if ((a.kind === "call" || a.kind === "raise" || a.kind === "bet") && !vpipCounted.has(a.id)) {
            vpipCounted.add(a.id); bump(a.id, "vpip");
        }
        if ((a.kind === "raise" || a.kind === "bet") && !pfrCounted.has(a.id)) {
            pfrCounted.add(a.id); bump(a.id, "pfr");
        }
        const desc = a.kind === "raise" || a.kind === "bet"
            ? (raises === 0 ? "open-raise" : raises === 1 ? "3-bet" : "4-bet+") + (a.allIn ? " all-in" : "")
            : a.kind === "call" ? (raises === 0 ? "limp" : `call ${raises === 1 ? "a raise" : "a re-raise"}`) + (a.allIn ? " all-in" : "")
            : a.kind === "check" ? "check (big blind)" : a.kind;
        line.set(a.id, line.has(a.id) ? `${line.get(a.id)}, then ${desc}` : desc);
        if (a.kind === "raise" || a.kind === "bet") raises++;
    }

    // After the flop: did they bet when checked to? fold or raise when bet into?
    let street = "preflop";
    let maxBet = 0;
    const bets = new Map<string, number>();
    for (const a of hand.actions) {
        if (a.street !== street) { street = a.street; maxBet = 0; bets.clear(); }
        const before = bets.get(a.id) ?? 0;
        if (tables.has(a.id) && street !== "preflop" && ["check", "bet", "raise", "call", "fold"].includes(a.kind)) {
            if (maxBet - before <= 0) {
                bump(a.id, "checkedToChances");
                if (a.kind === "bet" || a.kind === "raise") bump(a.id, "checkedToBets");
            }
            else {
                bump(a.id, "facingBetChances");
                if (a.kind === "fold") bump(a.id, "facingBetFolds");
                if (a.kind === "raise") bump(a.id, "facingBetRaises");
            }
        }
        if (["sb", "bb", "straddle", "call", "bet", "raise"].includes(a.kind)) {
            bets.set(a.id, a.amount);
            maxBet = Math.max(maxBet, a.amount);
        }
    }

    for (const sh of hand.shown) {
        const s = store.players[sh.id];
        if (!s) continue;
        s.shown.push({ cards: sh.cards, preflop: line.get(sh.id) ?? "blind only", stack: situation.get(sh.id) });
        if (s.shown.length > MAX_SHOWN) s.shown.shift();
    }
    return true;
}

/** Live play: count the previous hand once a new one starts. */
export function recordHand(hand: HandLog) {
    if (lastHand && lastHand.handNumber !== hand.handNumber && addHand(lastHand))
        saveStats();
    lastHand = hand;
}

function find(id: string, name?: string): PlayerStats | undefined {
    if (store.players[id]) return store.players[id];
    // PokerNow ids may change between games; fall back to the name.
    if (name) {
        const lower = name.trim().toLowerCase();
        return Object.values(store.players).find(p => p.name.trim().toLowerCase() === lower);
    }
    return undefined;
}

/** Shrinks observed hits/chances toward `prior`, which counts as `weight` observations. */
const shrink = (hits: number, chances: number, prior: number, weight: number) =>
    (hits + prior * weight) / (chances + weight);

function frequencies(c: Counts | undefined, prior: typeof TYPICAL, weight: number): typeof TYPICAL {
    const z = c ?? emptyCounts();
    return {
        vpip: shrink(z.vpip, z.hands, prior.vpip, weight),
        pfr: shrink(z.pfr, z.hands, prior.pfr, weight),
        threeBet: shrink(z.threeBets, z.threeBetChances, prior.threeBet, weight),
        aggression: shrink(z.checkedToBets, z.checkedToChances, prior.aggression, weight),
        raiseVsBet: shrink(z.facingBetRaises, z.facingBetChances, prior.raiseVsBet, weight),
        foldToBet: shrink(z.facingBetFolds, z.facingBetChances, prior.foldToBet, weight),
    };
}

export type Situation = { stack: number, bb: number, tableAverage: number };

/**
 * A player's profile, for their CURRENT stack situation if given:
 * typical player -> this player overall -> this player in this situation.
 */
export function profile(id: string, name?: string, now?: Situation): Profile {
    const s = find(id, name);
    let f = frequencies(s?.overall, TYPICAL, PRIOR);
    let hands = s?.overall.hands ?? 0;
    let cls: StackClass | undefined;
    if (now) {
        cls = stackClassOf(now.stack, now.bb, now.tableAverage);
        const bucket = s?.byStack[cls];
        f = frequencies(bucket, f, SITUATION_PRIOR);
        hands = bucket?.hands ?? 0;
    }
    return {
        hands, stackClass: cls,
        style: Math.max(0.5, Math.min(2.5, f.vpip / TYPICAL.vpip)),
        vpip: f.vpip, pfr: f.pfr, threeBet: f.threeBet, aggression: f.aggression,
        raiseVsBet: f.raiseVsBet, foldToBet: f.foldToBet,
    };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * How much of a "fish" this player is, 0..1: plays far too many hands
 * (VPIP well above 30%), and mostly passively (limps and calls rather than
 * raising) or rarely folds to bets. These players pay off value bets and
 * don't fold to bluffs, so the best play against them is NOT balanced:
 * bet strong hands for value, bluff them less, and isolate them preflop.
 * A typical player scores 0; the loose-passive regulars in the first real log score ~0.8.
 */
export function fishScore(p: Profile): number {
    const vpip = p.vpip ?? p.style * TYPICAL.vpip;
    const loose = clamp01((vpip - 0.30) / 0.25);
    const passive = clamp01(1 - (p.pfr / Math.max(vpip, 0.01)) / 0.5);
    const sticky = clamp01((0.55 - p.foldToBet) / 0.3);
    return loose * (0.6 * passive + 0.4 * sticky);
}

export function style(id: string, name?: string, now?: Situation): number {
    return profile(id, name, now).style;
}

export function describe(id: string, name?: string): string {
    const s = find(id, name);
    if (!s || s.overall.hands < 0.5) return "no history";
    const pct = (x: number, n: number) => n >= 0.5 ? `${Math.round(100 * x / n)}%` : "-";
    const o = s.overall;
    let text = `${Math.round(o.hands)} hands, VPIP ${pct(o.vpip, o.hands)}, PFR ${pct(o.pfr, o.hands)}, ` +
        `3-bet ${pct(o.threeBets, o.threeBetChances)}, bets when checked to ${pct(o.checkedToBets, o.checkedToChances)}, ` +
        `folds to bets ${pct(o.facingBetFolds, o.facingBetChances)}`;
    const parts = (["short", "normal", "big"] as StackClass[])
        .filter(k => (s.byStack[k]?.hands ?? 0) >= 5)
        .map(k => `${k} stack: VPIP ${pct(s.byStack[k]!.vpip, s.byStack[k]!.hands)}`);
    if (parts.length > 1) text += ` (${parts.join(", ")})`;
    return text;
}

export function allPlayers(): PlayerStats[] {
    return Object.values(store.players).sort((a, b) => b.overall.hands - a.overall.hands);
}
