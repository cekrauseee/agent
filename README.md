# Agent

A Next.js backend for Google-authenticated conversations, durable OpenAI generation, projects,
private Markdown pages and recording transcription. The pnpm/Turborepo workspace contains the web
app in `apps/web`, durable worker in `apps/worker` and shared server code in `packages/backend`.

## Run locally

Install Node.js 24 LTS, pnpm 11.10.0 and Docker Compose. Clone the repository, then:

```sh
pnpm setup
pnpm dev
```

Setup installs locked dependencies, upserts root `.env` from `.env.example`, starts PostgreSQL and
applies migrations on the host. `pnpm dev` starts both the host web app and durable worker through
Turborepo; Compose runs only PostgreSQL. If this project's containers or data already exist, answer
the fresh start prompt with Enter or `N` to reuse them, or `Y` to authorize deleting the project's
local PostgreSQL data. Existing values are preserved, missing local defaults/session secret are
generated, and obsolete keys are removed. Ports come from `.env` or host overrides, falling back to
3000/5432. If another container occupies a configured port, setup asks `[y/N]` before stopping it
without deleting its data; declining cancels setup. Running legacy app/worker containers must be
stopped manually before reuse. See [setup details](docs/runtime.md#setup-script).

The defaults are `http://localhost:3000` for the app and localhost:5432 for PostgreSQL. Fill
existing `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `OPENAI_API_KEY` credentials in `.env`;
setup leaves missing external credentials blank and reports their names. Restart `pnpm dev` after
configuration changes. Configure Google's callback as
`http://localhost:3000/api/auth/callback/google`, adjusted to your app port. Keep `APP_PORT`,
`POSTGRES_PORT`, `BETTER_AUTH_URL`, the host `DATABASE_URL` and Google's callback consistent. The
app, worker and migration command load root `.env`; its host database URL must match the Compose
PostgreSQL port. Env files are ignored. Builds and `/api/health` need no service secrets.

The worker must run for admitted generations to progress. Missing OpenAI configuration leaves them
pending; no development login bypass is provided. The database volume survives
`docker compose down`; adding `--volumes` destroys its data. Apply migrations before starting the
worker or accepting API traffic. See [runtime setup](docs/runtime.md) for host development and
[authentication](docs/auth.md) for Google/session configuration.

## Verify

With local PostgreSQL running:

```sh
pnpm format:check
TEST_DATABASE_URL=postgresql://agent:agent-local@localhost:5432/agent pnpm test:backend
pnpm typecheck
pnpm lint
pnpm build
pnpm db:generate
docker compose config --quiet
```

The database checks need a local administrative connection able to create/drop temporary databases.
They apply migrations to isolated databases, use real signed Better Auth sessions and controlled
OpenAI SDK transports, and remove their own databases afterward. Without `TEST_DATABASE_URL`,
integration checks are skipped. No test makes paid provider requests. `pnpm db:generate` should
report no schema changes on an unchanged checkout; apply reviewed migrations with `pnpm db:migrate`
using root `.env` (exported variables can override it).

GitHub Actions runs format check, lint, typecheck and the full backend suite with a disposable
PostgreSQL service on PRs and `main`. Use `pnpm format` to apply the 100-column, single-quote,
no-semicolon style. See [CI and code style](docs/ci.md), including typed errors for
unused/deprecated code. The database driver defaults from `VERCEL_ENV`: Neon for Vercel
preview/production, PostgreSQL otherwise; an explicit override supports non-Vercel workers.

## Developer documentation

- [Architecture and schema](docs/architecture.md): ownership, transaction boundaries, durable jobs
  and deletion.
- [API reference](docs/api.md): each endpoint's purpose, request bodies, query parameters, response
  objects, status codes and SSE events.
- [Runtime](docs/runtime.md) and [database](docs/database.md): configuration, Compose, migrations
  and connection lifecycle.
- [CI and code style](docs/ci.md): GitHub checks, Prettier policy, typed lint and merge validation.
- [Authentication and models](docs/auth.md): Google profiles, sessions, model/effort catalog and
  defaults.
- [Projects and history](docs/organization.md), [conversation execution](docs/conversations.md),
  [private pages](docs/spaces.md) and [transcription](docs/transcription.md): payloads, limits,
  SSE/reload, editing and failure contracts.

Local backend tests and production builds verify the implementation; setup regression tests use
controlled commands. Live Google OAuth, Neon and OpenAI remain unverified without credentials and
authorized spending. In particular, account access to the exact
model/background/web-search/compaction combination and `gpt-transcribe` requires live validation
before production use. There is no model substitution. No production deployment is included.
