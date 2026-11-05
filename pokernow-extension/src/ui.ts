import { cardValueCodeFromName, isCardValueCodeValid } from "./cards";
import { parseHandRank } from "./rank";
import { getPhaseFromBoardLength } from "./state";

export function isMyTurn() {
    return document.querySelector(".action-signal") !== null;
}

export function parseCard(element: Element): Card {
    if (!element)
        throw new Error("can't parse card from null element");

    const rawValue = element.querySelector(".value")?.textContent;
    const rawSuit = element.querySelector(".suit")?.textContent;

    if (!rawValue || !rawSuit)
        throw new Error("can't find value or suit in card element");

    const valueName = rawValue as CardValueName;
    const valueCode = cardValueCodeFromName(valueName);

    if (!isCardValueCodeValid(valueCode))
        throw new Error("invalid card value code: " + rawValue);

    return {
        value: {
            name: valueName,
            code: valueCode,
        },
        suit: rawSuit as CardSuit,
    };
}

export function getHandCards() {
    const cards = document.querySelectorAll(".you-player .card");

    try {
        const firstCard = parseCard(cards[0]);
        const secondCard = parseCard(cards[1]);
        return [firstCard, secondCard];
    }
    catch (err) {
        throw new Error("error parsing hand cards: " + err);
    }
}

export function getBoardCards() {
    const cards = [...document.querySelectorAll(".table-cards .card")];

    try {
        return cards.map(parseCard);
    }
    catch (err) {
        throw new Error("error parsing board cards: " + err);
    }
}

export function getBigBlindValue() {
    return parseInt(document.querySelectorAll(".blind-value .chips-value")[1].textContent ?? "");
}

export function getToCallValue() {
    const callText = (document.querySelector("button.call")?.textContent ?? "").toLowerCase();
    // "Call 1,909" -> 1909 (thousands separators allowed).
    const m = callText.match(/call\s*([\d,.]+)/);
    const fromButton = m ? parseFloat(m[1].replace(/,/g, "")) : 0;
    if (fromButton > 0) return fromButton;

    // v1.15.6: when calling puts us all-in, the button shows no "Call <amount>", and the bot read
    // "nothing to call": its check became a fold (two pair with 77% equity vs an all-in, real game).
    // If we can't check, take the price from the table: biggest bet minus ours, up to our stack.
    const checkButton = document.querySelector<HTMLButtonElement>("button.check");
    if (checkButton && !checkButton.disabled) return 0;
    return toCallFromTable();
}

/** Biggest bet in front of another player minus ours, capped at our stack (0 if unreadable). */
function toCallFromTable(): number {
    const num = (el: Element | null | undefined) => {
        const v = parseFloat((el?.textContent ?? "").replace(/[^\d.]/g, ""));
        return isNaN(v) ? 0 : v;
    };
    const betOf = (el: Element) => num(el.querySelector(".table-player-bet-value .chips-value") ?? el.querySelector(".table-player-bet-value"));
    const players = Array.from(document.querySelectorAll(".table-player"));
    const me = players.find(el => el.classList.contains("you-player"));
    if (!me) return 0;
    const top = Math.max(0, ...players.filter(el => el !== me).map(betOf));
    const stack = num(me.querySelector(".table-player-stack .chips-value") ?? me.querySelector(".table-player-stack"));
    const owed = top - betOf(me);
    return owed > 0 ? (stack > 0 ? Math.min(owed, stack) : owed) : 0;
}

export function getHandRank() {
    const rawRank = document.querySelector(".player-hand-message")?.textContent ?? "";
    return parseHandRank(rawRank);
}

export function getPhase() {
    const boardCardsElements = document.querySelectorAll(".table-cards .card");
    return getPhaseFromBoardLength(boardCardsElements.length);
}

export function getStack() {
    const stackText = document.querySelector(".table-player.you-player .table-player-stack")?.textContent;
    return parseInt(stackText ?? "0");
}

export function getTotalPot() {
    const potText = document.querySelector(".table-pot-size .add-on .chips-value")?.textContent;
    return parseInt(potText ?? "0");
}

export function getPrevPhasePot() {
    const prevPotText = document.querySelector(".table-pot-size .main-value .chips-value")?.textContent;
    return parseInt(prevPotText ?? "0");
}

/**
 * Counts other seated players who still have cards. PokerNow's class names
 * here are a guess, so check the "opponents" number in the console logs.
 */
