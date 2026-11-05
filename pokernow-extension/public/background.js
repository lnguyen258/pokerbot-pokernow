chrome.runtime.onInstalled.addListener((details) => {
    // Chrome only adds content scripts to pages opened AFTER an install or update.
    // Add the new bot to tables that are already open, so updating mid-game just works
    // (the old copy in the page sees the new one arrive and stops; see main.ts).
    if (details.reason === "install" || details.reason === "update") reinjectOpenTables();
});

async function reinjectOpenTables() {
    const scripts = chrome.runtime.getManifest().content_scripts ?? [];
    for (const cs of scripts) {
        const tabs = await chrome.tabs.query({ url: cs.matches }).catch(() => []);
        for (const tab of tabs) {
            if (tab.id === undefined || tab.discarded) continue;
            chrome.scripting.executeScript({ target: { tabId: tab.id }, files: cs.js })
                .then(() => console.log(`[update] bot added to tab ${tab.id} (${tab.url})`))
                .catch(err => console.warn(`[update] couldn't add the bot to tab ${tab.id}:`, err));
        }
    }
}

// Clicking the icon always opens popup.html (manifest default_popup). Nothing else runs on a click.
