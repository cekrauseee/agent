# Backend conventions

Read README.md and docs/architecture.md and docs/database.md before changing shared behavior. Keep
service secrets server-only and lazy. Ownership comes from the validated Better Auth session; reuse
bounded private API helpers. Apply reviewed Drizzle migrations, never schema push. Preserve
transaction guards, queue identity and provider cleanup contracts.

Run this project's formatting, lint, typecheck and tests. Database checks require a local
TEST_DATABASE_URL and must create/drop only their own isolated temporary databases. Setup tests use
injected commands; never invoke a real reset to validate them. Live providers/production require
explicit authorization.
