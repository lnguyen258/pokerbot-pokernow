/**
 * Checks the brain's math and the log parser on known cases.
 * Run from pokernow-extension/:  npm test
 */
const B = "./.build-test";
global.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
const { icm } = require(`${B}/ai/icm.js`);
const { parseHand, currentHandMessages } = require(`${B}/table/logReader.js`);
const { buildTableView } = require(`${B}/table/tableView.js`);
const { allInAnalysis } = require(`${B}/ai/preflop/pushFold.js`);
const { preflopDecide } = require(`${B}/ai/preflop/preflopBrain.js`);
const { rangeSize, fullRange } = require(`${B}/ai/preflop/hands.js`);

let failures = 0;
function check(name, ok, detail) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
    if (!ok) failures++;
}

// 1. ICM example worked by hand: stacks 5000/3000/2000, payouts 50/30/20 -> 38.39 / 32.75 / 28.86
const e = icm([5000, 3000, 2000], [50, 30, 20]);
check("ICM 3-player example", Math.abs(e[0] - 38.39) < 0.02 && Math.abs(e[2] - 28.86) < 0.02,
    e.map(x => x.toFixed(2)).join(" / "));

// 2. Log parsing (format from pokernow-gpt's parser), newest first like the API.
const newestFirst = [
    '"Cat @ c3" folds',
    '"Bob @ b2" raises to 600',
    '"Dan @ d4" posts a big blind of 200',
    '"Alice @ a1" posts a small blind of 100',
    'Player stacks: #1 "Alice @ a1" (2600) | #3 "Bob @ b2" (400) | #5 "Cat @ c3" (1800) | #7 "Dan @ d4" (3200)',
    '-- starting hand #42 (id: xyz)  (No Limit Texas Hold\'em) (dealer: "Cat @ c3") --',
    '"Old @ o1" collected 300 from pot',
    '-- starting hand #41 (id: old) --',
];
const hand = parseHand(currentHandMessages(newestFirst));
check("parse hand number + players", hand.handNumber === 42 && hand.players.length === 4, `#${hand.handNumber}, ${hand.players.length} players`);
check("parse actions", hand.actions.map(a => a.kind).join(",") === "sb,bb,raise,fold",
    hand.actions.map(a => `${a.kind}${a.amount || ""}`).join(","));

// Seats 1,3,5,7. Alice posts SB, Dan posts BB (seats 3 and 5 sit between them in seat order,
// as if someone were skipped), so acting order is Bob, Cat, then Alice SB, Dan BB.
const view = buildTableView(hand, "Alice", 0);
check("positions from blinds", view && view.players.map(p => `${p.name}:${p.position}`).join(" ") ===
    "Bob:CO Cat:BTN Alice:SB Dan:BB", view && view.players.map(p => `${p.name}:${p.position}`).join(" "));
// v1.15.8, real hand: the small blind's seat had just emptied, so only a big blind was posted
// (by the seat after the dealer). The bot is first to act, not the big blind, and the big
// blind is not a limper.
{
    const dead = parseHand(currentHandMessages([
        '"Nak @ n10" posts a big blind of 100',
        'Player stacks: #1 "Me @ m1" (1091) | #5 "Fresh @ f5" (2409) | #7 "Derek @ d7" (740) | #8 "Ben @ b8" (2640) | #10 "Nak @ n10" (1120)',
        '-- starting hand #14 (id: dsb)  (No Limit Texas Hold\'em) (dealer: "Ben @ b8") --',
    ]));
    const v = buildTableView(dead, "Me", 0);
    const pos = v && v.players.map(p => `${p.name}:${p.position}`).join(" ");
    check("dead small blind: big blind poster is BB, I'm first to act", pos === "Me:UTG Fresh:HJ Derek:CO Ben:BTN Nak:BB", pos);
}
check("stacks after betting", view.players.find(p => p.name === "Bob").invested === 600 &&
    view.players.find(p => p.name === "Alice").stack === 2500, `Bob invested ${view.players.find(p => p.name === "Bob").invested}`);

// 3. Heads-up push/fold at 10 BB in chips (2 players, winner takes all = chip EV).
//    Known equilibrium: small blind shoves ~58% of hands, big blind calls ~37%.
function huView(stackBB) {
    const players = [
        { id: "sb", name: "Me", seat: 1, position: "BTN/SB", startStack: stackBB, stack: stackBB - 0.5, invested: 0.5, streetBet: 0.5, folded: false, actions: [], isMe: true },
        { id: "bb", name: "Opp", seat: 2, position: "BB", startStack: stackBB, stack: stackBB - 1, invested: 1, streetBet: 1, folded: false, actions: [], isMe: false },
    ];
    return { handNumber: 1, street: "preflop", sb: 0.5, bb: 1, players, me: players[0], actions: [
        { id: "sb", street: "preflop", kind: "sb", amount: 0.5, allIn: false },
        { id: "bb", street: "preflop", kind: "bb", amount: 1, allIn: false }], pot: 1.5 };
}
for (const depth of [3, 5, 10, 15, 20]) {
    const v = huView(depth);
    const r = allInAnalysis(v, v.players[0], [v.players[1]], () => fullRange(), () => 1, [1, 0]);
    const p = rangeSize(r.actorRange), c = rangeSize(r.callers[0].callRange);
    const detail = `shove ${(p * 100).toFixed(0)}%, call ${(c * 100).toFixed(0)}%`;
    if (depth === 10)
        check("HU push/fold 10 BB vs known equilibrium (~58% shove / ~37% call)",
            Math.abs(p - 0.58) < 0.05 && Math.abs(c - 0.37) < 0.05, detail);
    else
        console.log(`INFO  HU push/fold ${depth} BB: ${detail}`);
}

// 4. The user's scenarios, with an 8-player payout table (top 4 positive).
const PAY = [100, 60, 35, 15, -10, -20, -30, -40];
function scenario(desc, stacks, myIndex, holeCards, actions, bb = 200) {
    const msgs = [`-- starting hand #7 (id: s) --`,
        "Player stacks: " + stacks.map((s, i) => `#${i + 1} "P${i} @ p${i}" (${s})`).join(" | "), ...actions];
    const v = buildTableView(parseHand(msgs), `P${myIndex}`, 0);
    const toCall = Math.max(...v.players.map(p => p.streetBet)) - v.me.streetBet;
    const suit = { c: "c", d: "d", h: "h", s: "s" };
    const card = t => ({ value: { name: t[0], code: "23456789TJQKA".indexOf(t[0]) + 2 }, suit: suit[t[1]] });
    const state = { hand: holeCards.split(" ").map(card), board: [], bigBlind: bb, toCall, stack: v.me.stack, pot: v.pot };
    const config = require(`${B}/config.js`).CONFIG;
    config.payouts = PAY;
    const d = preflopDecide(v, state);
    console.log(`\n${desc}\n  -> ${d.action.type}${d.action.raiseAmount ? " " + d.action.raiseAmount : ""}: ${d.reason}`);
    return d;
}

// 4 players left: seats P0..P3. Blinds by P2 (SB) and P3 (BB) -> P0 = CO, P1 = BTN.
let d = scenario("K2o on the button, 4 left, folded to me (deep: 35-45 BB)",
    [9000, 8000, 7000, 8400], 1, "Kh 2c",
    ['"P2 @ p2" posts a small blind of 100', '"P3 @ p3" posts a big blind of 200', '"P0 @ p0" folds']);
d = scenario("K9o on the button, 4 left, folded to me (deep: 35-45 BB)",
    [9000, 8000, 7000, 8400], 1, "Kh 9c",
    ['"P2 @ p2" posts a small blind of 100', '"P3 @ p3" posts a big blind of 200', '"P0 @ p0" folds']);
check("K9o button 4-handed opens", d.action.type === "raise");

scenario("K2o on the button, 4 left, ~13 BB (like your 2600 / 200 game)",
    [3000, 2600, 2000, 2400], 1, "Kh 2c",
    ['"P2 @ p2" posts a small blind of 100', '"P3 @ p3" posts a big blind of 200', '"P0 @ p0" folds']);

d = scenario("K2o first to act (CO), 4 left, deep",
    [9000, 8000, 7000, 8400], 0, "Kh 2c",
    ['"P2 @ p2" posts a small blind of 100', '"P3 @ p3" posts a big blind of 200']);
check("K2o first to act 4-handed folds", d.action.type === "check_or_fold");

d = scenario("Big stack (2600) on button vs short stacks in the blinds, 72o",
    [3000, 2600, 400, 500], 1, "7h 2c",
    ['"P2 @ p2" posts a small blind of 100', '"P3 @ p3" posts a big blind of 200', '"P0 @ p0" folds']);

// 5 players: seats P0..P4. P1 SB (400 chips = 2 BB), P2 BB, then P3, P4, P0 act first.
d = scenario("Short stack (400 = 2 BB) in the SB goes all-in; I'm the big blind with Q9o",
    [2600, 400, 3000, 1800, 2200], 2, "Qh 9c",
    ['"P1 @ p1" posts a small blind of 100', '"P2 @ p2" posts a big blind of 200',
     '"P3 @ p3" folds', '"P4 @ p4" folds', '"P0 @ p0" folds', '"P1 @ p1" raises to 400 and go all in']);
check("call a 2 BB shove with Q9o in the big blind", d.action.type === "call");

// 5 players: P3 SB, P4 BB, so acting order is P0 (UTG), P1 (CO), P2 (BTN).
// The 400-chip player (P1) just CALLS 200 = half their stack. I'm on the button.
d = scenario("A 400-chip player limps for half their stack; I'm on the button with A9o (3000 chips)",
    [2600, 400, 3000, 1800, 2200], 2, "Ah 9c",
    ['"P3 @ p3" posts a small blind of 100', '"P4 @ p4" posts a big blind of 200',
     '"P0 @ p0" folds', '"P1 @ p1" calls 200']);

