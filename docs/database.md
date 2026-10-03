# Database

`packages/backend/src/db/schema.ts` is the shared Drizzle schema. Better Auth's `user`, `session`,
`account` and `verification` use library-compatible string IDs. Domain records use
database-generated UUIDs. User extensions are nullable `firstName`, `lastName`, `preferredModel` and
`preferredEffort`; the auth configuration must declare these through Better Auth's
`additionalFields`.

`getDb()` from `@agent/backend/db` lazily creates one process-wide pool for the long-running Node
application. `createDatabase()` creates an explicitly scoped connection with `close()` for
scripts/tests. PostgreSQL uses `drizzle-orm/node-postgres`; Neon uses `drizzle-orm/neon-serverless`
and its Pool/WebSocket transport, preserving interactive transactions. Node 24 supplies the
WebSocket constructor. Both pools allow ten connections with 30-second idle and 10-second connection
timeouts. This lifecycle targets the Node runtime; an edge runtime would require request-scoped
pools and close calls. Builds never open a connection.

## Migrations

```sh
pnpm db:generate
pnpm db:migrate
```

Generation reads `packages/backend/src/db/schema.ts` through `packages/backend/drizzle.config.ts`
and requires no credentials. Generated SQL and metadata live in `packages/backend/drizzle`. Commit
the generated SQL and Drizzle journal/snapshot files together. The root migration command loads
ignored root `.env` with Node native env support; exported variables take precedence. The runner
reads `DATABASE_URL`, `VERCEL_ENV` and the optional `DATABASE_DRIVER` override. Migration paths are
resolved from the backend module, independently of the working directory. Vercel preview/production
defaults to Neon; other environments default to node-postgres. A non-Vercel production worker can
explicitly set `DATABASE_DRIVER=neon`. `NODE_ENV=production` alone does not select Neon. Compose
supplies only PostgreSQL; configure the host connection in root `.env`. Applied migrations are
recorded in `drizzle.__drizzle_migrations`; repeated runner calls skip already-applied migrations.
Run one migration writer/runner at a time. Do not replace migrations with schema push or edit
migrations already applied to a shared database.

## Ownership and deletion

Projects and conversations reference their user owner. A composite foreign key prevents linking a
conversation to another owner's project. Deleting a project sets its conversations' project ID to
null. Conversation deletion cascades to all messages. User deletion cascades to owned data and auth
sessions/accounts. Domain mutations set `updatedAt` explicitly; database defaults apply at
insertion.

A unique owner on `space` permits one space per user; identity creation/lookup must ensure that
space exists. Folder parent and page folder composite foreign keys enforce the same space. Root
pages/folders are allowed. Folder deletion cascades through descendants and pages. Self-parenting is
rejected by a check; longer cycles must be prevented by transactional domain move logic. Domain
operations still authorize every lookup and mutation through the authenticated owner. There is no
generic ACL layer.

## Generation transaction contract

Message order is `(turn, role)` with at most one user and one assistant row per turn. Order user
before assistant in history queries. A unique `(conversationId, requestId, role)` protects request
deduplication. The request and generation identifiers are UUIDs. The partial unique index admits
only one pending/running assistant per conversation, across all application processes.

Before inserting a turn, lock its owned conversation row (`SELECT ... FOR UPDATE`) in a short
transaction. Allocate/increment `nextTurn`, advance `generationVersion`, assign
`currentGenerationId`, and insert both messages atomically. Snapshot the assistant's effective
`model`/`effort`, `contextBefore`, and `responseIdBefore`. Persist partial text, citations, usage,
provider output/response identity and resumable `streamCursor` on the assistant row. Keep provider
network calls outside transactions.

All progress/completion writers must check the current generation ID and version while holding the
conversation lock; use the same transaction to update the assistant and valid conversation context.
A stale writer or deleted conversation must produce no update. Editing replaces the latest pair
atomically, advances the version, and restores the pre-turn context; discarded metadata must be
deleted with that pair. `providerOutput` and conversation `context` retain replayable provider
items/compaction artifacts, while the message text remains display history. The generation domain
enforces these guards and provider recovery. `generation_job` is a content-free durable
worker/cleanup queue that survives conversation deletion; `generation_event` cascades with its
assistant; `turn_request` stores IDs/fingerprints for request deduplication and cascades with its
conversation. `paid_request` stores bounded shared rate/concurrency reservations. There is no
historical attempt content. See [Conversation execution](conversations.md) for worker, SSE and
recovery semantics.

## Checks

```sh
TEST_DATABASE_URL=postgresql://agent:agent-local@localhost:5432/agent pnpm test:backend
```

The opt-in integration test accepts a local PostgreSQL administrative URL, creates an isolated empty
database, migrates twice, verifies constraints/concurrency/delete semantics and Drizzle transaction
commit/rollback, then drops only that temporary database. Without `TEST_DATABASE_URL`, the database
check is reported as skipped. The Neon configuration check constructs/closes a pool without network
access; live Neon queries require a separately configured real database.
