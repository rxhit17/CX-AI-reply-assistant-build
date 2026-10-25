# CX Reply Assistant

An AI-assisted customer-support tool. Support agents handle conversations for several brands, and the assistant writes
**draft-only, brand-grounded replies**. An agent reviews, edits, approves and sends every message: the AI never sends
anything by itself.

## What it does

- **Multi-brand inbox.** Customers, orders and conversations per brand, with live updates. Agents only see the brands
  they belong to.
- **Grounded drafts.** Each draft is written from the brand's own policy knowledge base and the customer's verified
  order. Return windows, refund eligibility, damage windows and shipping thresholds are computed by code, not by the
  model.
- **Order verification.** When a question needs order data, the assistant asks for the order number and matches it
  against that customer's own orders, so it works from the right order even when a customer has many.
- **Safety checks.** Every draft is validated before an agent sees it: citations, grounded figures, no refund or
  replacement promises that eligibility doesn't support, no invented procedures or offers, no other-brand names. One
  corrective retry, then a safe fallback.
- **Streaming.** The agent sees real progress and the reply text as it is written.
- **Knowledge base management.** Admins edit policies; versions, embeddings and stale-policy detection are automatic.
- **Audit trail.** Every draft, its sources, guardrail results, eligibility results and agent actions are stored and
  viewable in the AI Logs page.

## Architecture

```
Browser (React + Vite)
   │  Supabase JS (anon key): login, realtime, row-level-security reads
   │  REST + Bearer JWT, server-sent events for streaming drafts
   ▼
Fastify API ── LangGraph workflow (packages/ai) ── OpenAI (chat, vision, embeddings)
   │
   ▼
Supabase: Postgres + pgvector + full-text search, Auth, Realtime, private Storage
```

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (design), [docs/database.md](docs/database.md) (schema),
[docs/conversation-intelligence.md](docs/conversation-intelligence.md) (case state and multi-turn behaviour).

### The AI workflow

Load the conversation and verified order → understand the message (intent, language, search query) → update the case
state → verify the order number if needed → decide the next action → retrieve policy (hybrid vector + keyword search,
brand-isolated in SQL) → run deterministic eligibility checks → write the reply → validate → retry once or fall back →
save the draft. Approval and sending are separate, audited steps.

## Tech stack

TypeScript (strict) · pnpm monorepo · React 19, Vite, Tailwind CSS 4, TanStack Query · Fastify 5 · LangChain and
LangGraph · OpenAI · Supabase (Postgres, pgvector, Auth, Realtime, Storage) · Zod · Vitest and Playwright · Docker ·
Azure Container Apps and Static Web Apps (Vercel config included).

## Repository layout

```
.
├── apps/
│   ├── api/              Fastify API: routes → services → Supabase
│   └── web/              React app (inbox, AI assistant, knowledge base, logs, settings)
├── packages/
│   ├── ai/               AI logic: LangGraph workflow, prompts, tools, policy rules, guardrails, retrieval
│   └── shared/           Zod schemas and types shared by the web app, the API and the AI package
├── supabase/
│   ├── migrations/       The database schema (applied in order)
│   └── seed/             Demo brands, customers, orders and policies
├── scripts/              migrate, seed, embed, evaluate, calibrate, clear chats, Azure deploy scripts
├── tests/                integration tests (real Supabase project) and Playwright end-to-end tests
├── docs/                 architecture, database, deployment, evaluation and calibration reports
├── Dockerfile            API image (the web app is static)
├── vercel.json           Optional: web app on Vercel
└── .env.example          Every setting, with comments
```

## Getting started

### Prerequisites

