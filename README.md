# Agent

A Next.js backend for Google-authenticated conversations, durable OpenAI generation, projects,
private Markdown pages and recording transcription. The existing starter page remains; this
repository delivers the backend APIs and worker, with shadcn preset `b1VlIwYS` ready for future
interface work.

## Run locally

Install Node.js 24 LTS, pnpm 11.10.0 and Docker Compose. Clone the repository, then:

```sh
pnpm setup
```

Setup installs locked dependencies, upserts `.env` from `.env.example`, builds the containers,
starts PostgreSQL, applies migrations and starts the app/worker. If this project's containers or
data already exist, press Enter to reuse them; type `fresh start` only to authorize deleting the
project's local PostgreSQL data. Existing values are preserved, missing local defaults/session
secret are generated, and obsolete keys are removed. Existing published ports are reused when their
env values are missing. See [setup details](docs/runtime.md#setup-script).

The defaults are `http://localhost:3000` for the app and localhost:5432 for PostgreSQL. Fill
existing `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `OPENAI_API_KEY` credentials in `.env`;
setup leaves missing external credentials blank and reports their names. Rerun `pnpm setup` and
choose reuse after changes. Configure Google's callback as
`http://localhost:3000/api/auth/callback/google`, adjusted to your app port. Keep `APP_PORT`,
`POSTGRES_PORT`, `BETTER_AUTH_URL`, the host `DATABASE_URL` and Google's callback consistent.
Compose forces the local PostgreSQL driver/container URL. Env files are ignored and excluded from
images. Builds and `/api/health` need no service secrets.

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
using exported database variables or the Compose command above.

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

Local backend tests, production builds, container startup and migrations establish the local
implementation. Live Google OAuth, Neon and OpenAI remain unverified without credentials and
authorized spending. In particular, account access to the exact
model/background/web-search/compaction combination and `gpt-transcribe` requires live validation
before production use. There is no model substitution. No production deployment is included.
