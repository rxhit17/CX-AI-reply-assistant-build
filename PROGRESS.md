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

## Phase 2 – Database & auth ⏳
Written, **not yet applied to the Supabase project / not yet verified against it**:
- `supabase/migrations/…0001_core_schema.sql` – 16 tables, composite brand-consistency FKs, KB version snapshots (DB-computed hash/version), RLS enabled everywhere.
- `…0002_rls_policies.sql` – browser role is SELECT-only; all writes go through the API (service role after explicit authz); private storage bucket; Realtime publication.
- `…0003_retrieval_and_draft_rpcs.sql` – `match_kb_hybrid` (brand filter inside SQL, RRF fusion, keyword-only fallback) and atomic `fn_save_generation / fn_edit_draft / fn_approve_draft / fn_send_draft / fn_discard_draft` with stale-policy checks.
- `supabase/seed/data.ts` + `scripts/seed.ts` – 2 brands, 4 users, 8 customers, 8 orders, 18 KB entries, 8 conversations; relative dates; deterministic IDs; refuses non-local URLs unless explicitly overridden.
- Remaining: apply migrations, run seed, RLS/brand-isolation SQL tests, Supabase Auth wiring in API/web.
- Supabase Auth config: disable public sign-ups in the dashboard (Authentication → Sign In / Providers) — accounts are created by the seed/admin only.

## How to apply (needs your input)
1. Fill `.env` (see `.env.example`): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_*`, `OPENAI_API_KEY`.
2. `pnpm exec supabase link --project-ref <ref>` then `pnpm exec supabase db push` (asks for the DB password), or paste the three migration files into the SQL editor in order.
3. `SEED_ALLOW_REMOTE=true SEED_PASSWORD='<strong password>' pnpm db:seed`
