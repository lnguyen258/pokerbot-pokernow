/**
 * Recorded games in chrome.storage (docs/LEARNING_PIPELINE.md). Never throws.
 *   gameRecords: { [game]: { game, firstAt, lastAt, hands: RecordedHand[] } }
 */
import type { RecordedHand } from "./recorder";

export const GAMES_KEY = "gameRecords";
export const MAX_GAMES = 50;
export const MAX_HANDS_PER_GAME = 600;

export type GameRecord = { game: string, firstAt: number, lastAt: number, hands: RecordedHand[] };
export type GameStore = Record<string, GameRecord>;

let queue: Promise<void> = Promise.resolve();

/** Adds a finished hand to its game (saves one at a time, in order). */
export function saveHand(h: RecordedHand): Promise<void> {
    queue = queue.then(async () => {
        try {
            const saved = await chrome.storage.local.get(GAMES_KEY);
            const games: GameStore = saved[GAMES_KEY] && typeof saved[GAMES_KEY] === "object" ? saved[GAMES_KEY] : {};
            const g = games[h.game] ??= { game: h.game, firstAt: h.startedAt, lastAt: h.endedAt, hands: [] };
            g.hands.push(h);
            if (g.hands.length > MAX_HANDS_PER_GAME) g.hands.splice(0, g.hands.length - MAX_HANDS_PER_GAME);
            g.lastAt = h.endedAt;
            const keep = Object.values(games).sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_GAMES);
            await chrome.storage.local.set({ [GAMES_KEY]: Object.fromEntries(keep.map(x => [x.game, x])) });
        }
        catch { /* storage unavailable: skip */ }
    });
    return queue;
}

export type RecordType = "tournament" | "cash" | "untagged";

/**
 * Splits the store by game type (cash and tournament are separate bots, analysed separately).
 * Hands recorded before v1.15.1 have no type: they go to "untagged". Empty types are left out.
 */
export function splitByType(games: GameStore): Partial<Record<RecordType, GameStore>> {
    const out: Partial<Record<RecordType, GameStore>> = {};
    for (const g of Object.values(games ?? {})) {
        for (const h of g.hands) {
            const t: RecordType = h.gameType ?? "untagged";
            const store = out[t] ??= {};
            (store[g.game] ??= { ...g, hands: [] }).hands.push(h);
        }
    }
    return out;
}

export function summarize(games: GameStore) {
    const list = Object.values(games ?? {});
    const hands = list.reduce((a, g) => a + g.hands.length, 0);
    const clean = list.reduce((a, g) => a + g.hands.filter(h => h.complete).length, 0);
    return { games: list.length, hands, clean };
}