// 6. Postflop: QQ against a player who called preflop, on different boards.
const TYPICAL = { hands: 0, style: 1, pfr: 0.15, threeBet: 0.07, aggression: 0.35, raiseVsBet: 0.12, foldToBet: 0.45 };
const MANIAC = { hands: 60, style: 2.5, pfr: 0.9, threeBet: 0.5, aggression: 0.9, raiseVsBet: 0.5, foldToBet: 0.2 };
const { postflopDecide } = require(`${B}/ai/postflop/postflopBrain.js`);
const { preflopRange } = require(`${B}/ai/preflop/playerRanges.js`);
/** "check_or_fold", "call", "all_in", or the bet size as a share of the pot: "bet_33", "bet_50", ... */
function sizeKey(action, v, toCall) {
    if (action.type !== "raise") return action.type;
    if (action.raiseAmount === "all_in" || action.amount === undefined) return "all_in";
    const extra = action.amount - v.me.streetBet - toCall;
    return "bet_" + Math.round(extra / (v.pot + toCall) * 100);
}
function postflop(desc, boardText, extraActions, street) {
    // 4 players: P2 SB, P3 BB; P0 (CO) folds, I'm P1 on the button with QQ and open, P3 calls.
    const msgs = ['-- starting hand #9 (id: pf) --',
        'Player stacks: #1 "P0 @ p0" (4000) | #2 "P1 @ p1" (4000) | #3 "P2 @ p2" (4000) | #4 "P3 @ p3" (4000)',
        '"P2 @ p2" posts a small blind of 50', '"P3 @ p3" posts a big blind of 100',
        '"P0 @ p0" folds', '"P1 @ p1" raises to 250', '"P2 @ p2" folds', '"P3 @ p3" calls 250',
        `Flop:  [${boardText.split(" ").slice(0, 3).join(", ")}]`, ...extraActions];
    const v = buildTableView(parseHand(msgs), "P1", 0);
    const toCall = Math.max(...v.players.map(p => p.streetBet)) - v.me.streetBet;
    const card = t => ({ value: { name: t[0], code: "23456789TJQKA".indexOf(t[0]) + 2 }, suit: t[1] });
    const boardCards = boardText.split(" ").map(card);
    const state = { hand: [card("Qh"), card("Qd")], board: boardCards, toCall, stack: v.me.stack, pot: v.pot,
        phase: { name: street, code: { flop: 1, turn: 2, river: 3 }[street] }, bigBlind: 100 };
    const villain = v.players.find(p => p.name === "P3");
    const picks = {};
    let last;
    for (let i = 0; i < 20; i++) {
        last = postflopDecide(v, state, {
            preRanges: new Map([[villain.id, preflopRange(v, villain, TYPICAL)]]), profileOf: () => TYPICAL, callPressure: 0,
        });
        const k = sizeKey(last.action, v, toCall);
        picks[k] = (picks[k] || 0) + 1;
    }
    console.log(`\n${desc}\n  ${last.reason}\n  choices over 20 runs: ${JSON.stringify(picks)}`);
    return picks;
}
let pk = postflop("QQ on 9s 6s 2d (two spades), opponent checks to me", "9s 6s 2d", ['"P3 @ p3" checks'], "flop");
/** How many picks were bets between lo% and hi% of the pot. */
const sizedBets = (p, lo, hi) => Object.entries(p).filter(([k]) => k.startsWith("bet_") &&
    +k.slice(4) >= lo && +k.slice(4) <= hi).reduce((a, [, n]) => a + n, 0);
const betCount = p => Object.entries(p).filter(([k]) => k.startsWith("bet_") || k === "all_in").reduce((a, [, n]) => a + n, 0);
check("QQ on a two-spade flop bets", betCount(pk) >= 15);
postflop("QQ on Kc 7d 2h (dry, one overcard), opponent checks", "Kc 7d 2h", ['"P3 @ p3" checks'], "flop");
pk = postflop("QQ, turn 3c on 9s 6s 2d after I bet pot and got called; opponent checks",
    "9s 6s 2d 3c", ['"P3 @ p3" checks', '"P1 @ p1" bets 525', '"P3 @ p3" calls 525', "Turn: 9♠, 6♠, 2♦ [3♣]", '"P3 @ p3" checks'], "turn");
pk = postflop("QQ, turn As on 9s 6s 2d (flush AND overcard arrive) after flop bet-call; opponent checks",
    "9s 6s 2d As", ['"P3 @ p3" checks', '"P1 @ p1" bets 525', '"P3 @ p3" calls 525', "Turn: 9♠, 6♠, 2♦ [A♠]", '"P3 @ p3" checks'], "turn");
check("QQ slows down when the flush card comes (checks or bets 40% of the pot or less, never 90%+ or all-in)",
    (pk.check_or_fold || 0) + sizedBets(pk, 0, 40) >= 10 && !pk.all_in && sizedBets(pk, 90, 1000) === 0, JSON.stringify(pk));

// 7. Heads-up vs an aggressive player: they raise preflop, I call in the big blind,
//    I check the flop and they bet pot. Typical opponent vs maniac profile.
function headsUp(desc, myCards, boardText, prof) {
    const msgs = ['-- starting hand #20 (id: hu) --',
        'Player stacks: #1 "Me @ me" (4000) | #2 "Max @ mx" (4000)',
        '"Max @ mx" posts a small blind of 50', '"Me @ me" posts a big blind of 100',
        '"Max @ mx" raises to 250', '"Me @ me" calls 250',
        `Flop:  [${boardText.split(" ").join(", ")}]`, '"Me @ me" checks', '"Max @ mx" bets 500'];
    const v = buildTableView(parseHand(msgs), "Me", 0);
    const card = t => ({ value: { name: t[0], code: "23456789TJQKA".indexOf(t[0]) + 2 }, suit: t[1] });
    const state = { hand: myCards.split(" ").map(card), board: boardText.split(" ").map(card), toCall: 500,
        stack: v.me.stack, pot: v.pot, phase: { name: "flop", code: 1 }, bigBlind: 100 };
    const villain = v.players.find(p => p.name === "Max");
    const picks = {};
    let last;
    for (let i = 0; i < 20; i++) {
        last = postflopDecide(v, state, {
            preRanges: new Map([[villain.id, preflopRange(v, villain, prof)]]), profileOf: () => prof, callPressure: 0,
        });
        const k = sizeKey(last.action, v, 500);
        picks[k] = (picks[k] || 0) + 1;
    }
    console.log(`
${desc}
  ${last.reason}
  choices over 20 runs: ${JSON.stringify(picks)}`);
    return picks;
}
const vsTypical = headsUp("HU: 8h 7h (middle pair) on Kc 8d 3s, TYPICAL player bets pot", "8h 7h", "Kc 8d 3s", TYPICAL);
const vsManiac = headsUp("HU: same hand vs a MANIAC (raises 90%, bets 90%, folds to bets 20%)", "8h 7h", "Kc 8d 3s", MANIAC);
const raises = p => betCount(p);
check("middle pair: defends vs maniac, and raises them far more than a typical player",
    (vsManiac.call || 0) + raises(vsManiac) >= 16 && raises(vsManiac) >= raises(vsTypical) + 8,
    `typical ${JSON.stringify(vsTypical)}, maniac ${JSON.stringify(vsManiac)}`);
const aceHigh = headsUp("HU: Ah 5c (ace high) on Kc 8d 3s vs MANIAC", "Ah 5c", "Kc 8d 3s", MANIAC);
check("ace high calls down a maniac", (aceHigh.call || 0) >= 14, JSON.stringify(aceHigh));

// 8. River solver on a textbook spot: strong hands (KK) or air (QJ) vs bluff-catchers (AT),
//    pot-size bet. Theory: bet all KK, bluff half of QJ, the caller calls half the time.
{
    const { solveRiver } = require(`${B}/ai/postflop/riverSolver.js`);
    const { N, comboIndex } = require(`${B}/ai/postflop/board.js`);
    const c = s => "23456789TJQKA".indexOf(s[0]) * 4 + "cdhs".indexOf(s[1]);
    const ix = h => comboIndex(c(h[0]), c(h[1]));
    const oop = new Array(N).fill(0), ip = new Array(N).fill(0);
    const KK = [["Kd", "Kh"], ["Kd", "Ks"], ["Kh", "Ks"]], QJ = [["Qd", "Jh"], ["Qh", "Js"], ["Qs", "Jd"]];
    for (const h of KK.concat(QJ)) oop[ix(h)] = 1;
    for (const h of [["Ad", "Th"], ["Ah", "Ts"], ["As", "Td"]]) ip[ix(h)] = 1;
    const sol = solveRiver({ board: ["2c", "3d", "7h", "8s", "Kc"].map(c), pot: 100, ranges: [oop, ip],
        bets: [0, 0], stacks: [100, 100], toAct: 0, checked: false, raisesLeft: 0, sizes: [1] }, 1500);
    const bet = h => sol.strategyFor(ix(h)).find(s => s.action === "all-in").prob;
    const node = sol.root.children[sol.root.actions.indexOf("all-in")];
    const callShare = (() => { const i = ix(["Ad", "Th"]); const s = node.avg.map(a => a[i]); return s[1] / (s[0] + s[1]); })();
    check("river solver: textbook bluff/value/call frequencies",
        bet(KK[0]) > 0.97 && Math.abs(bet(QJ[0]) - 0.5) < 0.05 && Math.abs(callShare - 0.5) < 0.05 && sol.exploitability < 0.01,
        `KK bets ${(bet(KK[0]) * 100).toFixed(0)}%, QJ bluffs ${(bet(QJ[0]) * 100).toFixed(0)}%, AT calls ${(callShare * 100).toFixed(0)}%, ` +
        `${(sol.exploitability * 100).toFixed(2)}% of pot from perfect`);
}

