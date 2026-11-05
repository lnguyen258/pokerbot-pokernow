/**
 * Plays many 8-player Sit & Gos and reports tournament points per bot type.
 *
 *   npm run sim -- --tournaments 50 --seats smart,smart,equity,equity,station,maniac,nit,random
 *
 * Seats are shuffled every tournament. Points use CONFIG.payouts.
 * The +- is a 95% confidence interval: if two bots' intervals overlap a lot,
 * the sample is too small to say which is better.
 */
import { CONFIG } from "../config";
import { parseHand } from "../table/logReader";
import { addHand, resetStats } from "../table/stats";
import { HandResult, playTournament, SimBot } from "./engine";
import { TablePhase, phaseForPlayers } from "../table/tableView";
import * as fs from "fs";
import * as path from "path";
import { BOT_TYPES } from "./bots";

export type Score = { points: number[], places: number[] };

/** Chips won or lost (in big blinds) per bot type and table phase, and how many hands were dealt. */
export type PhaseStats = Map<string, Map<TablePhase, { bb: number, hands: number }>>;
export const PHASES: TablePhase[] = ["full", "conservative", "normal", "creative", "headsUp"];

export function recordPhases(stats: PhaseStats, r: HandResult, typeOf: (label: string) => string) {
    const phase = phaseForPlayers(r.players);
    for (const d of r.deltas) {
        const byPhase = stats.get(typeOf(d.label)) ?? new Map();
        const cell = byPhase.get(phase) ?? { bb: 0, hands: 0 };
        cell.bb += d.chips / r.bb;
        cell.hands++;
        byPhase.set(phase, cell);
        stats.set(typeOf(d.label), byPhase);
    }
}

export function runTournaments(makeBots: () => SimBot[], count: number,
    typeOf: (label: string) => string, progress = true, memory = false, phases?: PhaseStats): Map<string, Score> {
    const scores = new Map<string, Score>();
    const started = Date.now();
    for (let t = 0; t < count; t++) {
        if (!memory) resetStats();          // opponents are strangers each tournament
        const bots = makeBots();
        for (let i = bots.length - 1; i > 0; i--) {                 // shuffle seats
            const j = Math.floor(Math.random() * (i + 1));
            [bots[i], bots[j]] = [bots[j], bots[i]];
        }
        const result = playTournament(bots, undefined, log => addHand(parseHand(log)),
            phases ? r => recordPhases(phases, r, typeOf) : undefined);
        for (const [label, place] of result.places) {
            const s = scores.get(typeOf(label)) ?? { points: [], places: [] };
            s.points.push(CONFIG.payouts[place - 1] ?? 0);
            s.places.push(place);
            scores.set(typeOf(label), s);
        }
        if (progress && ((t + 1) % Math.max(1, Math.floor(count / 10)) === 0 || t + 1 === count)) {
            const secs = (Date.now() - started) / 1000;
            process.stdout.write(`  ${t + 1}/${count} tournaments, ${secs.toFixed(0)}s\n`);
        }
    }
    return scores;
}

export function summarize(s: Score) {
    const n = s.points.length;
    const mean = s.points.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(s.points.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
    return {
        n, mean, ci: 1.96 * sd / Math.sqrt(n),
        avgPlace: s.places.reduce((a, b) => a + b, 0) / n,
        top4: s.places.filter(p => p <= 4).length / n,
        wins: s.places.filter(p => p === 1).length / n,
    };
}

export function printTable(scores: Map<string, Score>) {
    const rows = [...scores.entries()].map(([type, s]) => ({ type, ...summarize(s) }))
        .sort((a, b) => b.mean - a.mean);
    console.log("\n  bot          points/tournament      avg place   top 4    wins   (seats played)");
    for (const r of rows)
        console.log(`  ${r.type.padEnd(12)} ${(r.mean >= 0 ? "+" : "") + r.mean.toFixed(1)} ± ${r.ci.toFixed(1)}`.padEnd(38) +
            `${r.avgPlace.toFixed(2).padStart(6)}   ${(r.top4 * 100).toFixed(0).padStart(4)}%   ${(r.wins * 100).toFixed(0).padStart(4)}%   (${r.n})`);
}

/** Big blinds won per 100 hands dealt, by table phase (where each bot wins and loses chips). */
export function printPhases(stats: PhaseStats, order: string[]) {
    console.log("\n  bb won per 100 hands dealt, by players left (hands dealt in brackets)");
    console.log("  bot          " + ["full 6-8", "conserv. 5", "normal 4", "creative 3", "heads-up 2"].map(h => h.padStart(16)).join(""));
    for (const type of order) {
        const byPhase = stats.get(type);
        if (!byPhase) continue;
        console.log(`  ${type.padEnd(12)} ` + PHASES.map(ph => {
            const c = byPhase.get(ph);
            if (!c || !c.hands) return "-".padStart(16);
            const v = 100 * c.bb / c.hands;
            return `${(v >= 0 ? "+" : "") + v.toFixed(0)} (${c.hands})`.padStart(16);
        }).join(""));
    }
}

function arg(name: string, fallback: string) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (require.main === module) {
    console.log = (() => {}) as typeof console.log;      // silence the bots' decision logs
    const out = (s: string) => process.stdout.write(s + "\n");
    const count = parseInt(arg("tournaments", "20"));
    const seatTypes = arg("seats", "smart,smart,equity,equity,station,maniac,nit,random").split(",");
    out(`Playing ${count} Sit & Gos, seats: ${seatTypes.join(", ")}`);
    out(`Payouts 1st..8th: ${CONFIG.payouts.join(" / ")}`);
    const phases: PhaseStats = new Map();
    const scores = runTournaments(
        () => seatTypes.map((t, i) => BOT_TYPES[t](`${t}${i + 1}`)),
        count, label => label.replace(/\d+$/, ""), true, process.argv.includes("--memory"), phases);
    console.log = out as typeof console.log;
    printTable(scores);
    const order = [...scores.entries()].sort((a, b) => summarize(b[1]).mean - summarize(a[1]).mean).map(([t]) => t);
    printPhases(phases, order);
    // --save <name>: keep the numbers in tools/sim-results/<name>.json (baselines to compare against later).
    const save = arg("save", "");
    if (save) {
        const file = path.join(__dirname, "../../sim-results", `${save}.json`);
        fs.writeFileSync(file, JSON.stringify({
            date: new Date().toISOString(), tournaments: count, seats: seatTypes, payouts: CONFIG.payouts,
            bots: Object.fromEntries(order.map(t => [t, {
                ...summarize(scores.get(t)!),
                bbPer100ByPhase: Object.fromEntries(PHASES.map(ph => {
                    const c = phases.get(t)?.get(ph);
                    return [ph, c && c.hands ? { bbPer100: 100 * c.bb / c.hands, hands: c.hands } : null];
                })),
            }])),
        }, null, 2));
        out(`\n  saved ${file}`);
    }
}
