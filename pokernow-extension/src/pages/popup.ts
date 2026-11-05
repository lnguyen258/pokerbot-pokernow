import { handsFromCsv } from "../table/csvLog";
import { addHand, allPlayers, describe, loadStats, saveStats } from "../table/stats";
import { DecisionRecord, HISTORY_KEY, historyText } from "../history";
import { GAMES_KEY, GameStore, splitByType, summarize } from "../table/gameRecords";

/**
 * Opening the popup only reads the bot's status. Nothing starts or stops unless a button is
 * clicked. No alert(): an alert closes the popup. Problems show in the status line instead.
 */
const statusBox = document.getElementById("bot-status")!;
function showStatus(text: string, kind: "playing" | "off" | "" = "") {
    statusBox.textContent = text;
    statusBox.className = kind;
}

function activeTab(): Promise<chrome.tabs.Tab | undefined> {
    return new Promise(resolve => chrome.tabs.query({ currentWindow: true, active: true }, tabs => resolve(tabs[0])));
}

/** Sends a message to the bot on the active tab. Resolves with its answer, or an explanation. */
async function askBot(message: ChromeMessage): Promise<{ ok: boolean, text: string }> {
    const tab = await activeTab();
    if (!tab?.id) return { ok: false, text: "No active tab" };
    // tab.url is only visible on the bot's sites (host permissions): anything else isn't a bot tab.
    if (!tab.url || !botSites().some(pattern => matchesPattern(pattern, tab.url!)))
        return { ok: false, text: "Not a PokerNow tab" };
    return new Promise(resolve => {
        chrome.tabs.sendMessage(tab.id!, message, (response) => {
            if (chrome.runtime.lastError || response === undefined)
                resolve({ ok: false, text: "Bot not loaded on this tab: reload the page (F5)" });
            else resolve({ ok: true, text: String(response) });
        });
    });
}

async function refreshStatus(message: ChromeMessage = "get_bot_status") {
    const r = await askBot(message);
    showStatus(r.ok ? `Bot: ${r.text}` : r.text, r.ok && r.text.startsWith("playing") ? "playing" : r.ok && r.text.startsWith("off") ? "off" : "");
}

/** The sites in the manifest (where Chrome injects the bot). */
function botSites(): string[] {
    return chrome.runtime.getManifest().content_scripts?.[0]?.matches ?? [];
}

