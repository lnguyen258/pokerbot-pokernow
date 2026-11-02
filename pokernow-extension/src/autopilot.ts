/**
 * Autopilot: auto-start. If the bot was on, it turns itself back on when a game
 * page (re)loads, so you don't press Start every time. You register and take
 * your seat yourself.
 */

export type AutopilotSettings = {
    autoStart: boolean,     // turn the bot on when a game page opens, if it was on before
};

export const DEFAULT_SETTINGS: AutopilotSettings = { autoStart: true };

export async function loadSettings(): Promise<AutopilotSettings & { botEnabled?: boolean }> {
    try {
        const s = await chrome.storage.local.get(["autopilot", "botEnabled"]);
        return { autoStart: s.autopilot?.autoStart ?? DEFAULT_SETTINGS.autoStart, botEnabled: s.botEnabled };
    }
    catch {
        return { ...DEFAULT_SETTINGS };
    }
}
