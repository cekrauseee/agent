# Agent workspace

A pnpm/Turborepo workspace. Each project owns its source, tests, documentation, scripts,
configuration consumers and environment. Root files coordinate the workspace only.

| Project                                            | Responsibility                                          |
| -------------------------------------------------- | ------------------------------------------------------- |
| [Web](apps/web/README.md)                          | Next.js application and HTTP API                        |
| [Worker](apps/worker/README.md)                    | Durable generation process                              |
| [Backend](packages/backend/README.md)              | Shared domains, schema, migrations and local PostgreSQL |
| [Environment](packages/environment/README.md)      | Shared env-file normalization                           |
| [Test utilities](packages/test-utils/README.md)    | Isolated local database fixtures                        |
| [ESLint](packages/eslint-config/README.md)         | Shared Node and Next lint policies                      |
| [Prettier](packages/prettier-config/README.md)     | Shared formatter and ignore policy                      |
| [TypeScript](packages/typescript-config/README.md) | Shared compiler presets                                 |

Use Node.js from `.node-version` and pnpm from `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm setup
pnpm dev
```

`setup` coordinates project setup tasks; `dev` runs persistent application tasks together.
Project READMEs describe configuration and operational prerequisites. There is no root `.env`.
Use `pnpm --filter <package> <task>` to work on one project.

```sh
pnpm format:check
pnpm lint
pnpm typecheck
TEST_DATABASE_URL=<local-admin-url> pnpm test
pnpm build
```

These commands delegate to the projects that implement each task. Application-specific commands,
outputs and environment variables stay in their project. Workflows in `.github/workflows` filter
on the owning project's files and declared workspace dependencies. Shared tooling changes run the
checks of consumers; unrelated application changes do not run each other's CI. Actions are pinned
and no workflow deploys or calls paid providers.
