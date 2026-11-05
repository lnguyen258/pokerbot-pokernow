import { call, canCheck, check, fold, getMyStreetBet, getState, raise } from "./ui";

export function performAction(action: Action, callback: () => void) {
    if (action.type === "check_or_fold") {
        if (canCheck())
            check();
        else
            fold();

        callback?.();
    }
    else if (action.type === "call") {
        call();
        callback?.();
    }
    else {
        const preset = action.raiseAmount ?? "min";
        raise(preset, action.amount ?? presetAmount(preset), callback);
    }
}

/**
 * Presets without an exact amount (from the simple bots) are typed in too:
 * pot = raise to (current bet + the pot after our call), 1/2 pot = half that raise.
 * Min and all-in stay on their buttons (the page knows those exactly).
 */
function presetAmount(preset: RaiseAmount): number | undefined {
    if (preset !== "pot" && preset !== "1/2_pot") return undefined;
    try {
        const state = getState();
        const currentBet = getMyStreetBet() + state.toCall;
        const potAfterCall = state.pot + state.toCall;
        const extra = preset === "pot" ? potAfterCall : Math.round(potAfterCall / 2);
        const to = currentBet + Math.max(extra, state.bigBlind);
        return to >= getMyStreetBet() + state.stack ? undefined : to;
    }
    catch { return undefined; }
}

export function sanitizeAction(action: Action | undefined, state: State) {
    let sanitized = {...action!};

    switch (sanitized.type) {
        case "check_or_fold":
        case "call":
        case "raise":
            // ok, no problem here
            break;
        default:
            sanitized.type = "check_or_fold";
            break;
    }

    if (sanitized.type === "raise") {
        switch (sanitized.raiseAmount) {
            case "min":
            case "1/2_pot":
            // case "3/4_pot":
            case "pot":
            // case "overbet":
            case "all_in":
                // ok, no problem here
                break;
            default:
                sanitized.raiseAmount = "min";
                break;
        }
        if (sanitized.amount !== undefined && !(Number.isFinite(sanitized.amount) && sanitized.amount > 0))
            delete sanitized.amount;
        if (sanitized.amount !== undefined) sanitized.amount = Math.round(sanitized.amount);
    }

    return sanitized;
}
