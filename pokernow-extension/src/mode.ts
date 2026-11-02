/**
 * Playing modes: "normal" (the default, tuned for beginners and fish) and
 * "shark" (for tables of strong players), switched from the popup.
 */
import { CONFIG, SHARK_MODE } from "./config";

export type Mode = "normal" | "shark";

const NORMAL = { tuning: { ...CONFIG.tuning }, population: { ...CONFIG.population } };
let current: Mode = "normal";

export function setMode(mode: Mode) {
    const shark = mode === "shark";
    Object.assign(CONFIG.tuning, NORMAL.tuning, shark ? SHARK_MODE.tuning : {});
    Object.assign(CONFIG.population, NORMAL.population, shark ? SHARK_MODE.population : {});
    if (mode !== current) console.log(`[mode] switched to ${mode} mode`);
    current = mode;
}

export type GameType = "tournament" | "cash";

/** Tournament (ICM: chips worth points) or cash game (chips are money). */
export function setGameType(type: GameType) {
    if (type !== CONFIG.gameType) console.log(`[mode] game type: ${type}`);
    CONFIG.gameType = type;
}

/** Reads the popup settings (playing mode and game type) and applies them. */
export async function loadMode(): Promise<Mode> {
    let mode: Mode = "normal";
    let type: GameType = CONFIG.gameType;
    try {
        const s = await chrome.storage.local.get(["sharkMode", "gameType"]);
        mode = s.sharkMode ? "shark" : "normal";
        if (s.gameType === "cash" || s.gameType === "tournament") type = s.gameType;
    }
    catch { /* storage unavailable: defaults */ }
    setMode(mode);
    setGameType(type);
    return mode;
}
