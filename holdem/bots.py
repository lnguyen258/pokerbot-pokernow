"""Bots. Each has act(obs) -> ("fold",) | ("call",) | ("raise", total_bet_this_street)."""
import random

from cards import equity


def raise_to(obs, pot_fraction):
    """Bet/raise sized as a fraction of the pot after calling, clamped to legal limits."""
    target = obs["opp_bet"] + pot_fraction * (obs["pot"] + obs["to_call"])
    return ("raise", int(max(obs["min_raise_to"], min(target, obs["max_raise_to"]))))


class CallingStation:
    """Never folds, never raises. Weak players often play like this."""

    def act(self, obs):
        return ("call",)


class RandomBot:
    def __init__(self, seed=None):
        self.rng = random.Random(seed)

    def act(self, obs):
        r = self.rng.random()
        if r < 0.15:
            return ("fold",)
        if r < 0.65 or obs["min_raise_to"] is None:
            return ("call",)
        return raise_to(obs, self.rng.choice([0.5, 1.0, 2.0]))


class Maniac:
    """Raises the pot every time it can."""

    def act(self, obs):
        if obs["min_raise_to"] is None:
            return ("call",)
        return raise_to(obs, 1.0)


class EquityBot:
    """Step 3: decide from hand strength and pot odds.

    1. Estimate equity = chance to win vs random hands (simulation).
    2. When the opponent bets, assume their hand is better than random and
       discount our equity a bit; the bigger the bet, the bigger the discount.
    3. Strong -> raise for value. Profitable to call -> call. Otherwise fold.
       Occasionally bluff when checked to, so we're not purely predictable.
    """

    def __init__(self, sims=200, bluff_freq=0.12, seed=None):
        self.sims = sims
        self.bluff_freq = bluff_freq
        self.rng = random.Random(seed)

    def act(self, obs):
        eq = equity(obs["hole"], obs["board"], obs["n_opponents"], self.sims, self.rng)
        pot, to_call = obs["pot"], obs["to_call"]
        can_raise = obs["min_raise_to"] is not None
        preflop = obs["street"] == "preflop"

        if to_call > 0:
            eq -= 0.12 * min(1.0, to_call / max(pot - to_call, 1))
        pot_odds = to_call / (pot + to_call) if to_call else 0.0

        value_line = 0.62 if preflop else 0.72
        if eq >= value_line and can_raise:
            if preflop:
                return raise_to(obs, 0.8)      # about 2.5-3x the previous bet
            return raise_to(obs, 1.0 if eq > 0.85 else 0.66)
        if to_call == 0:
            if not preflop and can_raise and self.rng.random() < self.bluff_freq:
                return raise_to(obs, 0.5)
            return ("call",)                   # check
        if eq >= pot_odds + 0.03:
            return ("call",)
        return ("fold",)


def _range_bot():
    from range_bot import RangeBot       # imported lazily: builds a table on first use
    return RangeBot()


BOTS = {
    "range": _range_bot,
    "equity": EquityBot,
    "station": CallingStation,
    "random": RandomBot,
    "maniac": Maniac,
}
