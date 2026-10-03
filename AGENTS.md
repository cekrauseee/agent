# Repository conventions

Use pnpm and the committed lockfile. The backend runs in the Node runtime with a separate durable
generation worker; never place service secrets in client code. Derive ownership from the Better Auth
session and reuse the bounded private API helpers. Apply reviewed Drizzle migrations rather than
pushing the schema directly.

See [README](README.md), [architecture](docs/architecture.md), [API contracts](docs/api.md) and
[CI/code style](docs/ci.md) before changing behavior. Run format check, the relevant backend checks,
typecheck, lint and build; database checks require `TEST_DATABASE_URL` and must use isolated
temporary databases. Apply Prettier with `pnpm format`; unused/deprecated references are lint
errors. Live provider calls and production operations need explicit authorization.

Read the current Next.js guides under `apps/web/node_modules/next/dist/docs/` before changing the
web application. The managed framework instructions live in `apps/web/AGENTS.md`.
