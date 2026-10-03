# Workspace development

Use the Node version in `.node-version` and pnpm version in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm setup
pnpm dev
```

Setup first prepares shared environment defaults, then the backend's PostgreSQL/migrations, then
each app's specific env settings. Existing data/reset/legacy-container safeguards belong to
[backend setup](../packages/backend/README.md#local-database-and-migrations). Setup does not start
either application. `pnpm dev` runs web and worker together on the host; Docker runs PostgreSQL only.

Use `pnpm --filter <package> <task>` for project tasks. Root commands coordinate formatting, lint,
types, tests and builds. Tests require a local administrative `TEST_DATABASE_URL` and create/drop
only isolated temporary databases. Provider behavior uses controlled transports; live checks are
separate. [Environment precedence](environment.md) applies consistently to runtime and migrations.

Each project has its own GitHub workflow and checks, filtered by project files and declared shared
dependencies. Unrelated app-only changes do not run the other app's workflow. Shared config, global
environment examples, global documentation and workspace/toolchain changes validate consumers.
The common pinned action reuses install/format/lint/type/test steps. Web additionally builds;
backend checks schema drift and Compose. No workflow deploys or makes paid calls.

Global documentation belongs under `docs/` and is indexed by [its summary](README.md). API,
worker, database and package implementation guides stay with their owner and link to shared rules.