export function getOpponentCount() {
    const others = [...document.querySelectorAll(".table-player")]
        .filter(p => !p.classList.contains("you-player"));
    const inHand = others.filter(p => {
        if (/fold|standing|away|offline|empty|disconnected/i.test(p.className))
            return false;
        return p.querySelector(".card") !== null || p.querySelector(".table-player-cards") !== null;
    });
    const count = inHand.length || others.length;
    return Math.min(Math.max(count, 1), 9);
}

export function getState(): State {
    const hand = getHandCards();
    const board = getBoardCards();

    return {
        phase: getPhase(),
        handRank: getHandRank(),
        hand,
        board,
        handPlusBoard: [...hand, ...board],
        bigBlind: getBigBlindValue(),
        stack: getStack(),
        pot: getTotalPot(),
        prevPhasePot: getPrevPhasePot(),
        toCall: getToCallValue(),
        opponents: getOpponentCount(),
    };
}

export function canCheck() {
    return !document.querySelector<HTMLButtonElement>("button.check")?.disabled;
}

export function check() {
    document.querySelector<HTMLButtonElement>("button.check")?.click();
}

export function fold() {
    document.querySelector<HTMLButtonElement>("button.fold")?.click();
}

export function call() {
    document.querySelector<HTMLButtonElement>("button.call")?.click();
}

/** Chips we already have in front of us on this street. */
export function getMyStreetBet() {
    const el = document.querySelector(".you-player .table-player-bet-value .chips-value")
        ?? document.querySelector(".you-player .table-player-bet-value");
    return parseInt(el?.textContent?.replace(/[^0-9]/g, "") ?? "") || 0;
}

const PRESET_INDEX: Record<RaiseAmount, number> = { "min": 0, "1/2_pot": 1, "pot": 3, "all_in": 4 };

function submitButton() {
    return document.querySelector<HTMLInputElement | HTMLButtonElement>(
        '.raise-controller-form input[type="submit"], .raise-controller-form button[type="submit"]');
}

/** The bet box in the raise menu (a number or text field, not the slider). */
function amountInput() {
    const form = document.querySelector(".raise-controller-form");
    if (!form) return null;
    const fields = [...form.querySelectorAll<HTMLInputElement>("input")]
        .filter(i => i.type === "number" || i.type === "text" || i.type === "tel" || i.type === "");
    return fields[0] ?? null;
}

/**
 * Types a value so the page notices: set it through the browser's own value setter
 * (frameworks like React keep their own copy and ignore a plain assignment), then
 * fire the input and change events a real keystroke would.
 */
function typeInto(input: HTMLInputElement, value: number) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    input.focus();
    if (setter) setter.call(input, String(value)); else input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Opens the raise menu and raises. With an amount: types it into the bet box
 * ("raise to"), checks the box kept it, and submits. If the box is missing,
 * refuses the number, or the submit button is disabled, it clicks the preset
 * button instead. All-in always uses the all-in button (exact to the chip).
 */
export function raise(preset: RaiseAmount, amount: number | undefined, callback: () => void) {
    const raiseButton = document.querySelector<HTMLButtonElement>("button.raise");
    if (!raiseButton || raiseButton.disabled) {       // can't raise (e.g. only calling all-in is left)
        call();
        callback?.();
        return;
    }
    raiseButton.click();

    const clickPreset = (why: string) => {
        if (why) console.warn(`[raise] ${why}: using the ${preset} button instead`);
        document.querySelectorAll<HTMLButtonElement>(".default-bet-buttons button")[PRESET_INDEX[preset] ?? 0]?.click();
        setTimeout(() => { submitButton()?.click(); callback?.(); }, 50);
    };

    setTimeout(() => {
        try {
            if (amount === undefined || preset === "all_in") return clickPreset("");
            const input = amountInput();
            if (!input) return clickPreset("bet box not found");
            typeInto(input, amount);
            setTimeout(() => {
                const shown = parseInt(input.value.replace(/[^0-9]/g, ""));
                const submit = submitButton();
                if (shown !== amount) return clickPreset(`bet box shows ${input.value}, not ${amount}`);
                if (!submit || submit.disabled) return clickPreset(`page refused ${amount}`);
                console.log(`[raise] typed ${amount}`);
                submit.click();
                callback?.();
            }, 50);
        }
        catch (err) {
            console.error("[raise] typing failed:", err);
            clickPreset("error");
        }
    }, 100);
}

export function showHandIfPossible() {
    document.querySelector<HTMLButtonElement>('button.show-your-hand')?.click();
}
