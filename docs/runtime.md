# Local runtime

Use Node.js 24 LTS (`.node-version`), pnpm 11.10.0 and Docker Compose. The web app lives in
`apps/web`, the durable generation worker in `apps/worker`, and shared server code in
`packages/backend`. Both applications run on the host; Compose runs only PostgreSQL. Bundled
Geist font files and their SIL license live in `apps/web/app/fonts`, so builds need no font download.

```sh
pnpm setup
pnpm dev
```

`pnpm dev` starts the web app and worker together through Turborepo. Both processes and
`pnpm db:migrate` load the ignored root `.env` with Node's native env support. `APP_PORT` controls
the web app's port; the default is http://localhost:3000. Restart development after changing env
values. The worker must run for admitted generations to progress. See
[Conversation execution](conversations.md) for worker, HTTP/SSE and recovery contracts.

## Setup script

`pnpm setup` runs `scripts/setup.mjs` using Node's standard library. It works before `node_modules`
exists, installs with the committed lockfile, waits for PostgreSQL readiness, then applies
migrations on the host. It finishes by instructing you to run `pnpm dev`; it does not build or start
application containers or launch development processes. Install system tools and start the Docker
engine first. Setup does not provision external services.

Setup targets the Compose project `agent`. Before changing files or containers, it detects existing
containers, including stopped and orphaned services, and labeled volumes. A fresh start prompt
defaults to reuse: Enter, `N` or `no` retains them; `Y` or `yes` authorizes deletion of this
project's containers, orphans and volumes. Answers are case-insensitive. Fresh start permanently
removes local PostgreSQL data. Non-interactive execution refuses whenever confirmation is needed.

If reused legacy `app` or `worker` containers are running, restarting or paused, setup refuses
before changes. Find their names with `docker compose ps --all --orphans`, stop them explicitly with
`docker stop <name> ...`, then rerun setup and choose reuse. Stop any previously started host
app/worker before migrations as well. Stopped legacy containers remain; the existing named
`postgres-data` volume and rows are reused. To return to the previous container workflow, check out
its Compose/Dockerfile version and stop the host processes first; database compatibility still
depends on the applied migrations.

The env upsert uses `.env.example` as its allowlist, order and comment layout. Existing nonempty
values retain raw quoting; duplicate assignments collapse to their last value. Empty/missing values
get example defaults. A missing `BETTER_AUTH_SECRET` gets 32 cryptographically random bytes encoded
as 64 hex characters; an existing secret shorter than 32 characters fails without changing it.
Obsolete keys and old comments are removed. `.env` is replaced atomically with owner-only
permissions (`0600`) and remains ignored by Git. Host env parsing treats `$NAME` references
literally; do not depend on Compose-style interpolation for application configuration.

Missing ports use host `APP_PORT`/`POSTGRES_PORT` overrides, then 3000/5432. Missing
`BETTER_AUTH_URL` and `DATABASE_URL` follow those ports. Existing URLs/ports are preserved: keep
them and Google's callback consistent yourself. Compose reads `.env` for its PostgreSQL port.
Missing Google/OpenAI credentials remain blank; setup reports only their names, never fabricates
credentials or makes paid requests. Fill already-provisioned credentials and restart development.

Before writing `.env`, setup checks other running containers for TCP bindings conflicting with the
configured app/PostgreSQL localhost ports. Each conflict requires confirmation to stop that
container without deleting its data. Declining any prompt cancels without changing `.env` or
stopping containers. All prompts and locked dependency installation must succeed before approved
stops or resets. Host processes occupying those ports must be stopped manually.

A failed command stops the sequence; rerun after correcting the failure. Setup does not undo an
explicitly authorized reset. Google login and paid features require configured service credentials;
health checks and builds do not. Manual equivalents after configuring root `.env` are:

```sh
pnpm install --frozen-lockfile
docker compose up --detach --wait postgres
pnpm db:migrate
pnpm dev
```

## PostgreSQL and runtime configuration

PostgreSQL binds to `127.0.0.1:${POSTGRES_PORT:-5432}` with the existing `postgres-data` volume.
`docker compose down` retains that volume; `docker compose down --volumes` permanently deletes local
data. Compose's `agent-local` password is for the local development database only. Keep the host
`DATABASE_URL` aligned with `POSTGRES_PORT`; Compose does not override application URLs. Apply
migrations before starting workers or accepting API traffic.

Server modules import `server-only`. `requiredEnv()` in `packages/backend/src/server/env.ts` reads
service credentials lazily, so module imports and builds do not require them. Never place secrets in
`NEXT_PUBLIC_` variables. See [Authentication](auth.md) for Google's callback and session setup.

`databaseConfig()` returns `{ driver, url }`. It defaults to `neon` when `VERCEL_ENV` is `preview`
or `production`, and `postgres` otherwise. `NODE_ENV` controls framework behavior, not database
transport. `DATABASE_URL` must use `postgres:` or `postgresql:`; no connection opens during build.
`DATABASE_DRIVER=postgres|neon` is an optional explicit override. A non-Vercel production worker
using Neon must select that driver and share the deployed app's database. It must run as a
long-lived process; Vercel request handlers do not replace it. See [Database](database.md).

## Checks and migrations

```sh
pnpm format:check
pnpm test:backend
pnpm typecheck
pnpm lint
pnpm build
docker compose config --quiet
```

Backend tests use Node's built-in test runner with `tsx` and the `react-server` condition. Database
checks need `TEST_DATABASE_URL` and create/drop only isolated temporary databases. Tests use
controlled provider transports and make no paid requests.

`pnpm db:generate` creates reviewable migrations in `packages/backend/drizzle`; `pnpm db:migrate`
applies them using root `.env`. The schema and Drizzle configuration live in `packages/backend`. Run
one migration writer/runner at a time and apply migrations before `pnpm dev`.

`tests/setup.test.ts` uses temporary directories and injected commands to check env idempotence,
quoting, secret permissions, reuse/reset confirmations, volume-only recovery, port conflicts,
non-interactive refusal, install/readiness/migration failures, legacy consumer transition, and host
migrations after database readiness without application Docker builds or starts. It never operates
real containers or data. See [CI and code style](ci.md) for the shared quality policy and
[API reference](api.md) for request and response contracts.
