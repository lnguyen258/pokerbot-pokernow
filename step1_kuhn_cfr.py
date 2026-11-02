"""
Step 1 of the roadmap: vanilla CFR on Kuhn poker.

Kuhn poker: 3 cards (J, Q, K), each player antes 1 chip and gets one card.
Player 0 acts first. Actions: p = pass/check/fold, b = bet/call (1 chip).
Highest card wins at showdown.

Run:
  python step1_kuhn_cfr.py            # train and print the strategy
  python step1_kuhn_cfr.py --play     # train, then play against the bot

What "working" looks like: exploitability falls toward 0, and player 0's
average value approaches -1/18 = -0.0556 (the known game value).
"""
import random
import sys

CARD_NAMES = "JQK"
ACTIONS = "pb"
TERMINALS = {"pp", "bp", "bb", "pbp", "pbb"}


def payoff_p0(history, c0, c1):
    """Chips won by player 0 at a terminal history."""
    if history == "bp":    # player 1 folded to a bet
        return 1
    if history == "pbp":   # player 0 folded to a bet
        return -1
    stake = 1 if history == "pp" else 2   # showdown
    return stake if c0 > c1 else -stake


def to_act(history):
    return len(history) % 2


class Node:
    """One information set: what a player knows (their card + the betting so far)."""

    def __init__(self):
        self.regret_sum = [0.0, 0.0]
        self.strategy_sum = [0.0, 0.0]

    def strategy(self):
        # Regret matching: play actions in proportion to their positive regret.
        pos = [max(r, 0.0) for r in self.regret_sum]
        total = sum(pos)
        return [p / total for p in pos] if total > 0 else [0.5, 0.5]

    def average_strategy(self):
        # The AVERAGE strategy is what converges to equilibrium, not the current one.
        total = sum(self.strategy_sum)
        return [s / total for s in self.strategy_sum] if total > 0 else [0.5, 0.5]


nodes = {}


def cfr(cards, history, reach0, reach1):
    """Returns the expected value for player 0 and updates regrets along the way."""
    if history in TERMINALS:
        return payoff_p0(history, cards[0], cards[1])

    player = to_act(history)
    key = CARD_NAMES[cards[player]] + history
    node = nodes.setdefault(key, Node())
    strat = node.strategy()

    action_values = [0.0, 0.0]
    node_value = 0.0
    for i, a in enumerate(ACTIONS):
        if player == 0:
            action_values[i] = cfr(cards, history + a, reach0 * strat[i], reach1)
        else:
            action_values[i] = cfr(cards, history + a, reach0, reach1 * strat[i])
        node_value += strat[i] * action_values[i]

    # Regret is weighted by how likely the OPPONENT was to get us here.
    sign = 1 if player == 0 else -1          # values are from player 0's view
    my_reach, opp_reach = (reach0, reach1) if player == 0 else (reach1, reach0)
    for i in range(2):
        node.regret_sum[i] += opp_reach * sign * (action_values[i] - node_value)
        node.strategy_sum[i] += my_reach * strat[i]
    return node_value


def train(iterations):
    deals = [(a, b) for a in range(3) for b in range(3) if a != b]
    total = 0.0
    for t in range(1, iterations + 1):
        for cards in deals:              # walk every deal: "vanilla" CFR
            total += cfr(cards, "", 1.0, 1.0) / len(deals)
        if t in (1, 10, 100, 1000, iterations):
            print(f"iter {t:>6}  avg value p0 {total / t:+.4f}  "
                  f"exploitability {exploitability():.5f}")


def avg(card, history):
    node = nodes.get(CARD_NAMES[card] + history)
    return node.average_strategy() if node else [0.5, 0.5]


def best_response_value(br_player):
    """How much a perfect opponent who knows our strategy would win, per hand."""

    def value(history, my_card, weights):
        # weights[c] = chance prob * our bot's reach prob for its card c
        if history in TERMINALS:
            v = 0.0
            for c, w in weights.items():
                cards = (my_card, c) if br_player == 0 else (c, my_card)
                u = payoff_p0(history, *cards)
                v += w * (u if br_player == 0 else -u)
            return v
        if to_act(history) == br_player:
            return max(value(history + a, my_card, weights) for a in ACTIONS)
        total = 0.0
        for i, a in enumerate(ACTIONS):
            new_w = {c: w * avg(c, history)[i] for c, w in weights.items()}
            total += value(history + a, my_card, new_w)
        return total

    v = 0.0
    for my_card in range(3):
        weights = {c: 1 / 6 for c in range(3) if c != my_card}
        v += value("", my_card, weights)
    return v


def exploitability():
    # 0 means no strategy can beat the bot in expectation.
    return (best_response_value(0) + best_response_value(1)) / 2


def print_strategy():
    print("\nBot's strategy (probability of BET/CALL):")
    for key in sorted(nodes, key=lambda k: (len(k), k)):
        print(f"  card {key[0]}  history '{key[1:] or '-'}'  ->  "
              f"{nodes[key].average_strategy()[1]:.2f}")


def play():
    bank = 0
    print("\nYou vs the bot. Enter p (pass/check/fold) or b (bet/call). Ctrl+C to quit.")
    while True:
        cards = random.sample(range(3), 2)
        human = random.randint(0, 1)
        print(f"\n--- You are player {human}. Your card: {CARD_NAMES[cards[human]]} ---")
        h = ""
        while h not in TERMINALS:
            if to_act(h) == human:
                a = ""
                while a not in ("p", "b"):
                    a = input(f"history '{h or '-'}', your move: ").strip().lower()
            else:
                a = random.choices(ACTIONS, avg(cards[1 - human], h))[0]
                print(f"bot plays {a}")
            h += a
        won = payoff_p0(h, *cards) * (1 if human == 0 else -1)
        bank += won
        print(f"bot had {CARD_NAMES[cards[1 - human]]}. You {'+' if won > 0 else ''}{won}. "
              f"Running total: {bank:+d}")


if __name__ == "__main__":
    train(20000)
    print_strategy()
    if "--play" in sys.argv:
        play()
