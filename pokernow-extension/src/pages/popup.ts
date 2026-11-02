import { handsFromCsv } from "../table/csvLog";
import { addHand, allPlayers, describe, loadStats, saveStats } from "../table/stats";
import { DEFAULT_SETTINGS, loadSettings } from "../autopilot";

function sendMessageToTab(message: ChromeMessage, callback?: (response: any) => void) {
    chrome.tabs.query({ currentWindow: true, active: true }, (tabs) => {
        if (tabs.length === 0) {
            alert("No active tab found.");
            return;
        }

        const currentTab = tabs[0];
        const currentTabID = currentTab.id!;
        chrome.tabs.sendMessage(currentTabID, message, callback!);
    });
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

document.getElementById("start-bot")?.addEventListener("click", () => {
    chrome.tabs.query({ currentWindow: true, active: true }, (tabs) => {
        if (tabs.length === 0) {
            alert("No active tab found.");
            return;
        }

        const currentTab = tabs[0];
        const currentTabURL = currentTab.url || "";

        // Only on the sites this build was made for (sites.json -> manifest).
        if (!botSites().some(pattern => matchesPattern(pattern, currentTabURL))) {
            alert("The bot isn't set up for this website. Sites in this build:\n" + botSites().join("\n") +
                "\n\nAdd yours to sites.json and run npm run build.");
            return;
        }

        // If the URL is correct, send the message to start the bot
        sendMessageToTab("start_bot");
    });
});

document.getElementById("kill-bot")?.addEventListener("click", () => {
    sendMessageToTab("kill_bot");
});

setInterval(() => {
    sendMessageToTab("get_bot_status", (response) => {
        if (response) {
            document.getElementById("bot-status")!.textContent = `Bot status: ${response}`;
        }
    });
}, 500);

// Game type: tournament (ICM) or cash game (chip EV).
const gameTypeInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="game-type"]'));
chrome.storage.local.get("gameType", (saved) => {
    const type = saved.gameType === "cash" ? "cash" : "tournament";
    for (const input of gameTypeInputs) input.checked = input.value === type;
});
for (const input of gameTypeInputs)
    input.addEventListener("change", () => { if (input.checked) chrome.storage.local.set({ gameType: input.value }); });

// Shark mode: switches the bot's settings for tables of strong players.
const sharkMode = document.getElementById("shark-mode") as HTMLInputElement | null;
if (sharkMode) {
    chrome.storage.local.get("sharkMode", (saved) => { sharkMode.checked = !!saved.sharkMode; });
    sharkMode.addEventListener("change", () => chrome.storage.local.set({ sharkMode: sharkMode.checked }));
}

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

// Autopilot settings.
const autoStart = document.getElementById("auto-start") as HTMLInputElement | null;

loadSettings().then(s => {
    if (autoStart) autoStart.checked = s.autoStart;
});

autoStart?.addEventListener("change", () => chrome.storage.local.set({
    autopilot: { ...DEFAULT_SETTINGS, autoStart: autoStart.checked },
}));
