# Progress

_Last updated: 2026-10-23_

## Phase 0 – Planning ✅

- Environment: Node 24.19, pnpm 12.15, Docker, Git. ARCHITECTURE.md written.
- Decisions: TypeScript pinned to 5.9.3 (typescript-eslint compat). Dev database = the user's Supabase Cloud project (local Supabase declined).

## Phase 1 – Foundation ✅

- pnpm monorepo (`apps/web`, `apps/api`, `packages/shared`, `packages/ai`), strict TS, ESLint 9, Prettier, Vitest.
- `@cx/shared` Zod contracts; `@cx/ai` date/business-day utilities (7 tests); Fastify shell with env validation, CORS, rate limit, `/health`, `/ready` (4 tests); Vite 8 + React 19 + Tailwind 4 shell.
- Verified: typecheck clean, lint clean, 11/11 unit tests, web + api builds succeed.
- Note: pnpm 12 needs `allowBuilds` in `pnpm-workspace.yaml`.

## Phase 2 – Database ✅ (API/web auth wiring happens in Phase 3)

- Project: Supabase Cloud `dthhteemjmdedzjovkng`. The direct DB host is IPv6-only and unreachable from the dev machine, so `DATABASE_URL` uses the session pooler (`aws-0-ap-south-1`).
- `pnpm db:migrate` applies migrations 1–5 with checksum tracking. `pnpm db:seed` is idempotent (ran twice).
- Migration 4: append-only tables still allow cascade deletes. Migration 5: keyword search uses OR semantics, and `match_kb_hybrid` is security-definer with an explicit brand-access check. Both were found by the integration tests.
- Demo logins: admin@demo.test, agent.bloom@demo.test, agent.nordic@demo.test, agent.multi@demo.test. Password = `SEED_PASSWORD` in `.env`.
- **Integration tests: 24/24 pass** (`pnpm test:integration`, real project). They cover:
  - anon sees nothing; agents see only their brand; browser writes and privileged RPCs are denied;
  - SQL retrieval brand isolation, including an agent asking for another brand's id (returns empty);
  - inactive entries are excluded; KB version bump, snapshot and immutability;
  - draft edit → approve → send, with 5 concurrent sends giving exactly 1 message;
  - cross-brand actors are forbidden; stale policy blocks approval; supersede and discard; blocking guardrails block approval;
  - composite FKs reject cross-brand rows; attachment size and mime constraints.
- Not yet verified: vector search path (Phase 4), Realtime delivery and storage policies (Phase 3).
- TODO for user: disable public sign-ups in the Supabase dashboard (Authentication → Sign In / Providers).

## Phase 3 – Conversation API ✅ (UI not started)

- Fastify routes with Bearer-JWT auth (user + role + brand memberships resolved from the DB): brands (admin-only settings PATCH), conversations (list/search/filter, detail, create, close/reopen), order, messages (idempotent on client_message_id, race-safe), read receipts, image upload (magic-byte sniffing, 5 MB, PNG/JPEG/WebP/GIF, private bucket, signed URLs).
- Other-brand resources return 404, not 403. Per-route rate limits.
- Tests: 25 API unit tests; API integration tests (auth, scoping, dedupe under 3 concurrent sends, attachment lifecycle, spoof/oversize/cross-brand rejection, admin-only settings).

## Phase 4 – Knowledge base + hybrid RAG ✅ (KB management UI not started)

- KB API: list/filter/search, get, versions, create/update (admin only), archive (soft delete) + restore, reembed (skips unchanged unless force), retrieval preview with scores.
- Embeddings (LangChain OpenAIEmbeddings text-embedding-3-small, 1536d): only when content_hash changes; failure is recorded on the row and content is kept; keyword fallback verified. 18 seeded entries embedded; second run skipped all 18.
- Retrieval (packages/ai): brand isolation in SQL; widened candidate fetch; relevance = absolute similarity + relative margin (vector mode) or fused rank (keyword mode); explicit insufficient-context result.
- **Calibration** (docs/retrieval-calibration.md, `pnpm calibrate`): 43 labelled queries. Run 1 (absolute threshold only) gave 22% precision; rule revised to add a relative margin (disclosed in the report). Chosen: similarity 0.26, margin 0.04 → precision 77%, recall 77%, 85% of answerable queries covered (borderline vs the 85% constraint), 1/12 out-of-scope/injection queries wrongly treated as sufficient. **In-sample on a small dataset: optimistic.** Keyword-only fallback cannot abstain reliably (3/12 false-sufficient at every setting); set to rank-1 only.
- Tests: **49/49 integration pass** (DB 24 + API 13 + KB 12, real Supabase + real OpenAI embeddings); 20 AI-package unit tests; 25 API unit tests.
- Bug found by tests and fixed: relevant entries were ordered by fused rank, letting keyword matches outrank the best semantic match, and topK was applied before relevance filtering.