- Node.js 22 or newer, and [pnpm](https://pnpm.io) 12 (`corepack enable` is enough)
- A [Supabase](https://supabase.com) project (Auth and Postgres)
- An [OpenAI](https://platform.openai.com) API key (or run with the built-in mock model, see below)

### 1. Install

```bash
git clone https://github.com/rxhit17/CX-AI-reply-assistant-build.git
cd CX-AI-reply-assistant-build
pnpm install
```

### 2. Configure

```bash
cp .env.example .env        # on Windows: copy .env.example .env
```

Fill in `.env` (all settings are documented in [`.env.example`](.env.example)). The essentials:

| Variable                                      | Where to find it                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `SUPABASE_URL`, `VITE_SUPABASE_URL`           | Supabase → Project Settings → API                                          |
| `SUPABASE_ANON_KEY`, `VITE_SUPABASE_ANON_KEY` | the public (anon / publishable) key                                        |
| `SUPABASE_SERVICE_ROLE_KEY`                   | the secret key. **Server only: never prefix it with `VITE_`.**             |
| `DATABASE_URL`                                | Supabase → Connect → session pooler connection string (for migrations)     |
| `OPENAI_API_KEY`                              | your OpenAI key                                                            |
| `SEED_PASSWORD`, `SEED_ALLOW_REMOTE=true`     | a strong password for the demo accounts; required to seed a hosted project |

Keep `.env` as plain `KEY=value` lines. It is git-ignored; never commit it.

### 3. Create the database and demo data

```bash
pnpm db:migrate     # create the schema
pnpm db:seed        # demo brands, customers, orders, policies and logins
pnpm db:embed       # compute policy embeddings (needs the OpenAI key)
```

In the Supabase dashboard, also disable public sign-ups (Authentication → Sign In / Providers).

### 4. Run

```bash
pnpm dev
```

API: http://127.0.0.1:3101 (check `/health` and `/ready`) · Web: http://localhost:5173

### 5. Log in

| Email                    | Role  | Access                                                |
| ------------------------ | ----- | ----------------------------------------------------- |
| `admin@demo.test`        | admin | everything, incl. settings and knowledge base editing |
| `agent.multi@demo.test`  | agent | both brands                                           |
| `agent.bloom@demo.test`  | agent | Bloom Botanics only                                   |
| `agent.nordic@demo.test` | agent | Nordic Living only                                    |

The password is the `SEED_PASSWORD` you set. **These are demo accounts: change or delete them before real use.**

### Try it

1. Click a customer in the inbox. The side panel shows all of that customer's orders.
2. Switch to **Customer simulator** and send, for example: _"I want to return my item"_.
3. Switch back to **Agent** and click **Generate AI reply**. With `ORDER_GATE_ENABLED=true` the draft asks for the
   order number. Send one of the customer's real order numbers as the customer, and the order is linked and shown.
4. Generate again, then edit, **Approve**, and **Send**.

### No OpenAI key?

Set `LLM_MODE=mock` for a deterministic, rule-based stand-in model (keyword retrieval, no network calls). It is meant
for tests and trying the UI, not for real answers.

## Commands

| Command                                              | What it does                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm dev`                                           | API and web app with live reload                                       |
| `pnpm build`                                         | Production build of everything                                         |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check` | Static checks                                                          |
| `pnpm test`                                          | Unit tests (AI package and API), no network needed                     |
| `pnpm test:integration`                              | Integration tests against a real Supabase project (see below)          |
| `pnpm test:e2e`                                      | Playwright end-to-end tests                                            |
| `pnpm db:migrate` / `db:seed` / `db:embed`           | Database setup                                                         |
| `pnpm db:clear-chats [--yes]`                        | Delete all conversations (dry run unless `--yes`)                      |
| `pnpm calibrate`                                     | Re-tune retrieval thresholds ([report](docs/retrieval-calibration.md)) |
| `pnpm eval`, `pnpm eval:conversation`                | Real-model evaluation suites ([results](docs/eval-results.md))         |

## Testing

- **Unit tests** (`pnpm test`): the AI package (policy rules, guardrails, retrieval, the workflow graph including
  retry and fallback paths) and the API, using a mocked model. Fast and deterministic.
- **Integration tests** (`pnpm test:integration`): run against a real Supabase project and OpenAI. They sign in as the demo
  accounts (run the seed first) and cover row-level security, brand isolation, concurrent sends, the draft lifecycle and
  the API. They write test data, so use a development project, never production.
- **Evaluation** (`pnpm eval`): scores real-model answers on a labelled set of scenarios.

## Configuration notes

- `ORDER_GATE_ENABLED` turns on the order-number check. `ORDER_GATE_MAX_ATTEMPTS` is how many wrong numbers are
  accepted before the case is handed to a person.
- The API keeps rate limits in memory, so it should run as **one instance**.
- Retrieval thresholds were calibrated on a small labelled set (see the calibration report for the caveats).

## Deployment

The API runs as a container and the web app as static files. A step-by-step runbook with one-command scripts for
**Azure** (Container Apps, Container Registry, Static Web Apps) is in
[docs/azure-deployment.md](docs/azure-deployment.md). `vercel.json` is included if you prefer Vercel for the web app.

## Security

- Authentication is Supabase Auth; the API verifies the token and loads the user's role and brands from the database.
- Authorization is checked on every route from database rows (never from client-supplied ids), and row-level security
  is a second layer. Another brand's data returns "not found".
- Customer and policy text are treated as data, never as instructions. The AI's tools are a fixed, read-only set.
- Secrets live only in server environment variables. The browser gets the Supabase URL and public key only.

## Documentation

| Document                                                               | Contents                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------ |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                           | Design, security model, workflow                       |
| [docs/database.md](docs/database.md)                                   | Tables, relationships, policies, functions, migrations |
| [docs/azure-deployment.md](docs/azure-deployment.md)                   | Deploying and updating on Azure                        |
| [docs/conversation-intelligence.md](docs/conversation-intelligence.md) | Case state and multi-turn behaviour                    |
| [docs/retrieval-calibration.md](docs/retrieval-calibration.md)         | How retrieval thresholds were chosen                   |
| [docs/eval-results.md](docs/eval-results.md)                           | Evaluation results                                     |
| [docs/PROGRESS.md](docs/PROGRESS.md)                                   | Development log                                        |

## Status and limitations

Working end to end locally and deployed on Azure. Known gaps: the model is not deterministic, so answers should be
spot-checked when policies change; image analysis has had limited testing with real photos; and no open-source license
has been chosen yet.
