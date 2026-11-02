/**
 * Parses PokerNow game-log lines into a hand history (HandLog).
 *
 * The live bot does NOT download any log: its only input is the screen (table/screenReader.ts
 * builds a HandLog from the page). This parser is used to import past CSV logs in the popup,
 * by the tests, and for the HandLog type. Lines look like:
 *   -- starting hand #12 (id: abc) ... (dealer: "Bob @ x9") --
 *   Player stacks: #1 "Alice @ a1" (1000) | #4 "Bob @ x9" (2600)
 *   "Alice @ a1" posts a small blind of 100
 *   "Bob @ x9" raises to 600
 *   Flop:  [A♠, 7♣, 2♦]
 */
export type Street = "preflop" | "flop" | "turn" | "river";
export type ActionKind = "sb" | "bb" | "ante" | "straddle" | "fold" | "check" | "call" | "bet" | "raise";

export type LogAction = {
    id: string,
    street: Street,
    kind: ActionKind,
    /** For call/bet/raise/blinds: the player's total bet on this street afterwards. For ante: the ante. */
    amount: number,
    allIn: boolean,
};

export type LogPlayer = { id: string, name: string, seat: number, stack: number };

export type HandLog = {
    handNumber: number,
    street: Street,                // the street the board is on now (even before anyone acts)
    handId?: string,               // PokerNow's unique id for the hand
    myCards?: string,              // "Your hand is K♦, J♦" (only in your own log)
    dealerId?: string,
    players: LogPlayer[],          // stacks at the start of the hand
    actions: LogAction[],
    shown: { id: string, cards: string }[],
    collected: { id: string, amount: number }[],   // pots won and uncalled bets returned
};

const PLAYER_LINE = /^"(.+?) @ ([^"]+)"\s+(.*)$/;
const STACKS = /#(\d+)\s+"(.+?) @ ([^"]+)"\s+\(([\d.,]+)\)/g;

function num(s: string) {
    return parseFloat(s.replace(/,/g, ""));
}

/** Messages of the latest hand, oldest first. Input is newest first, as the API returns it. */
export function currentHandMessages(newestFirst: string[]): string[] {
    const out: string[] = [];
    for (const m of newestFirst) {
        out.push(m);
        if (m.includes("starting hand #")) break;
    }
    return out.reverse();
}

export function parseHand(msgs: string[]): HandLog {
    const log: HandLog = { handNumber: 0, street: "preflop", players: [], actions: [], shown: [], collected: [] };
    let street: Street = "preflop";

    for (const raw of msgs) {
        const m = raw.trim();
        const start = m.match(/starting hand #(\d+)/);
        if (start) {
            log.handNumber = parseInt(start[1]);
            log.dealerId = m.match(/dealer: "(?:.+?) @ ([^"]+)"/)?.[1];
            log.handId = m.match(/\(id: ([^)]+)\)/)?.[1];
            continue;
        }
        if (m.startsWith("Your hand is ")) {
            log.myCards = m.slice("Your hand is ".length);
            continue;
        }
        if (m.startsWith("Player stacks:")) {
            for (const s of m.matchAll(STACKS))
                log.players.push({ seat: parseInt(s[1]), name: s[2], id: s[3], stack: num(s[4]) });
            continue;
        }
        const st = m.match(/^(Flop|Turn|River)\b/i);
        if (st) {
            street = st[1].toLowerCase() as Street;
            log.street = street;
            continue;
        }
        const returned = m.match(/^Uncalled bet of ([\d.,]+) returned to "(?:.+?) @ ([^"]+)"/);
        if (returned) {
            log.collected.push({ id: returned[2], amount: num(returned[1]) });
            continue;
        }
        const p = m.match(PLAYER_LINE);
        if (!p) continue;
        const id = p[2], rest = p[3];
        const allIn = /all in/i.test(rest);
        const amount = (re: RegExp) => num(rest.match(re)![1]);
        let kind: ActionKind | undefined, value = 0;

        if (/^posts a small blind of/.test(rest)) { kind = "sb"; value = amount(/of ([\d.,]+)/); }
        else if (/^posts a big blind of/.test(rest)) { kind = "bb"; value = amount(/of ([\d.,]+)/); }
        else if (/^posts an? ante of/.test(rest)) { kind = "ante"; value = amount(/of ([\d.,]+)/); }
        else if (/^posts a straddle of/.test(rest)) { kind = "straddle"; value = amount(/of ([\d.,]+)/); }
        else if (/^folds/.test(rest)) kind = "fold";
        else if (/^checks/.test(rest)) kind = "check";
        else if (/^calls/.test(rest)) { kind = "call"; value = amount(/calls ([\d.,]+)/); }
        else if (/^bets/.test(rest)) { kind = "bet"; value = amount(/bets ([\d.,]+)/); }
        else if (/^raises to/.test(rest)) { kind = "raise"; value = amount(/raises to ([\d.,]+)/); }
        else if (/^collected/.test(rest)) log.collected.push({ id, amount: amount(/collected ([\d.,]+)/) });
        else if (/^shows a /.test(rest)) log.shown.push({ id, cards: rest.replace(/^shows a /, "").replace(/\.$/, "") });

        if (kind)
            log.actions.push({ id, street, kind, amount: value, allIn });
    }
    return log;
}
