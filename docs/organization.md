# Projects, conversations and history

All endpoints require a database-validated session. Mutations also require an exact trusted
`Origin`, as described in [authentication](auth.md). Ownership comes from the session; foreign IDs
return 404. Responses are private and not cached. Domain IDs and pagination cursors are UUIDs.

| Endpoint                           | Methods            | Body or result                                                                                            |
| ---------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| `/api/projects`                    | GET, POST          | GET returns `{projects,nextCursor}`; POST accepts `{title}`                                               |
| `/api/projects/[id]`               | GET, PATCH, DELETE | PATCH accepts `{title}`                                                                                   |
| `/api/conversations`               | GET, POST          | GET returns `{conversations,nextCursor}`; POST accepts optional `{title,projectId}`                       |
| `/api/conversations/[id]`          | GET, PATCH, DELETE | PATCH accepts `title`, `projectId`, or both; GET includes generation snapshot and latest editable user ID |
| `/api/conversations/[id]/messages` | GET                | Returns `{messages,nextCursor,lastEditableUserMessageId,currentGeneration}`                               |

Create returns 201; deletion returns `{deleted:true}`. Titles are trimmed and must contain 1–200
characters. An omitted conversation title becomes `New conversation`. Metadata JSON is limited to 4
KiB and unknown fields are rejected. PATCH requires at least one supported field. `projectId:null`
detaches a conversation. Assignments must target a project owned by the same user.

Deleting a project atomically removes the association from its conversations and preserves their
messages. Deleting a conversation permanently cascades to its messages. Deletion locks the owned
conversation before removal, so subsequent generation updates cannot find or resurrect it. Provider
cancellation is integrated by the generation executor using the internal cleanup receipt; provider
IDs are never included in the deletion HTTP response.

## Pagination and reload

List routes accept `limit` (default 50, maximum 100) and `after` (the previous page's `nextCursor`).
Projects and conversations sort oldest first by creation timestamp and UUID; timestamp comparisons
use PostgreSQL's original precision. Conversation lists optionally accept `projectId=<uuid>` or
`projectId=null` for ungrouped conversations. A cursor must belong to the owner and match the
project filter. A deleted cursor returns 404; restart the list in that case.

Messages sort by turn ascending, then user before assistant. A history cursor must be a message in
that conversation. The latest editable user-message identity is returned independently of the
requested history page. `currentGeneration` contains the durable current assistant message,
including its text, status, generation ID, stream cursor and model/effort snapshot, even when it is
outside the requested page. Completed and failed snapshots can remain current; the status
distinguishes them from active work.

Public messages contain IDs, turn, role, text, status, model, effort, generation ID, stream cursor,
safe URL citations and timestamps. They exclude provider response IDs, provider output,
context/compaction artifacts, raw error and usage payloads. Citations project only public HTTP(S)
URLs, titles and optional annotation indices, rejecting credential-bearing URLs and other protocols.
Project/page content and sibling conversations are never loaded into model context.

## Generation integration

`@agent/backend/organization` exports `lockConversation(tx,ownerId,id)`, `publicConversation`,
`publicMessage` and `initialTitle(text?)`. The executor uses the owned lock inside short
transactions to create turns, replace the latest turn and reconcile status; it must compare the
current generation identity and version before writing. No message mutation endpoint competes with
generation execution.

`deleteConversation(ownerId,id,db?)` returns an internal `{generationId,providerResponseId,status}`
receipt after transactional deletion. The executor wires remote cancellation/cleanup at the deletion
route and handles in-flight provider-creation races. Missing rows invalidate all later
progress/final writes. Do not hold a transaction open while contacting a provider.

## Verification

`TEST_DATABASE_URL=postgresql://agent:agent-local@localhost:5432/agent pnpm test:backend` runs
isolated local PostgreSQL checks. Each integration check creates and drops its own temporary
database. Organization checks cover actual signed-session route calls, CRUD, cross-user denial,
reassignment, project detach preserving history, active-generation deletion, ordered keyset
pagination, safe reload snapshots, latest-edit identity and input limits. Real provider cancellation
and generation lifecycle are verified with the generation implementation; no paid provider call is
needed for metadata checks.

Conversation deletion now queues provider cleanup transactionally; see
[Conversation execution](conversations.md) for execution endpoints, background recovery and cleanup
limits.
