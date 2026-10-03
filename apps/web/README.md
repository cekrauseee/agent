# Web

The `agent-web` Next.js Node application owns the Google-authenticated conversation interface, HTTP
routes, components, fonts and web-only tooling. Home supports text and recording transcription,
reasoning effort selection, editable latest turns and durable OpenAI generation using shadcn preset
`b1VlIwYS`. The APIs also provide projects and private Markdown pages. Reused domain code comes from
`@agent/backend`; this project does not import the worker. Read the installed Next.js guide before
changing framework behavior.

## Development and configuration

Run commands from `apps/web`, after installing the workspace dependencies. Prepare the
[shared base and local database](../../docs/development.md) with root `pnpm setup`, then:

```sh
pnpm setup
pnpm dev
```

Setup normalizes web-specific settings and explicit overrides; database/provider defaults are
inherited from the root base. Existing app values are preserved. The file is replaced atomically
with mode 0600; raw quoting stays intact and `$NAME` references remain literal. The shared
environment package generates a missing local Better Auth session secret and refuses to replace a
short existing secret. External credentials remain blank until supplied.

Configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `BETTER_AUTH_SECRET` in the web env.
Configure shared `OPENAI_API_KEY` using the
[shared base and web overrides](../../docs/environment.md). `APP_PORT` defaults to 3000. Keep
`BETTER_AUTH_URL` and Google's callback `http://localhost:3000/api/auth/callback/google` consistent
with that port. Use the same database as the worker. The Next preload reads project files before
shared workspace files and sets the port before Next starts. Exported variables take precedence.
Builds and process health require no service secrets.

`pnpm dev` from the workspace root starts both applications in one terminal. Run the worker for
admitted generations to progress. Neither application is built or served in Docker.

## Documentation

- [Conversation interface](docs/frontend.md): routes, client state, recording, transcript position
  and controlled browser verification.
- [API contracts](docs/api.md): requests, responses, errors and SSE.
- [Authentication and preferences](docs/auth.md): Google, sessions and model settings.
- [Conversation routes](docs/conversations.md), [history](docs/organization.md),
  [private pages](docs/spaces.md) and [transcription](docs/transcription.md).
- [Backend architecture](../../packages/backend/docs/architecture.md) and
  [worker execution](../worker/docs/execution.md) describe their owned internals.

## Verification and CI

```sh
pnpm format:check
pnpm lint
pnpm typecheck
TEST_DATABASE_URL=<local-admin-url> pnpm test
pnpm build
```

The `pnpm test` command runs server tests in `tests/` and client tests in `tests/frontend/` in
separate processes. Server tests exercise actual route handlers, signed sessions and persisted SSE
data; `pnpm test:frontend` runs only client checks without the React server condition. Transcription
uses controlled SDK transports; generation route tests seed saved worker outcomes through the shared
schema. Database tests create/drop only isolated local databases. Without `TEST_DATABASE_URL` they
are skipped. Live OAuth/provider behavior remains separate.

The [web workflow](../../.github/workflows/web.yml) runs only for web or declared dependency
changes, including shared config and workspace tooling. It supplies a disposable PostgreSQL database
and runs these checks, including the production build, on pinned Node 24. Style/compiler presets
come from the three declared configuration packages.
