# Conversation execution

Messages run through the official OpenAI JavaScript SDK (`openai` 7.27.0) and Responses API. Every
request sends `instructions: "you are a helpful assistant"`, only hosted `web_search`, automatic
tool choice, the saved model/effort pair, native server-side compaction, and `background: true`,
`stream: true`, `store: true`. Settings are snapshotted at reservation. No project/page text, custom
tool loop, summarization agent or prompt cache is added.

Worker operation, replay and cleanup are documented in the
[worker execution guide](../../worker/docs/execution.md).

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

## Context and limits

Latest-turn replacement, retry and cancellation preserve the existing identities and API contracts.
The backend restores saved context and rejects stale writers; see the
[shared transaction contract](../../../packages/backend/docs/database.md#generation-transaction-contract)
and [worker recovery](../../worker/docs/execution.md#context-and-editing).

Request bounds and shared paid admission limits are in the
[API conventions](api.md#conventions-and-errors). Route tests live in `tests/generation.test.ts`;
worker execution uses its own controlled-provider suite. Run
`TEST_DATABASE_URL=<local-admin-url> pnpm test` from `apps/web`. Each suite migrates and removes
only isolated test databases; no test calls a paid provider.
