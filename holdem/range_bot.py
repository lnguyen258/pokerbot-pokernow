"""RangeBot: plays against the opponent's estimated range, not against random hands.

Each decision:
  1. Update the opponent's range from their actions this hand (ranges.py).
  2. Simulate: deal them hands from that range, run out the board, record who wins.
  3. For every option, estimate its expected value (EV) in chips:
       check  = our equity x pot (discounted when out of position)
       call   = equity vs their betting range x final pot - cost of calling
       bet/raise = they fold (we win the pot now)
                 + they continue (we play our equity vs their CONTINUING range)
     Fold equity is what makes button steals and bluffs profitable; the
     continuing range is what tells us how thin we can value bet.
  4. Pick an option at random, favouring higher EV (softmax). Options with
     nearly equal EV get mixed, so we're harder to read than a fixed rule.
"""
import math
import random

from bots import raise_to
from ranges import (COMBOS, N, PREFLOP_STRENGTH, OpponentModel, board_strength,
                    continue_strength, mass, soft_top)
from cards import evaluate

STREET_CARDS = {"preflop": 0, "flop": 3, "turn": 4, "river": 5}


def simulate(hole, board, weights, sims, rng):
    """Deal opponent hands from `weights` and run out the board.
    Returns (combo index, our result 1/0.5/0) per simulation."""
    dead = set(hole) | set(board)
    deck = [c for c in range(52) if c not in dead]
    picks = rng.choices(range(N), weights=weights, k=sims)
    results = []
    need = 5 - len(board)
    for i in picks:
        a, b = COMBOS[i]
        run = []
        while len(run) < need:
            c = deck[rng.randrange(len(deck))]
            if c != a and c != b and c not in run:
                run.append(c)
        full = board + run
        me, opp = evaluate(hole + full), evaluate([a, b] + full)
        results.append(1.0 if me > opp else 0.5 if me == opp else 0.0)
    return picks, results


def equity_vs(picks, results, membership=None):
    """Our equity against a sub-range (re-weights the same simulations)."""
    if membership is None:
        return sum(results) / len(results)
    num = sum(membership[i] * r for i, r in zip(picks, results))
    den = sum(membership[i] for i in picks)
    return num / den if den > 1e-6 else sum(results) / len(results)


class RangeBot:
    def __init__(self, sims=400, temperature=0.04, seed=None, verbose=False):
        self.sims = sims
        self.temperature = temperature        # higher = more mixing
        self.rng = random.Random(seed)
        self.verbose = verbose
        self.model = OpponentModel()
        self.hole = None
        self.seen = 0

    # ---- bookkeeping

    def hand_over(self, seat, history, holes):
        self.model.learn(history, 1 - seat)
        self.hole = None

    def _sync(self, obs):
        if obs["hole"] != self.hole:              # new hand
            self.hole = obs["hole"]
            self.seen = 0
            self.model.new_hand()
            self.model.remove_cards(self.hole)
        for ev in obs["history"][self.seen:]:
            if ev["seat"] != obs["seat"]:
                board = obs["board"][:STREET_CARDS[ev["street"]]]
                self.model.remove_cards(board)
                self.model.observe(ev, board)
        self.seen = len(obs["history"])
        self.model.remove_cards(obs["board"])

    # ---- decision

    def act(self, obs):
        self._sync(obs)
        hole, board = obs["hole"], obs["board"]
        w = self.model.weights
        if mass(w) <= 0:
            w = self.model.weights = [1.0] * N
            self.model.remove_cards(hole + board)
        picks, results = simulate(hole, board, w, self.sims, self.rng)
        eq = equity_vs(picks, results)

        pot, to_call = obs["pot"], obs["to_call"]
        preflop = obs["street"] == "preflop"
        river = obs["street"] == "river"
        # Acting last (button, after the flop) lets us realise more of our equity.
        realise = 1.0 if river or obs["is_button"] else 0.85
        if preflop:
            strength = PREFLOP_STRENGTH
        else:
            strength = continue_strength(*board_strength(board))

        options = []
        if to_call == 0:
            options.append((("call",), realise * eq * pot, "check"))
        else:
            options.append((("fold",), 0.0, "fold"))
            r = 1.0 if to_call >= obs["my_stack"] else realise
            options.append((("call",), r * eq * (pot + to_call) - to_call, "call"))

        if obs["min_raise_to"] is not None:
            facing_reraise = preflop and sum(
                1 for e in obs["history"] if e["street"] == "preflop" and e["action"] == "raise") >= 1
            for frac in ((1.0,) if preflop else (0.5, 1.0)):
                action = raise_to(obs, frac)
                x = action[1] - obs["my_bet"]                                  # chips we put in
                their_call = min(action[1] - obs["opp_bet"], obs["opp_stack"])  # chips they must add
                q = self.model.continue_fraction(their_call, pot + x, preflop, facing_reraise)
                cont = soft_top(w, strength, q)
                fold_p = 1 - mass(w, cont) / mass(w)
                eq_c = equity_vs(picks, results, cont)
                r = 1.0 if river or action[1] >= obs["max_raise_to"] else realise
                ev = fold_p * pot + (1 - fold_p) * (r * eq_c * (pot + x + their_call) - x)
                label = f"raise {frac:g} pot (fold {fold_p:.0%}, eq if called {eq_c:.0%})"
                options.append((action, ev, label))

        # Softmax: mostly pick the best EV, mix between close options.
        scale = max(pot, 1) * self.temperature
        best = max(ev for _, ev, _ in options)
        probs = [math.exp((ev - best) / scale) for _, ev, _ in options]
        choice = self.rng.choices(range(len(options)), weights=probs)[0]
        if self.verbose:
            print(f"eq vs range {eq:.0%} | " +
                  " | ".join(f"{lbl}: {ev:+.1f}" for _, ev, lbl in options) +
                  f"  -> {options[choice][2]}")
        return options[choice][0]
