# Agent

A Next.js backend for Google-authenticated conversations, durable OpenAI generation, projects, private Markdown pages and recording transcription. The existing starter page remains; this repository delivers the backend APIs and worker, with shadcn preset `b1VlIwYS` ready for future interface work.

## Run locally

Install Node.js 24 LTS, pnpm 11.10.0 and Docker Compose. Clone the repository, then:

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# Fill the existing Google OAuth credentials, Better Auth secret and OpenAI key.
docker compose up --build --detach --wait postgres app
docker compose run --rm app pnpm db:migrate
docker compose up --detach --wait worker
```

The app is at `http://localhost:3000`; PostgreSQL is available on localhost:5432. Configure Google's callback as `http://localhost:3000/api/auth/callback/google`. Set `BETTER_AUTH_SECRET` to a random value of at least 32 characters. Set `APP_PORT`, `POSTGRES_PORT`, `BETTER_AUTH_URL` and Google's callback consistently when changing ports. Compose forces the local PostgreSQL driver and container database URL. Env files are ignored and excluded from images; credentials are runtime inputs. Builds and `/api/health` need no service secrets.

The worker must run for admitted generations to progress. Missing OpenAI configuration leaves them pending; no development login bypass is provided. The database volume survives `docker compose down`; adding `--volumes` destroys its data. Apply migrations before starting the worker or accepting API traffic. See [runtime setup](docs/runtime.md) for host development and [authentication](docs/auth.md) for Google/session configuration.

## Verify

With local PostgreSQL running:

```sh
TEST_DATABASE_URL=postgresql://agent:agent-local@localhost:5432/agent pnpm test:backend
pnpm typecheck
pnpm lint
pnpm build
pnpm db:generate
docker compose config --quiet
```

The database checks need a local administrative connection able to create/drop temporary databases. They apply migrations to isolated databases, use real signed Better Auth sessions and controlled OpenAI SDK transports, and remove their own databases afterward. Without `TEST_DATABASE_URL`, integration checks are skipped. No test makes paid provider requests. `pnpm db:generate` should report no schema changes on an unchanged checkout; apply reviewed migrations with `pnpm db:migrate` using exported database variables or the Compose command above.

## Developer documentation

- [Architecture and schema](docs/architecture.md): ownership, transaction boundaries, durable jobs and deletion.
- [API reference](docs/api.md): each endpoint's purpose, request bodies, query parameters, response objects, status codes and SSE events.
- [Runtime](docs/runtime.md) and [database](docs/database.md): configuration, Compose, migrations and connection lifecycle.
- [Authentication and models](docs/auth.md): Google profiles, sessions, model/effort catalog and defaults.
- [Projects and history](docs/organization.md), [conversation execution](docs/conversations.md), [private pages](docs/spaces.md) and [transcription](docs/transcription.md): payloads, limits, SSE/reload, editing and failure contracts.

Local backend tests, production builds, container startup and migrations establish the local implementation. Live Google OAuth, Neon and OpenAI remain unverified without credentials and authorized spending. In particular, account access to the exact model/background/web-search/compaction combination and `gpt-transcribe` requires live validation before production use. There is no model substitution. No production deployment is included.
