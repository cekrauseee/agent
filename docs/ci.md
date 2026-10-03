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
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
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

## Formatting

Prettier is the formatter for source, config and developer documentation. `.prettierrc.json` uses
single quotes in JavaScript/TypeScript and JSX, no trailing statement semicolons, a 100-column
target and wrapped Markdown prose. The remaining settings use Prettier's standard stable defaults.
JSON still uses the double quotes required by its syntax. Prettier can retain double quotes to avoid
unnecessary escaping and insert a leading semicolon where automatic semicolon insertion would be
unsafe.

100 columns balances laptop readability and avoiding excessive wrapping. `printWidth` is a wrapping
target rather than an absolute limit: indivisible strings, URLs, SQL and Markdown tables can exceed
it. We do not add a competing maximum-line rule that forces awkward string rewrites. Generated Next
output, database migration artifacts and the pnpm lockfile are excluded through `.prettierignore`;
their own generators remain authoritative.

`pnpm format` applies the policy; `pnpm format:check` fails when a maintained file is not formatted.
Configure your editor's Prettier integration to use this repository's installed version and config.

## Lint

The Next.js Core Web Vitals and TypeScript presets remain enabled. The existing TypeScript ESLint
plugin supplies the typed `@typescript-eslint/no-deprecated` rule, configured as an error, for
TypeScript and JavaScript module sources. It reports references whose type declarations/JSDoc mark
them `@deprecated`; it cannot detect an undocumented upstream deprecation. Type-aware lint uses
`projectService` and this repository's tsconfig, including `.mjs` tooling.

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