/** Chrome match pattern check, e.g. "https://*.example.com/*" (a host without a port matches any port). */
function matchesPattern(pattern: string, url: string): boolean {
    const m = pattern.match(/^(\*|https?):\/\/([^/]+)(\/.*)$/);
    if (!m) return false;
    let u: URL;
    try { u = new URL(url); } catch { return false; }
    const [, scheme, host, path] = m;
    if (scheme === "*" ? !/^https?:$/.test(u.protocol) : u.protocol !== scheme + ":") return false;
    const [hostName, port] = host.split(":");
    const hostOk = hostName === "*" || u.hostname === hostName ||
        (hostName.startsWith("*.") && (u.hostname === hostName.slice(2) || u.hostname.endsWith(hostName.slice(1))));
    if (!hostOk || (port && port !== "*" && u.port !== port)) return false;
    const glob = new RegExp("^" + path.split("*").map(p => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    return glob.test(u.pathname + u.search);
}

document.getElementById("start-bot")?.addEventListener("click", () => refreshStatus("start_bot"));
document.getElementById("kill-bot")?.addEventListener("click", () => refreshStatus("kill_bot"));

document.getElementById("version")!.textContent = `v${chrome.runtime.getManifest().version}`;
refreshStatus();
setInterval(refreshStatus, 1000);

// Game type: tournament (ICM) or cash game (chip EV).
const gameTypeInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="game-type"]'));
chrome.storage.local.get("gameType", (saved) => {
    const type = saved.gameType === "cash" ? "cash" : "tournament";
    for (const input of gameTypeInputs) input.checked = input.value === type;
});
for (const input of gameTypeInputs)
    input.addEventListener("change", () => { if (input.checked) chrome.storage.local.set({ gameType: input.value }); });

// Shark mode: switches the bot's settings for tables of strong players. A warning shows while it's on.
const sharkMode = document.getElementById("shark-mode") as HTMLInputElement | null;
const sharkWarning = document.getElementById("shark-warning");
const showShark = (on: boolean) => { if (sharkWarning) sharkWarning.style.display = on ? "block" : "none"; };
if (sharkMode) {
    chrome.storage.local.get("sharkMode", (saved) => { sharkMode.checked = !!saved.sharkMode; showShark(!!saved.sharkMode); });
    sharkMode.addEventListener("change", () => { chrome.storage.local.set({ sharkMode: sharkMode.checked }); showShark(sharkMode.checked); });
}

// Recorded games (docs/LEARNING_PIPELINE.md): summary, download as JSON, clear.
const gamesSummary = document.getElementById("games-summary");
function showGames() {
    chrome.storage.local.get(GAMES_KEY, (saved) => {
        const games = (saved?.[GAMES_KEY] ?? {}) as GameStore;
        const s = summarize(games);
        const parts = Object.entries(splitByType(games)).map(([t, g]) => `${t} ${summarize(g!).hands}`);
        if (gamesSummary) gamesSummary.textContent = `${s.games} games, ${s.hands} hands (${s.clean} clean)` +
            (parts.length ? ` - ${parts.join(", ")}` : "");
    });
}
showGames();
setInterval(showGames, 3000);
// One file per game type (cash and tournament are analysed separately).
document.getElementById("download-games")?.addEventListener("click", () => {
    chrome.storage.local.get(GAMES_KEY, (saved) => {
        const byType = splitByType((saved?.[GAMES_KEY] ?? {}) as GameStore);
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
        Object.entries(byType).forEach(([type, games], i) => {
            const blob = new Blob([JSON.stringify({ exportedAt: Date.now(), version: chrome.runtime.getManifest().version, gameType: type, games }, null, 1)],
                { type: "application/json" });
            setTimeout(() => {
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `pokerbot-games-${type}-${stamp}.json`;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
            }, i * 300);
        });
    });
});
// Clear: no confirm() (dialogs can close the popup): click twice within 3 s.
const clearButton = document.getElementById("clear-games") as HTMLButtonElement | null;
let clearArmed = false;
clearButton?.addEventListener("click", () => {
    if (!clearArmed) {
        clearArmed = true;
        clearButton.textContent = "Click again to delete";
        setTimeout(() => { clearArmed = false; clearButton.textContent = "Clear"; }, 3000);
        return;
    }
    clearArmed = false;
    clearButton.textContent = "Clear";
    chrome.storage.local.remove(GAMES_KEY, showGames);
});

// Recent decisions (written by the bot, src/history.ts): newest first, with a Copy button.
let history: DecisionRecord[] = [];
const historyBox = document.getElementById("history");
function showHistory() {
    chrome.storage.local.get(HISTORY_KEY, (saved) => {
        history = Array.isArray(saved?.[HISTORY_KEY]) ? saved[HISTORY_KEY] : [];
        if (!historyBox) return;
        historyBox.innerHTML = "";
        if (!history.length) { historyBox.textContent = "No decisions yet."; return; }
        for (const r of history) {
            const row = document.createElement("div");
            const head = document.createElement("div");
            head.textContent = `${new Date(r.at).toLocaleTimeString()}  ${r.hand}${r.board ? " on " + r.board : ""}  -> ${r.action}`;
            const why = document.createElement("div");
            why.className = "why";
            why.textContent = r.why.length > 180 ? r.why.slice(0, 180) + "..." : r.why;
            row.append(head, why);
            historyBox.appendChild(row);
        }
    });
}
showHistory();
setInterval(showHistory, 2000);
const copyButton = document.getElementById("copy-history") as HTMLButtonElement | null;
copyButton?.addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(historyText(history) || "No decisions yet.");
        copyButton.textContent = "Copied";
    }
    catch { copyButton.textContent = "Copy failed"; }
    setTimeout(() => { copyButton.textContent = "Copy"; }, 1500);
});

// Import past PokerNow logs into the opponent profiles.
const importInput = document.getElementById("import-logs") as HTMLInputElement | null;
const importStatus = document.getElementById("import-status");
const profilesBox = document.getElementById("profiles");

function showProfiles() {
    if (!profilesBox) return;
    profilesBox.innerHTML = "";
    for (const p of allPlayers().slice(0, 25)) {
        const row = document.createElement("div");
        row.textContent = `${p.name}: ${describe("", p.name)}${p.shown.length ? `, ${p.shown.length} hands shown` : ""}`;
        profilesBox.appendChild(row);
    }
}

loadStats(true).then(showProfiles);

importInput?.addEventListener("change", async () => {
    await loadStats(true);
    let added = 0, duplicates = 0;
    const errors: string[] = [];
    for (const file of Array.from(importInput.files ?? [])) {
        try {
            for (const hand of handsFromCsv(await file.text())) {
                if (addHand(hand)) added++; else duplicates++;
            }
        }
        catch (err) {
            errors.push(`${file.name}: ${err}`);
        }
    }
    await saveStats();
    if (importStatus)
        importStatus.textContent = `Imported ${added} new hands` +
            (duplicates ? ` (${duplicates} already counted)` : "") +
            (errors.length ? "\n" + errors.join("\n") : "");
    showProfiles();
    importInput.value = "";
});
