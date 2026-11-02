"""Cards, a 7-card hand evaluator, and Monte Carlo equity.

A card is an int 0..51: rank = card // 4 (0 = deuce ... 12 = ace), suit = card % 4.
Use parse("As Kd") / show(cards) to convert to and from text like PokerNow shows.
"""
import random
from functools import lru_cache

RANK_CHARS = "23456789TJQKA"
SUIT_CHARS = "cdhs"


def parse(text):
    """'As Kd 7h' -> [51, 46, 22]. Accepts '10' for ten."""
    out = []
    for tok in text.replace("10", "T").split():
        out.append(RANK_CHARS.index(tok[0].upper()) * 4 + SUIT_CHARS.index(tok[1].lower()))
    return out


def show(cards):
    return " ".join(RANK_CHARS[c // 4] + SUIT_CHARS[c % 4] for c in cards)


def _straight_high(rank_set):
    """Highest rank of a 5-card straight in rank_set, or -1."""
    for high in range(12, 3, -1):
        if all((high - i) in rank_set for i in range(5)):
            return high
    if {12, 0, 1, 2, 3} <= rank_set:      # wheel: A-2-3-4-5
        return 3
    return -1


def evaluate(cards):
    """Score 5 to 7 cards. Higher tuple = better hand.
    Categories: 8 straight flush, 7 quads, 6 full house, 5 flush, 4 straight,
    3 trips, 2 two pair, 1 pair, 0 high card."""
    counts = [0] * 13
    suits = [[], [], [], []]
    for c in cards:
        counts[c // 4] += 1
        suits[c % 4].append(c // 4)

    for s in suits:
        if len(s) >= 5:
            sf = _straight_high(set(s))
            if sf >= 0:
                return (8, sf)
            flush = tuple(sorted(s, reverse=True)[:5])
            break
    else:
        flush = None

    groups = sorted(((n, r) for r, n in enumerate(counts) if n), reverse=True)
    if groups[0][0] == 4:
        kicker = max(r for r, n in enumerate(counts) if n and r != groups[0][1])
        return (7, groups[0][1], kicker)
    if groups[0][0] == 3 and len(groups) > 1 and groups[1][0] >= 2:
        return (6, groups[0][1], groups[1][1])
    if flush:
        return (5,) + flush
    st = _straight_high({r for r, n in enumerate(counts) if n})
    if st >= 0:
        return (4, st)
    singles = sorted((r for r, n in enumerate(counts) if n == 1), reverse=True)
    if groups[0][0] == 3:
        return (3, groups[0][1]) + tuple(singles[:2])
    pairs = sorted((r for r, n in enumerate(counts) if n == 2), reverse=True)
    if len(pairs) >= 2:
        kicker = max(r for r, n in enumerate(counts) if n and r not in pairs[:2])
        return (2, pairs[0], pairs[1], kicker)
    if pairs:
        return (1, pairs[0]) + tuple(singles[:3])
    return (0,) + tuple(singles[:5])


def equity(hole, board, n_opponents=1, sims=300, rng=random):
    """Chance to win (ties count half) against n random hands, by simulation."""
    if not board:
        return preflop_equity(_hand_class(hole), n_opponents)
    return _simulate(hole, board, n_opponents, sims, rng)


def _simulate(hole, board, n_opponents, sims, rng):
    dead = set(hole) | set(board)
    deck = [c for c in range(52) if c not in dead]
    need = 5 - len(board) + 2 * n_opponents
    score = 0.0
    for _ in range(sims):
        draw = rng.sample(deck, need)
        full_board = board + draw[: 5 - len(board)]
        mine = evaluate(hole + full_board)
        best_opp = max(evaluate(draw[5 - len(board) + 2 * i: 7 - len(board) + 2 * i] + full_board)
                       for i in range(n_opponents))
        if mine > best_opp:
            score += 1
        elif mine == best_opp:
            score += 0.5
    return score / sims


def _hand_class(hole):
    """One of the 169 preflop hand types, e.g. 'AKs', 'T9o', '77'."""
    a, b = sorted(hole, key=lambda c: -(c // 4))
    ra, rb = RANK_CHARS[a // 4], RANK_CHARS[b // 4]
    if ra == rb:
        return ra + rb
    return ra + rb + ("s" if a % 4 == b % 4 else "o")


@lru_cache(maxsize=None)
def preflop_equity(hand_class, n_opponents):
    """Cached: there are only 169 preflop hand types."""
    r1, r2 = RANK_CHARS.index(hand_class[0]), RANK_CHARS.index(hand_class[1])
    suited = hand_class.endswith("s")
    hole = [r1 * 4, r2 * 4 + (0 if suited else 1)]
    return _simulate(hole, [], n_opponents, 2000, random.Random(hand_class))
