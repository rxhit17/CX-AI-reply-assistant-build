# Architecture

> Original design document. Hosting has since moved to Azure (see [azure-deployment.md](azure-deployment.md)); the order-verification step, streaming, conversation case state and Hinglish support were added after this was written (see the [README](../README.md) and [conversation-intelligence.md](conversation-intelligence.md)).

AI-powered CX Reply Assistant: agents manage customer conversations and get **draft-only**, brand-grounded AI replies that they edit, approve and send.

## 1. Topology

```
Browser (React/Vite, Vercel)
   │  Supabase JS (anon key): auth session, Realtime, RLS-protected reads
   │  REST + Bearer JWT
   ▼
Fastify API (Railway)  ── LangGraph workflow (packages/ai) ── OpenAI (chat / embeddings / vision)
   │  user-scoped Supabase client (JWT forwarded → RLS applies)
   │  service-role client ONLY for narrowly scoped system writes, after explicit authz
   ▼
Supabase (Postgres + pgvector + FTS + Auth + Realtime + Storage)
```

No Redis/Kafka/etc. Rate limiting is in-process (`@fastify/rate-limit`), acceptable for a single Railway instance; documented trade-off.

## 2. Version decisions (verified against npm on 2026-10-23)

| Package               | Version                                                                    | Note                                                                                        |
| --------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Node                  | 24 LTS (>=22)                                                              |                                                                                             |
| TypeScript            | **5.9.3**                                                                  | Latest is 7.x, but `typescript-eslint` 8.72 supports `<6.1`. Pinned for lint compatibility. |
| React / Vite          | 19.x / 8.x                                                                 |                                                                                             |
| Tailwind              | 4.x (`@tailwindcss/vite`)                                                  | shadcn/ui components added by hand (Radix + cva), `components.json` present                 |
| Fastify               | 5.x                                                                        |                                                                                             |
| Zod                   | 4.x                                                                        | shared contracts and LLM structured output                                                  |
| LangChain / LangGraph | `@langchain/core` 1.x, `@langchain/openai` 1.x, `@langchain/langgraph` 1.x |                                                                                             |
| Supabase JS           | 2.x                                                                        |                                                                                             |
| Vitest / Playwright   | 5.x / 1.64                                                                 |                                                                                             |

APIs of LangChain/LangGraph are verified against the installed package typings before use, not recalled from memory.

## 3. Monorepo layout

- `packages/shared` – Zod schemas + inferred types + API contracts (single source of truth for web, api, ai).
- `packages/ai` – pure AI logic: LangChain model factory, prompts, LangGraph `StateGraph`, tools, deterministic policy rules, guardrails, retrieval client. No HTTP, no framework code. Dependencies (DB, LLM) are injected so tests can mock them.
- `apps/api` – Fastify: auth plugin, routes, services, repositories (the only code touching Supabase).
- `apps/web` – React UI. Never holds secrets; talks to API and Supabase (anon + RLS).
- `supabase/` – migrations, seed, SQL tests (pgTAP-style / scripted).
- `scripts/` – seed, embedding backfill, retrieval calibration, evaluation runner.
- `tests/` – integration + Playwright e2e.

Layering inside the API: `routes → services → repositories → Supabase`. Business rules live in `packages/ai/src/policy` (pure functions) and are reused by tools and guardrails (no duplication).

## 4. Security model

1. **Auth**: Supabase Auth JWT. API verifies via `supabase.auth.getUser(token)`; profile/role loaded from DB, never from client claims.
2. **Authorization**: `brand_memberships(user_id, brand_id)`; admins have global access. Every route resolves brand from the DB row (conversation → brand) and checks membership. Client-supplied brand/user IDs are never trusted.
3. **RLS** enabled on every table from migration 1. API uses a _user-scoped_ client for reads/writes where possible, so RLS is a second enforcement layer.
4. **Brand isolation in SQL**: `match_kb_hybrid(p_brand_id, …)` filters `brand_id` and `is_active` inside the function; `EXECUTE` revoked from `anon`/`authenticated` for the service path where the API derives `brand_id` from the conversation record. Cross-brand test is part of the DB integration suite.
5. **Storage**: private bucket, path `brand/<brand_id>/conversation/<id>/…`, signed URLs only, storage RLS keyed on brand membership.
6. **LLM safety**: customer text and KB text are untrusted data (delimited, never instructions). Tools are a fixed registry; none mutate orders. Output validated in code (see §6).
7. Secrets only in server env; `VITE_*` contains only the Supabase URL + anon key.

