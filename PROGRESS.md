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

## Next: Phase 3 – API + conversation UI

## Blockers / needs user action

- Disable public sign-ups in Supabase.
- Railway/Vercel access for Phase 10.
