<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Repository conventions

Use pnpm and the committed lockfile. The backend runs in the Node runtime with a separate durable generation worker; never place service secrets in client code. Derive ownership from the Better Auth session and reuse the bounded private API helpers. Apply reviewed Drizzle migrations rather than pushing the schema directly.

See [README](README.md), [architecture](docs/architecture.md) and [API contracts](docs/api.md) before changing behavior. Run the relevant backend checks, typecheck, lint and build; database checks require `TEST_DATABASE_URL` and must use isolated temporary databases. Live provider calls and production operations need explicit authorization.
