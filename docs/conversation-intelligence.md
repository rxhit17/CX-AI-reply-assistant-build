# Conversation intelligence (case state and next-action decisions)

Fixes the "assistant keeps asking the customer to confirm what they already confirmed" failure. Written for engineers reviewing the workflow.

## Root causes (verified in code)

1. **Per-message classification.** `understandIntent` classified only the latest message. "I already confirmed. What is the next step?" has no intent of its own, so it became `unclear`/`general_question`.
2. **That routed to the clarification path.** `afterUnderstanding` sent `unsupported` to `generateSafeFallback`, which composed in mode `clarify` ("ask one short clarifying question") with no order, eligibility or policy loaded, so the model re-asked the last question.
3. **No memory of customer statements.** Facts existed only inside raw history; nothing extracted "unused", "original packaging" or "wants a refund", and eligibility checks were keyed to the _latest_ intent only.
4. **Prompt had no anti-repeat or progress rules**, and no notion of a decided next step.
5. **History window of 12** previous messages in both model calls (long threads lost early facts).
6. **Brand sign-off on every reply** (email-style in a live chat).
7. **`/s+/g` bug** in the non-English compliance check normalisation (my own shell-escaping slip): whitespace was not normalised, so verbatim-quote verification could miss quotes spanning line breaks.

Not a root cause: `runGeneration` uses a fresh graph and random checkpoint thread id, but the conversation is reloaded from PostgreSQL every run.

## Design

```
loadConversation → loadVerifiedOrderFacts (+ previous case state) → understandIntent (one LLM call, now also extracts case_update)
 → updateCaseState (deterministic merge) → decideNextAction (deterministic) → [route] → retrieval / analyzeImage / eligibility
 → generateResponse → validateResponse → saveDraft
```

- **Case state** (`packages/ai/src/case-state.ts`): `issue_type`, `confirmed_facts`, `denied_facts`, `other_facts`, `desired_resolution`, `resolution_confirmed`, `corrections`, `as_of_message_id`. Customer statements only, labelled _unverified_ in prompts. Verified facts (order, eligibility) always come from the database and rules engine.
- **Extraction**: added to the existing `understand` structured output (`case_update`); **no extra LLM call**.
- **Merge** (`mergeCaseState`): facts accumulate; later statements override (confirmed ↔ denied); retractions remove; `unknown` never overwrites known; resolution confirmation is sticky until the resolution changes or is withdrawn; idempotent for repeated messages.
- **Persistence**: `ai_generations.case_state jsonb` (migration `20261024000007`), saved by `fn_save_generation`, loaded by `ports.loadPreviousCaseState`. It is a **cache**: the message history stays authoritative and every run re-derives state from it. The persisted value only keeps facts that fall outside the 30-message window. No new tables.
- **Next action** (`packages/ai/src/policy/next-action.ts`, pure and unit-tested):
  - `effectiveIntent`: a context-dependent message (`unclear`, `general_question`, `complaint`, `greeting` that continues the case) continues the open case.
  - `decideNextAction`: route, which eligibility checks to run (latest intent ∪ what the customer wants), missing information (`order_reference`, `photo`), workflow stage and a preliminary next action.
  - `finalizeNextAction`: after the deterministic checks, ineligible → `explain_eligibility`, needs review → `handoff_to_human`, missing photo → `ask_missing_info`.
  - Actions: `acknowledge`, `clarify_request`, `ask_missing_info`, `explain_policy`, `explain_eligibility`, `provide_next_step`, `order_status_update`, `handoff_to_human`.
- **Prompts**: compose receives the case summary, next-action instruction, topics already answered, still-missing items and the previous agent reply; it must not re-ask, repeat itself, or invent procedures.
- **No documented procedure** (the seeded Nordic policy does not say how to start a return): the model must set `next_step_documented=false`; the graph then flags escalation with a clear reason instead of letting invented steps through.

## Guardrails added (`packages/ai/src/guardrails.ts`)

- `no_redundant_question` (blocking): the model's `questions_asked` topics, plus English regex backstops, must not include a **closed** topic the customer already answered (`item_unused`, `original_packaging`, photo, order, resolution confirmation). Descriptive facts ("the item differs from the listing") are excluded so legitimate clarifying questions are not blocked.
- `no_repeated_reply` (blocking): word-overlap ≥ 0.85 with the previous agent reply.
- `no_invented_procedure` (blocking): return label, portal, RMA, drop-off, pick-up, collection, courier, QR code, tracking number… are only allowed if a policy source uses the term.
- Existing citation, figure-grounding, promise, completed-action, brand-leak and photo checks are unchanged.

## Sign-off and greeting

`shouldAddSignOff`: the fixed brand sign-off is added to the first agent reply and after a 6-hour pause, not to every live-chat message. Greeting logic is unchanged (first reply only). Brand voice is untouched.

