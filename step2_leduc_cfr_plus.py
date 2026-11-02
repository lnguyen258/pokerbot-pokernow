"""
Step 2 of the roadmap: vanilla CFR vs CFR+ on Leduc hold'em.

Leduc hold'em: deck of 6 cards (J J Q Q K K). Each player antes 1 and gets
one private card. Betting round 1 (bet size 2), then one public board card,
then betting round 2 (bet size 4). At most 2 raises per round.
At showdown, pairing the board wins; otherwise the higher card wins.

Actions: f = fold, c = check/call, r = bet/raise.

Run:
  python step2_leduc_cfr_plus.py          # 300 iterations of each
  python step2_leduc_cfr_plus.py 1000     # more iterations

What "working" looks like: both exploitability curves fall, CFR+ falls much
faster, and player 0's value approaches about -0.086 chips per hand.
"""
import sys
import time

RANKS = "JQK"
BET_SIZE = (2, 4)          # round 1, round 2
MAX_RAISES = 2
DECK = range(6)            # card c has rank c // 2


def rank(card):
    return card // 2


def legal_actions(h):
    """h is the action string for the current round only."""
    if h and h[-1] == "r":
        return "fcr" if h.count("r") < MAX_RAISES else "fc"
    return "cr"


def round_over(h):
    return h.endswith("cc") or h.endswith("rc")


def apply(action, rnd, h, pot):
    """Returns the new pot after `action` by the player to act."""
    p = len(h) % 2
    pot = list(pot)
    if action == "c":
        pot[p] = pot[1 - p]
    elif action == "r":
        pot[p] = pot[1 - p] + BET_SIZE[rnd]
    return pot


def showdown_p0(c0, c1, board, pot):
    s0 = (rank(c0) == rank(board), rank(c0))
    s1 = (rank(c1) == rank(board), rank(c1))
    if s0 > s1:
        return pot[1]
    if s1 > s0:
        return -pot[0]
    return 0


def info_key(card, board, prev, h):
    if board is None:
        return RANKS[rank(card)] + ":" + h
    return RANKS[rank(card)] + RANKS[rank(board)] + ":" + prev + "/" + h


class Node:
    __slots__ = ("actions", "regret", "strat_sum", "delta", "current")

    def __init__(self, actions):
        n = len(actions)
        self.actions = actions
        self.regret = [0.0] * n
        self.strat_sum = [0.0] * n
        self.delta = [0.0] * n            # regret gathered during this iteration
        self.current = [1.0 / n] * n      # strategy frozen for this iteration

    def strategy(self):
        pos = [r if r > 0 else 0.0 for r in self.regret]
        total = sum(pos)
        n = len(pos)
        return [x / total for x in pos] if total > 0 else [1.0 / n] * n

    def average(self):
        total = sum(self.strat_sum)
        n = len(self.strat_sum)
        return [x / total for x in self.strat_sum] if total > 0 else [1.0 / n] * n


