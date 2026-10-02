# Private space, folders and Markdown pages

Every signed-in user has one private space, provisioned by authentication. Ownership comes from the
validated session. All endpoints require authentication; mutations also require the exact trusted
`Origin`. Foreign and nonexistent resource IDs return 404. Responses are private/no-store. IDs are
UUIDs and remain stable through renames and moves.

| Endpoint            | Methods            | Body or result                                                                                     |
| ------------------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| `/api/space`        | GET                | Returns `{space,parentId,folders,pages,nextFolderCursor,nextPageCursor}`                           |
| `/api/folders`      | POST               | `{name,parentId?}`; omitted/null parent creates a root folder                                      |
| `/api/folders/[id]` | GET, PATCH, DELETE | PATCH accepts `name`, `parentId`, or both; null parent moves to root                               |
| `/api/pages`        | POST               | `{title,folderId?,markdown?}`; omitted/null folder creates a root page; Markdown defaults to empty |
| `/api/pages/[id]`   | GET, PATCH, DELETE | PATCH accepts `title`, `folderId`, and/or `markdown`, plus required `expectedUpdatedAt`            |

POST returns 201 and the resource. GET/PATCH return the resource; DELETE returns `{deleted:true}`.
Folder responses include id, spaceId, parentId, name and timestamps. Page responses include id,
spaceId, folderId, title, complete markdown and timestamps. Directory listings omit Markdown. There
are no client-supplied ownership fields; unknown JSON fields are rejected and PATCH requires at
least one mutable field.

Names and titles are trimmed, contain 1–200 characters, and cannot contain `/`, `\`, control
characters, malformed Unicode, or equal `.` or `..`. Duplicate sibling names are allowed, including
a folder and page with the same name: IDs identify resources, not paths or slugs. Pages preserve the
complete Markdown string, including whitespace, line endings and Unicode. Content must be valid
Unicode without null characters and cannot exceed 1 MiB of UTF-8 text. Folder JSON is bounded at 4
KiB; page JSON is bounded at 6 MiB plus 4 KiB to permit JSON escaping of the maximum content. Actual
streamed request bytes, rather than the declared length alone, enforce these limits.

## Listings

Omit `parentId` to list the root; use `parentId=<folder UUID>` to list that folder. The folder must
exist in the signed-in user's space. `limit` defaults to 50 and permits 1–100 entries **per resource
kind**. Folders and pages sort separately by UUID. Pass the previous `nextFolderCursor` as
`folderAfter` and `nextPageCursor` as `pageAfter` to advance each list independently. Null next
cursors mean that kind has no more entries. A cursor must belong to the same space and directory. A
deleted cursor returns 404; restart that list.

## Moves, deletion and content conflicts

Every tree mutation takes the owned space row's PostgreSQL transaction lock before reading source or
destination rows. Reads take a shared lock for a coherent directory snapshot. Parent ownership and
existence checks, ancestor-cycle checks, moves and deletes therefore share a database serialization
point across application processes. A folder cannot move into itself or a descendant; competing
opposite moves produce one success and one 409. Cross-space moves fail. Root destinations use JSON
null.

Deleting a folder permanently deletes its complete subtree and contained pages through transactional
database cascades. A competing create or move cannot slip a page into a deleted tree: it either
commits before deletion and is removed, or sees the missing parent and fails. Root pages outside
that subtree survive. There is no recycle bin, revision history or content rendering.

For every page PATCH, send the `updatedAt` string from the most recent GET, POST or PATCH response
as `expectedUpdatedAt`. A stale precondition returns 409 without changing the page; reload before
resubmitting. Missing or malformed preconditions return 400. All page changes, including metadata
moves and renames, advance the timestamp by at least one serialized millisecond. This avoids lost
updates even when consecutive edits occur within the same millisecond. The precondition uses the
public ISO timestamp's millisecond precision consistently with PostgreSQL's higher precision
storage.

## Verification and limits

`TEST_DATABASE_URL=postgresql://agent:agent-local@localhost:5432/agent pnpm test:backend` includes
signed-session Spaces checks in an isolated temporary PostgreSQL database. Checks cover nested and
root CRUD, stable identities, duplicate names, directory pagination, ownership boundaries,
nonexistent/foreign parents, opposite concurrent moves, competing page edits, stale preconditions,
exact Markdown roundtrip and byte bounds, recursive deletion and a competing deletion/create. No
paid API calls or browser QA are needed. Live Neon operation remains unverified without configured
credentials. Space-row serialization intentionally favors correctness over concurrent throughput
within one user's tree; finer locking is only needed if measured contention warrants it.
