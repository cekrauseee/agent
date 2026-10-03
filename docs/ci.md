# CI and code style

`.github/workflows/ci.yml` runs on pull requests into `main`, pushes to `main` and manual workflow
dispatch. One `Quality checks` job runs formatting, lint, type checking, the backend suite, production
build, schema drift and Compose configuration checks. New runs cancel older runs for the same ref.
The job has a 15-minute timeout and read-only repository permissions; action versions are pinned to
their verified release commits.

The runner uses Node from `.node-version`, pnpm from `package.json`, a cached pnpm store and
`pnpm install --frozen-lockfile`. Its PostgreSQL 17 service is temporary, with a local test-only
account able to create/drop databases. `TEST_DATABASE_URL` is always provided so the database tests
execute rather than skip. Each integration test migrates its isolated database and removes it
afterward. Google/OpenAI behavior uses controlled fixtures and SDK transports; CI needs no
production secrets and makes no paid calls. Live provider checks remain separate.

## Local commands

```sh
pnpm setup
pnpm dev
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
TEST_DATABASE_URL=postgresql://agent:agent-local@localhost:5432/agent pnpm test:backend
pnpm build
pnpm db:generate
docker compose config --quiet
```

Use your actual PostgreSQL port when different. `pnpm setup` prepares the local environment; it is
interactive when existing project containers/data require a reuse/reset choice, so CI installs
dependencies and starts its disposable database directly. Setup's reset/upsert behavior is described
in [runtime setup](runtime.md#setup-script). API request/response contracts are in the
[API reference](api.md).

## Workspace tasks

The root commands use Turborepo to run package tasks. `pnpm dev` starts `@agent/web` and
`@agent/worker` together: Next.js owns hot reload and Node's `--watch` restarts the worker when its
imported source changes. Both tasks are persistent and uncached, with no build or Docker
prerequisite. `pnpm worker:dev` filters development to the worker; `pnpm worker` runs it without
watching. `pnpm --filter @agent/web dev` starts only the web app. `pnpm start` serves an existing
production web build.

Web commands load the ignored root `.env` using a preload with Node's native `process.loadEnvFile`;
worker and migration commands use `--env-file-if-exists`. Exported environment values take
precedence, and quoted dollar signs remain literal. The web preload maps `APP_PORT` to Next's
`PORT`, defaulting to 3000; a CLI `--port` can override it. No service secret is put into Next's
public configuration.

`pnpm build`, `pnpm lint` and `pnpm typecheck` follow workspace dependencies. The backend exports
TypeScript source, so it needs no build or generated distribution before either app can run. Build
caching saves Next production output and excludes `.next/cache` and `.next/dev`. Typecheck caching
also restores generated Next route types and `next-env.d.ts`. Root `.env`, shared tooling and
inherited application environment values participate in task hashes. Runtime dev tasks and the root
backend test/migration commands never cache database or provider effects.

Lint and typecheck include root tests/tooling as separate root tasks. Backend tests remain one root
suite because they exercise routes, worker execution and shared backend together. Inspect the graph
without starting services using `pnpm dev --dry=json` or filter any package with
`pnpm exec turbo run typecheck --filter=@agent/worker`.

## Formatting

Prettier is the formatter for source, config and developer documentation.
`packages/prettier-config/index.json`, exported as `@agent/prettier-config` and loaded by the root
`prettier.config.mjs`, uses single quotes in JavaScript/TypeScript and JSX, no trailing statement
semicolons, a 100-column target and wrapped Markdown prose. The remaining settings use Prettier's
standard stable defaults. JSON still uses the double quotes required by its syntax. Prettier can
retain double quotes to avoid unnecessary escaping and insert a leading semicolon where automatic
semicolon insertion would be unsafe.

100 columns balances laptop readability and avoiding excessive wrapping. `printWidth` is a wrapping
target rather than an absolute limit: indivisible strings, URLs, SQL and Markdown tables can exceed
it. We do not add a competing maximum-line rule that forces awkward string rewrites. Generated Next
output in every app, Turbo caches, database migration artifacts and the pnpm lockfile are excluded
through `.prettierignore`; their own generators remain authoritative.

`pnpm format` applies the policy; `pnpm format:check` fails when a maintained file is not formatted.
Configure your editor's Prettier integration to use this repository's installed version and config.

## Lint

The web app consumes `@agent/eslint-config/next`, retaining the Next.js Core Web Vitals and
TypeScript presets. The worker, backend and root tooling consume `@agent/eslint-config/node`. Both
reuse the same formatter compatibility and typed quality rules. The existing TypeScript ESLint
plugin supplies the typed `@typescript-eslint/no-deprecated` rule, configured as an error, for
TypeScript and JavaScript module sources. It reports references whose type declarations/JSDoc mark
them `@deprecated`; it cannot detect an undocumented upstream deprecation. Type-aware lint uses
`projectService` and each consumer's tsconfig, including `.mjs` tooling.

`@agent/typescript-config` exports base, Node and Next presets. Consumers retain their own source
includes and web path alias, while strictness and common compiler settings live in the shared base.
Node consumers retain DOM/Web API declarations used by server requests and transcription. Next
consumers add the Next plugin and incremental checking.

Unused variables/imports are errors. Intentionally unused callback/caught-error parameters may start
with `_`; ordinary unused variables have no such exception. `pnpm lint` also rejects warnings.

`eslint-config-prettier` disables conflicting style rules after the quality presets. Prettier runs
as a separate check rather than inside an ESLint rule, so editors and CI use one formatter without
duplicate work. This follows the
[Prettier integration guidance](https://prettier.io/docs/integrating-with-linters) and the installed
Next.js guide. Typed deprecation behavior follows the
[TypeScript ESLint rule](https://typescript-eslint.io/rules/no-deprecated/).

## Merge and delivery

Wait for `Quality checks` on the exact PR head before merging. The workflow also checks the merged
`main` commit. This workflow validates changes; it does not deploy, provision services or configure
branch protection. GitHub enforcement requires a separately configured required-check rule; no
repository rules are bypassed by this workflow.

After a merge, synchronize local `main` and remove the merged local/remote branch when no checkout
needs it. Keep the primary checkout, dependencies, runtime containers and persistent data; those are
the development environment, not PR residue.
