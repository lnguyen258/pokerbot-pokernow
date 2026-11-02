# How to build a poker bot: the techniques that work

Nov 1, 2026 · @Luis

The strongest poker bots all combine three things: a game-theoretic blueprint trained by self-play with counterfactual regret minimization (CFR), real-time search on top of it, and, in newer systems, neural networks that replace hand-built abstractions.

## Landmark systems

Poker AI went from heads-up (two players) to six players and then to general-purpose learners in about five years. Each system below added one idea you can reuse.

| System | Year | Game | What it added |
| --- | --- | --- | --- |
| [DeepStack](https://arxiv.org/pdf/1701.01724) | 2016 | Heads-up no-limit | Continual re-solving plus neural networks that estimate the value of a situation. Beat 11 pros over 44,000 hands |
| [Libratus](https://www.ijcai.org/proceedings/2017/0772.pdf) | 2017 | Heads-up no-limit | Abstracted blueprint, nested subgame solving, a self-improver. Beat four pros over 120,000 hands |
| [Pluribus](https://par.nsf.gov/servlets/purl/10119653) | 2019 | Six-player no-limit | Depth-limited search for many players; trained in 8 days on a 64-core server with no GPUs |
| [ReBeL](https://arxiv.org/pdf/2007.13544) | 2020 | Heads-up no-limit, Liar's Dice | AlphaZero-style self-play plus search that works with hidden information, with far less poker-specific knowledge |
| [Student of Games](https://pmc.ncbi.nlm.nih.gov/articles/PMC10651118) | 2023 | Chess, Go, poker, Scotland Yard | One algorithm for perfect and imperfect information games |
| [Supremus](https://arxiv.org/pdf/2007.10442) | 2020 | Heads-up no-limit | Improved DeepStack-style value networks; beats Slumbot by a large margin, where a plain DeepStack reimplementation loses to it |

## Core building blocks

Heads-up no-limit hold'em has about 10^161 decision points, so no bot solves it directly. Every top system shrinks the game, solves the small version, then refines the answer during play.

**1. Abstraction.** Two kinds are standard. Action abstraction keeps only a few bet sizes (for example half pot, pot, all-in) and maps an off-tree opponent bet to the nearest one. Card abstraction buckets strategically similar hands together, often by clustering their equity distributions. Libratus shrank the game from 10^161 to about 10^12 decision points this way ([IJCAI 2017](https://www.ijcai.org/proceedings/2017/0772.pdf)). Abstraction costs information, so strong bots use it only for the early rounds or for future rounds, and drop it in live search.

**2. Counterfactual regret minimization (CFR).** The bot plays against itself and tracks regret: how much better each action would have done in hindsight. Its average strategy converges toward a Nash equilibrium in two-player zero-sum games. Useful variants:

- **CFR+** clips negative regrets and, in its author's tests, converged more than an order of magnitude faster than vanilla CFR ([Tammelin](https://web3.arxiv.org/pdf/1407.5042)). It helped essentially solve heads-up limit hold'em.
- **Discounted CFR (DCFR)** down-weights early iterations and beats CFR+ in games where some actions are very costly mistakes ([Brown and Sandholm](https://par.nsf.gov//servlets/purl/10119655)).
- **Monte Carlo CFR (MCCFR)** samples parts of the tree each iteration instead of walking all of it. Pluribus used it to train its blueprint ([overview](https://www.kdnuggets.com/2020/12/remembering-pluribus-facebook-master-difficult-poker-game.html)).

**3. Blueprint plus real-time search.** The abstract solution is only a blueprint. During play the bot re-solves the part of the game it has actually reached, in finer detail. Libratus called this nested subgame solving and built a new subgame whenever the opponent made an off-abstraction bet, avoiding rounding errors. The search must stay consistent with the blueprint so the opponent cannot exploit the switch ([Libratus article](https://par.nsf.gov/servlets/purl/10077416)).

**4. Self-improvement.** Libratus watched which bet sizes opponents used that were missing from its blueprint, then computed strategies for those branches and added them ([summary](https://www.futurity.org/libratus-poker-artificial-intelligence-1635242/)).

## Neural approaches

Neural networks attack the two weak points above: hand-built abstraction and the cost of searching to the end of the game.

- **Deep CFR** replaces CFR's tables of regrets with neural networks, so no handcrafted abstraction is needed. The variant Single Deep CFR (SD-CFR) drops the separate average-strategy network and reaches lower exploitability ([overview](https://www.emergentmind.com/topics/deep-cfr)). A 2025 paper adds variance reduction and discounting (VR-DeepDCFR+) and reports faster convergence than earlier model-free neural CFR ([arXiv](https://arxiv.org/html/2511.08174v1)).
- **Value networks for depth-limited search (DeepStack).** The bot searches only to the end of the current betting round, then asks a trained network for the value of the position. DeepStack used such networks after the flop and turn were dealt, and solved the rest of the game directly on the turn and river ([paper](https://arxiv.org/pdf/1701.01724)). Reimplementing it well is hard: the Supremus authors found a plain reimplementation lost to Slumbot until they made several improvements ([arXiv](https://arxiv.org/abs/2007.10442)).
- **ReBeL** trains value and policy networks by self-play over public belief states, which makes AlphaZero-style RL plus search sound with hidden information. It provably converges to a Nash equilibrium in two-player zero-sum games, but its network input grows linearly with the number of hand possibilities in a public state ([paper](https://arxiv.org/pdf/2007.13544)). Code is [open source](https://github.com/facebookresearch/rebel).
- **Student of Games** combines guided search, self-play learning and game-theoretic reasoning in one algorithm, and beat the strongest openly available agent in heads-up no-limit hold'em ([Science Advances](https://pmc.ncbi.nlm.nih.gov/articles/PMC10651118)). Its authors raise the open question of whether this level of play is reachable with less compute.

For a solo builder the realistic path is: tabular MCCFR for a small abstraction first, then Deep CFR or a value network once the pipeline works.

## Multiplayer poker

If your bot will play at a full table, two-player theory no longer guarantees anything. CFR is not guaranteed to converge to a Nash equilibrium outside two-player zero-sum games, and a Nash strategy no longer ensures you avoid losing. Pluribus's authors therefore set an empirical goal: consistently beat strong humans ([Science paper](https://par.nsf.gov/servlets/purl/10119653)).

What made it work cheaply:

- **A blueprint from MCCFR self-play** against copies of itself, using action and card abstraction. Training took 8 days on a 64-core server with under 512 GB of RAM and no GPUs ([overview](https://www.kdnuggets.com/2020/12/remembering-pluribus-facebook-master-difficult-poker-game.html)). The authors estimated about $150 of cloud compute ([NOVA](https://www.pbs.org/wgbh/nova/article/pluribus-texas-holdem)).
- **Information abstraction only for future rounds**, never for the betting round actually being played.
- **Depth-limited real-time search**, which looks ahead several moves given possible opponent decisions. Scientific American credits it for the low computing needs compared with earlier superhuman game AIs ([article](https://www.scientificamerican.com/article/ai-conquers-six-player-poker)).
- **A fixed strategy.** Pluribus did not adapt to individual opponents.

Result: about 5 big blinds per 100 hands against professionals ([Gizmodo](https://gizmodo.com/superhuman-ai-crushes-poker-pros-at-six-player-texas-1836257695)). The evaluation used 10,000 hands with five humans against one copy of the AI, and 10,000 hands with one human against five copies ([NOVA](https://www.pbs.org/wgbh/nova/article/pluribus-texas-holdem)).

## Opponent exploitation

An equilibrium bot is hard to beat but only wins slightly against weak players, because it does not try to punish their mistakes ([AAMAS 2024](https://aamas.csc.liv.ac.uk/Proceedings/aamas2024/pdfs/p2393.pdf)). Playing a pure best response to an estimated opponent model is the opposite risk: if the model is wrong, you can be exploited ([NeurIPS 2022](https://proceedings.neurips.cc/paper_files/paper/2022/file/b12a1d1014e952e676f5d6931d03241a-Paper-Conference.pdf)).

Safe-exploitation methods sit between the two:

- **Restricted Nash response (RNR).** Solve a modified game in which the opponent is forced to follow your model with probability p and plays freely otherwise. Raising p moves your strategy from Nash toward a best response ([Johanson et al., as described in this 2026 paper](https://arxiv.org/pdf/2607.28520)).
- **Safe Exploitation Search.** A real-time search that interpolates between safety and exploitation, with bounded exploitability, and updates cheaply as the opponent model changes ([NeurIPS 2022](https://neurips.cc/virtual/2022/poster/54171)).
- **Depth-limited restricted responses.** Continual depth-limited RNR combines limited look-ahead with an opponent model, with a guarantee of at least the value of the game ([AAMAS 2024](https://aamas.csc.liv.ac.uk/Proceedings/aamas2024/pdfs/p2393.pdf)).
- **Certified exploitation.** A 2026 preprint deploys an exploit only after statistical tests confirm the opponent deviates, and tracks a loss budget it can certify ([arXiv](https://www.alphaxiv.org/abs/2607.28520.md)). Treat it as new and unreviewed.

When the opponent data is thin, stay close to equilibrium and exploit only deviations you are confident about.

## LLM-based poker agents

Language models are a newer, less proven route. The results below are mostly recent preprints, so treat them as promising rather than established.

- **Fine-tuning on solver or game data.** [PokerGPT](https://arxiv.org/pdf/2401.06781) trains a lightweight LLM on real poker data to play multiplayer hold'em. [SpinGPT](https://arxiv.org/abs/2509.22387) targets the three-player Spin & Go format: it matched the solver's action in 78% of decisions and scored 13.4 ± 12.9 BB/100 against Slumbot heads-up over 30,000 hands, an interval wide enough that the true edge could be small.
- **Skill libraries, no training.** [PokerSkill](https://arxiv.org/html/2605.30094v1) reports pure LLM agents with encoded GTO knowledge and no solver queries at inference, losing less to GTOWizard than Slumbot does. It is a preprint.
- **LLMs as a helper to classic solvers.** An [Abstraction Agent](https://www.alphaxiv.org/abs/2609.04303) preprint uses an LLM to propose strategic features and cluster hands into abstraction buckets from a natural-language rules description. Other work lets an LLM call an external solver for decisions.

My read: for a first working bot, the CFR route is better understood and has verifiable exploitability numbers. An LLM layer is best added later, for table-reading, opponent notes or abstraction design.

## A practical build roadmap

This ordering is my recommendation, built from the papers above, not a published recipe. Each step gives you something you can test before adding the next.

1. **Solve a toy game exactly.** Implement vanilla CFR on Kuhn or Leduc hold'em and check that exploitability falls toward zero.
2. **Move to CFR+ or DCFR** on limit hold'em or a small no-limit subgame, to see the faster convergence.
3. **Build abstractions.** Pick a handful of bet sizes (action abstraction) and cluster hands by equity distribution with k-means (card abstraction), as hobby projects such as [Poker-AI](https://github.com/Gongsta/Poker-AI) do.
4. **Train a blueprint with MCCFR** on the abstract game, solving preflop and flop in more detail than later rounds, as Libratus did.
5. **Add real-time subgame solving** for the current betting round, with a rule for off-tree bet sizes.
6. **Evaluate honestly.** Measure exploitability if the game is small enough, and play long head-to-head matches against a benchmark bot such as Slumbot. Poker results are noisy, so report confidence intervals, as the SpinGPT result above shows.
7. **Optionally add exploitation** with restricted Nash response once you have opponent data.
8. **Optionally replace tables with networks** (Deep CFR or a value network) when memory becomes the limit.

### Open-source starting points

| Tool | Use it for |
| --- | --- |
| [OpenSpiel](https://github.com/mwalton/openspiel_benchmarks) (DeepMind's framework; the link is a repo reproducing its algorithms, and the paper is arxiv.org/abs/1908.09453) | CFR variants, RL and game-solving algorithms on small games |
| [RLCard](https://github.com/datamllab/rlcard) | Card-game environments including Leduc, limit and no-limit Texas hold'em |
| [ReBeL](https://github.com/facebookresearch/rebel) | Reference code for RL plus search on Liar's Dice |
| [DeepPDCFR](https://github.com/rpSebastian/DeepPDCFR) | Code for the 2025 neural CFR variants |

## Legal and ethical limits

Build and test bots against other bots, in play-money games, or on research benchmarks such as Slumbot. Poker sites are actively working to detect and remove bots ([NPR via WJCT](https://www.wjct.org/?p=195542)), and bot use on real-money tables is typically against a site's terms of service and can cost you your account and balance. I have not checked any specific site's rules, so read the terms before you play anywhere. This report covers research techniques only and does not cover evading bot detection.

## Sources

These links come from search results. I read excerpts and abstracts, not every paper in full, so check a paper before relying on a specific number.

- [Superhuman AI for multiplayer poker (Pluribus), Science 2019](https://par.nsf.gov/servlets/purl/10119653)
- [Libratus: The Superhuman AI for No-Limit Poker, IJCAI 2017](https://www.ijcai.org/proceedings/2017/0772.pdf)
- [Superhuman AI for heads-up no-limit poker: Libratus, Science 2018](https://par.nsf.gov/servlets/purl/10077416)
- [DeepStack: Expert-Level AI in No-Limit Poker](https://arxiv.org/pdf/1701.01724)
- [ReBeL: Combining Deep RL and Search for Imperfect-Information Games](https://arxiv.org/pdf/2007.13544)
- [Student of Games, Science Advances 2023](https://pmc.ncbi.nlm.nih.gov/articles/PMC10651118)
- [Solving Large Imperfect Information Games Using CFR+](https://web3.arxiv.org/pdf/1407.5042)
- [Solving Imperfect-Information Games via Discounted Regret Minimization](https://par.nsf.gov//servlets/purl/10119655)
- [Deep (Predictive) Discounted CFR, 2025](https://arxiv.org/html/2511.08174v1)
- [Unlocking the Potential of Deep Counterfactual Value Networks (Supremus)](https://arxiv.org/abs/2007.10442)
- [Safe Opponent-Exploitation Subgame Refinement, NeurIPS 2022](https://proceedings.neurips.cc/paper_files/paper/2022/file/b12a1d1014e952e676f5d6931d03241a-Paper-Conference.pdf)
- [Continual Depth-limited Responses, AAMAS 2024](https://aamas.csc.liv.ac.uk/Proceedings/aamas2024/pdfs/p2393.pdf)
- [Confidence-Scheduled Restricted Responses, 2026 preprint](https://arxiv.org/pdf/2607.28520)
- [SpinGPT, 2025](https://arxiv.org/abs/2509.22387)
- [PokerSkill, 2026 preprint](https://arxiv.org/html/2605.30094v1)
- [PokerGPT, 2024](https://arxiv.org/pdf/2401.06781)
- [RLCard toolkit paper](https://arxiv.org/pdf/1910.04376)
