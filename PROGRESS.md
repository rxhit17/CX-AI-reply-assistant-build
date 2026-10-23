# Progress

_Last updated: 2026-10-23_

## Acceptance checklist

See `docs/ACCEPTANCE.md` (updated per phase). Nothing is marked done without verification evidence.

## Phase 0 – Planning ✅

- Environment: Node 24.19, npm 11, pnpm 12.15 (installed), Docker 29.5 (daemon running), Supabase CLI via `npx` (2.122), Git 2.54.
- Credentials: **no OpenAI key, no Supabase project, no Railway/Vercel access** in env.
- Decisions: TypeScript pinned to 5.9.3 (typescript-eslint compat). Local Supabase in Docker for dev.
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
