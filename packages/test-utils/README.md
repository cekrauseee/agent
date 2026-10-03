# Test database utilities

`withTestDatabase` gives web and worker tests one migrated local temporary database and removes it
on success or failure. It validates the admin URL's local host, closes the global pool and restores
the caller's environment. It never resets an existing database and imports no application source.

Set `TEST_DATABASE_URL` to a local PostgreSQL administrative URL able to create/drop databases. Run
`pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm test` here. The own regression verifies
cleanup/environment restoration after a controlled failure and isolation on a second run.

The [test utilities workflow](../../.github/workflows/test-utils.yml) is filtered to this package
and declared dependencies and supplies disposable PostgreSQL. Provider and application fixtures
remain in their owning app.
