/**
 * Cash game simulator: the measuring stick for the cash version.
 *
 * A 10-seat table, blinds 1/2 that never change, 100 bb buy-ins (200 chips), no rake:
 * the user's real game. Players top up to the buy-in whenever they're below it
 * (busting = rebuying). Results are in big blinds won per 100 hands (bb/100), with a
 * 95% confidence range, because cash results swing a lot.
 *
 * Play is split into sessions (default 300 hands): same opponents for the whole session
 * (the smart bots learn them, as in a real game), new seats and fresh 100 bb stacks after.
 *
 *   npm run cash -- --hands 200000
 *   npm run cash -- --hands 50000 --pool smart,shark,fish,fish,fish,fish,station,nit,maniac,equity
 *
 * Bot types: smart (the extension, normal mode), shark (the extension in Shark mode: the
 * "strong player"), fish, station, maniac, nit, equity (a simple bot), random.
 */
import os from "os";
import { Worker, isMainThread, parentPort } from "worker_threads";
import { CONFIG, SHARK_MODE } from "../config";
import { parseHand } from "../table/logReader";
import { addHand, resetStats } from "../table/stats";
import { BOT_TYPES, smartBot } from "./bots";
import { Seat, SimBot, playHand } from "./engine";

export type CashOptions = {
    sb: number,
    bb: number,
    buyIn: number,          // chips; players top up to this when below it
    sessionHands: number,   // hands with the same opponents before reseating
};

export const CASH_DEFAULTS: CashOptions = { sb: 1, bb: 2, buyIn: 200, sessionHands: 300 };

/** The user's table: 10 seats, a mix of bots, weak players and strong players. */
export const DEFAULT_POOL = ["smart", "shark", "shark", "fish", "fish", "fish", "fish", "equity", "equity", "nit"];

let handId = 0;

/** One session. Returns each player's chips won (after all top-ups) and hands played. */
export function playCashSession(bots: SimBot[], opts: CashOptions = CASH_DEFAULTS,
    onHand?: (log: string[]) => void): { won: Map<string, number>, hands: number } {
    const seats: Seat[] = bots.map((bot, i) => ({ seat: i + 1, name: bot.label, id: `id-${bot.label}`, bot, stack: opts.buyIn }));
    const invested = new Map(seats.map(s => [s.name, opts.buyIn]));
    let button = Math.floor(Math.random() * seats.length);
    for (let n = 1; n <= opts.sessionHands; n++) {
        for (const s of seats) {                         // top up (or rebuy) before the hand
            if (s.stack < opts.buyIn) {
                invested.set(s.name, invested.get(s.name)! + opts.buyIn - s.stack);
                s.stack = opts.buyIn;
            }
        }
        button = (button + 1) % seats.length;
        const log = playHand(seats, seats, seats[button], [opts.sb, opts.bb], n, ++handId);
        onHand?.(log);
    }
    return { won: new Map(seats.map(s => [s.name, s.stack - invested.get(s.name)!])), hands: opts.sessionHands };
}

/** Makes a bot from a type name ("shark" = the extension in Shark mode). */
export function makeBot(type: string, label: string): SimBot {
    if (type === "shark") return smartBot(label, { ...SHARK_MODE.tuning, ...SHARK_MODE.population });
    const make = BOT_TYPES[type];
    if (!make) throw new Error(`unknown bot type "${type}" (known: shark, ${Object.keys(BOT_TYPES).join(", ")})`);
    return make(label);
}

/** "fish3" -> "fish" */
export const typeOf = (label: string) => label.replace(/\d+$/, "");

// ---------------------------------------------------------------- worker side

type Job = { id: number, pool: string[], sessions: number, opts: CashOptions };
type JobResult = { id: number, sessions: [string, number][][] };    // per session: [label, chips won]

function workerMain() {
    console.log = (() => {}) as typeof console.log;          // silence decision logs
    console.warn = (() => {}) as typeof console.warn;
    console.error = (() => {}) as typeof console.error;
    CONFIG.gameType = "cash";
    parentPort!.on("message", (job: Job) => {
        const sessions: [string, number][][] = [];
        for (let k = 0; k < job.sessions; k++) {
            resetStats();                                     // new opponents each session
            const counts = new Map<string, number>();
            const bots = job.pool.map(type => {
                const c = (counts.get(type) ?? 0) + 1;
                counts.set(type, c);
                return makeBot(type, `${type}${c}`);
            });
            for (let i = bots.length - 1; i > 0; i--) {         // random seats
                const j = Math.floor(Math.random() * (i + 1));
                [bots[i], bots[j]] = [bots[j], bots[i]];
            }
            const result = playCashSession(bots, job.opts, log => addHand(parseHand(log)));
            sessions.push([...result.won.entries()]);
        }
        parentPort!.postMessage({ id: job.id, sessions } as JobResult);
    });
}