## Phase 5–7 – LangGraph workflow, tools, guardrails, draft API ✅ (UI not started)

- **LangGraph** StateGraph (packages/ai/src/graph): typed Annotation state, conditional routing (small talk / order / policy / image / human / unsupported), bounded retry (initial + 1 corrective attempt) then safe fallback, failure persistence (`failed` generation, no draft body), per-process MemorySaver. The graph ends at saveDraft; approval/sending are separate durable DB operations.
- **Deliberate deviation:** intent, language and the standalone search query come from ONE model call in `understandIntent`; `rewriteQuery` is a deterministic step that uses it (saves a call).
- **LangChain**: ChatOpenAI + withStructuredOutput(Zod), ChatPromptTemplate, OpenAIEmbeddings, tool() registry (9 tools; scope-bound to one conversation, no ids in tool inputs, none can modify orders/refunds).
- **Deterministic rules** (no LLM): return/refund windows (inclusive, brand-specific), damage windows in hours + photo requirement, free-shipping threshold (strictly above), cancellation by order state, delivery estimates in business days.
- **Guardrails** (code): citations exist, grounded figures (days/$ must appear in sources/facts), order number matches, no completed-action claims, no refund/replacement promises unless eligibility supports, no guarantees/invented offers, no other-brand names, no UUIDs/system details, no false/redundant photo statements, no internal source labels, repeated-greeting + language warnings. Model-based check only for non-English drafts, and its findings must quote the reply verbatim.
- **API**: POST /api/ai/generate|regenerate, GET /api/conversations/:id/draft, GET|PATCH /api/ai/drafts/:id, approve, send (idempotent), discard, GET /api/ai/logs(+/:id). Per-agent and per-conversation rate limits, one in-flight generation per conversation, request timeout via AbortSignal. Stale-policy detection (409 STALE_POLICY).
- **Tests**: AI package 130 unit tests (rules, intent, guardrails, retrieval, graph incl. retry/fallback/failure); API 28 unit tests; **64 integration tests pass** (DB 24, API 13, KB 12, AI lifecycle 15) against the real project.
- **Real-model run** (scripts/probe-live.ts, gpt-4o-mini + gpt-4.1-mini judge): all 8 seeded scenarios yield valid non-fallback drafts (~4–9 s each). Defects found by this run and fixed: delivery-estimate figures wrongly blocked; thanks/acknowledgement misclassified as unclear; over-strict LLM judge (now quote-verified, gpt-4.1-mini); model leaking "S1"/"(Source: …)" labels into replies.
- Not yet verified with the real model at scale: see evaluation suite (Phase 9). Image analysis was only exercised with the mock; needs a real photo test.

## Next: frontend (Phase 3 UI, KB UI, Logs UI, Settings), then evaluation suite, Playwright e2e, security tests, docs, deployment

## Blockers / needs user action

- Disable public sign-ups in Supabase (Authentication → Sign In / Providers).
- Railway/Vercel access for Phase 10.

## Task 1 – Conversation intelligence fix ✅ (see docs/conversation-intelligence.md)

- Root causes verified; case state + next-action decision added to the existing graph (no new LLM call, one jsonb column).
- Tests run: typecheck, lint, unit (AI 190, API 28), integration (67), Playwright e2e (16/16), web + API builds. Real-model conversation eval: 5/6 runs pass (`docs/eval-conversation.md`).
- Remaining: first-message eligibility is premature; one flaky run ends in the safe fallback; regex backstops are English-only.

## Task 1.1 – Conversation reliability fixes ✅ (see docs/conversation-intelligence.md)

- `follow_up_pending` action, grounded handoff fallback, ambiguity gating (`mismatch`), per-sentence procedural grounding, persistence rules (state before the current message, ordered by covered message), guardrail false-positive fixes.
- Tests: typecheck/lint clean; AI 259, API 28, integration 70, Playwright 16/16, builds OK.
- Live GPT-4o-mini (`pnpm eval:conversation`, 8 scenarios x 6): 43/48 in the full run (4 failures were network errors in C2, 1 model variability in A1); C2 re-run 6/6. Reports: docs/eval-conversation-full-run.md, docs/eval-conversation.md.

## Language change – English, Spanish, Hinglish ✅

- French and Hindi (Devanagari) removed everywhere; Hinglish (Hindi in Roman letters, code `hinglish`) added. `SUPPORTED_LANGUAGES` lives in `packages/shared`; `packages/ai/src/languages.ts` normalises codes (`hi`/`hindi` -> `hinglish`, unsupported such as `fr` -> English reply).
- Hinglish holding/handoff messages, prompt language rule, guardrail patterns, mock LLM, eval scorer, eval cases, retrieval queries, seed data (French demo customer replaced by a Spanish one) and the Settings language list updated.
- Tests: typecheck/lint clean; AI 267, API 28, integration 70; builds OK; DB re-seeded.
