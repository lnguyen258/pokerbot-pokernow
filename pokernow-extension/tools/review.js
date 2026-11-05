/**
 * Review recorded games (docs/LEARNING_PIPELINE.md, step 4).
 *
 *   npm run review                      newest pokerbot-games*.json in your Downloads folder
 *   npm run review -- path/to/file.json
 *
 * Writes tools/reviews/review-<date>.md and prints the headline numbers.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

function newestDownload() {
    const dir = path.join(os.homedir(), "Downloads");
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter(f => /^pokerbot-games.*\.json$/i.test(f))
        .map(f => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    return files[0]?.f ?? null;
}

const file = process.argv[2] || newestDownload();
if (!file || !fs.existsSync(file)) {
    console.error("No file. Download it from the popup (Recorded games -> Download games), then: npm run review -- <file>");
    process.exit(1);
}
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const games = Object.values(data.games ?? data);
const hands = games.flatMap(g => g.hands ?? []);

// ---- helpers
const LATE_TO_EARLY = ["BTN", "CO", "HJ", "LJ", "MP", "UTG+1"];
function positionOf(h, name) {
    const ps = [...h.players].sort((a, b) => a.seat - b.seat);
    const n = ps.length;
    const d = Math.max(0, ps.findIndex(p => p.name === h.dealer));
    const i = ps.findIndex(p => p.name === name);
    if (i < 0) return "?";
    const rel = (i - d + n) % n;                     // 0 = button, 1 = SB, 2 = BB, ...
    if (n === 2) return rel === 0 ? "BTN/SB" : "BB";
    if (rel === 1) return "SB";
    if (rel === 2) return "BB";
    if (rel === 0) return "BTN";
    const fromButton = n - rel, nonBlind = n - 2;
    return rel === 3 && nonBlind >= 3 ? "UTG" : LATE_TO_EARLY[fromButton] ?? `EP${rel}`;
}
const me = h => h.players.find(p => p.isMe);
const net = (h, p) => ((p.end ?? 0) - p.start) / (h.bb || 1);       // in big blinds
const vpip = (h, name) => h.actions.some(a => a.name === name && a.street === "preflop" && ["call", "raise", "bet"].includes(a.kind));
const pfr = (h, name) => h.actions.some(a => a.name === name && a.street === "preflop" && a.kind === "raise");
function actionLine(h) {
    const out = [];
    let street = "";
    for (const a of h.actions) {
        if (a.street !== street) {
            street = a.street;
            const b = street === "flop" ? h.board.slice(0, 3) : street === "turn" ? h.board.slice(0, 4) : street === "river" ? h.board : [];
            out.push(`**${street}**${b.length ? " [" + b.join(" ") + "]" : ""}:`);
        }
        out.push(`${a.name} ${a.kind}${a.to ? " " + a.to : ""}${a.allIn ? " (all-in)" : ""}`);
    }
    return out.join(" ");
}
const pct = (x, n) => n ? `${Math.round(100 * x / n)}%` : "-";
const fmt = x => (x >= 0 ? "+" : "") + x.toFixed(1);

// ---- my results
const mine = hands.filter(h => me(h));
const clean = hands.filter(h => h.complete);
const totalBB = mine.reduce((a, h) => a + net(h, me(h)), 0);
function group(keyOf) {
    const m = new Map();
    for (const h of mine) {
        const k = keyOf(h);
        const g = m.get(k) ?? { hands: 0, bb: 0, vpip: 0, pfr: 0 };
        g.hands++; g.bb += net(h, me(h));
        if (vpip(h, me(h).name)) g.vpip++;
        if (pfr(h, me(h).name)) g.pfr++;
        m.set(k, g);
    }
    return m;
}
const ORDER = ["UTG", "UTG+1", "MP", "LJ", "HJ", "CO", "BTN", "SB", "BB", "BTN/SB"];
const byPos = [...group(h => positionOf(h, me(h).name)).entries()].sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
const bySize = [...group(h => h.players.length).entries()].sort((a, b) => b[0] - a[0]);
const table = rows => ["| | Hands | Net BB | BB/100 | VPIP | PFR |", "|---|---|---|---|---|---|",
    ...rows.map(([k, g]) => `| ${k} | ${g.hands} | ${fmt(g.bb)} | ${fmt(100 * g.bb / g.hands)} | ${pct(g.vpip, g.hands)} | ${pct(g.pfr, g.hands)} |`)].join("\n");

function handBlock(h) {
    const m = me(h);
    const lines = [
        `- **${m.cards?.join(" ") ?? "?"}** in ${positionOf(h, m.name)}, ${h.players.length} players, ${fmt(net(h, m))} BB` +
        `${h.complete ? "" : " (not clean)"} (game ${h.game}, hand ${h.number})`,
        `  - ${actionLine(h)}`,
    ];
    const shown = h.players.filter(p => !p.isMe && p.cards?.length);
    if (shown.length) lines.push(`  - shown: ${shown.map(p => `${p.name} ${p.cards.join(" ")}`).join(", ")}`);
    for (const d of h.decisions ?? []) lines.push(`  - bot: ${d.action}, because ${String(d.why).slice(0, 400)}`);
    return lines.join("\n");
}

const biggestLosses = [...mine].sort((a, b) => net(a, me(a)) - net(b, me(b))).slice(0, 10).filter(h => net(h, me(h)) < 0);
const myAllIns = mine.filter(h => h.actions.some(a => a.name === me(h).name && a.allIn));
const showdowns = hands.filter(h => h.players.some(p => !p.isMe && p.cards?.length));

// ---- opponents
const opp = new Map();
for (const h of clean) for (const p of h.players) {
    if (p.isMe) continue;
    const o = opp.get(p.name) ?? { hands: 0, vpip: 0, pfr: 0, aggr: 0, passive: 0, shown: [] };
    o.hands++;
    if (vpip(h, p.name)) o.vpip++;
    if (pfr(h, p.name)) o.pfr++;
    for (const a of h.actions) if (a.name === p.name && a.street !== "preflop") {
        if (a.kind === "bet" || a.kind === "raise") o.aggr++;
        else if (a.kind === "call") o.passive++;
    }
    if (p.cards?.length) o.shown.push(p.cards.join(" "));
    opp.set(p.name, o);
}
const oppRows = [...opp.entries()].sort((a, b) => b[1].hands - a[1].hands).slice(0, 30).map(([name, o]) =>
    `| ${name} | ${o.hands} | ${pct(o.vpip, o.hands)} | ${pct(o.pfr, o.hands)} | ${o.aggr + o.passive ? (o.aggr / Math.max(1, o.passive)).toFixed(1) : "-"} | ${o.shown.slice(0, 4).join(", ")} |`);

const notClean = hands.filter(h => !h.complete);
const reasons = new Map();
for (const h of notClean) for (const n of h.notes ?? []) { const k = n.replace(/\d+/g, "N"); reasons.set(k, (reasons.get(k) ?? 0) + 1); }

const report = `# Bot review: ${path.basename(file)}

Generated ${new Date().toLocaleString()} from ${games.length} game(s), ${hands.length} hands
(${clean.length} clean = ${pct(clean.length, hands.length)}). Exported by extension v${data.version ?? "?"}.

## Headline
- Hands we were dealt: **${mine.length}**. Net: **${fmt(totalBB)} BB**, **${fmt(mine.length ? 100 * totalBB / mine.length : 0)} BB/100 hands**.
- Our all-ins: ${myAllIns.length}. Showdowns seen: ${showdowns.length}.

## By seat
${table(byPos)}

## By players at the table
${table(bySize.map(([k, g]) => [`${k} players`, g]))}

## Biggest losses
${biggestLosses.map(handBlock).join("\n") || "None."}

## Our all-ins
${myAllIns.slice(0, 20).map(handBlock).join("\n") || "None."}

## Showdowns (what opponents had)
${showdowns.slice(0, 20).map(handBlock).join("\n") || "None."}

## Opponents (clean hands)
| Player | Hands | VPIP | PFR | Bets per call after flop | Shown |
|---|---|---|---|---|---|
${oppRows.join("\n") || "| - | | | | | |"}

## Recording quality
${notClean.length} hand(s) not clean. ${[...reasons.entries()].map(([k, n]) => `${n}x ${k}`).join("; ") || ""}
`;

const outDir = path.join(__dirname, "reviews");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `review-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`);
fs.writeFileSync(out, report);
console.log(`${games.length} game(s), ${hands.length} hands (${clean.length} clean), dealt ${mine.length}: ` +
    `${fmt(totalBB)} BB, ${fmt(mine.length ? 100 * totalBB / mine.length : 0)} BB/100`);
console.log("By seat: " + byPos.map(([k, g]) => `${k} ${fmt(100 * g.bb / g.hands)}`).join(" | "));
console.log(`Report: ${out}`);
