/**
 * The bot's last decisions, kept in chrome.storage so the popup can show them and copy them
 * (for reviewing hands without opening the console). Never throws: history is optional.
 */
export type DecisionRecord = {
    at: number,            // time (ms)
    hand: string,          // e.g. "K♥ 9♦"
    board: string,         // e.g. "Q♠ 7♦ 2♣" or ""
    action: string,        // e.g. "raise to 600", "call", "fold"
    why: string,           // the brain's reason line, e.g. "[full 8p] [preflop] ..."
};

export const HISTORY_KEY = "recentDecisions";
export const HISTORY_SIZE = 15;

const SUITS: Record<string, string> = { c: "♣", d: "♦", h: "♥", s: "♠" };
export function cardText(c: Card | undefined): string {
    if (!c) return "?";
    const v = c.value?.name ?? "?";
    return `${v === "10" ? "T" : v}${SUITS[c.suit as string] ?? c.suit ?? ""}`;
}

export function actionText(a: Action | undefined): string {
    if (!a) return "none";
    if (a.type === "check_or_fold") return "check/fold";
    if (a.type === "call") return "call";
    if (a.amount !== undefined) return `raise to ${a.amount}`;
    return `raise (${a.raiseAmount ?? "?"})`;
}

export async function recordDecision(r: DecisionRecord): Promise<void> {
    try {
        const saved = await chrome.storage.local.get(HISTORY_KEY);
        const list: DecisionRecord[] = Array.isArray(saved[HISTORY_KEY]) ? saved[HISTORY_KEY] : [];
        list.unshift(r);
        await chrome.storage.local.set({ [HISTORY_KEY]: list.slice(0, HISTORY_SIZE) });
    }
    catch { /* extension reloaded or storage unavailable: skip */ }
}

/** Plain text of the records, newest first, for copying into a message. */
export function historyText(list: DecisionRecord[]): string {
    return list.map(r => `${new Date(r.at).toLocaleTimeString()} | ${r.hand}${r.board ? ` on ${r.board}` : ""} | ${r.action}\n  ${r.why}`).join("\n");
}
