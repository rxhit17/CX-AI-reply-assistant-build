# Progress

_Last updated: 2026-10-23_

## Acceptance checklist

See `docs/ACCEPTANCE.md` (updated per phase). Nothing is marked done without verification evidence.

## Phase 0 – Planning ✅

- Environment: Node 24.19, npm 11, pnpm 12.15 (installed), Docker 29.5 (daemon running), Supabase CLI via `npx` (2.122), Git 2.54.
- Credentials: **no OpenAI key, no Supabase project, no Railway/Vercel access** in env.
- Decisions: TypeScript pinned to 5.9.3 (typescript-eslint compat). **Dev database = the user's Supabase Cloud project** (user declined local Supabase; credentials go in `.env`). Migrations were smoke-tested once on a throwaway local Supabase (Postgres 17 + pgvector): all 3 applied cleanly. Local stack has since been stopped.
- ARCHITECTURE.md written.

## Phase 1 – Foundation ✅
- pnpm monorepo (`apps/web`, `apps/api`, `packages/shared`, `packages/ai`), strict TS (5.9.3), ESLint 9, Prettier, Vitest.
- `@cx/shared`: Zod contracts for all entities/requests. `@cx/ai`: deterministic date/business-day utilities (+7 tests).
- `apps/api`: Fastify 5 with env validation, CORS, rate limit, error handler, `/health`, `/ready` (+4 tests).
- `apps/web`: Vite 8 + React 19 + Tailwind 4 shell with API status check.
- Verified: `pnpm typecheck` clean, `pnpm lint` clean, `pnpm test` 11/11, web + api production builds succeed, built API serves `/health` 200 and `/ready` 503 without DB (expected).
- Notes: pnpm 12 needs `allowBuilds` in `pnpm-workspace.yaml` (esbuild, supabase). shadcn/ui components are added by hand (Radix + cva) in Phase 3.

## Blockers / needs user action

- `OPENAI_API_KEY` for real-model eval and retrieval calibration.
- Supabase Cloud project (URL, anon key, service-role key, DB URL), Railway + Vercel access for Phase 10.

## Phase 2 – Database & auth ✅ (DB part; API/web auth wiring comes with Phase 3)
- Dev database = user's Supabase Cloud project (, pooler ). Direct DB host is IPv6-only and unreachable from the dev machine, so  uses the session pooler.
-  (scripts/migrate.ts) applies migrations 1–5 with checksum tracking;  is idempotent (ran twice OK). Demo logins: admin@demo.test, agent.bloom@demo.test, agent.nordic@demo.test, agent.multi@demo.test (password = SEED_PASSWORD in .env).
- Migration 4: append-only tables allow cascade deletes. Migration 5: keyword search OR-semantics + definer-with-explicit-brand-check for match_kb_hybrid (both found by the integration tests).
- **Integration tests: 24/24 pass** (): anon sees nothing; agents see only their brand; browser writes denied; privileged RPCs denied; SQL retrieval brand isolation (incl. agent asking for another brand's id → empty); inactive entries excluded; KB version bump/snapshot/immutability; draft edit→approve→send with 5 concurrent sends → exactly 1 message; cross-brand actor forbidden; stale policy blocks approval; supersede/discard; blocking guardrail blocks approval; composite FKs reject cross-brand rows; attachment size/mime constraints.
- Not yet verified: vector search path (needs embeddings, Phase 4), Realtime delivery, storage policies (Phase 3).
- TODO for user: disable public sign-ups in Supabase dashboard.