## 5. Data model (summary)

`profiles, brands, brand_settings, brand_memberships, customers, orders, order_items, conversations, messages, message_attachments, knowledge_base, knowledge_base_versions, ai_generations, ai_generation_sources, ai_draft_events, escalation_requests`.

- `knowledge_base`: `embedding vector(1536)` (text-embedding-3-small), `content_hash`, `version`, `embedding_status`, generated `tsvector` column + GIN, HNSW index on embedding.
- Drafts are `ai_generations` rows with status `draft → edited → approved → sent | discarded | superseded | withheld`. Every transition appends `ai_draft_events`.
- `send_draft(p_draft_id, p_idempotency_key, p_agent_id)` is an atomic RPC (row lock, status check, insert message, mark sent). `messages.client_message_id` unique per conversation gives idempotency for manual/customer sends.
- Stale policy: draft stores source `(kb_id, version)`; approve/send compares with current versions and rejects with `STALE_POLICY` when changed.

## 6. AI workflow (LangGraph)

`StateGraph` with typed Annotation state. Nodes: `loadConversation → loadOrderFacts → understandIntent → route`

- small_talk → `generateConversational`
- order_question → `getOrderDetails` → `evaluateEligibility`
- policy_question → `rewriteQuery → retrieveBrandKnowledge → evaluateEligibility`
- image_complaint → `analyzeImage → rewriteQuery → retrieve → evaluateEligibility`
- human_request → `generateEscalation`
- unsupported/unclear → `safeFallback`

then `generateResponse → validateResponse → safetyRouter` (pass → `saveDraft`; fail → one bounded retry with violation feedback → else `safeFallback`). Retrieval insufficiency short-circuits to a clarification/escalation draft without calling the LLM to invent policy.

Checkpointing: in-memory/`MemorySaver` per generation for retry recovery; authoritative history in Postgres. The graph ends at `saveDraft`; approval/sending are separate API operations.

Guardrail layers: (1) SQL retrieval isolation + sufficiency, (2) deterministic business rules (windows, thresholds, evidence), (3) prompt controls, (4) code output validation (JSON schema, citation IDs exist and belong to brand, forbidden commitments, cross-brand terms, fact consistency with eligibility result), (5) safe fallback. LLM-judge groundedness check only when deterministic checks pass but the draft cites policy-sensitive content.

## 7. Retrieval calibration

Hybrid = vector (cosine) + FTS (`websearch_to_tsquery`) fused with Reciprocal Rank Fusion, plus category boost from intent. Sufficiency thresholds (min vector similarity, min RRF) are env-configurable and chosen from a labelled dataset (`scripts/calibrate-retrieval.ts`, results in `docs/retrieval-calibration.md`). Without an OpenAI key the calibration cannot run; defaults are marked **uncalibrated** until it does.

## 8. Dev vs. production

- Dev: local Supabase via `supabase start` (Docker) + `.env`.
- Prod: Supabase Cloud, Railway (API, `/health` + `/ready`), Vercel (web). See README deployment section.
- CI tests use a mocked LLM (deterministic); real-model evaluation is a separate command.

## 9. Known external dependencies / blockers

OpenAI API key, Supabase Cloud project, Railway and Vercel accounts are not available in the current environment. Local work proceeds against local Supabase; real-model eval and deployment are blocked until credentials are provided (tracked in PROGRESS.md).
