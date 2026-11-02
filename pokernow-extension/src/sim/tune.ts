/**
 * Self-improvement by self-play: searches for better strategy settings
 * (CONFIG.tuning) by playing Sit & Gos.
 *
 * Each round: the current best settings ("champion") play against 3 slightly
 * changed versions ("challengers") plus a field of other bots. A challenger
 * replaces the champion only if it scores more points per tournament by more
 * than the statistical noise. At the end, the final champion plays the
 * original settings in a separate, larger match, to check the gain is real.
 *
 *   npm run tune -- --rounds 8 --tournaments 300
 */
import * as fs from "fs";
import * as path from "path";
import { CONFIG } from "../config";
import { SimBot } from "./engine";
import { Tuning, equityBot, maniacBot, nitBot, smartBot } from "./bots";
import { printTable, runTournaments, summarize } from "./run";

export type Knob = Exclude<keyof Tuning, "postflopSims" | "riverSolver" | "riverIterations">;
export const SPACE: Record<Knob, [number, number]> = {
    openScale: [0.6, 1.6],
    threeBetEquity: [0.5, 0.7],
    callPenaltyIP: [0, 0.1],
    callPenaltyOOP: [0.02, 0.15],
    realiseOOP: [0.75, 1.0],
    postflopTemperature: [0.01, 0.12],
    isolateFish: [0, 2],
    exploitCutoff: [0.1, 1.01],          // 1.01 = never stop solving
};
const KNOBS = Object.keys(SPACE) as Knob[];

function gaussian() {
    return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

function mutate(base: Tuning): Tuning {
    const next = { ...base };
    const n = Math.random() < 0.5 ? 1 : 2;
    for (let k = 0; k < n; k++) {
        const knob = KNOBS[Math.floor(Math.random() * KNOBS.length)];
        const [lo, hi] = SPACE[knob];
        const v = next[knob] + gaussian() * 0.15 * (hi - lo);
        next[knob] = Math.round(Math.min(hi, Math.max(lo, v)) * 1000) / 1000;
    }
    return next;
}

function diff(a: Tuning, b: Tuning): string {
    return KNOBS.filter(k => a[k] !== b[k]).map(k => `${k} ${b[k]} -> ${a[k]}`).join(", ") || "(same)";
}

function arg(name: string, fallback: string) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// The other seats: the original settings plus different styles, so the tuner
// can't win by learning to beat only one kind of opponent.
const field = (original: Tuning): SimBot[] =>
    [smartBot("original", original), equityBot("equity"), nitBot("nit"), maniacBot("maniac")];

if (require.main === module) {
    const out = (s: string) => process.stdout.write(s + "\n");
    console.log = (() => {}) as typeof console.log;
    const rounds = parseInt(arg("rounds", "8"));
    const perRound = parseInt(arg("tournaments", "300"));
    const validation = parseInt(arg("validate", "1000"));
    const original: Tuning = { ...CONFIG.tuning, postflopSims: 400 };
    let champion: Tuning = { ...original };
    const history: object[] = [];

    out(`Tuning: ${rounds} rounds x ${perRound} tournaments, then a ${validation}-tournament check.`);
    for (let r = 1; r <= rounds; r++) {
        const challengers = [mutate(champion), mutate(champion), mutate(champion)];
        const scores = runTournaments(() => [
            smartBot("champion", champion),
            ...challengers.map((c, i) => smartBot(`challenger${i + 1}`, c)),
            ...field(original),
        ], perRound, l => l, false);
        const champ = summarize(scores.get("champion")!);
        let best = -1, bestEdge = 0;
        challengers.forEach((_, i) => {
            const c = summarize(scores.get(`challenger${i + 1}`)!);
            const noise = Math.sqrt((c.ci / 1.96) ** 2 + (champ.ci / 1.96) ** 2);
            const edge = (c.mean - champ.mean) / noise;           // in standard errors
            if (edge > 1 && edge > bestEdge) { best = i; bestEdge = edge; }
        });
        const line = challengers.map((c, i) => {
            const s = summarize(scores.get(`challenger${i + 1}`)!);
            return `  challenger ${i + 1}: ${s.mean.toFixed(1)} pts  [${diff(c, champion)}]`;
        }).join("\n");
        out(`\nRound ${r}: champion ${champ.mean.toFixed(1)} ± ${champ.ci.toFixed(1)} pts/tournament\n${line}`);
        if (best >= 0) {
            out(`  -> challenger ${best + 1} becomes champion (${bestEdge.toFixed(1)} standard errors better)`);
            champion = challengers[best];
        }
        else out("  -> no challenger clearly better; champion stays");
        history.push({ round: r, champion, championScore: champ.mean, promoted: best + 1 });
    }

    out(`\nCheck: final champion vs original settings, ${validation} tournaments...`);
    const check = runTournaments(() => [
        smartBot("tuned", champion), smartBot("tuned", champion),
        smartBot("original", original), smartBot("original", original),
        equityBot("equity"), nitBot("nit"), maniacBot("maniac"), equityBot("equity"),
    ].map((b, i) => ({ ...b, label: `${b.label}${i + 1}` })), validation, l => l.replace(/\d+$/, ""), true);
    console.log = out as typeof console.log;
    printTable(check);

    const tuned = summarize(check.get("tuned")!), orig = summarize(check.get("original")!);
    const noise = Math.sqrt((tuned.ci / 1.96) ** 2 + (orig.ci / 1.96) ** 2);
    const verdict = tuned.mean - orig.mean > 2 * noise ? "BETTER (clear)" :
        tuned.mean - orig.mean > noise ? "probably better" :
        tuned.mean - orig.mean < -noise ? "WORSE: keep the original" : "no clear difference";
    out(`\nTuned vs original: ${(tuned.mean - orig.mean).toFixed(1)} pts/tournament -> ${verdict}`);
    out(`Settings found: ${JSON.stringify({ ...champion, postflopSims: CONFIG.tuning.postflopSims })}`);
    out(`Changes: ${diff(champion, original)}`);

    const dir = path.join(__dirname, "..", "..", "sim-results");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "tuning.json"), JSON.stringify({
        date: new Date().toISOString(), original, champion, verdict,
        tunedPoints: tuned.mean, originalPoints: orig.mean, history,
    }, null, 2));
    out(`Saved to tools/sim-results/tuning.json`);
}
