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

## Next: Phase 5–7 – LangGraph workflow, tools, deterministic policy rules, guardrails, draft API

## Blockers / needs user action
- Disable public sign-ups in Supabase (Authentication → Sign In / Providers).
- Railway/Vercel access for Phase 10.