// 9. Full pipeline on a river: log lines -> table reader -> ranges -> solver.
{
    const msgs = ['-- starting hand #30 (id: rv) --',
        'Player stacks: #1 "Me @ me" (3000) | #2 "Max @ mx" (3000)',
        '"Max @ mx" posts a small blind of 50', '"Me @ me" posts a big blind of 100',
        '"Max @ mx" raises to 250', '"Me @ me" calls 250',
        'Flop:  [K♣, 8♦, 3♠]', '"Me @ me" checks', '"Max @ mx" bets 200', '"Me @ me" calls 200',
        'Turn: K♣, 8♦, 3♠ [2♥]', '"Me @ me" checks', '"Max @ mx" checks',
        'River: K♣, 8♦, 3♠, 2♥ [7♣]'];
    const v = buildTableView(parseHand(msgs), "Me", 0);
    const card = t => ({ value: { name: t[0], code: "23456789TJQKA".indexOf(t[0]) + 2 }, suit: t[1] });
    const state = { hand: [card("Kh"), card("Qd")], board: ["Kc", "8d", "3s", "2h", "7c"].map(card), toCall: 0,
        stack: v.me.stack, pot: v.pot, phase: { name: "river", code: 3 }, bigBlind: 100 };
    const villain = v.players.find(p => p.name === "Max");
    const t0 = Date.now();
    const d = postflopDecide(v, state, { preRanges: new Map([[villain.id, preflopRange(v, villain, TYPICAL)]]),
        profileOf: () => TYPICAL, callPressure: 0 });
    console.log(`\nRiver, KQ on K-8-3-2-7, villain checked back the turn (${Date.now() - t0} ms):\n  ${d.reason}`);
    check("river decisions use the solver heads-up", /solved/.test(d.reason));
}

// 11. The hand the first bot lost: it 3-bet, villain called, flop Q J 9, bot bets with 55,
//     villain raises. Villain's range is full of overpairs, sets and straight draws: fold.
{
    const msgs = ['-- starting hand #5 (id: t55) --', 'Player stacks: #1 "Me @ me" (5000) | #2 "Vil @ v" (5000)',
        '"Vil @ v" posts a small blind of 50', '"Me @ me" posts a big blind of 100',
        '"Vil @ v" raises to 250', '"Me @ me" raises to 750', '"Vil @ v" calls 750',
        'Flop:  [Q♠, J♦, 9♣]', '"Me @ me" bets 750', '"Vil @ v" raises to 2250'];
    const v = buildTableView(parseHand(msgs), "Me", 0);
    const card = t => ({ value: { name: t[0], code: "23456789TJQKA".indexOf(t[0]) + 2 }, suit: t[1] });
    const state = { hand: [card("5h"), card("5d")], board: ["Qs", "Jd", "9c"].map(card), toCall: 1500,
        stack: v.me.stack, pot: v.pot, phase: { name: "flop", code: 1 }, bigBlind: 100 };
    const vil = v.players.find(p => p.name === "Vil");
    let folds = 0;
    for (let i = 0; i < 20; i++) {
        const d = postflopDecide(v, state, { preRanges: new Map([[vil.id, preflopRange(v, vil, TYPICAL)]]),
            profileOf: () => TYPICAL, callPressure: 0 });
        if (d.action.type === "check_or_fold") folds++;
    }
    check("55 folds to a flop raise on Q-J-9 after the 3-bet was called", folds === 20, `${folds}/20 folds`);
}

// 12. Target the fish.
const FISH = { hands: 40, style: 2.4, vpip: 0.6, pfr: 0.03, threeBet: 0.02, aggression: 0.15, raiseVsBet: 0.05, foldToBet: 0.25 };
{
    const stats = require(`${B}/table/stats.js`);
    const t = stats.fishScore(TYPICAL), f = stats.fishScore(FISH), m = stats.fishScore(MANIAC);
    check("fish score: typical player 0, loose-passive caller high", t < 0.05 && f > 0.7,
        `typical ${t.toFixed(2)}, fish ${f.toFixed(2)}, maniac ${m.toFixed(2)}`);

    // Preflop: a fish limps UTG, folded to me on the button. Same spot vs an unknown limper.
    const { CLASSES, percentile } = require(`${B}/ai/preflop/hands.js`);
    const mid = CLASSES.map((name, i) => ({ name, p: percentile(i) })).find(h => h.p >= 0.40 * require(`${B}/config.js`).CONFIG.tuning.openScale);
    const cards = mid.name[2] === "s" ? `${mid.name[0]}h ${mid.name[1]}h` : `${mid.name[0]}h ${mid.name[1]}c`;
    const stacksSix = [4000, 4000, 4000, 4000, 4000, 4000];
    const limpSpot = ['"P4 @ p4" posts a small blind of 50', '"P5 @ p5" posts a big blind of 100',
        '"P0 @ p0" calls 100', '"P1 @ p1" folds', '"P2 @ p2" folds'];
    stats.resetStats();
    const unknown = scenario(`${mid.name} (top ${(mid.p * 100).toFixed(0)}%) on the button, an UNKNOWN player limped`,
        stacksSix, 3, cards, limpSpot, 100);
    for (let i = 0; i < 40; i++)
        stats.addHand(parseHand([`-- starting hand #${i + 1} (id: fish${i}) --`,
            "Player stacks: " + stacksSix.map((s, k) => `#${k + 1} "P${k} @ p${k}" (${s})`).join(" | "),
            '"P4 @ p4" posts a small blind of 50', '"P5 @ p5" posts a big blind of 100', '"P0 @ p0" calls 100',
            '"P1 @ p1" folds', '"P2 @ p2" folds', '"P3 @ p3" folds', '"P4 @ p4" folds', '"P5 @ p5" checks',
            'Flop:  [2♣, 7♦, K♥]', '"P5 @ p5" bets 100', '"P0 @ p0" calls 100']));
    const vsFish = scenario(`${mid.name} on the button, a FISH limped (limps and calls every hand)`, stacksSix, 3, cards, limpSpot, 100);
    check("isolates a fish limper with a hand it folds vs an unknown limper",
        vsFish.action.type === "raise" && unknown.action.type !== "raise", `${mid.name}: unknown ${unknown.action.type}, fish ${vsFish.action.type}`);
    stats.resetStats();

    // River: balanced (solver) vs a typical player, exploit vs a fish.
    const msgs = ['-- starting hand #31 (id: rvf) --',
        'Player stacks: #1 "Me @ me" (3000) | #2 "Max @ mx" (3000)',
        '"Max @ mx" posts a small blind of 50', '"Me @ me" posts a big blind of 100',
        '"Max @ mx" calls 100', '"Me @ me" checks',
        'Flop:  [K♣, 8♦, 3♠]', '"Me @ me" bets 100', '"Max @ mx" calls 100',
        'Turn: K♣, 8♦, 3♠ [2♥]', '"Me @ me" bets 200', '"Max @ mx" calls 200',
        'River: K♣, 8♦, 3♠, 2♥ [7♣]'];
    const v = buildTableView(parseHand(msgs), "Me", 0);
    const card = t => ({ value: { name: t[0], code: "23456789TJQKA".indexOf(t[0]) + 2 }, suit: t[1] });
    const state = { hand: [card("Kh"), card("Td")], board: ["Kc", "8d", "3s", "2h", "7c"].map(card), toCall: 0,
        stack: v.me.stack, pot: v.pot, phase: { name: "river", code: 3 }, bigBlind: 100 };
    const villain = v.players.find(p => p.name === "Max");
    let last, bets = 0;
    for (let i = 0; i < 20; i++) {
        last = postflopDecide(v, state, { preRanges: new Map([[villain.id, preflopRange(v, villain, FISH)]]),
            profileOf: () => FISH, callPressure: 0 });
        if (last.action.type === "raise") bets++;
    }
    console.log(`\nRiver vs a FISH, KT (top pair, weak kicker) on K-8-3-2-7 after betting flop and turn:\n  ${last.reason}`);
    check("vs a fish the river is played exploitatively (no solver), top pair bets for value",
        /Target the fish/.test(last.reason) && !/solved/.test(last.reason) && bets >= 14, `bets ${bets}/20`);
}

// 14. The hand from the live game: 7 players left, a player shoves ~20 BB, the bot called
//     with KQo and lost to 99. Beginners rarely shove light: a deep all-in is a strong hand.
{
    const stats = require(`${B}/table/stats.js`);
    const config = require(`${B}/config.js`).CONFIG;
    const REAL = [15, 9, 4, 2, -2, -4, -9, -15];
    const stacks7 = [2400, 2000, 3000, 1500, 2200, 1900, 2500];
    const shove = amount => ['"P5 @ p5" posts a small blind of 50', '"P6 @ p6" posts a big blind of 100',
        '"P0 @ p0" folds', `"P1 @ p1" raises to ${amount} and go all in`,
        '"P2 @ p2" folds', '"P3 @ p3" folds', '"P4 @ p4" folds', '"P5 @ p5" folds'];
    const spot = (desc, cards, amount, stacks = stacks7) => {
        const d = scenario(desc, stacks, 6, cards, shove(amount), 100);
        return d.action.type;
    };
    const run = () => {
        config.payouts = REAL;
        const saved = PAY.slice();
        PAY.splice(0, 8, ...REAL);
        const r = {
            KQ: spot("7 left, P1 shoves 20 BB, I have KQo in the big blind", "Kh Qd", 2000),
            AQ: spot("7 left, P1 shoves 20 BB, I have AQo in the big blind", "Ah Qd", 2000),
            QQ: spot("7 left, P1 shoves 20 BB, I have QQ in the big blind", "Qh Qd", 2000),
            KK: spot("7 left, P1 shoves 20 BB, I have KK in the big blind", "Kh Kd", 2000),
            shortKQ: spot("7 left, P1 shoves only 5 BB, I have KQo in the big blind", "Kh Qd", 500,
                [2400, 500, 3000, 1500, 2200, 1900, 2500]),
        };
        PAY.splice(0, 8, ...saved);
        return r;
    };
    stats.resetStats();
    const vsUnknown = run();
    // Same spot vs a loose-passive beginner: plays 60% of hands, almost never raises.
    for (let i = 0; i < 40; i++)
        stats.addHand(parseHand([`-- starting hand #${i + 1} (id: lp${i}) --`,
            "Player stacks: " + stacks7.map((s, k) => `#${k + 1} "P${k} @ p${k}" (${s})`).join(" | "),
            '"P5 @ p5" posts a small blind of 50', '"P6 @ p6" posts a big blind of 100',
            '"P0 @ p0" folds', i % 5 < 3 ? '"P1 @ p1" calls 100' : '"P1 @ p1" folds',
            '"P2 @ p2" folds', '"P3 @ p3" folds', '"P4 @ p4" folds', '"P5 @ p5" folds', '"P6 @ p6" checks']));
    const vsFish = run();
    stats.resetStats();
    check("deep all-in, 7 left: folds KQo and AQo, calls KK (vs unknown AND vs a loose-passive beginner)",
        [vsUnknown, vsFish].every(r => r.KQ !== "call" && r.AQ !== "call" && r.KK === "call"),
        `unknown ${JSON.stringify(vsUnknown)}, beginner ${JSON.stringify(vsFish)}`);
    check("still calls a 5 BB short-stack shove with KQo", vsUnknown.shortKQ === "call", vsUnknown.shortKQ);
}

