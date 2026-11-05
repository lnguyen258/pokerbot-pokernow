/**
 * Cash game evolution: tunes the smart bot's settings for the user's cash table.
 *
 * Every generation, every candidate plays the bot's seat on the SAME deals (duplicate
 * test: seeded cards, seats, button and decisions), against the default table (sharks,
 * fish, equity bots, a nit). A candidate's score is how many bb/100 it wins MORE than the
 * starting settings on those exact deals, so card luck mostly cancels out. Scores carry
 * over between generations with a decay. The best survive and breed (mix + small random
 * changes); the starting settings always stay as the yardstick.
 *
 * At the end, a playoff on many fresh deals: the best candidates, the starting settings,
 * v1.9.0's fixed sizes ("fixed") and the old button sizes ("old").
 *
 *   npm run evolve-cash -- --generations 40
 *   npm run evolve-cash -- --resume                  # continue after a stop
 *   npm run evolve-cash -- --final-sessions 400      # bigger playoff
 *
 * Progress is saved after every generation to tools/sim-results/evolution-cash.json.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CONFIG } from "../config";
import { Genes } from "./bots";
import { CASH_DEFAULTS, DEFAULT_POOL, VARIANTS, runCash } from "./cash";
import { SPACE } from "./tune";

type Knobbed = Record<string, number>;
type Genome = { id: string, tuning: Genes, born: number, parents: string[], sum: number, sq: number, n: number };
type Save = {
    settings: Record<string, number>, generation: number, nextId: number, population: Genome[],
    history: object[], hall: { id: string, tuning: Genes, generation: number, edge: number }[], playoff?: object,
};

// Tournament-only knobs don't matter at a cash table.
const ACTIVE: Record<string, [number, number]> = Object.fromEntries(
    Object.entries(SPACE).filter(([k]) => k !== "openSizeBB"));
const KNOBS = Object.keys(ACTIVE);
const DECAY = 0.6;

function arg(name: string, fallback: string) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const gaussian = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const edge = (g: Genome) => g.n ? g.sum / g.n : 0;
const edgeCi = (g: Genome) => {
    if (g.n < 2) return 999;
    const m = g.sum / g.n;
    return 1.96 * Math.sqrt(Math.max(0, g.sq / g.n - m * m) / g.n);
};

function mutate(t: Genes, strength: number): Genes {
    const next = { ...t } as Genes & Knobbed;
    const count = 1 + Math.floor(Math.random() * 3);
    for (let k = 0; k < count; k++) {
        const knob = KNOBS[Math.floor(Math.random() * KNOBS.length)];
        const [lo, hi] = ACTIVE[knob];
        next[knob] = round3(Math.min(hi, Math.max(lo, next[knob] + gaussian() * strength * (hi - lo))));
    }
    return next;
}

function crossover(a: Genes, b: Genes): Genes {
    const child = { ...a } as Genes & Knobbed;
    for (const k of KNOBS) if (Math.random() < 0.5) child[k] = (b as Genes & Knobbed)[k];
    return child;
}

function changes(t: Genes, base: Genes): string {
    const a = t as Genes & Knobbed, b = base as Genes & Knobbed;
    return KNOBS.filter(k => Math.abs(a[k] - b[k]) > 1e-9).map(k => `${k} ${b[k]}->${a[k]}`).join(", ") || "(original)";
}

/** bb/100 per (seed, variant) from duplicate results. */
function perSeed(results: [string, number][][], count: number): number[][] {
    const toBb100 = (chips: number) => chips / CASH_DEFAULTS.bb / CASH_DEFAULTS.sessionHands * 100;
    return results.map(r => Array.from({ length: count }, (_, i) => toBb100(r[i][1])));
}

