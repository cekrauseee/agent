# Generation execution

## Running the worker

Apply migrations before accepting work. Compose runs PostgreSQL; the root development command starts
both host applications, each using its own env file. Run worker commands from `apps/worker`:

```sh
pnpm setup
pnpm dev
```

The standalone worker entry is `apps/worker/src/run-worker.ts`; execution lives in
`apps/worker/src/worker.ts` and reuses `@agent/backend`. `pnpm start` runs only that worker with
`apps/worker/.env` loaded. The local database driver defaults to PostgreSQL; a non-Vercel production
worker using Neon must additionally set `DATABASE_DRIVER=neon`. Missing OpenAI configuration leaves
reservations pending and emits a sanitized worker error; configure the key and restart the worker to
continue. It does not provision a key. A deployment needs this long-running process;
request-lifetime background work is insufficient.

The worker claims up to ten jobs per pass with short PostgreSQL transactions, 90-second leases and
`SKIP LOCKED`. It starts a native background response, durably saves its response ID, then closes
only the initial HTTP stream. Subsequent passes poll that ID and resume its stream with
`responses.retrieve(id, { stream: true, starting_after })`. Each pass caps resumed-stream time at
ten seconds. A two-second pause separates passes; visibility latency depends on available worker
slots. Database locks are never held during a provider call.

Provider inference continues after client disconnects and worker process restarts. The worker saves
canonical terminal output even if nobody connects. A restart resumes jobs whose IDs were saved. An
expired creation claim without a saved ID becomes `failed` with `ambiguous_creation`; it is never
resubmitted automatically. A provider may have accepted that ambiguous request, and an explicit
retry can therefore incur another charge. There is no exactly-once guarantee or API for discovering
an unknown ID from application metadata.

## Context and editing

Ordinary continuation uses the last completed `previous_response_id`, passing only the new user
message and sending instructions again. Native compaction uses
`context_management: [{type:"compaction",compact_threshold:100000}]`. Display history remains
intact. The application saves complete provider output and a replay window reduced to the latest
applicable compaction item plus subsequent items. It treats encrypted artifacts as opaque.

If the provider explicitly rejects an expired/missing previous response reference, the worker
reconstructs only the valid active replay window through the installed SDK's `toResponseInputItems`,
followed by the new user message. It does not fall back on arbitrary network errors, reset history,
or invent a summary. Compaction and API caching do not make historical tokens free.

Replacement keeps the latest user-message ID, deletes its assistant and event ledger, and increments
generation identity/version. It restores that assistant's saved context and provider reference from
_before_ the turn. Its old request, answer, reasoning and compaction are excluded, including for the
first turn whose prior context is empty. Older turns are immutable. Retry uses the same reservation
path and one user message. Every progress/final write verifies current generation ID/version and
active status under the conversation lock; stale callbacks cannot overwrite edits or recreate
deleted conversations.

Deletion queues all known provider responses for remote cancellation/deletion in the same
transaction that removes local history. Jobs contain no message text or replay artifacts and survive
deletion to handle an in-flight response-ID callback. Cleanup runs outside transactions and retries
transient failures; failed cleanup never restores discarded content. Cancelling/removing stored
Responses cannot change the provider's independent retention policies. An ID lost in an ambiguous
creation cannot be cancelled remotely; this is a provider-creation boundary limitation, not restored
product history.

## Limits and verification

Shared PostgreSQL controls bound both chat and transcription to ten reservations per user per
minute, three active reservations per user and twenty globally. Duplicates do not consume another
slot. Active leases last thirty minutes and workers renew them while monitoring; terminal/cancelled
operations release them. Inactive records expire after an hour. A brief SQL advisory transaction
lock serializes these limits; no Redis or billing system is required. Reservations pending for more
than thirty minutes without a worker lose their capacity lease. This is a small-installation
control, not a monetary spending guarantee.

Responses cap output at 16,384 tokens (including reasoning) and hosted tool calls at five. The
documented `max_tool_calls` API field is missing from SDK 7.27.0's HTTP parameter type; a narrow
typed extension sends it unchanged. SDK retrieval, `starting_after`, encrypted output, phase
preservation and native compaction support were verified against installed types/source.
Provider-level limits and account quotas still apply.

Focused checks use the real SDK with a controlled HTTP/SSE transport and an isolated local
PostgreSQL database. They cover delta/citation accumulation, settings and tool selection,
dedup/concurrent reservations, authorization, disconnect/reconnect, fresh-pool worker recovery,
final persistence with no client, expired-reference replay, first/latest replacement and
old-compaction removal, stale writes, cancellation/retry/incomplete failure, ambiguous creation,
deletion during creation, remote cleanup retry, and shared rate/concurrency limits.

```sh
TEST_DATABASE_URL=postgresql://agent:agent-local@localhost:5432/agent pnpm test
```

Current official documentation establishes the catalog's
[Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) and
[Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) Responses/web-search support,
[GPT-6 family compaction](https://developers.openai.com/api/docs/guides/latest-model),
[native compaction](https://developers.openai.com/api/docs/guides/compaction),
[background/resumable response protocol](https://developers.openai.com/api/docs/guides/background),
and
[output/tool limits](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).
Background examples do not explicitly enumerate both catalog IDs. Account access and the complete
model/background/web-search/compaction combination remain live-unverified without authorized
credentials/spending. No model substitution is performed: an unsupported combination produces a
saved provider failure. Real streaming/cancellation, retention timing, rate limits, hosted search
and compaction thresholds need live checks before production use. No paid calls were made.