// 15. Live complaint: "calls trash preflop for 5 BB, then folds the flop".
{
    const REAL = [15, 9, 4, 2, -2, -4, -9, -15];
    const saved = PAY.slice();
    PAY.splice(0, 8, ...REAL);
    const st = [2000, 2000, 2000, 2000, 2000, 2000, 2000];
    const blinds = ['"P5 @ p5" posts a small blind of 50', '"P6 @ p6" posts a big blind of 100'];
    const quiet = (desc, stacks, me, cards, actions) => {
        const log = console.log; console.log = () => {};
        try { return scenario(desc, stacks, me, cards, actions, 100).action; } finally { console.log = log; }
    };
    const trash = ["Jh 4c", "9h 3h", "Kh 6c", "Qh 7c", "Th 8c", "7h 2c"];
    const res = {};
    for (const h of trash) {
        // A 12 BB player raises to 5 BB: 40% of their stack, effectively all-in.
        res[`${h} vs 12 BB stack raising 5 BB`] = quiet("", [2000, 1200, 2000, 2000, 2000, 2000, 2000], 6, h,
            [...blinds, '"P0 @ p0" folds', '"P1 @ p1" raises to 500', '"P2 @ p2" folds', '"P3 @ p3" folds', '"P4 @ p4" folds', '"P5 @ p5" folds']).type;
        res[`${h} SB, 3 limpers`] = quiet("", st, 5, h,
            [...blinds, '"P0 @ p0" calls 100', '"P1 @ p1" calls 100', '"P2 @ p2" calls 100', '"P3 @ p3" folds', '"P4 @ p4" folds']).type;
        res[`${h} BB vs raise to 5 BB + 2 callers`] = quiet("", st, 6, h,
            [...blinds, '"P0 @ p0" folds', '"P1 @ p1" raises to 500', '"P2 @ p2" calls 500', '"P3 @ p3" calls 500', '"P4 @ p4" folds', '"P5 @ p5" folds']).type;
    }
    const bad = Object.entries(res).filter(([, t]) => t !== "check_or_fold").map(([k, t]) => `${k}: ${t}`);
    check("folds trash preflop: vs a near-all-in 5 BB raise, completing SB multiway, vs raise + callers",
        bad.length === 0, bad.length ? bad.join("; ") : `${Object.keys(res).length} spots, all folds`);
    const good = quiet("", [2000, 1200, 2000, 2000, 2000, 2000, 2000], 6, "Ah Jc",
        [...blinds, '"P0 @ p0" folds', '"P1 @ p1" raises to 500', '"P2 @ p2" folds', '"P3 @ p3" folds', '"P4 @ p4" folds', '"P5 @ p5" folds']).type;
    check("still calls AJo vs that 12 BB player's 5 BB raise", good === "call", good);
    PAY.splice(0, 8, ...saved);
}

// 13. Think time fits the 10 s turn timer, including the time spent deciding.
{
    const timing = require(`${B}/timing.js`);
    const config = require(`${B}/config.js`).CONFIG;
    const max = config.timing.maxSeconds, min = config.timing.minSeconds;
    let longest = 0, shortest = Infinity;
    for (let i = 0; i < 3000; i++) {
        timing.noteStrength(Math.random());
        const action = [{ type: "call" }, { type: "raise", raiseAmount: "all_in" }, { type: "check_or_fold" }][i % 3];
        const ms = timing.thinkTime(action, { toCall: i % 2 ? 900 : 0, stack: 1000 }).ms;
        longest = Math.max(longest, ms); shortest = Math.min(shortest, ms);
    }
    const ok = longest <= max * 1000 && shortest >= min * 1000 && timing.fitToBudget(8) < timing.fitToBudget(10) &&
        timing.remainingWait(4000, 3000) === 1000 && timing.remainingWait(4000, max * 1000 + 500) === 0 &&
        timing.remainingWait(max * 1000, 1500) === max * 1000 - 1500;
    check(`think time between ${min} and ${max} s in total, decision time included`, ok && max <= 5,
        `thinks from ${(shortest / 1000).toFixed(1)} to ${(longest / 1000).toFixed(1)} s; 3 s spent deciding a 4 s think -> waits ${timing.remainingWait(4000, 3000) / 1000} s more`);
}

// 10. Player profiles by stack situation, and recency.
{
    const stats = require(`${B}/table/stats.js`);
    stats.resetStats();
    let n = 0;
    // X is loose and aggressive with a big stack, tight when short.
    const hand = (xStack, xRaises) => {
        n++;
        return parseHand([`-- starting hand #${n} (id: prof${n}) --`,
            `Player stacks: #1 "X @ x" (${xStack}) | #2 "Y @ y" (1000) | #3 "Z @ z" (1000) | #4 "W @ w" (1000)`,
            '"Z @ z" posts a small blind of 10', '"W @ w" posts a big blind of 20',
            xRaises ? '"X @ x" raises to 60' : '"X @ x" folds', '"Y @ y" folds', '"Z @ z" folds', '"W @ w" folds']);
    };
    for (let i = 0; i < 40; i++) stats.addHand(hand(4000, i % 20 < 17));     // big stack: raises 85%
    for (let i = 0; i < 40; i++) stats.addHand(hand(200, i % 10 === 5));     // short (10 BB): raises 10%
    const big = stats.profile("x", "X", { stack: 4000, bb: 20, tableAverage: 1750 });
    const short = stats.profile("x", "X", { stack: 200, bb: 20, tableAverage: 800 });
    const overall = stats.profile("x", "X");
    check("profile separates big-stack and short-stack play",
        big.pfr > 0.6 && short.pfr < 0.25 && overall.pfr > short.pfr && overall.pfr < big.pfr,
        `raises: big stack ${(big.pfr * 100).toFixed(0)}%, short ${(short.pfr * 100).toFixed(0)}%, overall ${(overall.pfr * 100).toFixed(0)}%`);

    // Recency: a player who was tight for 60 hands, then turns maniac for 30.
    stats.resetStats();
    for (let i = 0; i < 90; i++) {
        n++;
        stats.addHand(parseHand([`-- starting hand #${n} (id: rec${n}) --`,
            'Player stacks: #1 "R @ r" (1000) | #2 "Y @ y" (1000) | #3 "Z @ z" (1000)',
            '"Y @ y" posts a small blind of 10', '"Z @ z" posts a big blind of 20',
            i < 60 ? '"R @ r" folds' : '"R @ r" raises to 60']));
    }
    const now = stats.profile("r", "R");
    check("profile follows a player who changes gears", now.pfr > 0.45,
        `raised in 30 of 90 hands (33%), all of them the last 30; profile now says ${(now.pfr * 100).toFixed(0)}%`);
    stats.resetStats();
}

// 5. A real PokerNow log download (if one is in the project folder).
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..");
const csvFile = fs.readdirSync(root).find(f => /^poker_now_log_.*\.csv$/.test(f));
if (csvFile) {
    const { handsFromCsv } = require(`${B}/table/csvLog.js`);
    const stats = require(`${B}/table/stats.js`);
    const hands = handsFromCsv(fs.readFileSync(path.join(root, csvFile), "utf8"));
    // Each hand's ending stacks must equal the next hand's "Player stacks" line.
    let match = 0, mismatch = 0;
    for (let h = 0; h + 1 < hands.length; h++) {
        const v = buildTableView(hands[h], hands[h].players[0].name, 0);
        const end = new Map(v.players.map(p => [p.id, p.stack]));
        for (const c of hands[h].collected) end.set(c.id, end.get(c.id) + c.amount);
        const ok = hands[h + 1].players.every(p => !end.has(p.id) || Math.abs(end.get(p.id) - p.stack) < 0.01);
        if (ok) match++; else mismatch++;
    }
    check(`real log (${csvFile}): ${hands.length} hands, stacks reconcile hand to hand`, mismatch === 0,
        `${match} ok, ${mismatch} mismatched`);
    let added = 0, again = 0;
    for (const h of hands) if (stats.addHand(h)) added++;
    for (const h of hands) if (stats.addHand(h)) again++;
    check("import counts each hand once", added === hands.length && again === 0, `${added} added, ${again} on re-import`);
    for (const p of stats.allPlayers())
        console.log(`INFO  ${p.name}: ${stats.describe("", p.name)}; shown: ` +
            (p.shown.map(x => `${x.cards} (${x.preflop})`).join("; ") || "-"));
}

