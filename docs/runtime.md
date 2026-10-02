# Local runtime

Use Node.js 24 LTS (`.node-version`) and pnpm 11.10.0. The existing Next.js 16.3.8 and React 19.2.8 versions are retained. shadcn is initialized with preset `b1VlIwYS` (`base-luma`, neutral colors, Lucide icons). Geist font files are bundled under `app/fonts` with their SIL license so builds do not fetch Google fonts.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up --build --detach --wait postgres app
docker compose run --rm app pnpm db:migrate
docker compose up --detach --wait worker
```

The app listens at http://localhost:3000; PostgreSQL listens on localhost:5432. Ports bind only to the local machine. If a port is occupied, set `POSTGRES_PORT` and/or `APP_PORT` when running Compose; also update `BETTER_AUTH_URL` and your host-side database URL to match. `/api/health` checks process liveness; Compose waits for PostgreSQL readiness before starting the app. The named `postgres-data` volume survives `docker compose down`. `docker compose down --volumes` permanently deletes local data.

Compose also starts the durable generation worker; apply migrations before accepting work. See [Conversation execution](conversations.md) for HTTP/SSE, worker and context/reload contracts.

See [Recording transcription](transcription.md) for the authenticated completed-audio upload endpoint, original-language output and upload/provider limits.

For host development, keep the database running with `docker compose up --detach postgres`, then run `pnpm dev` and, with database/OpenAI variables exported, `pnpm worker`. Stop the Compose app first if it occupies port 3000.

## Runtime configuration

Server modules import `server-only`. Use `requiredEnv()` from `lib/server/env.ts` to read required service credentials lazily at runtime, keeping module imports and builds independent of services. Never put credentials in `NEXT_PUBLIC_` variables. Local env files are ignored by Git and excluded from Docker's build context; inject them at container startup only.

`databaseConfig()` returns `{ driver, url }`. `DATABASE_DRIVER` is explicitly `postgres` (default) or `neon`, independently of `NODE_ENV`; `DATABASE_URL` must use `postgres:` or `postgresql:`. Compose always selects `postgres` and the internal `postgres` hostname, even though the image runs a production build. Neon uses a separate runtime URL and driver setting, with no build-time connection.

`.env.example` lists database, Better Auth, Google and OpenAI inputs. See [Authentication](auth.md) for Google callback configuration, session guards, profile/preferences endpoints and the shared model catalog. Real auth/provider secrets are needed for those features; the process health check and build do not need them. Compose's `agent-local` password is for its local development database only.

## Checks and migrations

```sh
pnpm test:backend
pnpm typecheck
pnpm lint
pnpm build
docker compose config --quiet
```

Backend tests use Node's built-in test runner with `tsx` and the `react-server` condition for server-only modules. `pnpm db:generate` creates reviewable Drizzle migrations; `pnpm db:migrate` applies them. See [Database](database.md) for schema, driver lifecycle, generation transaction requirements and database checks. Run migrations against the healthy Compose database with:

```sh
docker compose run --rm app pnpm db:migrate
```

The runtime image retains source and dependencies to support the same migration command. Rebuild it after changes to code or migrations. No credentials are baked into the image.
