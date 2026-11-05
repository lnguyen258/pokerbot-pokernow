/**
 * Startup smoke test: loads the BUILT content script (main.js) into fake pages and checks the
 * things that broke in v1.10.0. Nothing may throw at load, even when the table isn't drawn yet.
 * The bot must answer the popup, auto-start on game pages, stay off after Kill, and only one
 * bot may play a game.
 *
 * Run from pokernow-extension/:  npm run smoke   (builds into tools/.build-smoke, not dist/)
 */
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const code = fs.readFileSync(path.join(__dirname, ".build-smoke/main.js"), "utf8");
const wait = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail) {
    console.log(`${ok ? "PASS" : "FAIL"}  smoke: ${name}${detail ? "  (" + detail + ")" : ""}`);
    if (!ok) failures++;
}

/** Shared chrome.storage for every fake tab (like the real extension). */
const store = {};
const storageListeners = [];
const allTimers = [];
const errors = [];

/** A fake browser tab on `pathname`. The page is empty: no table, no blinds, no turn. */
function makeTab(pathname) {
    const docListeners = {};
    const tab = { onMessage: null, logs: [], runtimeAlive: true };
    const guard = fn => (...args) => {
        try { return fn(...args); }
        catch (err) { errors.push(`${pathname}: ${err && err.stack || err}`); }
    };
    const document = {
        querySelector: () => null,
        querySelectorAll: () => [],
        body: {},
        addEventListener: (type, f) => (docListeners[type] = docListeners[type] || []).push(f),
        dispatchEvent: e => { (docListeners[e.type] || []).forEach(f => f(e)); return true; },
    };
    class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
    class MutationObserver { observe() {} disconnect() {} }
    const chrome = {
        runtime: {
            get id() { return tab.runtimeAlive ? "smoke" : undefined; },
            getManifest: () => ({ version: "smoke", content_scripts: [] }),
            onMessage: { addListener: f => { tab.onMessage = f; } },
        },
        storage: {
            local: {
                get: async () => ({}),
                set: async obj => {
                    Object.assign(store, obj);
                    const changes = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { newValue: v }]));
                    for (const f of storageListeners) f(changes, "local");
                },
            },
            onChanged: { addListener: f => storageListeners.push(f) },
        },
    };
    const keep = (id) => { allTimers.push(id); return id; };
    const sandbox = {
        document, chrome, CustomEvent, MutationObserver,
        location: { hostname: "www.pokernow.club", host: "www.pokernow.club", pathname },
        console: { log: (...a) => tab.logs.push(a.join(" ")), warn: () => {}, info: () => {},
            error: (...a) => tab.logs.push("ERROR " + a.join(" ")) },
        setTimeout: (f, ms, ...a) => keep(setTimeout(guard(f), ms, ...a)),
        setInterval: (f, ms, ...a) => keep(setInterval(guard(f), ms, ...a)),
        clearTimeout, clearInterval,
        fetch: async () => { throw new Error("no network in smoke test"); },
    };
    sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
    tab.context = vm.createContext(sandbox);
    tab.load = () => {
        try { vm.runInContext(code, tab.context, { filename: "main.js" }); }
        catch (err) { errors.push(`${pathname} at load: ${err && err.stack || err}`); }
    };
    tab.send = message => new Promise(resolve => {
        if (!tab.onMessage) return resolve(undefined);
        let answered = false;
        tab.onMessage(message, {}, r => { answered = true; resolve(r); });
        setTimeout(() => { if (!answered) resolve(undefined); }, 50);
    });
    return tab;
}

process.on("unhandledRejection", err => errors.push(`unhandled promise: ${err && err.stack || err}`));

(async () => {
    // 1. A game page that hasn't drawn the table yet (what broke 1.10.0).
    const a = makeTab("/games/abc123");
    a.load();
    check("loads on an empty game page without throwing", errors.length === 0, errors[0]);
    check("answers the popup right after loading", typeof (await a.send("get_bot_status")) === "string",
        String(await a.send("get_bot_status")));
    await wait(1300);
    let status = await a.send("get_bot_status");
    check("auto-starts on a game page", /^playing/.test(status), status);
    check("logs the auto-start", a.logs.some(l => l.includes("[autostart] game page: starting")));

    // 2. Kill: stays off, even after the auto-start check runs again.
    status = await a.send("kill_bot");
    await wait(1300);
    status = await a.send("get_bot_status");
    check("Kill keeps the bot off (auto-start doesn't undo it)", /^off: killed/.test(status), status);
    status = await a.send("start_bot");
    check("Start turns it back on after Kill", /^playing/.test(status), status);

    // 3. Same game in a second tab: the newest bot plays, the older one stops.
    const b = makeTab("/games/abc123");
    b.load();
    await wait(1300);
    const sa = await a.send("get_bot_status"), sb = await b.send("get_bot_status");
    check("same game in two tabs: new tab plays, old tab stops",
        /^playing/.test(sb) && /another tab/.test(sa), `old: ${sa} | new: ${sb}`);

    // 4. Extension updated: a new copy is injected into the same page; the old copy retires.
    const c = makeTab("/games/xyz789");
    c.load();
    await wait(1300);
    c.load();                                   // the new copy in the same page
    await wait(300);
    check("new copy in the same page takes over (old one says it stops)",
        c.logs.some(l => l.includes("a newer version took over")), c.logs.filter(l => l.includes("[update]")).join(" / "));
    check("after an update the page still answers and plays", /^playing/.test(await c.send("get_bot_status") || ""));

    // 5. Lobby page: loads, answers, doesn't start.
    const d = makeTab("/");
    d.load();
    await wait(1300);
    status = await d.send("get_bot_status");
    check("lobby page: answers and waits", /^waiting: not a game page/.test(status), status);

    check("no errors in any timer or promise", errors.length === 0, errors.join("\n"));

    allTimers.forEach(t => { clearTimeout(t); clearInterval(t); });
    console.log(failures ? `\n${failures} smoke check(s) FAILED` : "\nall smoke checks passed");
    process.exit(failures ? 1 : 0);
})();
