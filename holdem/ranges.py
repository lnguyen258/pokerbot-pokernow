"""Opponent hand ranges: which of the 1,326 possible hands might they hold?

A range is a list of 1,326 weights, one per two-card combo. Every action the
opponent takes multiplies the weights by "how likely would they do this with
that hand". Weights never go fully to zero, so a surprise hand (a bluff, a
slowplay) stays possible and the bot can't be fooled into total certainty.

The "how likely" part is a model of a typical player:
  - preflop: they open/call/3-bet with the top X% of hands
  - postflop raise/bet: strong hands, plus some bluffs (draws first, then air)
    in the ratio a balanced player would use for that bet size
  - postflop call: the top part of their range, sized by how much they must
    call, scaled by how loose they've shown themselves to be
  - check: mostly removes their strongest hands
X% and looseness are learned per opponent (see OpponentModel.stats).
"""
import json
import math
import os

from cards import _hand_class, _straight_high, evaluate, preflop_equity

COMBOS = [(a, b) for a in range(52) for b in range(a + 1, 52)]
N = len(COMBOS)
FLOOR = 0.02          # minimum multiplier: nothing becomes impossible

# ---------------------------------------------------------------- preflop

_TABLE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "preflop_table.json")


def _preflop_percentiles():
    classes = sorted({_hand_class([a, b]) for a, b in COMBOS})
    if os.path.exists(_TABLE):
        with open(_TABLE) as f:
            eq = json.load(f)
    else:
        print("building preflop hand table (one-time, ~15s)...")
        eq = {c: preflop_equity(c, 1) for c in classes}
        with open(_TABLE, "w") as f:
            json.dump(eq, f, indent=0)
    size = {c: 6 if len(c) == 2 else 4 if c.endswith("s") else 12 for c in classes}
    pct, done = {}, 0
    for c in sorted(classes, key=lambda c: eq[c]):
        pct[c] = (done + size[c] / 2) / N
        done += size[c]
    return pct


_CLASS_PCT = _preflop_percentiles()
PREFLOP_STRENGTH = [_CLASS_PCT[_hand_class([a, b])] for a, b in COMBOS]

# ---------------------------------------------------------------- postflop

_board_cache = {}