// Screen-only table (sites without PokerNow's game log): rebuild the hand from the seats on the page.
{
    const { handFromScreen } = require(`${B}/table/screenReader.js`);
    const { decideWithView } = require(`${B}/ai/decide.js`);
    const config = require(`${B}/config.js`).CONFIG;
    config.payouts = PAY;
    const card = t => ({ value: { name: t[0], code: "23456789TJQKA".indexOf(t[0]) + 2 }, suit: t[1] });
    const seat = (name, stack, bet = 0, extra = {}) => ({ name, stack, bet, folded: false, isMe: false, dealer: false, ...extra });
    const quiet = () => {};

    // 6 seats, button on Cat: Dan SB, Eve BB, Fay (UTG) raises to 600, Al folds, I'm Bob (CO... button order) to act.
    let seats = [seat("Al", 8000, 0, { folded: true }), seat("Bob", 8000, 0, { isMe: true }), seat("Cat", 8000, 0, { dealer: true }),
        seat("Dan", 7900, 100), seat("Eve", 7800, 200), seat("Fay", 7400, 600)];
    let hand = handFromScreen(seats, { street: "preflop", bb: 200, prevPot: 0 });
    let v = buildTableView(hand, "Bob", 8000);
    console.log(`\nScreen-only preflop: ${v.players.map(p => `${p.isMe ? "*" : ""}${p.name} ${p.position}${p.folded ? " (folded)" : ""}`).join(" | ")}`);
    check("screen: positions from the dealer button", v.players.find(p => p.name === "Dan").position === "SB" &&
        v.players.find(p => p.name === "Eve").position === "BB" && v.players.find(p => p.name === "Cat").position === "BTN" &&
        v.players.find(p => p.name === "Bob").position === "CO");
    check("screen: the raise is seen (Fay raised to 600, me 600 to call)",
        v.actions.some(a => a.kind === "raise" && a.amount === 600 && a.id === "screen:Fay") &&
        Math.max(...v.players.map(p => p.streetBet)) - v.me.streetBet === 600);
    const pre = (cards) => decideWithView(v, { hand: cards.split(" ").map(card), board: [], bigBlind: 200, toCall: 600, stack: 8000,
        pot: 900, phase: { name: "preflop", code: 0 } }, quiet);
    check("screen: 72o folds to a raise, AA re-raises", pre("7h 2c").type === "check_or_fold" && pre("Ah Ad").type === "raise");

    // No dealer button on the page: found from who has the big blind in front of them.
    seats = seats.map(s => ({ ...s, dealer: false }));
    v = buildTableView(handFromScreen(seats, { street: "preflop", bb: 200, prevPot: 0 }), "Bob", 8000);
    check("screen: no dealer button -> blinds from the bets", v.players.find(p => p.name === "Eve").position === "BB");

    // Flop, heads-up with Fay: pot 1500 from preflop, Fay bets 700, I have top pair.
    seats = [seat("Al", 8000, 0, { folded: true }), seat("Bob", 7400, 0, { isMe: true }), seat("Cat", 8000, 0, { dealer: true, folded: true }),
        seat("Dan", 7900, 0, { folded: true }), seat("Eve", 7800, 0, { folded: true }), seat("Fay", 6700, 700)];
    v = buildTableView(handFromScreen(seats, { street: "flop", bb: 200, prevPot: 1500 }), "Bob", 7400);
    v.pot = 2200;
    const post = decideWithView(v, { hand: [card("Ah"), card("Kd")], board: ["Ks", "8d", "3c"].map(card), bigBlind: 200, toCall: 700,
        stack: 7400, pot: 2200, phase: { name: "flop", code: 1 } }, quiet);
    check("screen: flop, top pair top kicker vs a bet doesn't fold", post.type !== "check_or_fold", JSON.stringify(post));
}

// Cash game: chips are money. No ICM: calling an all-in needs exactly 50% (plus pot odds), at any stack sizes.
{
    const config = require(`${B}/config.js`).CONFIG;
    const { requiredEquityAllIn } = require(`${B}/ai/icm.js`);
    config.payouts = PAY;
    const stacks = [5000, 3000, 1500, 500];
    config.gameType = "tournament";
    const tour = requiredEquityAllIn(stacks, 1, 0, PAY);
    config.gameType = "cash";
    const cash = requiredEquityAllIn(stacks, 1, 0, PAY);
    const chips = icm(stacks, PAY);
    config.gameType = "tournament";
    console.log(`\nCall an all-in from the big stack with 3000 of 4 stacks: tournament needs ${(tour * 100).toFixed(1)}%, cash ${(cash * 100).toFixed(1)}%`);
    check("cash game: no ICM (stack value = chips, an all-in call needs 50%)",
        Math.abs(cash - 0.5) < 1e-9 && tour > 0.52 && chips.every((v, i) => v === stacks[i]));
}

// ---- REFORM.md: table phases and the target behaviours of each part.
// `todo` checks are written before the part that makes them pass: they print TODO
// (not FAIL) until then. When a part is done, its todos become plain checks.
let todos = 0;
function todo(part, name, ok, detail) {
    if (ok) return check(`[part ${part}] ${name}`, true, detail);
    console.log(`TODO  [part ${part}] ${name}${detail ? "  (" + detail + ")" : ""}`);
    todos++;
}
{
    const { tablePhase, phaseTag } = require(`${B}/table/tableView.js`);
    const { decideWithView } = require(`${B}/ai/decide.js`);
    const card = t => ({ value: { name: t[0], code: "23456789TJQKA".indexOf(t[0]) + 2 }, suit: t[1] });
    const want = { 8: "full", 7: "full", 6: "full", 5: "conservative", 4: "normal", 3: "creative", 2: "headsUp" };
    const viewOf = n => buildTableView(parseHand([`-- starting hand #3 (id: ph${n}) --`,
        "Player stacks: " + Array.from({ length: n }, (_, i) => `#${i + 1} "P${i} @ p${i}" (4000)`).join(" | "),
        '"P0 @ p0" posts a small blind of 50', '"P1 @ p1" posts a big blind of 100']), n > 2 ? "P2" : "P0", 0);
    const got = [8, 7, 6, 5, 4, 3, 2].map(n => `${n}:${tablePhase(viewOf(n))}`);
    check("table phase by players left (8..2)", [8, 7, 6, 5, 4, 3, 2].every(n => tablePhase(viewOf(n)) === want[n]), got.join(" "));

    const lines = [];
    const v7 = viewOf(7);
    decideWithView(v7, { hand: [card("Ah"), card("Kd")], board: [], bigBlind: 100, toCall: 100, stack: v7.me.stack,
        pot: v7.pot, phase: { name: "preflop", code: 0 } }, m => lines.push(m));
    check("decision log starts with the phase", lines[0] && lines[0].startsWith("[full 7p] [preflop]") && phaseTag(v7) === "[full 7p]",
        lines[0] && lines[0].slice(0, 40));
}

const STATION = { hands: 60, style: 2, vpip: 0.6, pfr: 0.08, threeBet: 0.03, aggression: 0.2, raiseVsBet: 0.05, foldToBet: 0.1 };
/**
 * Runs postflopDecide `runs` times on a spot and counts the choices (fold/check, call, all_in, bet_<% pot>).
 * players: stacks by seat (P0 = SB, P1 = BB, then UTG ... BTN), me: my name, actions: the log after the blinds.
 */
