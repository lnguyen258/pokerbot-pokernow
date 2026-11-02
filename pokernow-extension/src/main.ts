import { getAction, lastBrain } from "./ai/ai";
import { getBigBlindValue, getState, isMyTurn, showHandIfPossible } from "./ui";
import { performAction, sanitizeAction } from "./action";
import { noteStrength, remainingWait, thinkTime } from "./timing";
import { loadSettings } from "./autopilot";


const timeoutMs = 500;
let botLoopTimeout: NodeJS.Timer | undefined;
let running = false;

console.log(`"pokerbot v${chrome.runtime.getManifest().version}"`);

let busy = false;                              // deciding or waiting on the current turn
let busySince = 0;
let lastActed = 0;                             // the page needs a moment to clear our turn after a click
let turnWatcher: MutationObserver | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;

function startBotLoop() {
    stopBotLoop();
    running = true;
    chrome.storage.local.set({ botEnabled: true }).catch(() => {});

    console.log("starting bot");
    console.log("big blind: " + getBigBlindValue());

    const next = () => {                       // poll again soon (fallback to the watcher below)
        busy = false;
        if (running) botLoopTimeout = setTimeout(botLoop, timeoutMs);
    };

    async function botLoop() {
        if (!running) return;
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

        const wait = thinkTime(sanitizedAction, state);
        const spent = Date.now() - turnSeen;           // time already used deciding
        const waitMs = remainingWait(wait.ms, spent);
        console.log(`[timing] think ${(wait.ms / 1000).toFixed(1)}s (${wait.why}), ` +
            `decided in ${(spent / 1000).toFixed(1)}s, waiting ${(waitMs / 1000).toFixed(1)}s more`);
        if (!running) { busy = false; return; }
        botLoopTimeout = setTimeout(() => {
            try {
                if (!running) { busy = false; return; }
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

// Auto-start: if the bot was on when this page last closed, turn it back on.
loadSettings().then(s => {
    if (s.autoStart && s.botEnabled) {
        console.log("[autopilot] bot was on before: starting automatically");
        startBotLoop();
    }
});

/**
 * Helper extension hook (your own site only, never PokerNow): the "Bot Table Helper"
 * extension starts and stops the bot with page events. Content scripts of two extensions
 * share the page, so a CustomEvent on `document` reaches us; detail is a plain string.
 *   in:  "pokerbot-helper" with detail "start" | "stop" | "ping"
 *   out: "pokerbot-status" with detail "running" | "off"
 */
if (!/(^|\.)pokernow\.(club|com)$/i.test(location.hostname)) {
    const reply = () => document.dispatchEvent(new CustomEvent("pokerbot-status", { detail: running ? "running" : "off" }));
    document.addEventListener("pokerbot-helper", (e) => {
        const command = (e as CustomEvent).detail;
        if (command === "start" && !running) { console.log("[helper] start"); startBotLoop(); }
        else if (command === "stop" && running) { console.log("[helper] stop"); stopBotLoop(); chrome.storage.local.set({ botEnabled: false }).catch(() => {}); }
        reply();
    });
}

chrome.runtime.onMessage.addListener((message: ChromeMessage, sender, callback) => {
    switch (message) {
        case "start_bot":
            startBotLoop();
            break;
        case "kill_bot":
            stopBotLoop();
            chrome.storage.local.set({ botEnabled: false }).catch(() => {});
            break;
        case "get_bot_status":
            let status: BotStatus = running ? `playing, last decision: ${lastBrain}` : "off";
            callback(status);
            break;
    }
});
