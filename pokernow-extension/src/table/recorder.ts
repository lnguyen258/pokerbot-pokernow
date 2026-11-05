/**
 * Hand recorder: turns a stream of table snapshots (what the page shows, taken on every change)
 * into hand histories, as the hands are played. See docs/LEARNING_PIPELINE.md.
 *
 * Pure logic (no page access), so tests can feed it made-up snapshots.
 */
import type { DecisionRecord } from "../history";
import { HandLog, LogAction, Street } from "./logReader";
import { CONFIG } from "../config";

export type SeatSnap = {
    name: string,
    seat: number,          // seat number on the table (clockwise order)
    stack: number,         // chips behind
    bet: number,           // chips in front of them on this street
    folded: boolean,
    dealer: boolean,
    isMe: boolean,
    cards: string[],       // cards visible on this seat (opponents: only at showdown)
};

export type Snapshot = {
    at: number,
    seats: SeatSnap[],     // in seat order
    board: string[],
    myCards: string[],
    bb: number,
};

export type RecKind = "sb" | "bb" | "fold" | "check" | "call" | "bet" | "raise";
export type RecAction = { name: string, street: Street, kind: RecKind, to: number, allIn: boolean };
export type RecPlayer = {
    name: string, seat: number, isMe: boolean,
    start: number,         // chips at the start of the hand (before blinds)
    end?: number,          // chips at the start of the next hand
    contributed: number,   // chips put in this hand
    cards?: string[],      // shown at showdown (or ours)
};

export type RecordedHand = {
    id: string,
    game: string,
    number: number,
    startedAt: number,
    endedAt: number,
    bb: number,
    /** Game type the bot was set to when the hand started: cash and tournament are analysed separately. */
    gameType?: "tournament" | "cash",
    dealer?: string,
    players: RecPlayer[],
    board: string[],
    myCards: string[],
    actions: RecAction[],
    decisions: DecisionRecord[],
    complete: boolean,     // chips add up: safe to learn from
    notes: string[],
};

const streetOf = (boardLen: number): Street =>
    boardLen >= 5 ? "river" : boardLen === 4 ? "turn" : boardLen >= 3 ? "flop" : "preflop";

export class HandRecorder {
    private hand: RecordedHand | null = null;
    private street: Street = "preflop";
    private bets = new Map<string, number>();
    private maxBet = 0;
    private folded = new Set<string>();
    private allIn = new Set<string>();
    private acted = new Set<string>();
    private lastActor = -1;
    private count = 0;
    private seatOrder: string[] = [];
    private stackSeen = new Map<string, number>();   // last stack seen per player: a real bet makes it drop

    constructor(readonly game: string) {}

    /** The hand being played (for attaching decisions). */
    get current(): RecordedHand | null { return this.hand; }

    /** Decisions made on a new hand before this recorder saw that hand start. */
    private pending: DecisionRecord[] = [];

    /**
     * Attach a bot decision to its hand. The bot can act on a new hand a few ms before the
     * recorder notices the hand changed, so a decision whose cards don't match the hand
     * being recorded waits for the next hand instead of landing in the old one.
     */
    attachDecision(rec: DecisionRecord) {
        const mine = this.hand?.myCards.join(" ") ?? "";
        if (this.hand && (!mine || !rec.hand || mine === rec.hand)) this.hand.decisions.push(rec);
        else this.pending = [...this.pending, rec].slice(-5);
    }

    /** Feed one snapshot. Returns a finished hand when a new hand has started. */
    observe(s: Snapshot): RecordedHand | null {
        if (!s.seats.length) return null;
        let finished: RecordedHand | null = null;
        if (this.hand && this.ended(s)) {
            finished = this.finish(s);
            this.hand = null;
        }
        if (!this.hand) {
            if (this.canStart(s)) this.start(s);
        }
        else this.update(s);
        return finished;
    }

    private ended(s: Snapshot): boolean {
        const h = this.hand!;
        const dealer = s.seats.find(x => x.dealer)?.name;
        if (s.board.length < h.board.length) return true;
        if (dealer && h.dealer && dealer !== h.dealer) return true;
        if (s.myCards.length === 2 && h.myCards.length === 2 && s.myCards.join() !== h.myCards.join()) return true;
        return false;
    }