function spot(desc, stacks, me, hole, boardText, actions, street, prof, runs = 20) {
    const card = t => ({ value: { name: t[0], code: "23456789TJQKA".indexOf(t[0]) + 2 }, suit: t[1] });
    const msgs = ['-- starting hand #30 (id: sp) --',
        "Player stacks: " + stacks.map((s, i) => `#${i + 1} "P${i} @ p${i}" (${s})`).join(" | "),
        '"P0 @ p0" posts a small blind of 100', '"P1 @ p1" posts a big blind of 200', ...actions];
    const v = buildTableView(parseHand(msgs), me, 0);
    const toCall = Math.max(...v.players.map(p => p.streetBet)) - v.me.streetBet;
    const state = { hand: hole.split(" ").map(card), board: boardText.split(" ").map(card), toCall, stack: v.me.stack,
        pot: v.pot, phase: { name: street, code: { flop: 1, turn: 2, river: 3 }[street] }, bigBlind: 200 };
    const opps = v.players.filter(p => !p.isMe && !p.folded);
    const picks = {};
    let last;
    for (let i = 0; i < runs; i++) {
        last = postflopDecide(v, state, {
            preRanges: new Map(opps.map(p => [p.id, preflopRange(v, p, prof)])), profileOf: () => prof, callPressure: 0,
        });
        const k = sizeKey(last.action, v, toCall);
        picks[k] = (picks[k] || 0) + 1;
    }
    console.log(`\n${desc}\n  ${last.reason}\n  choices over ${runs} runs: ${JSON.stringify(picks)}`);
    return picks;
}
const folds = p => p.check_or_fold || 0;
const bets = p => betCount(p);
{
    const deep7 = [8000, 8000, 8000, 8000, 8000, 8000, 8000];
    const B7 = ['"P0 @ p0" posts a small blind of 100', '"P1 @ p1" posts a big blind of 200'];
    // Part 3: full table, tight.
    d = scenario("[part 3] 7 players, UTG raises to 2.5 BB, I have KJo on the button (40 BB)", deep7, 6, "Kh Jc",
        [...B7, '"P2 @ p2" raises to 500', '"P3 @ p3" folds', '"P4 @ p4" folds', '"P5 @ p5" folds']);
    check("[part 3] full table: KJo on the button folds to an UTG raise", d.action.type === "check_or_fold", `${d.action.type}`);

    let p = spot("[part 3] 7 players, I opened CO with Kh 5h, BB calls; flop Kd 8c 3s, I bet, BB raises",
        deep7, "P5", "Kh 5h", "Kd 8c 3s",
        ['"P2 @ p2" folds', '"P3 @ p3" folds', '"P4 @ p4" folds', '"P5 @ p5" raises to 500', '"P6 @ p6" folds',
         '"P0 @ p0" folds', '"P1 @ p1" calls 500', "Flop:  [K♦, 8♣, 3♠]", '"P1 @ p1" checks', '"P5 @ p5" bets 600',
         '"P1 @ p1" raises to 1800'], "flop", TYPICAL);
    // v1.15.5 (user: "relax a little"): it calls a raise ~5-10% of the time on purpose.
    check("[part 3] full table: top pair weak kicker folds to a flop raise", folds(p) >= 16, JSON.stringify(p));

    p = spot("[part 3] 7 players, 3-way flop Ks 8d 2h checked to me (CO) with Jc 4d (nothing)",
        deep7, "P5", "Jc 4d", "Ks 8d 2h",
        ['"P2 @ p2" folds', '"P3 @ p3" folds', '"P4 @ p4" folds', '"P5 @ p5" raises to 500', '"P6 @ p6" calls 500',
         '"P0 @ p0" folds', '"P1 @ p1" calls 500', "Flop:  [K♠, 8♦, 2♥]", '"P1 @ p1" checks'], "flop", TYPICAL);
    check("[part 3] full table, multiway: no bluff with nothing (checks 19+ of 20)", folds(p) >= 19, JSON.stringify(p));

    // Part 3 guards the other way: strong hands still play, and the tight rules stay at 6+ / 5 players.
    p = spot("[part 3] same full-table check-raise spot, but I have 8h 8s (a set)",
        deep7, "P5", "8h 8s", "Kd 8c 3s",
        ['"P2 @ p2" folds', '"P3 @ p3" folds', '"P4 @ p4" folds', '"P5 @ p5" raises to 500', '"P6 @ p6" folds',
         '"P0 @ p0" folds', '"P1 @ p1" calls 500', "Flop:  [K♦, 8♣, 3♠]", '"P1 @ p1" checks', '"P5 @ p5" bets 600',
         '"P1 @ p1" raises to 1800'], "flop", TYPICAL);
    check("[part 3] full table: a set never folds to a raise", folds(p) === 0, JSON.stringify(p));
    const deep4 = [8000, 8000, 8000, 8000];
    // v1.15.0: 4 players is tight now too (user: players here play good hands 4-handed); heads-up is not.
    p = spot("[v1.15] 4 players, same check-raise with Kh 5h (tight at 4 players)",
        deep4, "P2", "Kh 5h", "Kd 8c 3s",
        ['"P2 @ p2" raises to 500', '"P3 @ p3" folds', '"P0 @ p0" folds', '"P1 @ p1" calls 500', "Flop:  [K♦, 8♣, 3♠]",
         '"P1 @ p1" checks', '"P2 @ p2" bets 600', '"P1 @ p1" raises to 1800'], "flop", TYPICAL);
    check("[v1.15] 4 players: top pair weak kicker folds to a check-raise", folds(p) >= 17, JSON.stringify(p));
    p = spot("[v1.15] heads-up, same check-raise with Kh 5h (heads-up unchanged)",
        [8000, 8000], "P0", "Kh 5h", "Kd 8c 3s",
        ['"P0 @ p0" raises to 500', '"P1 @ p1" calls 500', "Flop:  [K♦, 8♣, 3♠]",
         '"P1 @ p1" checks', '"P0 @ p0" bets 600', '"P1 @ p1" raises to 1800'], "flop", TYPICAL);
    check("[v1.15] heads-up: top pair never folds to a raise (tight rules don't reach heads-up)", folds(p) === 0, JSON.stringify(p));

    // Part 4: position. Same hand, same table, different seat.
    const btn = scenario("[part 4] 7 players, folded to me on the button with K8o", deep7, 6, "Kh 8c",
        [...B7, '"P2 @ p2" folds', '"P3 @ p3" folds', '"P4 @ p4" folds', '"P5 @ p5" folds']);
    const utg = scenario("[part 4] 7 players, first to act (UTG) with K8o", deep7, 2, "Kh 8c", [...B7]);
    check("[part 4] position: K8o steals from the button but folds UTG",
        btn.action.type === "raise" && utg.action.type === "check_or_fold", `BTN ${btn.action.type}, UTG ${utg.action.type}`);

    // Part 7: heads-up pressure. I raised the button, they called, they check the flop. I have nothing.
    const huActions = ['"P0 @ p0" raises to 500', '"P1 @ p1" calls 500', "Flop:  [K♣, 8♦, 3♠]", '"P1 @ p1" checks'];
    const hu = [8000, 8000];
    // Heads-up the button posts the small blind: P0 is SB/BTN, P1 BB (checks first after the flop).
    p = spot("[part 7] heads-up, opponent checks the flop, I have Jd 4c (nothing) vs a TYPICAL player",
        hu, "P0", "Jd 4c", "Kc 8d 3s", huActions, "flop", TYPICAL);
    todo(7, "heads-up: air bets when checked to, sometimes all-in (bets 14+, all-in 2+ of 20)",
        bets(p) >= 14 && (p.all_in || 0) >= 2, JSON.stringify(p));
    p = spot("[part 7] same spot vs a CALLING STATION", hu, "P0", "Jd 4c", "Kc 8d 3s", huActions, "flop", STATION);
    todo(7, "heads-up: never shoves air into a calling station", !(p.all_in > 0), JSON.stringify(p));
}
// v1.11.1 bug: a 3-bet BLUFF with A2s turned into an all-in when the stack was short (12 BB).
{
    let shoves = 0;
    for (let i = 0; i < 40; i++) {
        const dd = scenario(i ? "" : "A2s on the button, 4 players, 12 BB, CO opens 2.5 BB", [2400, 2400, 2400, 2400], 3, "Ah 2h",
            ['"P0 @ p0" posts a small blind of 100', '"P1 @ p1" posts a big blind of 200', '"P2 @ p2" raises to 500']);
        if (dd.action.raiseAmount === "all_in") shoves++;
    }
    check("A2s never shoves as a 'bluff 3-bet' at 12 BB (40 runs)", shoves === 0, `${shoves} all-ins`);
}
// v1.12.0: the user's two losing hands. 5+ players: no preflop all-in unless short (10 BB) or QQ+ / AK.
{
    const B7 = ['"P0 @ p0" posts a small blind of 100', '"P1 @ p1" posts a big blind of 200'];
    const allIn = dd => dd.action.raiseAmount === "all_in";
    // 1. I'm the deepest (40 BB) in the big blind, HJ (15 BB) raises to 2 BB, I have A9o. (He had 77.)
    let dd = scenario("[user hand] 7 players, HJ raises 2 BB, deepest stack in the BB with A9o",
        [3000, 8000, 3000, 3000, 3000, 3000, 3000], 1, "Ah 9c",
        [...B7, '"P2 @ p2" folds', '"P3 @ p3" folds', '"P4 @ p4" raises to 400', '"P5 @ p5" folds', '"P6 @ p6" folds', '"P0 @ p0" folds']);
    check("[user hand] A9o doesn't re-shove a HJ raise at a 7-player table", !allIn(dd), dd.action.raiseAmount || dd.action.type);
    // 2. Deepest (22 BB), everyone else 15 BB, folded to me in the CO with ATo, button still to act. (BTN had AK.)
    dd = scenario("[user hand] 7 players, folded to me in the CO with ATo, 22 BB",
        [3000, 3000, 3000, 3000, 3000, 4400, 3000], 5, "Ah Tc",
        [...B7, '"P2 @ p2" folds', '"P3 @ p3" folds', '"P4 @ p4" folds']);
    check("[user hand] ATo doesn't open all-in at a 7-player table with 22 BB", !allIn(dd), dd.action.raiseAmount || dd.action.type);
    // Still all-in when it should: short stack, or a premium hand.
    dd = scenario("7 players, 6 BB on the button, folded to me with A8o", [3000, 3000, 3000, 3000, 3000, 3000, 1200], 6, "Ah 8c",
        [...B7, '"P2 @ p2" folds', '"P3 @ p3" folds', '"P4 @ p4" folds', '"P5 @ p5" folds']);
    check("short (6 BB) on the button: A8o still goes all-in", allIn(dd), dd.action.raiseAmount || dd.action.type);
    dd = scenario("7 players, 18 BB in the BB, HJ raises, I have QQ", [3000, 3600, 3000, 3000, 3000, 3000, 3000], 1, "Qh Qc",
        [...B7, '"P2 @ p2" folds', '"P3 @ p3" folds', '"P4 @ p4" raises to 400', '"P5 @ p5" folds', '"P6 @ p6" folds', '"P0 @ p0" folds']);
    check("QQ facing a raise still re-raises (all-in allowed)", dd.action.type === "raise", dd.action.raiseAmount || dd.action.type);
}
// v1.12.1: the user's third hand. 8 players, three clubs on the flop, the bot holds ONE club: it went all-in
// and a player with two clubs (a made flush) called. Now: no all-in / big commitment without a strong hand.
{
    const flop = ['"P2 @ p2" folds', '"P3 @ p3" folds', '"P4 @ p4" folds', '"P5 @ p5" raises to 500', '"P6 @ p6" folds',
        '"P7 @ p7" folds', '"P0 @ p0" folds', '"P1 @ p1" calls 500', "Flop:  [K♣, 7♣, 2♣]", '"P1 @ p1" checks'];
    const over = p => Object.entries(p).filter(([k]) => k.startsWith("bet_") && +k.slice(4) > 85).reduce((a, [, n]) => a + n, 0);
    for (const bbs of [12, 30]) {
        const stacks = [6000, 6000, 6000, 6000, 6000, bbs * 200, 6000, 6000];
        for (const hole of ["Kd 9c", "Td 9c", "Ad Kd"]) {
            const p = spot(`[user hand] 8 players, ${bbs} BB, K♣ 7♣ 2♣ checked to me with ${hole}`, stacks, "P5", hole, "Kc 7c 2c", flop, "flop", TYPICAL);
            check(`[user hand] 8 players ${bbs} BB, ${hole} on three clubs: no all-in, no overbet`, !p.all_in && over(p) === 0, JSON.stringify(p));
        }
    }
    const p = spot("8 players, 30 BB, K♣ 7♣ 2♣ checked to me with Ac Qc (a made flush)",
        [6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000], "P5", "Ac Qc", "Kc 7c 2c", flop, "flop", TYPICAL);
    check("8 players: a made flush still bets", betCount(p) >= 15, JSON.stringify(p));
}
// v1.12.2: the user's fourth hand. River, the nut straight, the opponent goes all-in: it FOLDED half the time.
// Cause: the river solver's answer for a hand outside our modelled range (98o after a button raise) was the
// default 50/50. Now it plays the learned regrets, and never folds a hand that beats 90%+ of their range.
{
    const { decideWithView } = require(`${B}/ai/decide.js`);
    const card = t => ({ value: { name: t[0], code: "23456789TJQKA".indexOf(t[0]) + 2 }, suit: t[1] });
    for (const n of [8, 4, 2]) {
        const acts = [];
        for (let i = 2; i < n; i++) acts.push(i === n - 1 ? `"P${i} @ p${i}" raises to 300` : `"P${i} @ p${i}" folds`);
        if (n > 2) acts.push('"P0 @ p0" folds');
        acts.push('"P1 @ p1" calls 300');
        const me = n > 2 ? `P${n - 1}` : "P0";
        if (n === 2) acts.splice(0, acts.length, '"P0 @ p0" raises to 300', '"P1 @ p1" calls 300');
        const msgs = ['-- starting hand #41 (id: nut) --', "Player stacks: " + Array.from({ length: n }, (_, i) => `#${i + 1} "P${i} @ p${i}" (4000)`).join(" | "),
            '"P0 @ p0" posts a small blind of 50', '"P1 @ p1" posts a big blind of 100', ...acts,
            "Flop:  [7♣, 6♦, 5♠]", '"P1 @ p1" checks', `"${me} @ p${me.slice(1)}" checks`,
            "Turn: 7♣, 6♦, 5♠ [2♥]", '"P1 @ p1" checks', `"${me} @ p${me.slice(1)}" checks`,
            "River: 7♣, 6♦, 5♠, 2♥ [K♣]", '"P1 @ p1" bets 3700 and go all in'];
        const v = buildTableView(parseHand(msgs), me, 0);
        const toCall = Math.max(...v.players.map(p => p.streetBet)) - v.me.streetBet;
        const state = { hand: [card("9h"), card("8d")], board: ["7c", "6d", "5s", "2h", "Kc"].map(card), toCall, stack: v.me.stack,
            pot: v.pot, phase: { name: "river", code: 3 }, bigBlind: 100 };
        let foldsN = 0;
        for (let i = 0; i < 20; i++) if (decideWithView(v, state, () => {}).type === "check_or_fold") foldsN++;
        check(`[user hand] ${n} players: the nut straight never folds to a river all-in`, foldsN === 0, `${foldsN} folds of 20`);
    }
}
// v1.12.4: kickers. 4 players, K-7-2, I bet, a TYPICAL player check-raises all-in: top pair with a good kicker
// calls, a weak kicker folds (beginners' all-in raises are value). Against a MANIAC even K3 calls.
{
    // Heads-up since v1.15.0 (at 4 players an all-in check-raise now reads as two pair or better: even KQ folds).
    const ck = ['"P0 @ p0" raises to 500', '"P1 @ p1" calls 500', "Flop:  [K♦, 7♣, 2♠]",
        '"P1 @ p1" checks', '"P0 @ p0" bets 700', '"P1 @ p1" raises to 7500 and go all in'];
    const st2 = [8000, 8000];
    const st4 = [8000, 8000, 8000, 8000];
    const kq = spot("[kicker] heads-up, KQ vs a typical check-raise all-in on K-7-2", st2, "P0", "Kh Qc", "Kd 7c 2s", ck, "flop", TYPICAL);
    const k3 = spot("[kicker] same with K3", st2, "P0", "Kh 3c", "Kd 7c 2s", ck, "flop", TYPICAL);
    const k3m = spot("[kicker] K3 vs a MANIAC's check-raise all-in", st2, "P0", "Kh 3c", "Kd 7c 2s", ck, "flop", MANIAC);
    check("[kicker] top pair good kicker (KQ) calls a typical player's all-in raise", (kq.call || 0) >= 18, JSON.stringify(kq));
    check("[kicker] the kicker matters: K3 folds more often than KQ", folds(k3) > folds(kq), `K3 ${JSON.stringify(k3)}, KQ ${JSON.stringify(kq)}`);
    const k3four = spot("[kicker] 4 players: K3 vs a typical check-raise all-in (tight at 4)", st4, "P3", "Kh 3c", "Kd 7c 2s",
        ['"P2 @ p2" folds', '"P3 @ p3" raises to 500', '"P0 @ p0" folds', '"P1 @ p1" calls 500', "Flop:  [K♦, 7♣, 2♠]",
         '"P1 @ p1" checks', '"P3 @ p3" bets 700', '"P1 @ p1" raises to 7500 and go all in'], "flop", TYPICAL);
    check("[kicker] 4 players: weak kicker folds to an all-in raise", folds(k3four) >= 18, JSON.stringify(k3four));
    check("[kicker] K3 still calls a maniac's all-in raise", (k3m.call || 0) >= 18, JSON.stringify(k3m));
    // The user saw a big bet with king high at 4 players, first to act. Bluffs stay small: <= ~55% pot, no all-in.
    const kh = spot("[air] 4 players, I called from the BB, first to act on Q-7-2 with K9 (king high)", st4, "P1", "Kh 9d", "Qs 7d 2c",
        ['"P2 @ p2" raises to 500', '"P3 @ p3" folds', '"P0 @ p0" folds', '"P1 @ p1" calls 500', "Flop:  [Q♠, 7♦, 2♣]"], "flop", TYPICAL);
    check("[air] 4 players: king high never bets big or all-in", !kh.all_in && sizedBets(kh, 56, 1000) === 0, JSON.stringify(kh));
}
// v1.14.0 hand recorder (docs/LEARNING_PIPELINE.md): a whole hand from made-up snapshots.
{
    const { HandRecorder, toHandLog } = require(`${B}/table/recorder.js`);
    const stats = require(`${B}/table/stats.js`);
    const seat = (name, n, stack, bet, extra = {}) => ({ name, seat: n, stack, bet, folded: false, dealer: false, isMe: false, cards: [], ...extra });
    let t = 0;
    const snap = (seats, board = [], myCards = ["A♥", "K♦"]) => ({ at: ++t, seats, board, myCards, bb: 100 });
    const flop = ["2♣", "7♦", "J♠"], turn = [...flop, "9♥"], river = [...turn, "4♣"];
    // Seats A (dealer), B (SB), C (BB), Me (first to act). Each line = what the page shows after one change.
    const seq = [
        snap([seat("A", 1, 1000, 0, { dealer: true }), seat("B", 2, 950, 50), seat("C", 3, 900, 100), seat("Me", 4, 1000, 0, { isMe: true })]),
        snap([seat("A", 1, 1000, 0, { dealer: true }), seat("B", 2, 950, 50), seat("C", 3, 900, 100), seat("Me", 4, 700, 300, { isMe: true })]),
        snap([seat("A", 1, 1000, 0, { dealer: true, folded: true }), seat("B", 2, 950, 50), seat("C", 3, 900, 100), seat("Me", 4, 700, 300, { isMe: true })]),
        snap([seat("A", 1, 1000, 0, { dealer: true, folded: true }), seat("B", 2, 950, 50, { folded: true }), seat("C", 3, 900, 100), seat("Me", 4, 700, 300, { isMe: true })]),
        snap([seat("A", 1, 1000, 0, { dealer: true, folded: true }), seat("B", 2, 950, 50, { folded: true }), seat("C", 3, 700, 300), seat("Me", 4, 700, 300, { isMe: true })]),
        snap([seat("A", 1, 1000, 0, { dealer: true, folded: true }), seat("B", 2, 950, 0, { folded: true }), seat("C", 3, 700, 0), seat("Me", 4, 700, 0, { isMe: true })], flop),
        snap([seat("A", 1, 1000, 0, { dealer: true, folded: true }), seat("B", 2, 950, 0, { folded: true }), seat("C", 3, 500, 200), seat("Me", 4, 700, 0, { isMe: true })], flop),
        snap([seat("A", 1, 1000, 0, { dealer: true, folded: true }), seat("B", 2, 950, 0, { folded: true }), seat("C", 3, 500, 200), seat("Me", 4, 500, 200, { isMe: true })], flop),
        snap([seat("A", 1, 1000, 0, { dealer: true, folded: true }), seat("B", 2, 950, 0, { folded: true }), seat("C", 3, 500, 0), seat("Me", 4, 500, 0, { isMe: true })], turn),
        snap([seat("A", 1, 1000, 0, { dealer: true, folded: true }), seat("B", 2, 950, 0, { folded: true }), seat("C", 3, 500, 0), seat("Me", 4, 500, 0, { isMe: true })], river),
        snap([seat("A", 1, 1000, 0, { dealer: true, folded: true }), seat("B", 2, 950, 0, { folded: true }), seat("C", 3, 0, 500), seat("Me", 4, 500, 0, { isMe: true })], river),
        snap([seat("A", 1, 1000, 0, { dealer: true, folded: true }), seat("B", 2, 950, 0, { folded: true }), seat("C", 3, 0, 500, { cards: ["Q♠", "Q♦"] }), seat("Me", 4, 0, 500, { isMe: true })], river),
        snap([seat("A", 1, 1000, 0, { dealer: true }), seat("B", 2, 950, 0), seat("C", 3, 0, 0, { cards: ["Q♠", "Q♦"] }), seat("Me", 4, 2050, 0, { isMe: true })], river),
        // Next hand: button moves to B, C is gone (busted), new blinds, new cards.
        snap([seat("A", 1, 900, 100), seat("B", 2, 950, 0, { dealer: true }), seat("Me", 4, 2000, 50, { isMe: true })], [], ["7♣", "7♠"]),
    ];
    const rec = new HandRecorder("test-game");
    let done = null;
    for (const s of seq) done = rec.observe(s) ?? done;
    const line = done ? done.actions.map(a => `${a.name} ${a.kind}${a.to ? " " + a.to : ""}`).join(", ") : "none";
    console.log(`\nrecorder: ${line}\n  clean: ${done && done.complete} ${done ? done.notes.join("; ") : ""}`);
    check("[recorder] hand tagged with the game type it was played as", done && done.gameType === "tournament", done && done.gameType);
    {
        const { splitByType } = require(`${B}/table/gameRecords.js`);
        const mk = (t) => ({ id: "x", game: "g", hands: [], ...(t ? { gameType: t } : {}) });
        const split = splitByType({ g: { game: "g", firstAt: 0, lastAt: 0, hands: [mk("cash"), mk("tournament"), mk("cash"), mk()] } });
        check("[recorder] export splits cash / tournament / untagged hands into separate files",
            split.cash.g.hands.length === 2 && split.tournament.g.hands.length === 1 && split.untagged.g.hands.length === 1,
            Object.keys(split).join(","));
    }
    check("[recorder] every action of a full hand, in order",
        line === "B sb 50, C bb 100, Me raise 300, A fold, B fold, C call 300, C bet 200, Me call 200, C check, Me check, C bet 500, Me call 500", line);
    check("[recorder] chips add up (clean), showdown cards and final stacks kept",
        done && done.complete && done.players.find(p => p.name === "C").cards.join(" ") === "Q♠ Q♦" &&
        done.players.find(p => p.name === "Me").end === 2050 && done.players.find(p => p.name === "C").end === 0, done && done.notes.join("; "));
    check("[recorder] the next hand started (button moved)", rec.current && rec.current.dealer === "B" && rec.current.myCards.join() === "7♣,7♠");
    stats.resetStats();
    const added = stats.addHand(toHandLog(done));
    const prof = stats.profile("screen:C", "C");
    check("[recorder] clean hand goes into the opponent profiles (matched by name)", added && prof.hands >= 1, `C: ${prof.hands} hand(s)`);
    // A broken hand (chips appear from nowhere) is kept but marked not clean.
    const bad = new HandRecorder("test-game-2");
    bad.observe(snap([seat("A", 1, 1000, 0, { dealer: true }), seat("B", 2, 950, 50), seat("Me", 3, 900, 100, { isMe: true })]));
    bad.observe(snap([seat("A", 1, 1000, 0, { dealer: true, folded: true }), seat("B", 2, 950, 50, { folded: true }), seat("Me", 3, 900, 100, { isMe: true })]));
    const broken = bad.observe(snap([seat("A", 1, 5000, 0), seat("B", 2, 900, 100, { dealer: true }), seat("Me", 3, 1000, 50, { isMe: true })], [], ["2♣", "3♣"]));
    check("[recorder] a hand whose chips don't add up is marked not clean", broken && !broken.complete, broken && broken.notes.join("; "));
    // Several players act between two snapshots (fast bots), and all-in bets still show after the board runs out.
    const fast = new HandRecorder("test-game-3");
    let fastDone = null;
    for (const s of [
        snap([seat("A", 1, 1000, 0, { dealer: true }), seat("B", 2, 950, 50), seat("C", 3, 900, 100), seat("Me", 4, 1000, 0, { isMe: true })]),
        snap([seat("A", 1, 1000, 0, { dealer: true }), seat("B", 2, 950, 50), seat("C", 3, 900, 100), seat("Me", 4, 700, 300, { isMe: true })]),
        snap([seat("A", 1, 1000, 0, { dealer: true, folded: true }), seat("B", 2, 950, 50, { folded: true }), seat("C", 3, 700, 300), seat("Me", 4, 700, 300, { isMe: true })]),
        snap([seat("A", 1, 1000, 0, { dealer: true, folded: true }), seat("B", 2, 950, 0, { folded: true }), seat("C", 3, 700, 0), seat("Me", 4, 700, 0, { isMe: true })], flop),
        snap([seat("A", 1, 1000, 0, { dealer: true, folded: true }), seat("B", 2, 950, 0, { folded: true }), seat("C", 3, 0, 700), seat("Me", 4, 0, 700, { isMe: true })], flop),
        snap([seat("A", 1, 1000, 0, { dealer: true, folded: true }), seat("B", 2, 950, 0, { folded: true }), seat("C", 3, 0, 700, { cards: ["J♣", "J♦"] }), seat("Me", 4, 0, 700, { isMe: true })], river),
        snap([seat("A", 1, 1000, 0, { dealer: true }), seat("B", 2, 950, 0), seat("C", 3, 2050, 0)], river, []),
        snap([seat("A", 1, 900, 100), seat("B", 2, 950, 0, { dealer: true }), seat("C", 3, 2000, 50)], [], []),
    ]) fastDone = fast.observe(s) ?? fastDone;
    const fastLine = fastDone ? fastDone.actions.map(a => `${a.name} ${a.kind}${a.to ? " " + a.to : ""}`).join(", ") : "none";
    check("[recorder] several actions between snapshots, all-in bets left on screen: recorded once, clean",
        fastLine === "B sb 50, C bb 100, Me raise 300, A fold, B fold, C call 300, C bet 700, Me call 700" && fastDone.complete,
        `${fastLine} | ${fastDone && fastDone.notes.join("; ")}`);
}
// v1.15.6 (real game, file 5 #26): facing an all-in bigger than our stack, the Call button shows no
// amount; the bot read "nothing to call" and its check became a fold of two pair.
{
    const el = (text, cls = "", kids = {}) => ({ textContent: text, disabled: false, classList: { contains: c => cls.split(" ").includes(c) },
        querySelector: s => kids[s] ?? null });
    const player = (bet, stack, me) => el("", me ? "table-player you-player" : "table-player",
        { ".table-player-bet-value .chips-value": el(String(bet)), ".table-player-stack .chips-value": el(String(stack)) });
    const page = (callText, checkEnabled, players) => ({
        querySelector: s => s === "button.call" ? (callText === null ? null : el(callText))
            : s === "button.check" ? (checkEnabled ? el("Check") : null) : null,
        querySelectorAll: s => s === ".table-player" ? players : [],
    });
    const { getToCallValue } = require(`${B}/ui.js`);
    const table = [player(1909, 0, false), player(0, 1291, true), player(0, 3000, false)];
    global.document = page("Call 1,909", false, table);
    check("[ui] call amount with a thousands separator", getToCallValue() === 1909, getToCallValue());
    global.document = page("All In", false, table);
    check("[ui] all-in call (button shows no amount): price read from the table, capped at our stack", getToCallValue() === 1291, getToCallValue());
    global.document = page(null, true, [player(0, 1291, true), player(0, 3000, false)]);
    check("[ui] nothing to call when we can check", getToCallValue() === 0, getToCallValue());
    delete global.document;
}
// v1.15.6 (real game, file 5 #14): careful rule dropped the best bet size (40%+ of the stack) and no
// smaller bet was left, so 87% equity checked the turn. Now a smaller bet is found.
{
    const msgs = ['-- starting hand #14 (id: h14) --',
        'Player stacks: #1 "Ana @ a" (1500) | #2 "Me @ me" (1844) | #3 "Pod @ p" (1500) | #4 "St @ s" (1500) | #5 "Mar @ m" (2200)',
        '"Ana @ a" posts a small blind of 50', '"Me @ me" posts a big blind of 100',
        '"Pod @ p" folds', '"St @ s" folds', '"Mar @ m" raises to 300', '"Ana @ a" folds', '"Me @ me" calls 300',
        'Flop:  [K♥, 2♥, J♦]', '"Me @ me" bets 451', '"Mar @ m" calls 451', 'Turn: K♥, 2♥, J♦ [5♦]'];
    const v = buildTableView(parseHand(msgs), "Me", 0);
    const card = t => ({ value: { name: t[0], code: "23456789TJQKA".indexOf(t[0]) + 2 }, suit: t[1] });
    const state = { hand: [card("K♣"), card("T♦")], board: ["K♥", "2♥", "J♦", "5♦"].map(card), toCall: 0,
        stack: v.me.stack, pot: v.pot, phase: { name: "turn", code: 2 }, bigBlind: 100 };
    const vil = v.players.find(p => p.name === "Mar");
    let bets = 0;
    for (let i = 0; i < 10; i++) {
        const d = postflopDecide(v, state, { preRanges: new Map([[vil.id, preflopRange(v, vil, TYPICAL)]]), profileOf: () => TYPICAL, callPressure: 0 });
        if (d.action.type === "raise" && d.action.amount - v.me.streetBet < 0.4 * v.me.stack) bets++;
    }
    check("[careful] top pair on a safe turn, 5 players: still value bets (under 40% of the stack)", bets >= 7, `${bets}/10`);
}
// v1.15.7 (real games: K4s and K3s all-ins into 3 players got 2 callers and busted us): overcalls.
{
    d = scenario("K4s in the SB, 5.6 BB, two limpers and the BB behind", [1500, 1500, 562, 2000], 2, "Kc 4c",
        ['"P2 @ p2" posts a small blind of 50', '"P3 @ p3" posts a big blind of 100', '"P0 @ p0" calls 100', '"P1 @ p1" calls 100'], 100);
    check("[overcall] K4s doesn't shove into two limpers + BB (they'd often both call)", d.action.type !== "raise", d.action.type);
    d = scenario("K3s in the SB, 5.9 BB, limper + raiser + BB", [2500, 3000, 1185, 860], 2, "Kc 3c",
        ['"P2 @ p2" posts a small blind of 100', '"P3 @ p3" posts a big blind of 200', '"P0 @ p0" calls 200', '"P1 @ p1" raises to 400']);
    check("[overcall] K3s doesn't re-shove over a raise with a limper in", d.action.type !== "raise", d.action.type);
    d = scenario("K3s in the SB, 5.9 BB, folded to me", [2500, 3000, 1185, 860], 2, "Kc 3c",
        ['"P2 @ p2" posts a small blind of 100', '"P3 @ p3" posts a big blind of 200', '"P0 @ p0" folds', '"P1 @ p1" folds']);
    check("[overcall] K3s still shoves when only the BB is left", d.action.type === "raise" && d.action.raiseAmount === "all_in", d.action.type);
}
if (todos) console.log(`\n${todos} REFORM target(s) still TODO (not failures)`);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