// ---------------------------------------------------------------- main side

function arg(name: string, fallback: string) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Plays sessions on all workers. Returns, per session, each label's chips won. */
export async function runCash(pool: string[], sessions: number, opts: CashOptions, workerCount: number,
    progress?: (done: number) => void): Promise<[string, number][][]> {
    const workers = Array.from({ length: workerCount }, () => new Worker(__filename));
    const out: [string, number][][] = [];
    const chunk = 2;
    let next = 0, done = 0, jobId = 0;
    await new Promise<void>((resolve, reject) => {
        const give = (w: Worker) => {
            if (next >= sessions) { if (done >= sessions) resolve(); return; }
            const n = Math.min(chunk, sessions - next);
            next += n;
            w.postMessage({ id: jobId++, pool, sessions: n, opts } as Job);
        };
        for (const w of workers) {
            w.on("message", (r: JobResult) => {
                out.push(...r.sessions);
                done += r.sessions.length;
                progress?.(done);
                if (done >= sessions) resolve(); else give(w);
            });
            w.on("error", reject);
        }
        workers.forEach(give);
    });
    await Promise.all(workers.map(w => w.terminate()));
    return out;
}

/** bb/100 per bot type, with a 95% range from the spread between sessions. */
export function summarize(results: [string, number][][], opts: CashOptions) {
    const per = new Map<string, number[]>();         // type -> bb/100 per (session x seat)
    for (const session of results)
        for (const [label, won] of session) {
            const list = per.get(typeOf(label)) ?? [];
            list.push(won / opts.bb / opts.sessionHands * 100);
            per.set(typeOf(label), list);
        }
    return [...per.entries()].map(([type, xs]) => {
        const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
        const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1));
        return { type, bb100: mean, ci95: 1.96 * sd / Math.sqrt(xs.length), seats: xs.length };
    }).sort((a, b) => b.bb100 - a.bb100);
}

async function main() {
    const opts: CashOptions = {
        sb: parseFloat(arg("sb", String(CASH_DEFAULTS.sb))),
        bb: parseFloat(arg("bb", String(CASH_DEFAULTS.bb))),
        buyIn: parseFloat(arg("buyin", String(CASH_DEFAULTS.buyIn))),
        sessionHands: parseInt(arg("session", String(CASH_DEFAULTS.sessionHands))),
    };
    const pool = arg("pool", DEFAULT_POOL.join(",")).split(",").map(s => s.trim()).filter(Boolean);
    pool.forEach((t, i) => makeBot(t, `check${i}`));             // fail early on a typo
    const hands = parseInt(arg("hands", "100000"));
    const sessions = Math.max(1, Math.round(hands / opts.sessionHands));
    const workerCount = Math.min(sessions, parseInt(arg("workers", String(Math.max(1, os.cpus().length - 2)))));

    console.log(`Cash game: ${pool.length} seats (${pool.join(", ")}), blinds ${opts.sb}/${opts.bb}, ` +
        `buy-in ${opts.buyIn} (${opts.buyIn / opts.bb} bb), no rake.`);
    console.log(`${sessions} sessions x ${opts.sessionHands} hands = ${sessions * opts.sessionHands} hands, ${workerCount} workers.`);
    const started = Date.now();
    let lastShown = 0;
    const results = await runCash(pool, sessions, opts, workerCount, done => {
        if (done - lastShown >= sessions / 10 || done === sessions) {
            lastShown = done;
            const secs = (Date.now() - started) / 1000;
            console.log(`  ${done * opts.sessionHands} hands, ${secs.toFixed(0)}s (${(done * opts.sessionHands / secs).toFixed(0)} hands/s)`);
        }
    });

    console.log(`\n  ${"player".padEnd(10)} ${"bb/100".padStart(8)}   95% range`);
    for (const r of summarize(results, opts))
        console.log(`  ${r.type.padEnd(10)} ${(r.bb100 >= 0 ? "+" : "") + r.bb100.toFixed(1).padStart(7)}   ±${r.ci95.toFixed(1)}`);
    console.log("\n(bb/100 = big blinds won per 100 hands. Zero-sum without rake: all rows weighted by seats add up to 0.)");
}

if (isMainThread) {
    if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
}
else workerMain();
