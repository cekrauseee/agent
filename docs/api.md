# API guide

All custom domain endpoints require a validated Better Auth session cookie. `GET /api/health` is public process liveness and returns `{ "status": "ok" }`; it does not verify database or provider readiness. Better Auth owns the Google redirect/callback/session endpoints under `/api/auth/*`. Use the supported social sign-in flow, not a user ID or forged cookie. See [authentication](auth.md).

Send `Origin` equal to `BETTER_AUTH_URL` on every mutation and `Content-Type: application/json` for JSON operations. Browser clients send session cookies with requests; same-origin requests are simplest. Domain responses use `Cache-Control: private, no-store`. Foreign resource IDs return 404. Unknown JSON fields and client ownership/provider IDs are rejected. UUID route identifiers are stable through renames and moves.

## Endpoints

| Group | Routes | Contract |
| --- | --- | --- |
| Identity | GET `/api/me`; GET/PATCH `/api/me/preferences`; GET `/api/models` | [Profile, preferences and allowlist](auth.md) |
| Projects | GET/POST `/api/projects`; GET/PATCH/DELETE `/api/projects/:id` | [Bodies and list cursors](organization.md) |
| Conversations | GET/POST `/api/conversations`; GET/PATCH/DELETE `/api/conversations/:id`; GET `/api/conversations/:id/messages` | [Metadata, history and reload](organization.md) |
| Generation | POST `/api/conversations/:id/messages`; PATCH `/api/conversations/:id/messages/:messageId`; GET `/api/conversations/:id/generations/:generationId`; POST its `/cancel` and `/retry`; GET its `/events` | [Generation, SSE and editing](conversations.md) |
| Private space | GET `/api/space`; POST `/api/folders` and `/api/pages`; GET/PATCH/DELETE `/api/folders/:id` and `/api/pages/:id` | [Tree, Markdown and content conflicts](spaces.md) |
| Recording | POST `/api/transcriptions` | [Bounded multipart upload](transcription.md) |

Create metadata resources returns 201 with the resource itself; generation admission returns 202 with `{userMessageId,generation,deduplicated}`. DELETE returns `{deleted:true}`. Lists use their documented cursors; do not treat IDs as offsets. See each contract for complete payload/result fields and bounds.

## Client sequence

After Google sign-in, load `/api/me` and `/api/models`. Create a conversation with `POST /api/conversations` and `{}` or `{title,projectId}`. Send a client-generated UUID request ID:

```json
{
  "requestId": "f5b1ae44-dce4-4ef2-9851-d069afceec92",
  "text": "Explain the result",
  "preferences": { "model": "gpt-6-luna", "effort": "medium" }
}
```

POST this body to `/api/conversations/:id/messages`, then subscribe to the returned generation's `/events`. Repeat an identical admission request only for request deduplication; reconnect with GET and the last application event cursor. Without a cursor, replace client state with the initial saved snapshot. On completion replace accumulated text with the canonical message. After reload, history returns `currentGeneration` and `lastEditableUserMessageId`, even when the latest turn is outside the current history page.

Only the latest user message can be replaced. Wait for an active generation to finish or explicitly cancel first. PATCH its message URL with a fresh request ID and replacement text; this permanently discards the prior answer and its context artifacts. Failed/cancelled latest assistants need retry or replacement before a new turn. Project deletion preserves conversation history; conversation/folder/page deletion is permanent. Page PATCH additionally requires the last response's `expectedUpdatedAt`; a conflict requires reloading.

## Errors

Custom JSON errors have `{ "error": "safe message" }`. Better Auth endpoints retain their library-owned error contract. Generation snapshots and durable SSE terminal errors also expose safe failure codes; see [execution](conversations.md).

| Status | Meaning |
| --- | --- |
| 400 | Invalid fields, UUID, precondition or body |
| 401 | Missing, forged, deleted or expired session |
| 403 | Missing or untrusted mutation Origin |
| 404 | Missing or foreign resource/cursor |
| 408 | Audio upload read timeout |
| 409 | Generation/request conflict, folder cycle or stale page precondition |
| 413 | Actual request/content bytes exceed the endpoint limit |
| 415 | Unsupported request content type or audio format |
| 429 | Shared rate/concurrency reservation limit |
| 500 | Sanitized internal failure |
| 502 / 503 / 504 | Transcription upstream failure / unavailable configuration or provider / provider timeout |

Provider generation failures are saved states, not successful answers; an admission 202 means accepted locally, not successful inference. A stream-only transport error has no durable event ID and calls for snapshot/reconnect. Provider IDs, raw errors, usage/output payloads and compaction artifacts are never API responses. Exact endpoint limits and live-service verification gaps are documented in their contracts.