    /** A hand can start once the blinds are in front of players and the board is empty. */
    private canStart(s: Snapshot): boolean {
        return s.board.length === 0 && s.seats.filter(x => x.bet > 0).length >= 1;
    }

    private start(s: Snapshot) {
        this.count++;
        const players: RecPlayer[] = s.seats.filter(x => x.stack + x.bet > 0).map(x => ({
            name: x.name, seat: x.seat, isMe: x.isMe, start: x.stack + x.bet, contributed: 0,
            cards: x.isMe && s.myCards.length === 2 ? s.myCards.slice() : undefined,
        }));
        this.hand = {
            id: `${this.game}#${this.count}@${s.at}`, game: this.game, number: this.count,
            startedAt: s.at, endedAt: s.at, bb: s.bb, gameType: CONFIG.gameType,
            dealer: s.seats.find(x => x.dealer)?.name,
            players, board: [], myCards: s.myCards.slice(), actions: [], decisions: [],
            complete: false, notes: [],
        };
        const mine = this.hand.myCards.join(" ");
        this.hand.decisions.push(...this.pending.filter(r => !mine || r.hand === mine));
        this.pending = [];
        this.street = "preflop";
        this.bets.clear(); this.folded.clear(); this.allIn.clear(); this.acted.clear();
        this.maxBet = 0;
        this.seatOrder = s.seats.map(x => x.name);
        this.stackSeen = new Map(s.seats.map(x => [x.name, x.stack + x.bet]));
        const dealerIdx = s.seats.findIndex(x => x.dealer);
        this.lastActor = dealerIdx;

        // Blinds: the bets already out when the hand starts (small one = SB, big one = BB).
        const posted = s.seats.filter(x => x.bet > 0).sort((a, b) => a.bet - b.bet);
        const bb = s.bb || posted[posted.length - 1]?.bet || 0;
        let haveBB = false;
        for (const x of posted) {
            let kind: RecKind;
            if (x.bet < bb) kind = "sb";
            else if (x.bet === bb && !haveBB) { kind = "bb"; haveBB = true; }
            else kind = x.bet > this.maxBet ? "raise" : "call";
            this.put(x, kind);
        }
        // Then anything else visible already (someone acted before our first look).
        this.update(s, true);
    }

    private player(name: string) { return this.hand!.players.find(p => p.name === name); }

    private put(x: SeatSnap, kind: RecKind) {
        const prev = this.bets.get(x.name) ?? 0;
        const p = this.player(x.name);
        if (p) p.contributed += Math.max(0, x.bet - prev);
        this.bets.set(x.name, x.bet);
        this.maxBet = Math.max(this.maxBet, x.bet);
        if (x.stack <= 0) this.allIn.add(x.name);
        this.stackSeen.set(x.name, x.stack);
        this.hand!.actions.push({ name: x.name, street: this.street, kind, to: x.bet, allIn: x.stack <= 0 });
        if (kind !== "sb" && kind !== "bb") this.acted.add(x.name);
    }

    private update(s: Snapshot, first = false) {
        const h = this.hand!;
        h.endedAt = s.at;
        if (!first && s.board.length > h.board.length) {
            this.closeStreet(s);
            this.street = streetOf(s.board.length);
            this.bets.clear(); this.acted.clear();
            this.maxBet = 0;
            this.lastActor = s.seats.findIndex(x => x.dealer);       // after the flop, first to act is left of the button
        }
        if (s.board.length > h.board.length) h.board = s.board.slice();

        // Seats in acting order, starting after the last player who acted (fixed for this pass:
        // several players may have acted since the last snapshot).
        const n = s.seats.length;
        const from = this.lastActor;
        for (let k = 1; k <= n; k++) {
            const i = (from + k + n) % n;
            const x = s.seats[i];
            if (!this.player(x.name) || this.folded.has(x.name)) continue;
            const prev = this.bets.get(x.name) ?? 0;
            if (x.folded) {
                this.folded.add(x.name);
                h.actions.push({ name: x.name, street: this.street, kind: "fold", to: 0, allIn: false });
                this.acted.add(x.name);
                this.lastActor = i;
            }
            // A real bet takes chips from the stack. A bet still shown after the next card (the pot
            // animation) doesn't, so it isn't counted again. All-in players can't act any more.
            else if (x.bet > prev + 0.001 && !this.allIn.has(x.name) &&
                x.stack < (this.stackSeen.get(x.name) ?? Infinity) - 0.001) {
                const kind: RecKind = x.bet > this.maxBet ? (this.maxBet === 0 && this.street !== "preflop" ? "bet" : "raise") : "call";
                this.put(x, kind);
                this.lastActor = i;
            }
        }
        for (const x of s.seats) this.stackSeen.set(x.name, x.stack);
        // Cards shown at showdown.
        for (const x of s.seats) {
            const p = this.player(x.name);
            if (p && !x.isMe && x.cards.length === 2) p.cards = x.cards.slice();
        }
    }

