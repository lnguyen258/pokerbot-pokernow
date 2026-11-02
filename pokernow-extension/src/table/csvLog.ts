/**
 * Reads a PokerNow log download (poker_now_log_<game>.csv).
 * Columns: entry, at, order. Rows are newest first; "order" sorts them.
 */
import { HandLog, parseHand } from "./logReader";

export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else quoted = false;
            }
            else field += ch;
        }
        else if (ch === '"') quoted = true;
        else if (ch === ",") { row.push(field); field = ""; }
        else if (ch === "\n" || ch === "\r") {
            if (field || row.length) { row.push(field); rows.push(row); }
            field = ""; row = [];
            if (ch === "\r" && text[i + 1] === "\n") i++;
        }
        else field += ch;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
}

/** Every complete hand in the file, oldest first. */
export function handsFromCsv(text: string): HandLog[] {
    const rows = parseCsv(text);
    const header = rows[0]?.map(h => h.trim().toLowerCase()) ?? [];
    const entryCol = header.indexOf("entry"), orderCol = header.indexOf("order");
    if (entryCol < 0) throw new Error("not a PokerNow log (no 'entry' column)");

    const entries = rows.slice(1)
        .map((r, i) => ({ msg: r[entryCol], order: orderCol >= 0 ? Number(r[orderCol]) : -i }))
        .filter(e => e.msg)
        .sort((a, b) => a.order - b.order)
        .map(e => e.msg);

    const hands: string[][] = [];
    let current: string[] | null = null;
    for (const msg of entries) {
        if (msg.includes("starting hand #")) { current = []; hands.push(current); }
        if (current) current.push(msg);
        if (msg.includes("ending hand #")) current = null;
    }
    return hands.map(parseHand).filter(h => h.players.length >= 2);
}
