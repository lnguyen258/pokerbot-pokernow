/**
 * Evolution by self-play: a population of smart bots, each with its own
 * strategy settings (CONFIG.tuning), plays thousands of 8-player Sit & Gos
 * against each other. After each generation the best scorers survive and
 * breed (mix their settings + small random changes); the worst are replaced.
 * The original settings stay in the population as a fixed yardstick.
 *
 * At the end, a playoff ("showdown") puts the best candidates of the whole
 * run, plus the original, at the same tables for a large final match, and
 * names the winner.
 *
 *   npm run evolve -- --tournaments 100000                  # 8 evolving bots per table
 *   npm run evolve -- --tournaments 100000 --fish 2         # 6 evolving bots + 2 fish per table
 *   npm run evolve -- --resume                              # continue after a stop
 *   npm run evolve -- --mode shark --tournaments 10000      # shark mode: 5 evolving + 3 sharks
 *
 * Shark mode evolves the settings for tables of STRONG players: the fixed seats are
 * "sharks" (the normal bot's tuning without the beginner reads: theory shove ranges
 * and bluffing), the starting point is the same, and the evolution also tunes how
 * much bluffing and how wide a shove range to expect (bluffBelief, bigBetRange).
 *
 * Tournaments run in parallel on all CPU cores but two. Progress is saved after
 * every generation to tools/sim-results/evolution.json (shark mode: evolution-shark.json).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Worker, isMainThread, parentPort } from "worker_threads";
import { CONFIG, SHARK_MODE } from "../config";
import { parseHand } from "../table/logReader";
import { addHand, resetStats } from "../table/stats";
import { playTournament } from "./engine";
import { Genes, fishBot, smartBot } from "./bots";
import { SPACE } from "./tune";

type Tuning = Genes;                                          // a bot's full settings

/** Extra knobs in shark mode: how opponents are read. */
const SHARK_SPACE: Record<string, [number, number]> = {
    bigBetRange: [0.05, 1],          // 1 = no cap on the theory shove range
    bluffBelief: [0.3, 1],           // 1 = full theory bluffing
};

// ---------------------------------------------------------------- worker side

type SeatSpec = { label: string, tuning: Partial<Tuning> | null };     // null = fish
type Job = { id: number, tables: SeatSpec[][] };
type JobResult = { id: number, places: [string, number][][] };

function workerMain() {
    console.log = (() => {}) as typeof console.log;           // silence decision logs
    console.warn = (() => {}) as typeof console.warn;
    console.error = (() => {}) as typeof console.error;
    parentPort!.on("message", (job: Job) => {
        const places = job.tables.map(table => {
            resetStats();                                     // strangers each tournament
            const bots = table.map(s => s.tuning ? smartBot(s.label, s.tuning) : fishBot(s.label));
            for (let i = bots.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [bots[i], bots[j]] = [bots[j], bots[i]];
            }
            const result = playTournament(bots, undefined, log => addHand(parseHand(log)));
            return [...result.places.entries()];
        });
        parentPort!.postMessage({ id: job.id, places } as JobResult);
    });
}

// ---------------------------------------------------------------- main side

type Genome = {
    id: string, tuning: Tuning, born: number, parents: string[],
    pts: number, sq: number, n: number,               // recency-weighted points, squares, tournaments
    lifetimePts: number, lifetimeN: number,
};
type HallEntry = { id: string, tuning: Tuning, generation: number, fitness: number, se: number, n: number };
type Save = {
    settings: Record<string, number>, generation: number, played: number, nextId: number,
    population: Genome[], hall: HallEntry[], history: object[], playoff?: object,
};

// The knobs being evolved (set in main: shark mode adds SHARK_SPACE).
let ACTIVE: Record<string, [number, number]> = { ...SPACE };
let KNOBS: string[] = Object.keys(ACTIVE);
type Knobbed = Record<string, number>;
const DECAY = 0.7;               // a genome's older generations count less (the field keeps changing)
const SEATS = 8;

function arg(name: string, fallback: string) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const gaussian = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const fitness = (g: Genome) => g.n ? g.pts / g.n : 0;
const stdErr = (g: Genome) => {
    if (g.n < 2) return 99;
    const mean = g.pts / g.n;
    return Math.sqrt(Math.max(0, g.sq / g.n - mean * mean) / g.n);
};

function mutate(t: Tuning, strength: number): Tuning {
    const next = { ...t } as Tuning & Knobbed;
    const count = 1 + Math.floor(Math.random() * 2);
    for (let k = 0; k < count; k++) {
        const knob = KNOBS[Math.floor(Math.random() * KNOBS.length)];
        const [lo, hi] = ACTIVE[knob];
        next[knob] = round3(Math.min(hi, Math.max(lo, next[knob] + gaussian() * strength * (hi - lo))));
    }
    return next;
}