def _draw_value(a, b, board):
    """Rough extra equity from a flush or straight draw that uses a hole card."""
    if len(board) >= 5:
        return 0.0
    cards = [a, b] + board
    value = 0.0
    for s in range(4):
        n = sum(1 for c in cards if c % 4 == s)
        if n == 4 and (a % 4 == s or b % 4 == s):
            value += 0.35
    full = {c // 4 for c in cards}
    only_board = {c // 4 for c in board}

    def outs(ranks):
        if _straight_high(ranks) >= 0:
            return set()
        return {r for r in range(13) if r not in ranks and _straight_high(ranks | {r}) >= 0}

    n_outs = len(outs(full) - outs(only_board))
    value += 0.32 if n_outs >= 2 else 0.17 if n_outs == 1 else 0.0
    if len(board) == 4:
        value *= 0.5       # one card to come instead of two
    return min(value, 0.55)


def board_strength(board):
    """For every combo on this board: (made-hand percentile 0..1, draw value).
    Percentile 1.0 = the best possible hand right now."""
    key = tuple(sorted(board))
    if key in _board_cache:
        return _board_cache[key]
    dead = set(board)
    scored = []
    for i, (a, b) in enumerate(COMBOS):
        if a not in dead and b not in dead:
            scored.append((evaluate([a, b] + board), i))
    scored.sort()
    made = [0.0] * N
    j = 0
    while j < len(scored):              # equal hands share a percentile
        k = j
        while k < len(scored) and scored[k][0] == scored[j][0]:
            k += 1
        p = (j + k) / 2 / len(scored)
        for _, i in scored[j:k]:
            made[i] = p
        j = k
    draw = [_draw_value(a, b, board) if made[i] < 0.9 else 0.0
            for i, (a, b) in enumerate(COMBOS)]
    if len(_board_cache) > 256:
        _board_cache.clear()
    _board_cache[key] = (made, draw)
    return made, draw


def continue_strength(made, draw):
    """Strength for 'should I keep playing': draws play like medium hands."""
    return [max(m, min(0.9, 0.35 + d)) if d > 0 else m for m, d in zip(made, draw)]

# ---------------------------------------------------------------- range math


def _sigmoid(x):
    x = max(-30.0, min(30.0, x))
    return 1.0 / (1.0 + math.exp(-x))


def soft_top(weights, strength, q, width=0.04):
    """Membership (0..1) of each combo in the strongest fraction q of the range.
    'Soft' so hands near the cutoff are partly in: players aren't robots."""
    if q >= 0.999:
        return [1.0] * N
    live = [i for i in range(N) if weights[i] > 0]
    if not live or q <= 0.001:
        return [0.0] * N
    live.sort(key=lambda i: -strength[i])
    total = sum(weights[i] for i in live)
    acc, cut = 0.0, strength[live[-1]]
    for i in live:
        acc += weights[i]
        if acc >= q * total:
            cut = strength[i]
            break
    return [_sigmoid((strength[i] - cut) / width) for i in range(N)]


def mass(weights, membership=None):
    if membership is None:
        return sum(weights)
    return sum(w * m for w, m in zip(weights, membership))


class Stat:
    """A frequency with a prior: starts at `prior` and moves toward what we observe."""

    def __init__(self, prior, strength=12):
        self.hits = prior * strength
        self.total = float(strength)

    def add(self, hit, weight=1.0):
        self.hits += weight * (1.0 if hit is True else 0.0 if hit is False else hit)
        self.total += weight

    @property
    def value(self):
        return self.hits / self.total


class OpponentModel:
    def __init__(self):
        # Tendencies (priors are a typical loose-ish home-game player).
        # Priors count as 8 hands, so a player's real habits show up quickly.
        self.open = Stat(0.55, 8)         # raises first in from the button/SB
        self.defend = Stat(0.60, 8)       # continues vs a preflop raise
        self.threebet = Stat(0.12, 8)     # re-raises a preflop raise
        self.reraise = Stat(0.05, 8)      # raises again after a 3-bet (4-bet+)
        self.vs_reraise = Stat(0.45, 8)   # continues when re-raised preflop
        self.aggression = Stat(0.35, 8)   # bets when checked to after the flop
        self.raise_vs_bet = Stat(0.12, 8) # raises when facing a bet after the flop
        self.looseness = Stat(1.0, 8)     # continues vs bets, relative to a balanced player (1.0)
        self.weights = [1.0] * N
        self.street = None
        self.raises = 0

    # ---- per hand

    def new_hand(self):
        self.weights = [1.0] * N
        self.street = None
        self.raises = 0

    def remove_cards(self, cards):
        dead = set(cards)
        for i, (a, b) in enumerate(COMBOS):
            if a in dead or b in dead:
                self.weights[i] = 0.0

    def _apply(self, membership):
        self.weights = [w * (FLOOR + (1 - FLOOR) * m) for w, m in zip(self.weights, membership)]

    def continue_fraction(self, to_call, pot_after_bet, preflop, facing_reraise=False):
        """Share of their range that keeps playing vs a bet (they call `to_call`
        into a pot of `pot_after_bet`)."""
        if preflop:
            q = self.vs_reraise.value if facing_reraise else self.defend.value
        else:
            balanced = 1 - to_call / max(pot_after_bet, 1)   # 'minimum defense frequency'
            q = balanced * self.looseness.value
        return max(0.03, min(1.0, q))

    def observe(self, ev, board):
        """Update the range after the opponent's action `ev` (an engine history dict)."""
        if ev["street"] != self.street:
            self.street, self.raises = ev["street"], 0
        w, act = self.weights, ev["action"]
        if act == "fold":
            return

        if ev["street"] == "preflop":
            s = PREFLOP_STRENGTH
            if act == "raise":
                q = (self.open.value if ev["to_call"] > 0 else 0.3) if self.raises == 0 \
                    else self.threebet.value if self.raises == 1 else self.reraise.value
                self._apply(soft_top(w, s, q))
            elif act == "call" and self.raises == 0 and ev["to_call"] > 0:   # limp
                strong = soft_top(w, s, self.open.value * 0.4)
                playable = soft_top(w, s, 0.85)
                self._apply([p * (1 - 0.8 * t) for p, t in zip(playable, strong)])
            elif act == "call" and ev["to_call"] > 0:                         # call a raise
                q = self.defend.value if self.raises == 1 else self.vs_reraise.value
                cont = soft_top(w, s, q)
                would_raise = soft_top(w, s, self.threebet.value if self.raises == 1 else self.reraise.value)
                self._apply([c * (1 - 0.7 * r) for c, r in zip(cont, would_raise)])
            else:                                                            # check option
                self._apply([1 - 0.8 * t for t in soft_top(w, s, 0.25)])
            if act == "raise":
                self.raises += 1
            return

        made, draw = board_strength(board)
        if act == "raise":
            facing = ev["to_call"] > 0
            added = ev["to"] - ev["before"] - ev["to_call"]
            r = added / max(ev["pot"] + ev["to_call"], 1)
            freq = self.raise_vs_bet.value if facing else self.aggression.value
            bluff_ratio = r / (1 + 2 * r)            # balanced bluff share for this size
            value = soft_top(w, made, freq * (1 - bluff_ratio))
            cand = [1.0 if d > 0 else 0.5 if m < 0.3 else 0.0 for m, d in zip(made, draw)]
            value_mass = mass(w, value)
            cand_mass = sum(wi * (1 - v) * c for wi, v, c in zip(w, value, cand))
            k = value_mass * bluff_ratio / (1 - bluff_ratio) / cand_mass if cand_mass > 0 else 0
            self._apply([v + (1 - v) * min(1.0, k * c) for v, c in zip(value, cand)])
            self.raises += 1
        elif act == "call" and ev["to_call"] > 0:
            q = self.continue_fraction(ev["to_call"], ev["pot"], False)
            cont = soft_top(w, continue_strength(made, draw), q)
            would_raise = soft_top(w, made, 0.08)
            self._apply([c * (1 - 0.7 * x) for c, x in zip(cont, would_raise)])
        else:                                                   # check
            strong = soft_top(w, made, self.aggression.value * 0.6)
            self._apply([1 - 0.6 * t for t in strong])

    # ---- learning between hands

    def learn(self, history, opp_seat):
        """Update tendencies from a finished hand's action history."""
        raises, street, last_bettor = 0, None, None
        first_preflop = True
        for ev in history:
            if ev["street"] != street:
                street, raises, last_bettor = ev["street"], 0, None
            mine = ev["seat"] == opp_seat
            act = ev["action"]
            if mine and street == "preflop":
                if first_preflop and raises == 0 and ev["to_call"] > 0:
                    self.open.add(act == "raise")
                if raises == 1:
                    self.defend.add(act != "fold")
                    self.threebet.add(act == "raise")
                elif raises >= 2:
                    self.vs_reraise.add(act != "fold")
                    self.reraise.add(act == "raise")
                first_preflop = False
            elif mine:
                if ev["to_call"] == 0:
                    self.aggression.add(act == "raise")
                elif last_bettor is not None and last_bettor != opp_seat:
                    self.raise_vs_bet.add(act == "raise")
                    balanced = 1 - ev["to_call"] / max(ev["pot"], 1)
                    # Looseness = how often they continue vs how often a balanced player would.
                    self.looseness.hits += 1.0 if act != "fold" else 0.0
                    self.looseness.total += balanced
            if act == "raise":
                raises += 1
                last_bettor = ev["seat"]
