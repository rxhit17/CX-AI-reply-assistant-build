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