    /** A street that ends with nobody betting: everyone still in (and not all-in) checked. */
    private closeStreet(s: Snapshot) {
        const h = this.hand!;
        const live = this.seatOrder.filter(name => this.player(name) && !this.folded.has(name) && !this.allIn.has(name));
        if (this.street !== "preflop" && this.maxBet === 0) {
            const dealerIdx = Math.max(0, this.seatOrder.indexOf(h.dealer ?? ""));
            const order = [...this.seatOrder.slice(dealerIdx + 1), ...this.seatOrder.slice(0, dealerIdx + 1)];
            for (const name of order)
                if (live.includes(name) && !this.acted.has(name))
                    h.actions.push({ name, street: this.street, kind: "check", to: 0, allIn: false });
        }
        else if (this.street === "preflop") {
            // Big blind's option: nobody raised, so they checked.
            const bbAct = h.actions.find(a => a.kind === "bb");
            if (bbAct && this.maxBet === bbAct.to && live.includes(bbAct.name) && !this.acted.has(bbAct.name))
                h.actions.push({ name: bbAct.name, street: "preflop", kind: "check", to: bbAct.to, allIn: false });
        }
        void s;
    }

    private finish(s: Snapshot): RecordedHand {
        const h = this.hand!;
        if (h.board.length > 0 || this.street === "preflop") this.closeStreet(s);
        for (const p of h.players) {
            const x = s.seats.find(y => y.name === p.name);
            p.end = x ? x.stack + x.bet : 0;                  // gone from the table = busted
        }
        const before = h.players.reduce((a, p) => a + p.start, 0);
        const after = h.players.reduce((a, p) => a + (p.end ?? 0), 0);
        const notes: string[] = [];
        if (Math.abs(before - after) > 1) notes.push(`chips don't add up: ${before} before, ${after} after`);
        for (const p of h.players) {
            const lost = p.start - (p.end ?? 0);
            if (lost > 0 && Math.abs(lost - p.contributed) > 1)
                notes.push(`${p.name} lost ${lost} but put in ${p.contributed}`);
        }
        if (!h.actions.some(a => a.kind !== "sb" && a.kind !== "bb")) notes.push("no actions seen");
        h.notes = notes;
        h.complete = notes.length === 0;
        return h;
    }
}

/** A recorded hand in the parser's format, for the opponent profiles (ids match the screen reader's). */
export function toHandLog(h: RecordedHand): HandLog {
    const id = (name: string) => `screen:${name}`;
    const actions: LogAction[] = h.actions.map(a => ({ id: id(a.name), street: a.street, kind: a.kind, amount: a.to, allIn: a.allIn }));
    const last = h.actions[h.actions.length - 1]?.street ?? "preflop";
    return {
        handNumber: h.number,
        street: h.board.length ? streetOf(h.board.length) : last,
        handId: h.id,
        dealerId: h.dealer ? id(h.dealer) : undefined,
        players: h.players.map(p => ({ id: id(p.name), name: p.name, seat: p.seat, stack: p.start })),
        actions,
        shown: h.players.filter(p => p.cards && !p.isMe).map(p => ({ id: id(p.name), cards: p.cards!.join(", ") })),
        collected: h.players
            .map(p => ({ id: id(p.name), amount: (p.end ?? 0) - (p.start - p.contributed) }))
            .filter(c => c.amount > 0),
    };
}
