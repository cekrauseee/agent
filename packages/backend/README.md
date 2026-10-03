# Shared backend

This package owns server domains, model preferences, private API helpers, paid admission, database
schema and reviewed migrations. Applications import explicit package exports instead of another
application's source. Provider construction is canonical here, including the exported OpenAI
constructor used by controlled test clients.

- [Architecture](docs/architecture.md): ownership, domain boundaries and transaction guards.
- [Database](docs/database.md): schema, transport, lifecycle and reviewed migration contracts.
- [Web API](../../apps/web/docs/api.md) and [worker](../../apps/worker/docs/execution.md) document
  their respective interfaces and execution.

## Local database and migrations

Run these commands from `packages/backend`, after installing locked workspace dependencies and
starting the Docker engine:

```sh
pnpm setup
```

Setup owns only this project's `.env`, `.env.example`, `compose.yaml` and database port. It prepares
local PostgreSQL, waits for readiness and runs host `pnpm db:migrate`; no application build,
container or persistent application process is started. It targets the existing Compose project
`agent` and named volume, preserving data on reuse. `POSTGRES_PORT` defaults to 5432 and the host
URL must match it. Runtime app URLs live in each app's own env file.

Before changing files/containers, existing project containers or volumes require a fresh-start
confirmation: Enter/N reuses data; Y explicitly deletes this project's containers, orphans and all
PostgreSQL data. Non-interactive runs refuse confirmation-dependent operations. Running legacy
app/worker containers require manual shutdown before reuse; stopped ones remain. Stop existing host
consumers before applying migrations.

Conflicting containers on the database's own localhost TCP port require explicit confirmation before
stopping them without deleting data. App ports belong to the apps and are not stopped by database
setup. Declining cancels before env writes or stops. All confirmations and frozen installation must
succeed before an approved stop/reset. Failed commands stop the sequence. The script does not undo
an explicitly authorized reset.

The shared environment helper preserves raw quoting, removes obsolete keys and writes `.env`
atomically with mode 0600. Migration commands load only `packages/backend/.env`; exported values
take precedence. Host parsing leaves `$NAME` literal. Compose interpolation applies to its own
database port. The local `agent-local` password is a development-only value; setup never creates
external credentials or calls a paid provider.

```sh
docker compose up --detach --wait postgres
pnpm db:generate
pnpm db:migrate
```

Compose runs PostgreSQL only. `docker compose down` preserves its volume; adding `--volumes`
permanently deletes local data. SQL/meta remain in `drizzle/`; schema and migration runner paths
resolve from this package. Use reviewed migrations, never schema push. Run one migration writer at a
time.

The package's `agent-app-env` binary shares initial local database defaults with app setup through
`@agent/environment`. Each app keeps its own runtime values; changing the backend port later does
not silently rewrite application URLs.

## Verification and CI

```sh
pnpm format:check
pnpm lint
pnpm typecheck
TEST_DATABASE_URL=<local-admin-url> pnpm test
pnpm db:generate
docker compose config --quiet
```

Tests own database integrity/migrations, shared env selection and generation input limits, plus
controlled setup regressions for reset/reuse, port conflict, legacy consumers and command failures.
They never run actual setup/reset against existing data. Isolated database tests migrate twice,
verify constraints and remove only their new database. No test makes paid provider requests.

The [backend workflow](../../.github/workflows/backend.yml) filters on this package and declared
dependencies, runs its quality/tests with disposable PostgreSQL, and checks schema drift and Compose
configuration. It does not build either app.
