# API reference

This document describes each implemented endpoint: its purpose, request body or query parameters,
successful response and expected errors. Paths are relative to the application origin, for example
`http://localhost:3000`. Example IDs and timestamps are illustrative; use values returned by your
instance.

## Contents

- [Conventions and errors](#conventions-and-errors)
- [Response objects](#response-objects)
- [Health](#health)
- [Google authentication](#google-authentication)
- [Profile, preferences and models](#profile-preferences-and-models)
- [Projects](#projects)
- [Conversations and history](#conversations-and-history)
- [Generation and editing](#generation-and-editing)
- [SSE events](#sse-events)
- [Space, folders and pages](#space-folders-and-pages)
- [Transcription](#transcription)

## Conventions and errors

All custom endpoints except `GET /api/health` require a valid Better Auth session cookie. Ownership
comes from that session; missing and foreign resource IDs both return 404. Better Auth owns
`/api/auth/*` and its public sign-in flow does not require an existing session.

Send cookies on requests and these headers on custom JSON mutations:

```http
Origin: http://localhost:3000
Content-Type: application/json
```

`Origin` must exactly match `BETTER_AUTH_URL`. Transcription uses `multipart/form-data` instead; let
your client generate the boundary. GET and DELETE operations have no body. Generation cancellation
also has no body. Creation with all-optional fields still requires a JSON object, such as `{}`.

Browser clients send session cookies (`credentials: "include"` when needed). The application does
not configure cross-origin CORS. Domain responses use `Cache-Control: private, no-store`. Dates are
UTC ISO 8601 strings with milliseconds. Resource/request IDs are UUIDs; Better Auth user/session IDs
are opaque strings. Custom JSON bodies reject unknown fields, including client ownership/provider
IDs.

### Limits

| Operation                                                             | Actual body limit                                                 |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Preferences, project/conversation metadata, folders, generation retry | 4,096 bytes                                                       |
| Message send/replacement                                              | 400,000 JSON bytes; message text at most 65,536 UTF-8 bytes       |
| Page create/update                                                    | 6,295,552 JSON bytes; Markdown at most 1,048,576 UTF-8 bytes      |
| Transcription                                                         | 4,000,000 bytes for the entire multipart body, including overhead |

Chat and transcription share admission limits: 10 requests per user per minute, 3 active per user
and 20 active globally. Identical deduplicated chat requests do not consume another slot. These are
request/concurrency bounds, not billing quotas. See
[generation runtime limits](conversations.md#limits-and-verification).

### Errors

Custom JSON errors have the shape:

```json
{ "error": "Resource not found" }
```

| HTTP status | Meaning                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 400         | Invalid body, field, identifier, query, precondition or audio                                                                          |
| 401         | Missing, invalid, deleted or expired session                                                                                           |
| 403         | Missing or untrusted mutation Origin                                                                                                   |
| 404         | Missing/foreign resource, generation or pagination cursor                                                                              |
| 408         | Audio upload read timeout                                                                                                              |
| 409         | Active-generation conflict, reused request ID, invalid latest-turn edit/retry, SSE cursor mismatch, folder cycle or stale page version |
| 413         | Request, text, Markdown or upload exceeds its limit                                                                                    |
| 415         | Unsupported request content type or audio format                                                                                       |
| 429         | Shared paid-request admission/concurrency limit                                                                                        |
| 500         | Sanitized internal failure                                                                                                             |
| 502         | Transcription provider failure or invalid output                                                                                       |
| 503         | Transcription configuration/provider unavailable, including upstream access/rate-limit failure                                         |
| 504         | Transcription provider timeout                                                                                                         |

Endpoint-specific errors below are in addition to shared authentication, Origin, parsing, size and
infrastructure errors. Origin is checked before session lookup on mutations, so an anonymous request
without trusted Origin can return 403. Better Auth uses its own `{code,message}` errors. Generation
failures after 202 are saved states/SSE errors, not another response to the original POST.

## Response objects

These are complete public response examples, reused by the endpoint descriptions. `null` indicates a
nullable field; JSON examples are values, not schemas.

### Project

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "title": "Research",
  "createdAt": "2026-10-02T12:00:00.000Z",
  "updatedAt": "2026-10-02T12:00:00.000Z"
}
```

### Conversation

```json
{
  "id": "22222222-2222-4222-8222-222222222222",
  "projectId": "11111111-1111-4111-8111-111111111111",
  "title": "Research notes",
  "createdAt": "2026-10-02T12:00:00.000Z",
  "updatedAt": "2026-10-02T12:00:00.000Z"
}
```

`projectId` is null when ungrouped. Create, list and PATCH return this base object. GET by ID adds
reload fields described below.

### Message

```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "turn": 0,
  "role": "assistant",
  "text": "Here is the result.",
  "status": "completed",
  "model": "gpt-6-luna",
  "effort": "medium",
  "generationId": "55555555-5555-4555-8555-555555555555",
  "streamCursor": 18,
  "citations": [
    {
      "type": "url_citation",
      "url": "https://example.com/article",
      "title": "Example article",
      "start_index": 0,
      "end_index": 18
    }
  ],
  "createdAt": "2026-10-02T12:00:00.000Z",
  "updatedAt": "2026-10-02T12:00:01.000Z"
}
```

- `turn` starts at zero; a user/assistant pair shares it. `role` is `user` or `assistant`.
- User messages have status `completed`, null `model`, `effort` and `generationId`, cursor `-1`, and
  no citations.
- Assistant status is `pending`, `running`, `completed`, `failed` or `cancelled`. Before progress,
  text is empty and cursor is `-1`.
- Citation ranges are optional and preserve provider annotation indices. Only public HTTP(S) URLs
  without credentials are returned.
- `streamCursor` is provider progress, **not** the SSE resume cursor. Provider IDs, raw
  usage/output, request fingerprints and compaction artifacts stay internal.

### Generation snapshot

A snapshot has all [Message](#message) fields, plus:

| Field         | Type           | Meaning                                                |
| ------------- | -------------- | ------------------------------------------------------ |
| `error`       | string or null | Safe saved failure code; null when no failure is saved |
| `eventCursor` | integer        | Latest durable application event ID, or 0 if none      |

Generation GET and SSE snapshot include these extras. Admission `generation` and history
`currentGeneration` contain only Message fields.

### Space, folder and page

Space:

```json
{
  "id": "66666666-6666-4666-8666-666666666666",
  "createdAt": "2026-10-02T12:00:00.000Z",
  "updatedAt": "2026-10-02T12:00:00.000Z"
}
```

Folder:

```json
{
  "id": "77777777-7777-4777-8777-777777777777",
  "spaceId": "66666666-6666-4666-8666-666666666666",
  "parentId": null,
  "name": "Notes",
  "createdAt": "2026-10-02T12:00:00.000Z",
  "updatedAt": "2026-10-02T12:00:00.000Z"
}
```

Page:

```json
{
  "id": "88888888-8888-4888-8888-888888888888",
  "spaceId": "66666666-6666-4666-8666-666666666666",
  "folderId": "77777777-7777-4777-8777-777777777777",
  "title": "Meeting notes",
  "markdown": "# Notes\n\nHello.\n",
  "createdAt": "2026-10-02T12:00:00.000Z",
  "updatedAt": "2026-10-02T12:00:00.000Z"
}
```

`parentId`/`folderId` is null at root. Directory page listings omit `markdown`; GET by page ID
returns full content. Duplicate sibling names are allowed: IDs identify items.

## Health

### GET /api/health

Checks process liveness. Public; no body. Does not test database or provider readiness. **200
response:**

```json
{ "status": "ok" }
```

## Google authentication

Better Auth 1.7.7 handles GET/POST under `/api/auth/*`. The following operations cover the
application's Google login/session/logout flow. Responses/cookies follow the installed library. See
[configuration](auth.md) for callback setup. Other library routes are not custom domain endpoints;
`/api/auth/update-user` is disabled.

### POST /api/auth/sign-in/social

Starts Google sign-in without an existing session. Send trusted Origin and JSON.

**Request body:**

```json
{
  "provider": "google",
  "callbackURL": "http://localhost:3000",
  "disableRedirect": true
}
```

| Field             | Required | Meaning                                                                          |
| ----------------- | -------- | -------------------------------------------------------------------------------- |
| `provider`        | Yes      | `google`, the only configured provider                                           |
| `callbackURL`     | No       | Trusted destination after successful sign-in; set explicitly for the client flow |
| `disableRedirect` | No       | true lets the client handle navigation                                           |

**200 response for this redirect-based request:**

```json
{ "url": "https://accounts.google.com/o/oauth2/v2/auth?...", "redirect": false }
```

Navigate to `url`, preserving OAuth state cookies. Without `disableRedirect: true`, `redirect` is
true and `Location` is also set. This starts OAuth; it does not establish a signed-in session.
Invalid provider/body/origin/callback errors follow Better Auth's `{code,message}` contract.

### GET /api/auth/callback/google

Completes Google's redirect flow. Google supplies query parameters such as `code` and `state`; do
not construct them yourself. No JSON body. On success, sets session cookies and redirects to the
callback destination (302), with no custom JSON success body. Rejection/invalid state uses Better
Auth's OAuth error handling.

### GET /api/auth/get-session

Reads the current validated session. No body; include issued cookies. **200 response:** null without
a valid session, otherwise `{session,user}`:

```json
{
  "session": {
    "id": "opaque-session-id",
    "userId": "opaque-user-id",
    "token": "example-session-token",
    "expiresAt": "2026-10-09T12:00:00.000Z",
    "createdAt": "2026-10-02T12:00:00.000Z",
    "updatedAt": "2026-10-02T12:00:00.000Z",
    "ipAddress": null,
    "userAgent": null
  },
  "user": {
    "id": "opaque-user-id",
    "name": "Alex Example",
    "email": "alex@example.com",
    "emailVerified": true,
    "image": null,
    "firstName": "Alex",
    "lastName": "Example",
    "preferredModel": null,
    "preferredEffort": null,
    "createdAt": "2026-10-02T12:00:00.000Z",
    "updatedAt": "2026-10-02T12:00:00.000Z"
  }
}
```

This example shows library fields and configured extensions. Stored preferences may be null;
`/api/me` returns effective defaults. Unlike this auth endpoint, custom private routes return 401
without a valid session.

### POST /api/auth/sign-out

Invalidates the current session and clears its cookies. Send cookies, trusted Origin and JSON `{}`.
A normal logout with this Google configuration has **200 response:**

```json
{ "success": true }
```

## Profile, preferences and models

### GET /api/me

Returns your profile, effective preferences and singleton space ID. Repairs a missing space
idempotently. No body. **200 response:**

```json
{
  "id": "opaque-user-id",
  "firstName": "Alex",
  "lastName": null,
  "email": "alex@example.com",
  "image": null,
  "preferences": { "model": "gpt-6-luna", "effort": "medium" },
  "spaceId": "66666666-6666-4666-8666-666666666666"
}
```

First/last names and image may be null. Names come from Google; the API does not edit profiles or
infer missing name parts.

### GET /api/me/preferences

Returns effective preferences for future generations. No body. **200 response:**

```json
{ "model": "gpt-6-luna", "effort": "medium" }
```

### PATCH /api/me/preferences

Replaces both saved fields. Already admitted generations keep their settings. **Required request
body and 200 response:**

```json
{ "model": "gpt-6.1-sol", "effort": "high" }
```

Both strings are required. A partial pair, unknown field or unsupported model/effort returns 400.

### GET /api/models

Returns the allowed catalog and defaults. Authenticated; no body. **200 response:**

```json
{
  "models": [
    {
      "id": "gpt-6-luna",
      "name": "GPT-6 Luna",
      "efforts": ["none", "low", "medium", "high", "xhigh", "max"]
    },
    {
      "id": "gpt-6.1-sol",
      "name": "GPT-6.1 Sol",
      "efforts": ["low", "medium", "high", "xhigh", "max"]
    }
  ],
  "defaults": { "model": "gpt-6-luna", "effort": "medium" }
}
```

The catalog is an application allowlist, not a live provider-access check. See
[model verification limits](auth.md#shared-generation-settings).

## Projects

Titles are trimmed strings of 1–200 characters. Projects group conversations; they do not supply
model context.

### GET /api/projects

Lists your projects, oldest first by creation timestamp then UUID. No body.

| Query   | Required | Meaning                    |
| ------- | -------- | -------------------------- |
| `limit` | No       | Integer 1–100; default 50  |
| `after` | No       | Previous `nextCursor` UUID |

**200 response:** object with `projects` (array of complete [Project](#project) objects) and
`nextCursor` (UUID or null). Empty result:

```json
{ "projects": [], "nextCursor": null }
```

Null means no next page. Missing/foreign/deleted cursor returns 404; IDs are cursors, not offsets.

### POST /api/projects

Creates an owned project. **Request body:**

```json
{ "title": "Research" }
```

**201 response:** created [Project](#project), without an envelope. Invalid/missing title
returns 400.

### GET /api/projects/:id

Reads an owned project. Path `id` is a project UUID; no body. **200 response:** [Project](#project).
Missing/foreign ID returns 404.

### PATCH /api/projects/:id

Renames a project. **Required body:** `{ "title": "New title" }`. **200 response:** updated
[Project](#project). Invalid title returns 400; missing/foreign project returns 404.

### DELETE /api/projects/:id

Permanently deletes a project and sets its conversations' `projectId` to null.
Conversations/messages survive. No body. **200 response:**

```json
{ "deleted": true }
```

Missing/foreign ID returns 404, including a repeated deletion.

## Conversations and history

### GET /api/conversations

Lists your conversation metadata, oldest first by creation timestamp then UUID. No body.

| Query       | Required | Meaning                                                                          |
| ----------- | -------- | -------------------------------------------------------------------------------- |
| `limit`     | No       | Integer 1–100; default 50                                                        |
| `after`     | No       | Previous `nextCursor` UUID                                                       |
| `projectId` | No       | Owned project UUID; literal `null` selects ungrouped conversations; omit for all |

**200 response:** `conversations` (array of base [Conversation](#conversation) objects) and
`nextCursor` (UUID or null). Empty result:

```json
{ "conversations": [], "nextCursor": null }
```

Missing/foreign project or cursor returns 404. Cursor/project-filter mismatch returns 400.

### POST /api/conversations

Creates a conversation, optionally in a project. **Request body:**

```json
{ "title": "Research notes", "projectId": "11111111-1111-4111-8111-111111111111" }
```

| Field       | Required | Default/constraint                                       |
| ----------- | -------- | -------------------------------------------------------- |
| `title`     | No       | `New conversation`; trimmed 1–200 characters if supplied |
| `projectId` | No       | null, otherwise owned project UUID                       |

`{}` is valid. **201 response:** base [Conversation](#conversation). Missing/foreign project
returns 404. The first user message replaces an untouched `New conversation` title with a
deterministic text excerpt.

### GET /api/conversations/:id

Reads metadata and reload state. No body. **200 response:** base [Conversation](#conversation) plus
`lastEditableUserMessageId` (latest user UUID or null) and `currentGeneration` ([Message](#message)
or null). Empty conversation:

```json
{
  "id": "22222222-2222-4222-8222-222222222222",
  "projectId": null,
  "title": "New conversation",
  "createdAt": "2026-10-02T12:00:00.000Z",
  "updatedAt": "2026-10-02T12:00:00.000Z",
  "lastEditableUserMessageId": null,
  "currentGeneration": null
}
```

`currentGeneration` can remain present after completion/failure; inspect its status. It does not
include `error`/`eventCursor`; use generation GET for those. Missing/foreign conversation
returns 404.

### PATCH /api/conversations/:id

Renames and/or reassigns a conversation. Send at least one field:

```json
{ "title": "Updated notes", "projectId": null }
```

`title` is trimmed, 1–200 characters. `projectId` is an owned project UUID or null to detach.
Omitted fields stay unchanged. **200 response:** updated base [Conversation](#conversation).
Empty/invalid body returns 400; missing/foreign source or project returns 404.

### DELETE /api/conversations/:id

Permanently deletes conversation/messages/local generation history and queues remote provider
cleanup, including creation races. Cleanup may finish later. No body. **200 response:**
`{ "deleted": true }`. Missing/foreign conversation returns 404. Late writes cannot resurrect local
history; see [cleanup limits](conversations.md#context-and-editing).

### GET /api/conversations/:id/messages

Loads saved history ordered by turn, user before assistant. No body. Query: `limit` (1–100, default
50), `after` (previous message cursor UUID).

**200 response fields:**

| Field                       | Type            | Meaning                                                 |
| --------------------------- | --------------- | ------------------------------------------------------- |
| `messages`                  | Message array   | Requested history page, using complete Message objects  |
| `nextCursor`                | UUID or null    | Last included message ID if another page exists         |
| `lastEditableUserMessageId` | UUID or null    | Latest user independently of requested page             |
| `currentGeneration`         | Message or null | Current saved assistant independently of requested page |

Empty history:

```json
{ "messages": [], "nextCursor": null, "lastEditableUserMessageId": null, "currentGeneration": null }
```

Missing/foreign conversation or a cursor outside it returns 404. A page can end between the user and
assistant of one turn.

## Generation and editing

Admission returns 202 after local persistence, not completed inference. The separate worker
progresses admitted generations; observe with GET/SSE. Reload/disconnection does not cancel
generation.

### POST /api/conversations/:id/messages

Creates one user message and reserves its assistant generation. **Request body:**

```json
{
  "requestId": "f5b1ae44-dce4-4ef2-9851-d069afceec92",
  "text": "Explain the result",
  "preferences": { "model": "gpt-6-luna", "effort": "medium" }
}
```

| Field         | Required | Constraint                                                                     |
| ------------- | -------- | ------------------------------------------------------------------------------ |
| `requestId`   | Yes      | Client-generated UUID unique to the operation within the conversation          |
| `text`        | Yes      | Nonblank valid Unicode without NUL, at most 64 KiB UTF-8; whitespace preserved |
| `preferences` | No       | Complete allowed `{model,effort}` pair; otherwise effective saved preferences  |

**202 response:**

```json
{
  "userMessageId": "33333333-3333-4333-8333-333333333333",
  "generation": {
    "id": "44444444-4444-4444-8444-444444444444",
    "turn": 0,
    "role": "assistant",
    "text": "",
    "status": "pending",
    "model": "gpt-6-luna",
    "effort": "medium",
    "generationId": "55555555-5555-4555-8555-555555555555",
    "streamCursor": -1,
    "citations": [],
    "createdAt": "2026-10-02T12:00:00.000Z",
    "updatedAt": "2026-10-02T12:00:00.000Z"
  },
  "deduplicated": false
}
```

Repeat identical operation/body/request ID to recover that generation with `deduplicated: true`; its
state may have progressed. Changed input with the same ID, a discarded request ID, active
generation, or unfinished latest turn returns 409. Invalid preferences return 400; shared admission
limits return 429. Retry/replace failed or cancelled latest work before appending a new turn.

### PATCH /api/conversations/:id/messages/:messageId

Replaces only the latest user turn. Path `messageId` is the user UUID, not assistant/generation ID.
Uses the same body and 202 envelope as [send](#post-apiconversationsidmessages), with a fresh
request ID and replacement text.

User-message ID stays unchanged. Prior assistant/events/context artifacts are discarded and a new
generation starts from the context before that turn; no versions are retained. Wait for active work
or explicitly cancel first. Older/incorrect target or active turn returns 409; missing/foreign
conversation returns 404.

### GET /api/conversations/:id/generations/:generationId

Reads saved generation state. Path `generationId` is the returned application UUID, not provider ID.
No body. **200 response:** [Generation snapshot](#generation-snapshot), including full
text/citations, `error` and `eventCursor`. Missing/foreign/discarded generation returns 404.

Safe failure codes include `cancelled`, `incomplete_response`, `provider_rejected`,
`provider_failed`, `provider_error`, `provider_response_unavailable`, `ambiguous_creation`. Provider
incomplete output is saved as `failed`; partial text is visible but excluded from future context.

### POST /api/conversations/:id/generations/:generationId/cancel

Cancels pending/running work locally and queues provider cleanup. No body. **200 response:**

```json
{ "generationId": "55555555-5555-4555-8555-555555555555", "status": "cancelled" }
```

Already terminal work returns its existing status unchanged. Missing/foreign/discarded generation
returns 404. Closing SSE does not invoke this cancellation.

### POST /api/conversations/:id/generations/:generationId/retry

Retries the failed/cancelled assistant of the latest turn, preserving its user-message ID. Discards
the old assistant attempt. **Request body:**

```json
{
  "requestId": "99999999-9999-4999-8999-999999999999",
  "preferences": { "model": "gpt-6-luna", "effort": "medium" }
}
```

A fresh request ID is required; preferences are optional with send's validation/default rules.
`text` is not accepted. **202 response:** send's admission envelope with a new assistant/generation
ID and existing user ID. Duplicates recover the same generation. Active/completed/older/incorrect
target returns 409; shared limits return 429. Explicit retry may incur another charge, especially
after ambiguous provider creation.

## SSE events

### GET /api/conversations/:id/generations/:generationId/events

Streams saved progress for the same generation. No body; include session cookies. **200 response:**
`Content-Type: text/event-stream`, private/no-store.

| Input                  | Meaning                                                |
| ---------------------- | ------------------------------------------------------ |
| Query `after`          | Optional application event ID, integer 0–2,147,483,647 |
| Header `Last-Event-ID` | Alternative cursor when `after` is omitted             |

Query wins when both exist. No cursor sends initial `snapshot`, then events after its ID. Supplied
cursor replays only later events with no snapshot; `after=0` replays from the ledger's start.
Nonzero cursor must belong to the generation: invalid format returns 400, mismatch 409,
missing/foreign generation 404 before streaming.

IDs are durable application IDs, potentially with gaps; do not use `streamCursor`. Ignore applied
IDs. Streams close at terminal state or after roughly 30 seconds; reconnect with the last applied
ID, never a new message POST. A closed connection alone is not completion.

**Frame example:**

```text
id: 42
event: text_delta
data: {"messageId":"44444444-4444-4444-8444-444444444444","generationId":"55555555-5555-4555-8555-555555555555","delta":"Hello","outputIndex":0,"contentIndex":0}

```

| Event               | Complete data contract                                    | Client action                                              |
| ------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| `snapshot`          | Generation snapshot                                       | Replace text/citations/status, save event ID               |
| `status`            | `{messageId,generationId,status}`                         | Update pending/running status                              |
| `text_delta`        | `{messageId,generationId,delta,outputIndex,contentIndex}` | Append delta once for its ID                               |
| `citations`         | `{messageId,generationId,citations}`                      | Replace Message citation array                             |
| `completed`         | `{messageId,generationId,status:"completed",message}`     | Replace with canonical Message                             |
| `error` (durable)   | `{messageId,generationId,status,code,message?}`           | Save failed/cancelled state and optional canonical Message |
| `error` (transport) | `{generationId,code:"stream_unavailable"}`                | No ID; fetch state/reconnect; inference remains unchanged  |

Snapshot carries assistant `id`, not a separate `messageId`. Durable events carry both identities.
Worker polling can finish a response without replaying every historical token; always replace
partial output on terminal/snapshot events. Final answers persist even without a connected client.
See [context/reload/retention details](conversations.md).

## Space, folders and pages

### GET /api/space

Lists immediate children of your root or an owned folder; does not recurse or include page Markdown.
No body.

| Query         | Required | Meaning                                           |
| ------------- | -------- | ------------------------------------------------- |
| `parentId`    | No       | Folder UUID; omit for root, not the string `null` |
| `limit`       | No       | 1–100 items per kind; default 50                  |
| `folderAfter` | No       | Previous `nextFolderCursor` UUID                  |
| `pageAfter`   | No       | Previous `nextPageCursor` UUID                    |

**200 response for an empty root:**

```json
{
  "space": {
    "id": "66666666-6666-4666-8666-666666666666",
    "createdAt": "2026-10-02T12:00:00.000Z",
    "updatedAt": "2026-10-02T12:00:00.000Z"
  },
  "parentId": null,
  "folders": [],
  "pages": [],
  "nextFolderCursor": null,
  "nextPageCursor": null
}
```

`folders` contains Folder objects; `pages` contains Page objects without `markdown`. Each kind sorts
by UUID with its independent cursor. Omit a kind's cursor to restart its list. Null next cursor
means no more items of that kind. Missing/foreign parent/cursor returns 404; wrong-directory cursor
returns 400.

### Names and content

Folder names/page titles are trimmed valid Unicode, 1–200 characters, without `/`, `\`, controls,
NUL, or the names `.`/`..`. Duplicate sibling names are allowed. Content is exact Markdown including
line endings/whitespace; empty is valid, malformed Unicode/NUL is not. Markdown is limited to 1 MiB
UTF-8. JSON null destinations mean root. Sources/destinations must belong to your space. See
[tree concurrency](spaces.md#moves-deletion-and-content-conflicts).

### POST /api/folders

Creates a root/nested folder. **Request body:**

```json
{ "name": "Notes", "parentId": null }
```

`name` is required. `parentId` defaults to null or accepts an owned folder UUID. **201 response:**
[Folder](#space-folder-and-page). Invalid name returns 400; foreign/missing parent returns 404.

### GET /api/folders/:id

Reads metadata, not children. No body; use space listing for children. **200 response:**
[Folder](#space-folder-and-page). Missing/foreign folder returns 404.

### PATCH /api/folders/:id

Renames and/or moves a folder. Send at least one field:

```json
{ "name": "Archive", "parentId": null }
```

Fields follow creation's constraints; omitted fields stay unchanged. **200 response:** updated
Folder. Empty/invalid body returns 400; foreign/missing source/destination 404; a
self/descendant/cyclic move 409, including competing moves.

### DELETE /api/folders/:id

Permanently deletes the folder, descendants and their pages. No body. **200 response:**
`{ "deleted": true }`. Missing/foreign folder returns 404. No recycle bin/revision history.

### POST /api/pages

Creates a root/nested Markdown page. **Request body:**

```json
{ "title": "Meeting notes", "folderId": null, "markdown": "# Notes\n\nHello.\n" }
```

| Field      | Required | Default/constraint                      |
| ---------- | -------- | --------------------------------------- |
| `title`    | Yes      | Folder-style name constraints           |
| `folderId` | No       | null for root or owned folder UUID      |
| `markdown` | No       | Empty string; complete Markdown content |

**201 response:** full [Page](#space-folder-and-page), with Markdown and `updatedAt`. Invalid
name/text returns 400, oversized content 413, foreign/missing folder 404.

### GET /api/pages/:id

Reads full metadata and Markdown. No body. **200 response:** Page. Missing/foreign page returns 404.
Keep `updatedAt` for updates.

### PATCH /api/pages/:id

Replaces content, renames and/or moves a page with a required version precondition. **Request
body:**

```json
{
  "expectedUpdatedAt": "2026-10-02T12:00:00.000Z",
  "title": "Updated meeting notes",
  "folderId": null,
  "markdown": "# Updated notes\n"
}
```

`expectedUpdatedAt` is required for every change, including moves/renames: copy the exact last page
response's `updatedAt` (`YYYY-MM-DDTHH:mm:ss.sssZ`). At least one of `title`, `folderId`, `markdown`
is required. Omitted fields stay unchanged. Content replaces the entire Markdown string; null folder
moves to root.

**200 response:** updated full Page with a new `updatedAt`. Missing/malformed precondition or no
mutable field returns 400; stale precondition 409 without changing content; oversized Markdown 413;
missing/foreign source/destination 404. Reload before resubmitting stale edits.

### DELETE /api/pages/:id

Permanently deletes the page. No body. **200 response:** `{ "deleted": true }`. Missing/foreign page
returns 404.

## Transcription

### POST /api/transcriptions

Transcribes a completed recording with `gpt-transcribe`, preserving spoken language. Does not store
audio/transcripts or create messages.

**Request body:** multipart with exactly one file part named `file`. No model, language,
conversation ID or other fields.

| Constraint | Value                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| Extensions | `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `wav`, `webm`                                                     |
| Size       | At least 12 file bytes; entire multipart body at most 4,000,000 bytes                                  |
| MIME type  | Supported audio/container type; generic/absent type requires supported extension and recognized header |
| Deadlines  | Upload read 30 seconds; provider 60 seconds; zero automatic retries                                    |

Example with existing signed-in cookies in a local cookie jar:

```sh
curl --cookie cookies.txt \
  --header 'Origin: http://localhost:3000' \
  --form 'file=@recording.webm;type=audio/webm' \
  http://localhost:3000/api/transcriptions
```

Let the HTTP client construct the multipart boundary. Provider prompt:
`Transcribe the speech in its original language.` No language hint or translation request.

**200 response:**

```json
{ "text": "Olá, estas são as minhas notas." }
```

Text is forwarded unchanged. Invalid multipart/audio or upstream decoding rejection returns 400;
unsupported request/audio type 415; oversized actual body 413; upload timeout 408; shared limit 429;
unavailable configuration/access/upstream rate limit 503; provider timeout 504; other provider
failures 502. Disconnecting aborts transcription; retry can incur another charge. See
[MIME types and verification limits](transcription.md).