function crossover(a: Tuning, b: Tuning): Tuning {
    const child = { ...a } as Tuning & Knobbed;
    for (const k of KNOBS) if (Math.random() < 0.5) child[k] = (b as Tuning & Knobbed)[k];
    return child;
}

function describeChanges(t: Tuning, base: Tuning): string {
    const a = t as Tuning & Knobbed, b = base as Tuning & Knobbed;
    return KNOBS.filter(k => Math.abs(a[k] - b[k]) > 1e-9).map(k => `${k} ${b[k]}->${a[k]}`).join(", ") || "(original)";
}

/** Plays the tables on all workers; returns places per table. */
function runParallel(workers: Worker[], tables: SeatSpec[][], chunk: number): Promise<[string, number][][]> {
    return new Promise((resolve, reject) => {
        const results: [string, number][][] = [];
        let next = 0, pending = 0, jobId = 0;
        const give = (w: Worker) => {
            if (next >= tables.length) {
                if (pending === 0) resolve(results);
                return;
            }
            const slice = tables.slice(next, next + chunk);
            next += slice.length;
            pending++;
            w.postMessage({ id: jobId++, tables: slice } as Job);
        };
        for (const w of workers) {
            w.removeAllListeners("message").removeAllListeners("error");
            w.on("message", (r: JobResult) => {
                results.push(...r.places);
                pending--;
                give(w);
            });
            w.on("error", reject);
        }
        workers.forEach(give);
    });
}

