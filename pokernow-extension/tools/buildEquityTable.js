/**
 * Builds the 169 x 169 preflop equity table: how often each starting-hand type
 * beats each other one (ties count half). Used by the preflop brain and by the
 * Python push/fold solver.
 *
 * Run from pokernow-extension/:
 *   npx tsc src/types.d.ts src/ai/equity/evaluator.ts --outDir tools/.build --module commonjs --target es2019 --skipLibCheck
 *   node tools/buildEquityTable.js
 */
const fs = require("fs");
const path = require("path");
const { evaluate } = require("./.build/evaluator.js");

const RANKS = "23456789TJQKA";
const SIMS = 3000;

// The 169 hand types, strongest-looking first (AA, AKs, AKo, ... ), and their combos.
const classes = [];
for (let hi = 12; hi >= 0; hi--) {
    for (let lo = hi; lo >= 0; lo--) {
        if (hi === lo) classes.push(RANKS[hi] + RANKS[lo]);
        else classes.push(RANKS[hi] + RANKS[lo] + "s", RANKS[hi] + RANKS[lo] + "o");
    }
}
function combosOf(cls) {
    const hi = RANKS.indexOf(cls[0]), lo = RANKS.indexOf(cls[1]);
    const out = [];
    for (let s1 = 0; s1 < 4; s1++)
        for (let s2 = 0; s2 < 4; s2++) {
            if (cls.length === 2 ? s2 <= s1 : cls[2] === "s" ? s1 !== s2 : s1 === s2) continue;
            out.push([hi * 4 + s1, lo * 4 + s2]);
        }
    return out;
}
const combos = classes.map(combosOf);

function matchup(i, j) {
    let total = 0, n = 0;
    const deck = new Array(52);
    while (n < SIMS) {
        const a = combos[i][Math.floor(Math.random() * combos[i].length)];
        const b = combos[j][Math.floor(Math.random() * combos[j].length)];
        if (a[0] === b[0] || a[0] === b[1] || a[1] === b[0] || a[1] === b[1]) continue;
        let k = 0;
        for (let c = 0; c < 52; c++)
            if (c !== a[0] && c !== a[1] && c !== b[0] && c !== b[1]) deck[k++] = c;
        for (let x = 0; x < 5; x++) {
            const y = x + Math.floor(Math.random() * (k - x));
            const t = deck[x]; deck[x] = deck[y]; deck[y] = t;
        }
        const board = deck.slice(0, 5);
        const ea = evaluate(a.concat(board)), eb = evaluate(b.concat(board));
        total += ea > eb ? 1 : ea === eb ? 0.5 : 0;
        n++;
    }
    return total / SIMS;
}

const t0 = Date.now();
const eq = classes.map(() => new Array(169).fill(0.5));
for (let i = 0; i < 169; i++) {
    for (let j = i + 1; j < 169; j++) {
        const e = matchup(i, j);
        eq[i][j] = Math.round(e * 10000) / 10000;
        eq[j][i] = Math.round((1 - e) * 10000) / 10000;
    }
    for (let j = i; j <= i; j++)                     // same type vs itself
        eq[i][i] = 0.5;
}
const out = { classes, combos: classes.map(c => combosOf(c).length), equity: eq };
for (const dir of ["src/ai/data", "../holdem"]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "equity169.json"), JSON.stringify(out));
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
const idx = c => classes.indexOf(c);
console.log("AA vs KK", eq[idx("AA")][idx("KK")], " AKs vs QQ", eq[idx("AKs")][idx("QQ")],
    " 22 vs AKo", eq[idx("22")][idx("AKo")], " 72o vs AA", eq[idx("72o")][idx("AA")]);
