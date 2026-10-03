# Conversation execution

Messages run through the official OpenAI JavaScript SDK (`openai` 7.27.0) and Responses API. Every
request sends `instructions: "you are a helpful assistant"`, only hosted `web_search`, automatic
tool choice, the saved model/effort pair, native server-side compaction, and `background: true`,
`stream: true`, `store: true`. Settings are snapshotted at reservation. No project/page text, custom
tool loop, summarization agent or prompt cache is added.

## Running the worker

Apply migrations before accepting work. Compose runs PostgreSQL; the root development command starts
both host applications using shared root `.env`:

```sh
pnpm setup
pnpm dev
```

The standalone worker entry is `apps/worker/src/run-worker.ts`; execution lives in
`apps/worker/src/worker.ts` and reuses `@agent/backend`. `pnpm worker` runs only that worker with
root `.env` loaded. The local database driver defaults to PostgreSQL; a non-Vercel production worker
using Neon must additionally set `DATABASE_DRIVER=neon`. Missing OpenAI configuration leaves
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

## HTTP operations

Every operation validates the Better Auth session and conversation ownership. Mutations require the
configured exact Origin. Foreign IDs return 404. Responses are private/no-store; provider IDs,
opaque items, raw provider errors, and credentials stay internal.

| Method and path                                                | Input/result                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `POST /api/conversations/:id/messages`                         | `{requestId,text,preferences?}`; 202 with `{userMessageId,generation,deduplicated}`                      |
| `PATCH /api/conversations/:id/messages/:messageId`             | Same body; replaces only the latest user turn; 202                                                       |
| `POST /api/conversations/:id/generations/:generationId/retry`  | `{requestId,preferences?}`; retries a failed/cancelled latest assistant, preserving user-message ID; 202 |
| `POST /api/conversations/:id/generations/:generationId/cancel` | Explicit cancellation; returns `{generationId,status}`                                                   |
| `GET /api/conversations/:id/generations/:generationId`         | Public saved snapshot, safe `error`, and `eventCursor`                                                   |
| `GET /api/conversations/:id/generations/:generationId/events`  | SSE; optional `after=<eventCursor>` or `Last-Event-ID`                                                   |
| `GET /api/conversations/:id/messages`                          | Ordered saved history and latest editable ID; see [Organization](organization.md)                        |

`requestId` is a client-generated UUID. Repeat the same operation/body/request ID to retrieve its
existing generation without another turn or provider call. A changed body with that ID returns 409.
Discarded request IDs return 409 rather than recreate deleted context; only IDs and input
fingerprints remain for deduplication. Reconnecting uses GET, never a new POST.

`preferences`, when supplied, is a complete `{model,effort}` pair from `/api/models`; arbitrary
models, invalid efforts, unknown fields and client provider IDs are rejected. Otherwise the user's
saved pair is used. Message text preserves whitespace and must be nonblank valid Unicode without
NUL, at most 64 KiB UTF-8. Message JSON bodies are capped at 400,000 actual bytes to permit escaped
Unicode; retry bodies at 4 KiB.

One generation per conversation can be pending/running. Simultaneous mutations conflict with 409.
Wait or cancel before editing an active turn. A failed/cancelled latest turn must be retried or
replaced before appending a new turn. Statuses are `pending`, `running`, `completed`, `failed`,
`cancelled`. Provider `incomplete` is represented as `failed` with `incomplete_response`; its
partial text is preserved and never becomes valid future context. Other safe codes include
`provider_rejected`, `provider_failed`, `provider_error`, `provider_response_unavailable` and
`ambiguous_creation`.

## SSE contract and reload

SSE IDs are durable application event IDs, scoped to the generation. They differ from
`streamCursor`, the provider sequence number; use `eventCursor` to resume the application stream.
Validate both message and generation identity in the consumer. A cursor from a different/discarded
generation returns 409; fetch a fresh snapshot.

Without a cursor, the first event is `snapshot` with canonical saved text/citations/status and its
`eventCursor`; replace local state and continue after that ID. With a cursor, only subsequent
durable events are replayed, in ID order. Ignore already-applied IDs. Streams end after a terminal
event/state or at thirty seconds; reconnect with the last applied ID. Disconnecting/closing an SSE
connection has no cancellation side effect.

| Event        | Data                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------- |
| `snapshot`   | Generation snapshot including IDs, full text/citations/status, `error`, `eventCursor`       |
| `status`     | `{messageId,generationId,status}`                                                           |
| `text_delta` | `{messageId,generationId,delta,outputIndex,contentIndex}`; append `delta`                   |
| `citations`  | `{messageId,generationId,citations}`; replace citation list                                 |
| `completed`  | `{messageId,generationId,status:"completed",message}`; replace with canonical final message |
| `error`      | `{messageId,generationId,status,code,message?}` for durable terminal failures               |

A transport-only `error` with `code: "stream_unavailable"` has no ID and does not fail the
generation; reload state/reconnect. A quick provider completion may be persisted through polling
rather than deliver every historical token delta; the terminal canonical message always replaces
accumulated partial text. Citation annotations retain safe HTTP(S) URLs, titles and ranges.
Commentary/final phases, hosted search source metadata, encrypted reasoning and compaction items are
retained internally as full output. Partial output is not presented as completed.

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
TEST_DATABASE_URL=postgresql://agent:agent-local@localhost:5432/agent pnpm test:backend
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
