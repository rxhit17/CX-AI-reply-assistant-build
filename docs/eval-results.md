# AI evaluation results

_Generated 2026-10-24T01:59:29.321Z · model `gpt-4o-mini` (judge `gpt-4.1-mini`, vision `gpt-4o-mini`, embeddings `text-embedding-3-small`) · 1 cases × 1 runs = 1 generations_

Scoring is code-based (see `packages/ai/src/eval/checks.ts`); no model grades another model. Cases run through the production LangGraph workflow with real retrieval from the brand-isolated knowledge base. Images are synthetic drawings, so image results measure pipeline behaviour, **not** vision accuracy on real photographs.

## Summary
| | |
|---|---|
| Runs passing every check | **1/1 (100.0%)** |
| Cases passing in all 1 runs | 1/1 |
| Flaky cases (passed some runs, failed others) | 0 |
| Cases failing in every run | 0 |
| Runs that needed the corrective retry | 0 (0.0%) |
| Runs ending in the safe fallback | 0 |
| Latency p50 / p95 | 6533 ms / 6533 ms |
| Tokens (all runs) | 2,086 |

## By metric (individual checks across all runs)
| Metric | Passed | Rate |
|---|---|---|
| intent | 1/1 | 100.0% |
| eligibility | 1/1 | 100.0% |
| escalation | 0/0 | n/a |
| groundedness | 2/2 | 100.0% |
| policy_compliance | 5/5 | 100.0% |
| brand | 3/3 | 100.0% |
| language | 0/0 | n/a |
| content | 5/5 | 100.0% |
| style | 1/1 | 100.0% |
| safety | 4/4 | 100.0% |

## By category (runs)
| Category | Cases | Passed | Rate |
|---|---|---|---|
| damaged | 1 | 1/1 | 100.0% |

## Per case
| Case | Passed runs |
|---|---|
| dmg-01-no-photo | 1/1 |

## Failures and flaky cases
None.