async function main() {
    const out = (s: string) => process.stdout.write(s + "\n");
    const dir = path.join(__dirname, "..", "..", "sim-results");
    const sharkRun = arg("mode", "normal") === "shark";
    const fileName = sharkRun ? "evolution-shark.json" : "evolution.json";
    const file = path.join(dir, fileName);
    fs.mkdirSync(dir, { recursive: true });

    const resume = process.argv.includes("--resume") && fs.existsSync(file);
    const saved: Save | null = resume ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    const settings = saved?.settings ?? {
        tournaments: parseInt(arg("tournaments", "100000")),
        population: parseInt(arg("population", "16")),
        perGeneration: parseInt(arg("per-generation", "520")),
        elites: parseInt(arg("elites", "6")),
        fish: sharkRun ? 0 : parseInt(arg("fish", "0")),
        sharks: sharkRun ? parseInt(arg("sharks", "3")) : 0,
        final: parseInt(arg("final", "4000")),
        postflopSims: parseInt(arg("sims", "400")),
    };
    const fixed = settings.fish + (settings.sharks ?? 0);
    const evolving = SEATS - fixed;
    const workerCount = parseInt(arg("workers", String(Math.max(1, os.cpus().length - 2))));
    const sim = { postflopSims: settings.postflopSims };
    // Starting point. Shark mode: the normal bot without the beginner reads, which is also the sharks' style.
    const original: Tuning = sharkRun
        ? { ...CONFIG.tuning, ...CONFIG.population, ...SHARK_MODE.tuning, ...SHARK_MODE.population, ...sim } as Tuning
        : { ...CONFIG.tuning, ...CONFIG.population, ...sim };
    if (sharkRun) { ACTIVE = { ...SPACE, ...SHARK_SPACE }; KNOBS = Object.keys(ACTIVE); }
    const fieldSeats = (): SeatSpec[] => [
        ...Array.from({ length: settings.fish }, (_, i) => ({ label: `fish${i + 1}`, tuning: null })),
        ...Array.from({ length: settings.sharks ?? 0 }, (_, i) => ({ label: `shark${i + 1}`, tuning: original })),
    ];
    const isField = (label: string) => label.startsWith("fish") || label.startsWith("shark");

    let generation = saved?.generation ?? 0;
    let played = saved?.played ?? 0;
    let nextId = saved?.nextId ?? 1;
    const hall: HallEntry[] = saved?.hall ?? [];
    const history: object[] = saved?.history ?? [];
    const newGenome = (tuning: Tuning, parents: string[], id = `g${nextId++}`): Genome =>
        ({ id, tuning, born: generation, parents, pts: 0, sq: 0, n: 0, lifetimePts: 0, lifetimeN: 0 });

    let population: Genome[] = saved?.population ?? [
        newGenome(original, [], "original"),
        ...Array.from({ length: settings.population - 1 }, () => newGenome(mutate(original, 0.2), ["original"])),
    ];

    out(`Evolution: ${settings.tournaments} tournaments, population ${settings.population}, ` +
        `${settings.perGeneration} tournaments per generation, ${evolving} evolving bots + ` +
        (sharkRun ? `${settings.sharks} sharks` : `${settings.fish} fish`) + ` per table, ` +
        `${workerCount} workers.${resume ? ` Resuming at generation ${generation + 1} (${played} played).` : ""}`);
    out(`Payouts 1st..8th: ${CONFIG.payouts.join(" / ")}. Saving to tools/sim-results/${fileName}`);

    const workers = Array.from({ length: workerCount }, () => new Worker(__filename));
    const save = (extra: Partial<Save> = {}) => fs.writeFileSync(file, JSON.stringify({
        settings, generation, played, nextId, population, hall, history, ...extra,
    } as Save, null, 1));
    const started = Date.now(), playedAtStart = played;

    while (played < settings.tournaments) {
        generation++;
        const genStart = Date.now();
        const count = Math.min(settings.perGeneration, settings.tournaments - played);
        // Seat everyone equally often: each table takes the least-seated genomes (ties at random).
        const tables: SeatSpec[][] = [];
        const seated = new Map(population.map(g => [g.id, 0]));
        for (let t = 0; t < count; t++) {
            const seats = population.map(g => ({ g, key: seated.get(g.id)! + Math.random() }))
                .sort((a, b) => a.key - b.key).slice(0, evolving).map(x => x.g);
            for (const g of seats) seated.set(g.id, seated.get(g.id)! + 1);
            tables.push([...seats.map(g => ({ label: g.id, tuning: g.tuning })), ...fieldSeats()]);
        }

        const results = await runParallel(workers, tables, 4);
        played += count;

        // Score: recency-weighted, so a genome's record mostly reflects the current field.
        const genPts = new Map<string, number[]>();
        for (const table of results)
            for (const [label, place] of table) {
                if (isField(label)) continue;
                const list = genPts.get(label) ?? [];
                list.push(CONFIG.payouts[place - 1] ?? 0);
                genPts.set(label, list);
            }
        for (const g of population) {
            const pts = genPts.get(g.id) ?? [];
            g.pts = g.pts * DECAY + pts.reduce((a, b) => a + b, 0);
            g.sq = g.sq * DECAY + pts.reduce((a, b) => a + b * b, 0);
            g.n = g.n * DECAY + pts.length;
            g.lifetimePts += pts.reduce((a, b) => a + b, 0);
            g.lifetimeN += pts.length;
        }

        const ranked = [...population].sort((a, b) => fitness(b) - fitness(a));
        const best = ranked[0];
        const orig = population.find(g => g.id === "original")!;
        hall.push({ id: best.id, tuning: best.tuning, generation, fitness: fitness(best), se: stdErr(best), n: best.n });

        const secs = (Date.now() - genStart) / 1000;
        const rate = (played - playedAtStart) / ((Date.now() - started) / 1000);
        const eta = (settings.tournaments - played) / Math.max(rate, 1e-9) / 60;
        out(`gen ${generation}: ${played}/${settings.tournaments} played (${secs.toFixed(0)}s, ${rate.toFixed(1)}/s, ~${eta.toFixed(0)} min left). ` +
            `best ${best.id} ${fitness(best) >= 0 ? "+" : ""}${fitness(best).toFixed(2)} ± ${(1.96 * stdErr(best)).toFixed(2)}, ` +
            `original ${fitness(orig) >= 0 ? "+" : ""}${fitness(orig).toFixed(2)} | ${describeChanges(best.tuning, original)}`);
        history.push({
            generation, played, best: best.id, bestFitness: round3(fitness(best)), originalFitness: round3(fitness(orig)),
            bestTuning: best.tuning, ranking: ranked.map(g => [g.id, round3(fitness(g))]),
        });

        // Next generation: elites survive, the rest are children of elites. Original always stays.
        if (played < settings.tournaments) {
            const elites = ranked.filter(g => g.id !== "original").slice(0, settings.elites);
            const strength = Math.max(0.04, 0.15 * (1 - played / settings.tournaments));   // smaller steps later on
            const pick = () => {                                     // tournament selection among elites
                const a = elites[Math.floor(Math.random() * elites.length)];
                const b = elites[Math.floor(Math.random() * elites.length)];
                return fitness(a) >= fitness(b) ? a : b;
            };
            const children: Genome[] = [];
            while (elites.length + 1 + children.length < settings.population) {
                const a = pick(), b = pick();
                const child = Math.random() < 0.5 && a !== b ? crossover(a.tuning, b.tuning) : { ...a.tuning };
                children.push(newGenome(mutate(child, strength), a === b ? [a.id] : [a.id, b.id]));
            }
            population = [orig, ...elites, ...children];
        }
        save();
    }

    if (settings.final <= 0) {
        await Promise.all(workers.map(w => w.terminate()));
        out("No playoff (--final 0).");
        return;
    }

    // ---- Playoff: the best of the run vs the original, all at the same tables.
    const candidates = new Map<string, Tuning>();
    // Only bots that have played (children bred after the last generation haven't).
    const ranked = [...population].filter(g => g.id !== "original" && g.n > 0).sort((a, b) => fitness(b) - fitness(a));
    // Hall of fame: generation winners with enough games, best first.
    const famous = [...hall].filter(h => h.n >= 100).sort((a, b) => b.fitness - a.fitness);
    for (const g of [...ranked.slice(0, 3).map(g => ({ id: g.id, tuning: g.tuning })), ...famous, ...ranked.slice(3)]) {
        if (candidates.size >= evolving - 1) break;
        if (!candidates.has(g.id)) candidates.set(g.id, g.tuning);
    }
    candidates.set("original", original);
    out(`\nPlayoff: ${[...candidates.keys()].join(", ")}, ${settings.final} tournaments, all at every table.`);
    const tables: SeatSpec[][] = Array.from({ length: settings.final }, () => [
        ...[...candidates.entries()].map(([label, tuning]) => ({ label, tuning })),
        ...fieldSeats(),
    ]);
    const results = await runParallel(workers, tables, 4);
    await Promise.all(workers.map(w => w.terminate()));

    const score = new Map<string, number[]>();
    for (const table of results)
        for (const [label, place] of table) {
            const list = score.get(label) ?? [];
            list.push(CONFIG.payouts[place - 1] ?? 0);
            score.set(label, list);
        }
    const rows = [...score.entries()].map(([id, pts]) => {
        const n = pts.length, mean = pts.reduce((a, b) => a + b, 0) / n;
        const sd = Math.sqrt(pts.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
        return { id, mean, ci: 1.96 * sd / Math.sqrt(n), pts };
    }).sort((a, b) => b.mean - a.mean);
    out("\n  bot          points/tournament   changes vs original");
    for (const r of rows)
        out(`  ${r.id.padEnd(12)} ${(r.mean >= 0 ? "+" : "") + r.mean.toFixed(2)} ± ${r.ci.toFixed(2)}`.padEnd(36) +
            (candidates.has(r.id) ? describeChanges(candidates.get(r.id)!, original) : "(field)"));

    const winner = rows.find(r => candidates.has(r.id))!;
    const origRow = rows.find(r => r.id === "original")!;
    // Paired comparison: same tournaments, so compare per tournament (less noise).
    const diffs = winner.pts.map((p, i) => p - origRow.pts[i]);
    const dMean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const dSd = Math.sqrt(diffs.reduce((a, b) => a + (b - dMean) ** 2, 0) / Math.max(1, diffs.length - 1));
    const dSe = dSd / Math.sqrt(diffs.length);
    const verdict = winner.id === "original" ? "the original settings won: keep them"
        : dMean > 2 * dSe ? "BETTER than the original (clear)"
        : dMean > dSe ? "probably better than the original"
        : "no clear difference from the original";
    out(`\nWinner: ${winner.id}, ${dMean >= 0 ? "+" : ""}${dMean.toFixed(2)} ± ${(1.96 * dSe).toFixed(2)} pts/tournament vs original -> ${verdict}`);
    const finalTuning = { ...candidates.get(winner.id)!, postflopSims: CONFIG.tuning.postflopSims };
    const popKeys = Object.keys(CONFIG.population);
    const split = (t: Knobbed) => ({
        tuning: Object.fromEntries(Object.entries(t).filter(([k]) => !popKeys.includes(k))),
        population: Object.fromEntries(Object.entries(t).filter(([k]) => popKeys.includes(k))),
    });
    out(`Settings: ${JSON.stringify(split(finalTuning as Knobbed))}`);
    save({
        playoff: {
            date: new Date().toISOString(), tournaments: settings.final, verdict, winner: winner.id,
            winnerTuning: finalTuning, edgeVsOriginal: round3(dMean), edgeCI: round3(1.96 * dSe),
            table: rows.map(r => ({ id: r.id, mean: round3(r.mean), ci: round3(r.ci), tuning: candidates.get(r.id) ?? null })),
        },
    });
    out(`Saved to tools/sim-results/${fileName}`);
}

if (isMainThread) {
    if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
}
else workerMain();
