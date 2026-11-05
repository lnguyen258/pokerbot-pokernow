import { getAction, lastBrain } from "./ai/ai";
import { getBigBlindValue, getState, isMyTurn, showHandIfPossible } from "./ui";
import { performAction, sanitizeAction } from "./action";
import { noteStrength, remainingWait, thinkTime } from "./timing";
import { lastDecision } from "./ai/smartBrain";
import { DecisionRecord, actionText, cardText, recordDecision } from "./history";
import { HandRecorder, RecordedHand, toHandLog } from "./table/recorder";
import { readSnapshot } from "./table/tableSnapshot";
import { saveHand } from "./table/gameRecords";
import { addHand, loadStats, saveStats } from "./table/stats";

const timeoutMs = 500;
let botLoopTimeout: NodeJS.Timer | undefined;
let running = false;

console.log(`"pokerbot v${chrome.runtime.getManifest().version}"`);

/**
 * Updating the extension mid-game: Chrome cuts the old copy of this script off from
 * the extension (settings and storage stop working) but leaves its timers running, and
 * background.js adds a fresh copy to the page. The fresh copy announces itself on the
 * page; the old one hears it and stops, so only one bot ever clicks.
 */
const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
document.dispatchEvent(new CustomEvent("pokerbot-takeover", { detail: instanceId }));

/** False once this copy is cut off from the extension (it was updated, reloaded or removed). */
function extensionAlive() {
    try { return !!chrome.runtime?.id; } catch { return false; }
}

let retired = false;                           // replaced or cut off: this copy never starts again

function retire(why: string) {
    if (running) console.log(`[update] ${why}: this old copy of the bot stops`);
    retired = true;
    stopBotLoop();
}

let busy = false;                              // deciding or waiting on the current turn
let busySince = 0;
let lastActed = 0;                             // the page needs a moment to clear our turn after a click
let turnWatcher: MutationObserver | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;

/**
 * Why the bot is off on this page. "killed": the user pressed Kill (lasts until Start or a
 * page reload). "other-tab": a newer bot took this game in another tab. Neither auto-starts.
 */
let offReason: "" | "killed" | "other-tab" = "";

function startBotLoop() {
    stopBotLoop();
    running = true;
    offReason = "";
    claimGame();

    console.log("starting bot");
    try { console.log("big blind: " + getBigBlindValue()); } catch { /* table not drawn yet */ }

    const next = () => {                       // poll again soon (fallback to the watcher below)
        busy = false;
        if (running) botLoopTimeout = setTimeout(botLoop, timeoutMs);
    };

    async function botLoop() {
        if (!running) return;
        if (!extensionAlive()) { retire("extension was updated or reloaded"); return; }
        if (busy && Date.now() - busySince < 8000) return;     // (a stuck turn resets after 8 s)
        clearTimeout(botLoopTimeout);
        try {
            if (!isMyTurn() || Date.now() - lastActed < 1000) {
                showHandIfPossible();
                next();
                return;
            }
            busy = true;
            busySince = Date.now();
            await playTurn();
        }
        catch (err) {
            // Never let one bad read stop the bot (e.g. the turn shows before the cards are drawn).
            console.error("bot loop error, trying again:", err);
            next();
        }
    }

    async function playTurn() {
        console.log("bot turn");
        const turnSeen = Date.now();

        const state = getState();
        console.log("state: ", state);

        let action: Action | undefined;
        noteStrength(0.5);                     // brains overwrite this with the real hand strength

        try {
            action = await getAction(state);
            console.log("bot action:", action);
        }
        catch (err) {
            action = undefined;
            console.error("bot error:", err);
        }

        const sanitizedAction = sanitizeAction(action, state);
        console.log("sanitized bot action:", sanitizedAction);
        // Decision history for the popup (never throws, not awaited).
        try {
            const rec: DecisionRecord = {
                at: Date.now(),
                hand: (state.hand ?? []).map(cardText).join(" "),
                board: (state.board ?? []).map(cardText).join(" "),
                action: actionText(sanitizedAction),
                why: lastBrain === "smart brain" && lastDecision ? lastDecision : lastBrain,
            };
            recordDecision(rec);
            recorder?.attachDecision(rec);                  // attach to the hand it belongs to
        }
        catch { /* history is optional */ }

        const wait = thinkTime(sanitizedAction, state);
        const spent = Date.now() - turnSeen;           // time already used deciding
        const waitMs = remainingWait(wait.ms, spent);
        console.log(`[timing] think ${(wait.ms / 1000).toFixed(1)}s (${wait.why}), ` +
            `decided in ${(spent / 1000).toFixed(1)}s, waiting ${(waitMs / 1000).toFixed(1)}s more`);
        if (!running) { busy = false; return; }
        botLoopTimeout = setTimeout(() => {
            try {
                if (!running) { busy = false; return; }
                if (!extensionAlive()) { retire("extension was updated or reloaded"); return; }
                if (!isMyTurn()) { next(); return; }   // turn ended while waiting (e.g. timer)
                console.log(`[timing] acting ${((Date.now() - turnSeen) / 1000).toFixed(1)}s after the turn started`);
                lastActed = Date.now();
                performAction(sanitizedAction, next);
            }
            catch (err) { console.error("bot click error:", err); next(); }
        }, waitMs);
    }

    // Chrome slows timers in covered or background tabs (down to once a minute), so the
    // 0.5 s poll alone can miss a turn. Page changes still arrive: react to them directly.
    turnWatcher = new MutationObserver(() => {
        if (running && !busy && isMyTurn()) botLoop();
    });
    // Safety net: check once a second whatever happened (botLoop ignores it while a turn is in progress).
    heartbeat = setInterval(botLoop, 1000);
    turnWatcher.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

    botLoop();
}

