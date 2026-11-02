"""Play two bots heads-up and report the win rate with a 95% confidence interval.

Run from the holdem folder:
  python match.py                       # equity bot vs every test bot
  python match.py equity maniac 5000    # one matchup, 5000 hands

Win rate is in big blinds per 100 hands (bb/100), the standard poker unit.
If the interval includes 0, you haven't proven either bot is better yet.
"""
import math
import random
import sys
import time

from bots import BOTS
from engine import play_hand

BB = 2


def run(name_a, name_b, hands, seed=0):
    rng = random.Random(seed)
    bots = [BOTS[name_a](), BOTS[name_b]()]
    results = []
    for i in range(hands):
        won = play_hand(bots, button=i % 2, bb=BB, rng=rng)
        results.append(won[0] / BB)
    mean = sum(results) / hands
    var = sum((x - mean) ** 2 for x in results) / (hands - 1)
    ci = 1.96 * math.sqrt(var / hands)
    return mean * 100, ci * 100


def report(a, b, hands):
    start = time.time()
    rate, ci = run(a, b, hands)
    verdict = "WINS" if rate - ci > 0 else "LOSES" if rate + ci < 0 else "unclear"
    print(f"{a:>8} vs {b:<8} {rate:+8.1f} ± {ci:5.1f} bb/100  over {hands} hands  "
          f"-> {verdict}  ({time.time() - start:.0f}s)")


if __name__ == "__main__":
    if len(sys.argv) >= 3:
        report(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 2000)
    else:
        for opp in ("station", "random", "maniac", "equity"):
            report("equity", opp, 2000)