async function main() {
    const out = (s: string) => process.stdout.write(s + "\n");
    const dir = path.join(__dirname, "..", "..", "sim-results");
    const file = path.join(dir, "evolution-cash.json");
    fs.mkdirSync(dir, { recursive: true });
    const resume = process.argv.includes("--resume") && fs.existsSync(file);
    const saved: Save | null = resume ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    const settings = saved?.settings ?? {
        generations: parseInt(arg("generations", "40")),
        population: parseInt(arg("population", "12")),
        sessions: parseInt(arg("sessions", "16")),           // 300-hand sessions per candidate per generation
        elites: parseInt(arg("elites", "4")),
        finalSessions: parseInt(arg("final-sessions", "200")),
        sims: parseInt(arg("sims", "400")),
        seed: parseInt(arg("seed", String(Math.floor(Math.random() * 1e6)))),
    };
    const workerCount = parseInt(arg("workers", String(Math.max(1, os.cpus().length - 2))));
    const pool = DEFAULT_POOL.map(t => t === "smart" ? "hero" : t);
    const original: Genes = { ...CONFIG.tuning, ...CONFIG.population, preflopSizing: 2, postflopSizing: 2 };

    let generation = saved?.generation ?? 0;
    let nextId = saved?.nextId ?? 1;
    const history: object[] = saved?.history ?? [];
    const hall = saved?.hall ?? [];
    const newGenome = (tuning: Genes, parents: string[], id = `c${nextId++}`): Genome =>
        ({ id, tuning, born: generation, parents, sum: 0, sq: 0, n: 0 });
    let population: Genome[] = saved?.population ?? [
        newGenome(original, [], "original"),
        ...Array.from({ length: settings.population - 1 }, () => newGenome(mutate(original, 0.2), ["original"])),
    ];
    const save = (extra: Partial<Save> = {}) => fs.writeFileSync(file, JSON.stringify(
        { settings, generation, nextId, population, history, hall, ...extra } as Save, null, 1));

    out(`Cash evolution: ${settings.generations} generations, population ${settings.population}, ` +
        `${settings.sessions} x ${CASH_DEFAULTS.sessionHands} hands per candidate per generation (same deals for all), ` +
        `${workerCount} workers.${resume ? ` Resuming after generation ${generation}.` : ""}`);
    out(`Table: ${pool.join(", ")}. Knobs: ${KNOBS.join(", ")}. Saving to tools/sim-results/evolution-cash.json`);
    const started = Date.now(), genAtStart = generation;

    while (generation < settings.generations) {
        generation++;
        const t0 = Date.now();
        const seed = settings.seed + generation * 100003;
        const results = await runCash(pool, settings.sessions, CASH_DEFAULTS, workerCount, undefined,
            { variants: population.map(g => g.tuning), seed, sims: settings.sims });
        const rows = perSeed(results, population.length);
        const origIndex = population.findIndex(g => g.id === "original");
        population.forEach((g, i) => {
            const diffs = rows.map(r => r[i] - r[origIndex]);       // vs the original on the same deals
            g.sum = g.sum * DECAY + diffs.reduce((a, b) => a + b, 0);
            g.sq = g.sq * DECAY + diffs.reduce((a, b) => a + b * b, 0);
            g.n = g.n * DECAY + diffs.length;
        });
        const origMean = rows.reduce((a, r) => a + r[origIndex], 0) / rows.length;
        const ranked = [...population].sort((a, b) => edge(b) - edge(a));
        const best = ranked[0];
        hall.push({ id: best.id, tuning: best.tuning, generation, edge: round3(edge(best)) });
        const per = (Date.now() - started) / 1000 / (generation - genAtStart);
        out(`gen ${generation}/${settings.generations} (${((Date.now() - t0) / 1000).toFixed(0)}s, ` +
            `~${(per * (settings.generations - generation) / 60).toFixed(0)} min left): original ${origMean >= 0 ? "+" : ""}${origMean.toFixed(0)} bb/100; ` +
            `best ${best.id} ${edge(best) >= 0 ? "+" : ""}${edge(best).toFixed(1)} ± ${edgeCi(best).toFixed(1)} vs original | ${changes(best.tuning, original)}`);
        history.push({ generation, seed, originalBb100: round3(origMean), ranking: ranked.map(g => [g.id, round3(edge(g))]) });

        if (generation < settings.generations) {
            const elites = ranked.filter(g => g.id !== "original").slice(0, settings.elites);
            const strength = Math.max(0.04, 0.15 * (1 - generation / settings.generations));
            const pick = () => {
                const a = elites[Math.floor(Math.random() * elites.length)];
                const b = elites[Math.floor(Math.random() * elites.length)];
                return edge(a) >= edge(b) ? a : b;
            };
            const children: Genome[] = [];
            while (1 + elites.length + children.length < settings.population) {
                const a = pick(), b = pick();
                const child = Math.random() < 0.5 && a !== b ? crossover(a.tuning, b.tuning) : { ...a.tuning };
                children.push(newGenome(mutate(child, strength), a === b ? [a.id] : [a.id, b.id]));
            }
            population = [population[origIndex], ...elites, ...children];
        }
        save();
    }

    // ---- Playoff on fresh deals: top candidates + yardsticks.
    const candidates = new Map<string, Genes>();
    const ranked = population.filter(g => g.id !== "original" && g.n > 0).sort((a, b) => edge(b) - edge(a));
    for (const g of ranked.slice(0, 4)) candidates.set(g.id, g.tuning);
    for (const h of [...hall].sort((a, b) => b.edge - a.edge))
        if (candidates.size < 6 && !candidates.has(h.id)) candidates.set(h.id, h.tuning);
    candidates.set("original", original);
    candidates.set("fixed (v1.9.0)", { ...original, ...VARIANTS.fixed });
    candidates.set("old buttons", { ...original, ...VARIANTS.old });
    const names = [...candidates.keys()];
    out(`\nPlayoff: ${names.join(", ")}; ${settings.finalSessions} x ${CASH_DEFAULTS.sessionHands} hands each on the same fresh deals ` +
        `(full ${CONFIG.tuning.postflopSims} postflop simulations).`);
    const results = await runCash(pool, settings.finalSessions, CASH_DEFAULTS, workerCount, undefined,
        { variants: [...candidates.values()], seed: settings.seed + 999999937 });
    const rows = perSeed(results, names.length);
    const oi = names.indexOf("original");
    const table = names.map((id, i) => {
        const xs = rows.map(r => r[i]), ds = rows.map(r => r[i] - r[oi]);
        const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
        const ci = (v: number[]) => { const m = mean(v); return 1.96 * Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1) / v.length); };
        return { id, bb100: round3(mean(xs)), vsOriginal: round3(mean(ds)), ci: round3(ci(ds)) };
    }).sort((a, b) => b.bb100 - a.bb100);
    out(`\n  ${"settings".padEnd(16)} ${"bb/100".padStart(8)}   vs original (same deals)`);
    for (const r of table)
        out(`  ${r.id.padEnd(16)} ${(r.bb100 >= 0 ? "+" : "") + r.bb100.toFixed(1).padStart(7)}   ` +
            (r.id === "original" ? "-" : `${r.vsOriginal >= 0 ? "+" : ""}${r.vsOriginal.toFixed(1)} ± ${r.ci.toFixed(1)}`) +
            (candidates.has(r.id) && !["original", "fixed (v1.9.0)", "old buttons"].includes(r.id) ? `   ${changes(candidates.get(r.id)!, original)}` : ""));
    const winner = table[0];
    out(`\nWinner: ${winner.id}` + (winner.id !== "original" ? `, ${winner.vsOriginal >= 0 ? "+" : ""}${winner.vsOriginal} ± ${winner.ci} bb/100 vs original` : ""));
    save({ playoff: { date: new Date().toISOString(), table, winner: winner.id, bestTuning: candidates.get(winner.id) } });
    out("Saved to tools/sim-results/evolution-cash.json");
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
