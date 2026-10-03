# Generation worker

This independent long-running Node service executes durable generation jobs and provider cleanup. It
imports shared backend domains and does not depend on Next.js or web source. Its entrypoint and
execution code live in `src/`; recovery and provider limits are in [execution](docs/execution.md).

## Run and configure

Run commands from `apps/worker`, after installing the workspace dependencies and applying the
backend migrations:

```sh
pnpm setup
pnpm dev
```

Setup prepares worker-specific overrides. Shared database/provider settings are inherited from the
root base; existing explicit worker values are retained. Configure `DATABASE_URL`, the optional
`DATABASE_DRIVER` override and `OPENAI_API_KEY`. Use the same database as the web app. No auth or
HTTP-port configuration is required here. Node loads project files before shared workspace files;
exported variables take precedence and quoted `$NAME` references are literal.

See the [global env hierarchy](../../docs/environment.md) and
[setup order](../../docs/development.md). Development watches imported TypeScript files.
`pnpm start` runs the persistent worker without watching. Both use the existing tsx runtime and the
react-server condition for server-only modules. SIGINT/SIGTERM stop the loop and close the database
pool. The workspace's `pnpm dev` starts both apps in one terminal; no worker build or application
container is required.

Missing provider configuration leaves admitted jobs pending. Run migrations before consumers;
production workers must be long-lived and share the deployed web database and driver. Provider
requests, context guards, leases and cleanup behavior are unchanged.

## Verification and CI

```sh
pnpm format:check
pnpm lint
pnpm typecheck
TEST_DATABASE_URL=<local-admin-url> pnpm test
```

Worker tests use shared domain admission plus a controlled SDK HTTP/SSE transport. They cover
restart/resume, settings, deltas/citations, compaction, replacement, cancellation/retry, ambiguous
creation and cleanup races without importing web routes or calling paid providers. Only isolated
temporary databases are created/dropped. The development regression checks the worker's persistent
task in the joint task graph without launching a server.

The [worker workflow](../../.github/workflows/worker.yml) is filtered to this project and declared
dependencies. It runs worker checks on Node 24 with disposable PostgreSQL. Configuration policies
come from the shared ESLint, Prettier and TypeScript packages.