function stopBotLoop() {
    running = false;
    busy = false;
    clearTimeout(botLoopTimeout);
    botLoopTimeout = undefined;
    turnWatcher?.disconnect();
    turnWatcher = undefined;
    clearInterval(heartbeat);
    heartbeat = undefined;
}

// A newer copy was added to this page (extension updated): stop this one.
document.addEventListener("pokerbot-takeover", (e) => {
    if ((e as CustomEvent).detail !== instanceId) retire("a newer version took over");
});

/** PokerNow game pages are /games/<id>. On other sites from sites.json, every page counts. */
const onPokerNow = /(^|\.)pokernow\.(club|com)$/i.test(location.hostname);
function gameKey(): string | null {
    if (!onPokerNow) return location.host + location.pathname;
    const m = location.pathname.match(/^\/games\/([^/]+)/);
    return m ? `${location.host}/games/${m[1]}` : null;
}

/**
 * One bot per game. The newest bot (latest page load or Start) writes itself to storage;
 * an older bot in another tab on the same game sees that and stops for good.
 */
function claimGame() {
    const game = gameKey();
    if (!game) return;
    try { chrome.storage.local.set({ activeBot: { game, id: instanceId, at: Date.now() } }).catch(() => {}); }
    catch { /* extension reloaded: storage gone */ }
}

try {
    chrome.storage.onChanged.addListener((changes, area) => {
        const claim = changes.activeBot?.newValue;
        if (area !== "local" || !claim || claim.id === instanceId || claim.game !== gameKey()) return;
        if (running) console.log("[one bot] this game was opened in another tab: this bot stops");
        stopBotLoop();
        offReason = "other-tab";
    });
}
catch { /* storage unavailable */ }

// Registered before anything else can fail, so the popup always gets an answer.
chrome.runtime.onMessage.addListener((message: ChromeMessage, sender, callback) => {
    if (retired) return;                       // an old copy: let the new one answer
    switch (message) {
        case "start_bot":
            console.log("[popup] start");
            startBotLoop();
            callback(status());
            break;
        case "kill_bot":
            console.log("[popup] kill: off until Start or a page reload");
            stopBotLoop();
            offReason = "killed";
            callback(status());
            break;
        case "get_bot_status":
            callback(status());
            break;
    }
});

/**
 * Hand recorder (docs/LEARNING_PIPELINE.md): on game pages, whether the bot is on or not, a snapshot
 * of the table on every change and once a second. Finished hands are saved; clean ones also update
 * the opponent profiles. Wrapped so it can never stop the bot.
 */
let recorder: HandRecorder | null = null;
let recordPending = false;
function recordTick() {
    recordPending = false;
    try {
        if (retired || !extensionAlive()) return;
        const game = gameKey();
        if (!game) return;
        if (!recorder || recorder.game !== game) recorder = new HandRecorder(game);
        const done = recorder.observe(readSnapshot());
        if (done) onHandRecorded(done);
    }
    catch (err) { console.warn("[recorder] skipped a snapshot:", err); }
}
function onHandRecorded(h: RecordedHand) {
    console.log(`[recorder] hand ${h.number} saved: ${h.actions.length} actions, ` +
        (h.complete ? "clean (learning from it)" : `not clean (${h.notes.join("; ")})`));
    saveHand(h);
    if (h.complete)
        loadStats().then(() => { if (addHand(toHandLog(h))) return saveStats(); }).catch(() => {});
}
setInterval(recordTick, 1000);
try {
    new MutationObserver(() => {
        if (!recordPending) { recordPending = true; setTimeout(recordTick, 150); }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
}
catch { /* no page body: the 1 s tick still runs */ }

/**
 * Auto-start: on a game page the bot is always on, unless it was killed here or another
 * tab took the game. Checked every second because PokerNow can switch from the lobby to
 * a game without reloading the page.
 */
function autoStart() {
    if (running || retired || offReason || !extensionAlive() || !gameKey()) return;
    console.log(`[autostart] game page: starting (${gameKey()})`);
    try { startBotLoop(); }
    catch (err) { console.error("[autostart] couldn't start yet, trying again in 1 s:", err); stopBotLoop(); }
}
setInterval(autoStart, 1000);
setTimeout(autoStart, 0);

/**
 * Helper extension hook (your own site only, never PokerNow): the "Bot Table Helper"
 * extension starts and stops the bot with page events. Content scripts of two extensions
 * share the page, so a CustomEvent on `document` reaches us; detail is a plain string.
 *   in:  "pokerbot-helper" with detail "start" | "stop" | "ping"
 *   out: "pokerbot-status" with detail "running" | "off"
 */
if (!onPokerNow) {
    const reply = () => document.dispatchEvent(new CustomEvent("pokerbot-status", { detail: running ? "running" : "off" }));
    document.addEventListener("pokerbot-helper", (e) => {
        const command = (e as CustomEvent).detail;
        if (command === "start" && !running) { console.log("[helper] start"); startBotLoop(); }
        else if (command === "stop" && running) { console.log("[helper] stop"); stopBotLoop(); offReason = "killed"; }
        reply();
    });
}

function status(): BotStatus {
    if (running) return `playing${lastBrain ? `, last decision: ${lastBrain}` : ""}`;
    if (offReason === "killed") return "off: killed (press Start, or reload the page)";
    if (offReason === "other-tab") return "off: this game is open in another tab, the bot plays there";
    if (!gameKey()) return "waiting: not a game page";
    return "starting...";
}
