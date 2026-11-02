"""Heads-up no-limit hold'em dealer, for testing bots offline.

Every bot gets the same plain-dict observation and returns an action:
    ("fold",)  ("call",)  ("raise", total_bet_this_street)
"call" also means check when there is nothing to call.
The PokerNow connector (step 4) should build this same dict from the web page,
so a bot that works here works there unchanged.
"""
import random

from cards import evaluate

STREETS = ("preflop", "flop", "turn", "river")


def play_hand(bots, button, sb=1, bb=2, stack=200, rng=random):
    """Plays one hand. Returns chips won by each seat, e.g. [+6, -6]."""
    deck = list(range(52))
    rng.shuffle(deck)
    holes = [deck[0:2], deck[2:4]]
    board_cards = deck[4:9]
    stacks = [stack, stack]
    invested = [0, 0]
    # One dict per action: street, seat, action ("fold"/"call"/"raise"),
    # to (seat's total bet this street after acting), pot and to_call (before acting).
    history = []

    def put(seat, amount):
        amount = min(amount, stacks[seat])
        stacks[seat] -= amount
        invested[seat] += amount
        return amount

    for street_i, street in enumerate(STREETS):
        board = board_cards[: (0, 3, 4, 5)[street_i]]
        bets = [0, 0]
        if street == "preflop":
            bets[button] = put(button, sb)
            bets[1 - button] = put(1 - button, bb)
            to_act = button          # heads-up: button posts SB and acts first preflop
        else:
            to_act = 1 - button
        last_raise = bb
        acted = [False, False]
        if street != "preflop" and 0 in stacks:
            continue                 # someone is all-in: just deal the board

        while True:
            if all(acted) and bets[0] == bets[1]:
                break
            if stacks[to_act] == 0:
                break
            opp = 1 - to_act
            to_call = bets[opp] - bets[to_act]
            max_to = bets[to_act] + stacks[to_act]
            min_to = min(bets[opp] + last_raise, max_to)
            can_raise = stacks[opp] > 0 and max_to > bets[opp]
            obs = {
                "hole": holes[to_act], "board": board, "street": street,
                "pot": sum(invested), "to_call": min(to_call, stacks[to_act]),
                "my_bet": bets[to_act], "opp_bet": bets[opp],
                "my_stack": stacks[to_act], "opp_stack": stacks[opp],
                "min_raise_to": min_to if can_raise else None,
                "max_raise_to": max_to if can_raise else None,
                "big_blind": bb, "is_button": to_act == button,
                "n_opponents": 1, "history": list(history), "seat": to_act,
            }
            action = bots[to_act].act(obs)
            kind = action[0]
            if kind == "fold" and to_call == 0:
                kind = "call"                # never fold when checking is free
            if kind == "raise" and not can_raise:
                kind = "call"

            event = {"street": street, "seat": to_act, "pot": sum(invested),
                     "to_call": min(to_call, stacks[to_act]), "before": bets[to_act]}
            if kind == "fold":
                history.append(dict(event, action="fold", to=bets[to_act]))
                result = [0, 0]
                result[opp] = invested[to_act]
                result[to_act] = -invested[to_act]
                _notify(bots, history, holes, None)
                return result
            if kind == "call":
                bets[to_act] += put(to_act, to_call)
                history.append(dict(event, action="call", to=bets[to_act]))
                acted[to_act] = True
                if all(acted):
                    break            # a call closes the action (except the SB limp preflop)
                to_act = opp
                continue
            else:
                target = max(min_to, min(int(action[1]), max_to))
                raise_size = target - bets[opp]
                if raise_size >= last_raise:
                    last_raise = raise_size
                put(to_act, target - bets[to_act])
                bets[to_act] = target
                history.append(dict(event, action="raise", to=target))
                acted = [False, False]
            acted[to_act] = True
            to_act = opp

    # Showdown. Refund any uncalled chips first.
    extra = invested[0] - invested[1]
    if extra > 0:
        invested[0] -= extra
    elif extra < 0:
        invested[1] += extra
    s0, s1 = (evaluate(holes[i] + board_cards) for i in (0, 1))
    _notify(bots, history, holes, board_cards)
    if s0 > s1:
        return [invested[1], -invested[1]]
    if s1 > s0:
        return [-invested[0], invested[0]]
    return [0, 0]


def _notify(bots, history, holes, board):
    for seat, bot in enumerate(bots):
        if hasattr(bot, "hand_over"):
            bot.hand_over(seat, history, holes if board else None)