class Solver:
    def __init__(self, plus):
        self.plus = plus          # True = CFR+, False = vanilla CFR
        self.nodes = {}
        self.t = 0

    # ---------- training ----------

    def cfr(self, cards, board, rnd, prev, h, pot, reach, updater):
        """Expected value for player 0. `updater` is the player whose regrets
        we update (CFR+ alternates), or None to update both (vanilla CFR)."""
        p = len(h) % 2
        key = info_key(cards[p], board, prev, h)
        node = self.nodes.get(key)
        if node is None:
            node = self.nodes[key] = Node(legal_actions(h))
        strat = node.current

        values = []
        for i, a in enumerate(node.actions):
            new_reach = list(reach)
            new_reach[p] *= strat[i]
            values.append(self.child_value(cards, board, rnd, prev, h, pot, a, new_reach, updater))
        node_value = sum(s * v for s, v in zip(strat, values))

        if updater is None or updater == p:
            sign = 1 if p == 0 else -1
            opp_reach = reach[1 - p]
            weight = self.t if self.plus else 1          # CFR+ uses linear averaging
            for i in range(len(values)):
                node.delta[i] += opp_reach * sign * (values[i] - node_value)
                node.strat_sum[i] += weight * reach[p] * strat[i]
        return node_value

    def child_value(self, cards, board, rnd, prev, h, pot, a, reach, updater):
        p = len(h) % 2
        if a == "f":
            return -pot[0] if p == 0 else pot[1]
        pot = apply(a, rnd, h, pot)
        nh = h + a
        if not round_over(nh):
            return self.cfr(cards, board, rnd, prev, nh, pot, reach, updater)
        if rnd == 1:
            return showdown_p0(cards[0], cards[1], board, pot)
        # Chance node: deal the board card.
        boards = [b for b in DECK if b not in cards]
        return sum(self.cfr(cards, b, 1, nh, "", pot, reach, updater)
                   for b in boards) / len(boards)

    def iterate(self):
        self.t += 1
        deals = [(a, b) for a in DECK for b in DECK if a != b]
        updaters = (0, 1) if self.plus else (None,)
        value = 0.0
        for u in updaters:
            # The same situation appears in many deals, so freeze each strategy
            # for the whole pass and apply the regret changes only at the end.
            for node in self.nodes.values():
                node.current = node.strategy()
            for cards in deals:
                value += self.cfr(cards, None, 0, "", "", [1, 1], [1.0, 1.0], u)
            for node in self.nodes.values():
                for i, d in enumerate(node.delta):
                    r = node.regret[i] + d
                    node.regret[i] = max(r, 0.0) if self.plus else r   # CFR+ clips at 0
                    node.delta[i] = 0.0
        return value / (len(deals) * len(updaters))

    # ---------- evaluation ----------

    def avg_strategy(self, card, board, prev, h):
        node = self.nodes.get(info_key(card, board, prev, h))
        n = len(legal_actions(h))
        return node.average() if node else [1.0 / n] * n

    def best_response(self, br):
        """Chips per hand a perfect opponent (seat `br`) wins vs our average strategy."""

        def value(me, board, rnd, prev, h, pot, weights):
            p = len(h) % 2
            acts = legal_actions(h)
            if p == br:
                return max(after(me, board, rnd, prev, h, pot, a, weights) for a in acts)
            total = 0.0
            # Our bot's action depends on its card, so split the weights per action.
            per_action = [dict() for _ in acts]
            for c, w in weights.items():
                s = self.avg_strategy(c, board, prev, h)
                for i in range(len(acts)):
                    per_action[i][c] = w * s[i]
            for i, a in enumerate(acts):
                total += after(me, board, rnd, prev, h, pot, a, per_action[i])
            return total

        def after(me, board, rnd, prev, h, pot, a, weights):
            p = len(h) % 2
            if a == "f":
                u0 = -pot[0] if p == 0 else pot[1]
                return sum(weights.values()) * (u0 if br == 0 else -u0)
            pot = apply(a, rnd, h, pot)
            nh = h + a
            if not round_over(nh):
                return value(me, board, rnd, prev, nh, pot, weights)
            if rnd == 1:
                v = 0.0
                for c, w in weights.items():
                    cards = (me, c) if br == 0 else (c, me)
                    u0 = showdown_p0(cards[0], cards[1], board, pot)
                    v += w * (u0 if br == 0 else -u0)
                return v
            v = 0.0
            for b in DECK:
                if b == me:
                    continue
                w2 = {c: w / 4 for c, w in weights.items() if c != b}
                v += value(me, b, 1, nh, "", pot, w2)
            return v

        total = 0.0
        for me in DECK:
            weights = {c: 1 / 30 for c in DECK if c != me}
            total += value(me, None, 0, "", "", [1, 1], weights)
        return total

    def exploitability(self):
        return (self.best_response(0) + self.best_response(1)) / 2


def main():
    iters = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    checkpoints = sorted({1, 10, 30, 100, 300, 1000, iters} & set(range(1, iters + 1)))
    for plus in (False, True):
        name = "CFR+" if plus else "vanilla CFR"
        solver = Solver(plus)
        start = time.time()
        print(f"\n=== {name} ===")
        for t in range(1, iters + 1):
            v = solver.iterate()
            if t in checkpoints:
                print(f"iter {t:>5}  value p0 {v:+.4f}  "
                      f"exploitability {solver.exploitability() * 1000:8.2f} milli-chips/hand  "
                      f"({time.time() - start:.0f}s)")
        print(f"{len(solver.nodes)} information sets")

    print("\nSample of the CFR+ strategy (round 1, first to act):")
    for card in (0, 2, 4):
        s = solver.avg_strategy(card, None, "", "")
        print(f"  holding {RANKS[rank(card)]}: check {s[0]:.2f}  bet {s[1]:.2f}")


if __name__ == "__main__":
    main()
