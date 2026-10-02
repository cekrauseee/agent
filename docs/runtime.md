# Local runtime

Use Node.js 24 LTS (`.node-version`) and pnpm 11.10.0. The existing Next.js 16.3.8 and React 19.2.8
versions are retained. shadcn is initialized with preset `b1VlIwYS` (`base-luma`, neutral colors,
Lucide icons). Geist font files are bundled under `app/fonts` with their SIL license so builds do
not fetch Google fonts.

```sh
pnpm setup
```

## Setup script

`pnpm setup` runs `scripts/setup.mjs` with Node's standard library; no new dependency is needed.
Install Node.js 24 LTS, pnpm 11.10.0 and Docker Compose first, and start the Docker engine. The
command works before `node_modules` exists and installs dependencies using the committed lockfile.
It does not install system tools or provision external services.

The script targets the Compose project `agent`. Before changing files or containers, it detects
existing project containers (including stopped ones) and labeled volumes. It prompts to reuse them
by default, or requires the exact phrase `fresh start` to authorize deletion of this project's
containers, orphans and volumes. Fresh start permanently removes local PostgreSQL data. Other
Compose projects and images are left alone. Non-interactive execution refuses to proceed when
existing containers/data require that choice; there is no automatic destructive confirmation.

The env upsert uses `.env.example` as the allowlist, order and comment layout. Existing nonempty
values retain their raw quoting and variable references; duplicate assignments collapse to their
last value. Empty/missing values get example defaults, and a missing `BETTER_AUTH_SECRET` gets 32
cryptographically random bytes encoded as 64 hex characters. An existing secret shorter than 32
characters fails without changing it. Unknown keys and old comments are removed. Markdown-style
explanations belong in the example, not the local file. The file is replaced atomically with
owner-only permissions (`0600`). It is ignored by Git and excluded from Docker images.

When port values are missing, setup uses host `APP_PORT`/`POSTGRES_PORT` overrides or this project's
existing published ports, then the example defaults. Missing `BETTER_AUTH_URL` and host
`DATABASE_URL` follow those ports. Existing URLs/ports are not rewritten: keep related settings
consistent yourself. Compose loads the normalized file directly, preserving its interpolation
behavior instead of having Node expand values. Missing Google/OpenAI credentials remain blank; the
script prints only their names and never fabricates credentials or makes paid requests. Fill
already-provisioned credentials and rerun setup choosing reuse.

After env setup, locked dependency installation and image build must succeed before any reset. The
script stops app/worker consumers, starts the healthy database, runs migrations, and only then
starts app/worker. Reuse preserves the named volume and existing rows. A failed command exits
nonzero and stops the sequence; rerunning can finish after the underlying failure is corrected. The
script does not undo an explicitly authorized reset. Without service credentials, local
containers/health can run, but Google login and paid features remain unavailable.

The Compose app runs the production build. For editing with hot reload, stop the Compose app and
worker, run `pnpm dev` on the host, and start the host worker separately with its env values
exported. Setup prepares the same database and host dependencies for that workflow; it does not
launch a terminal-bound development process. Manual equivalents remain:

```sh
pnpm install --frozen-lockfile
docker compose build app worker
docker compose stop app worker
docker compose up --detach --wait postgres
docker compose run --rm --no-deps app pnpm db:migrate
docker compose up --detach --wait app worker
```

## Services and host development

The app listens at http://localhost:3000; PostgreSQL listens on localhost:5432. Ports bind only to
the local machine. If a port is occupied, set `POSTGRES_PORT` and/or `APP_PORT` when running
Compose; also update `BETTER_AUTH_URL` and your host-side database URL to match. `/api/health`
checks process liveness; Compose waits for PostgreSQL readiness before starting the app. The named
`postgres-data` volume survives `docker compose down`. `docker compose down --volumes` permanently
deletes local data.

Compose also starts the durable generation worker; apply migrations before accepting work. See
[Conversation execution](conversations.md) for HTTP/SSE, worker and context/reload contracts.

See [Recording transcription](transcription.md) for the authenticated completed-audio upload
endpoint, original-language output and upload/provider limits.

For host development, keep the database running with `docker compose up --detach postgres`, then run
`pnpm dev` and, with database/OpenAI variables exported, `pnpm worker`. Stop the Compose app and
worker first. Use `pnpm dev --port <APP_PORT>` if your configured app port is not 3000; Google's
callback must use that same origin.

## Runtime configuration

Server modules import `server-only`. Use `requiredEnv()` from `lib/server/env.ts` to read required
service credentials lazily at runtime, keeping module imports and builds independent of services.
Never put credentials in `NEXT_PUBLIC_` variables. Local env files are ignored by Git and excluded
from Docker's build context; inject them at container startup only.

`databaseConfig()` returns `{ driver, url }`. It defaults to `neon` when Vercel's `VERCEL_ENV` is
`preview` or `production`, and to `postgres` otherwise, including Vercel development and local
production-built Docker images. `NODE_ENV` controls framework behavior, not database transport.
`DATABASE_URL` must use `postgres:` or `postgresql:`. Vercel's system environment variables must be
exposed to the deployment; no connection opens during build.

`DATABASE_DRIVER=postgres|neon` remains an optional explicit override, for example a production
worker outside Vercel with a Neon URL. Its blank value in `.env.example` uses the automatic default;
setup preserves an existing explicit value. Compose explicitly forces `postgres` with its internal
database hostname. A non-Vercel worker must use the same database URL/driver as its deployed app,
and must run as a long-lived process; Vercel request handlers do not replace that worker. See
[database configuration](database.md).

`.env.example` lists database, Better Auth, Google and OpenAI inputs. See [Authentication](auth.md)
for Google callback configuration, session guards, profile/preferences endpoints and the shared
model catalog. Real auth/provider secrets are needed for those features; the process health check
and build do not need them. Compose's `agent-local` password is for its local development database
only.

## Checks and migrations

```sh
pnpm format:check
pnpm test:backend
pnpm typecheck
pnpm lint
pnpm build
docker compose config --quiet
```

Backend tests use Node's built-in test runner with `tsx` and the `react-server` condition for
server-only modules. `pnpm db:generate` creates reviewable Drizzle migrations; `pnpm db:migrate`
applies them. See [Database](database.md) for schema, driver lifecycle, generation transaction
requirements and database checks.

`tests/setup.test.ts` exercises env normalization/idempotence, preserved quoting, generated secrets,
reuse/explicit reset, volume-only recovery, non-interactive refusal, failed builds and
migration-before-consumer ordering in temporary directories with controlled command execution. It
never deletes real containers or data.

Run migrations against the healthy Compose database with:

```sh
docker compose run --rm app pnpm db:migrate
```

The runtime image retains source and dependencies to support the same migration command. Rebuild it
after changes to code or migrations. No credentials are baked into the image.

See [CI and code style](ci.md) for GitHub checks and local formatting/lint commands. The
[API reference](api.md) describes each endpoint's request and response contract.