## Tests

- Unit: `case-state.test.ts`, `policy/next-action.test.ts`, new cases in `guardrails.test.ts`.
- Multi-turn regression (`graph/multi-turn.test.ts`, mock LLM, successive generations with persisted state): Emma / Oak Side Table, corrections, missing and linked orders, repeated messages, long histories, retrieval scoping, missing operational policy, guardrail retries, brand isolation, damaged-product photo follow-ups, sign-off policy.
- Real model: `pnpm eval:conversation` (writes `docs/eval-conversation.md`).

## Known limitations

- Extraction quality depends on the model. With `gpt-4o-mini` a hedged correction was missed until the prompt gained definitions and a worked example; one of six real-model runs still ended in the safe fallback because the model repeated its previous reply twice.
- The redundant-question regex backstops are English-only; other languages rely on the model's `questions_asked` self-report.
- `no_invented_procedure` allows a term if _any_ source uses it (for example "collection" in the defective-item sentence of the Nordic return policy).
- The first message of a conversation can already be answered with eligibility ("you are eligible to return…") before the customer has said they want a return.

---

# Task 1.1: reliability fixes

Verified against the Task 1 implementation and the live evaluation (`docs/eval-conversation.md`).

## Verified defects and fixes

| Defect                                                                                                                                           | Evidence               | Fix                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A repeated question got a repeated answer; the repeat guard then produced a generic holding message                                              | live run, A2 turns 5-6 | New next action `follow_up_pending` (customer asks "what is next" again, or repeats a message, after an agent reply already gave the step). The model is told to move the case forward; retry feedback says exactly what progress is required; if every attempt fails the fallback is a **grounded handoff** naming the request and the verified order, not a generic line. |
| First message ("doesn't look like what I ordered") produced "you are eligible to return…"                                                        | live run               | `mismatch` issue type. A mismatch with no stated resolution runs **no** return/refund checks and asks one question (`issue_cause`). New blocking guardrail `no_unrequested_eligibility`, and `eligibility_claim_supported` (a return claim needs a RETURN check, a refund claim a REFUND check).                                                                            |
| `no_invented_procedure` accepted a term if it appeared anywhere in any source                                                                    | review                 | Per-sentence grounding in `procedure.ts`: a sentence scoped to defective/damaged goods (or any sentence of a damage/warranty policy) only authorises the procedure for a case that actually has a defect. "Is a next step documented?" is also decided by code, overruling the model's claim.                                                                               |
| Repeated policy figures every turn                                                                                                               | live run               | Figures already stated by agents are passed to the model (`ALREADY STATED`), a warning-level `repeats_policy_facts` check, and repetition is allowed when the customer asks for clarification (`asks_clarification`).                                                                                                                                                       |
| Regeneration inherited the state computed for the same message                                                                                   | code review            | `loadPreviousCaseState(conversation, beforeMessageId)` excludes state computed for the current message.                                                                                                                                                                                                                                                                     |
| "Latest" state chosen by write time, so a slow older generation could shadow a newer one                                                         | code review            | State is chosen by the customer message it covers, not by `created_at`.                                                                                                                                                                                                                                                                                                     |
| Spurious retractions erased real facts (live model retracted `customer_ordered_wrong_item` on an unrelated message, even with a correction note) | live timelines         | A retraction is honoured only with a correction note **and** a replacement of the same kind (explicit denial, material issue change, or a different cause fact). Return/refund/exchange drift is not a change of issue.                                                                                                                                                     |
| "Return and refund" silently narrowed to "return"                                                                                                | live timeline          | Narrowing needs an explicit correction.                                                                                                                                                                                                                                                                                                                                     |
| `you're looking for a refund` treated as an entitlement claim (withheld a correct decline of an ineligible refund)                               | live run, D            | Entitlement now needs entitlement words (eligible, entitled, qualify, "you can return/get…"); negation is sentence-aware and handles contractions.                                                                                                                                                                                                                          |
| "this does not guarantee an outcome" blocked as a guarantee                                                                                      | live run, D            | Only asserted guarantees are blocked.                                                                                                                                                                                                                                                                                                                                       |

## Persistence rules (verified)

Customer messages stay authoritative (state is re-derived every run); agent text is never a customer fact (prompt rule + live scenario E); state is scoped to one conversation (and so one brand and customer); corrections override earlier statements; facts beyond the 30-message window survive in the persisted state; regeneration and out-of-order generations cannot supply stale state; one generation at a time per conversation within a process (409). No schema change was needed.

## Known limits

Between instances, two simultaneous generations for the SAME conversation are not prevented (in-process lock only); they cannot corrupt state, because each run reads only the state of earlier messages. Extraction recall still depends on the model.
