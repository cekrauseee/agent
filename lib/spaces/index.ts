import 'server-only'
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'
import { getDb, type Database, type Transaction } from '../db'
import { folders, pages, spaces } from '../db/schema'
import { fields, pagination, uuid } from '../organization'
import { ApiError } from '../server/http'

export const MAX_MARKDOWN_BYTES = 1024 * 1024
export const PAGE_BODY_LIMIT = MAX_MARKDOWN_BYTES * 6 + 4096
const malformedText = (value: string) =>
  value.includes('\0') ||
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
export function name(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 200 ||
    malformedText(value) ||
    /[/\\\p{Cc}]/u.test(value) ||
    ['.', '..'].includes(value.trim())
  )
    throw new ApiError(400, 'Name must contain 1–200 characters without separators or controls')
  return value.trim()
}
export function markdown(value: unknown): string {
  if (typeof value !== 'string' || malformedText(value))
    throw new ApiError(400, 'Markdown must be valid text without null characters')
  if (Buffer.byteLength(value, 'utf8') > MAX_MARKDOWN_BYTES)
    throw new ApiError(413, 'Markdown exceeds 1 MiB')
  return value
}
const parent = (value: unknown) => (value === null || value === undefined ? null : uuid(value))
function found<T>(row: T | undefined): T {
  if (!row) throw new ApiError(404, 'Resource not found')
  return row
}
async function lockSpace(tx: Transaction, ownerId: string, write: boolean) {
  // ponytail: one lock per private tree; use finer subtree locks only if measured contention warrants it.
  return found(
    (
      await tx
        .select()
        .from(spaces)
        .where(eq(spaces.ownerId, ownerId))
        .for(write ? 'update' : 'share')
    )[0],
  )
}
async function ownFolder(tx: Transaction, spaceId: string, id: string) {
  return found(
    (
      await tx
        .select()
        .from(folders)
        .where(and(eq(folders.spaceId, spaceId), eq(folders.id, uuid(id))))
    )[0],
  )
}
async function ownPage(tx: Transaction, spaceId: string, id: string) {
  return found(
    (
      await tx
        .select()
        .from(pages)
        .where(and(eq(pages.spaceId, spaceId), eq(pages.id, uuid(id))))
    )[0],
  )
}
const pageMetadata = {
  id: pages.id,
  spaceId: pages.spaceId,
  folderId: pages.folderId,
  title: pages.title,
  createdAt: pages.createdAt,
  updatedAt: pages.updatedAt,
}
export async function listSpace(ownerId: string, params: URLSearchParams, db: Database = getDb()) {
  const parentId = parent(params.get('parentId'))
  const { limit } = pagination(params)
  const folderAfter = params.has('folderAfter') ? uuid(params.get('folderAfter')) : null
  const pageAfter = params.has('pageAfter') ? uuid(params.get('pageAfter')) : null
  return db.transaction(async (tx) => {
    const space = await lockSpace(tx, ownerId, false)
    if (parentId) await ownFolder(tx, space.id, parentId)
    if (folderAfter && (await ownFolder(tx, space.id, folderAfter)).parentId !== parentId)
      throw new ApiError(400, 'Folder cursor does not match directory')
    if (pageAfter && (await ownPage(tx, space.id, pageAfter)).folderId !== parentId)
      throw new ApiError(400, 'Page cursor does not match directory')
    const folderRows = await tx
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.spaceId, space.id),
          parentId ? eq(folders.parentId, parentId) : isNull(folders.parentId),
          folderAfter ? gt(folders.id, folderAfter) : undefined,
        ),
      )
      .orderBy(asc(folders.id))
      .limit(limit + 1)
    const pageRows = await tx
      .select(pageMetadata)
      .from(pages)
      .where(
        and(
          eq(pages.spaceId, space.id),
          parentId ? eq(pages.folderId, parentId) : isNull(pages.folderId),
          pageAfter ? gt(pages.id, pageAfter) : undefined,
        ),
      )
      .orderBy(asc(pages.id))
      .limit(limit + 1)
    return {
      space: { id: space.id, createdAt: space.createdAt, updatedAt: space.updatedAt },
      parentId,
      folders: folderRows.slice(0, limit),
      pages: pageRows.slice(0, limit),
      nextFolderCursor: folderRows.length > limit ? folderRows[limit - 1].id : null,
      nextPageCursor: pageRows.length > limit ? pageRows[limit - 1].id : null,
    }
  })
}
export async function getFolder(ownerId: string, id: string, db: Database = getDb()) {
  return db.transaction(async (tx) => ownFolder(tx, (await lockSpace(tx, ownerId, false)).id, id))
}
export async function createFolder(ownerId: string, input: unknown, db: Database = getDb()) {
  const body = fields(input, ['name', 'parentId'])
  const folderName = name(body.name),
    parentId = parent(body.parentId)
  return db.transaction(async (tx) => {
    const space = await lockSpace(tx, ownerId, true)
    if (parentId) await ownFolder(tx, space.id, parentId)
    return (
      await tx.insert(folders).values({ spaceId: space.id, name: folderName, parentId }).returning()
    )[0]
  })
}
export async function updateFolder(
  ownerId: string,
  id: string,
  input: unknown,
  db: Database = getDb(),
) {
  const body = fields(input, ['name', 'parentId'])
  if (!Object.keys(body).length) throw new ApiError(400, 'Provide name or parentId')
  const patch = {
    ...(Object.hasOwn(body, 'name') ? { name: name(body.name) } : {}),
    ...(Object.hasOwn(body, 'parentId') ? { parentId: parent(body.parentId) } : {}),
    updatedAt: new Date(),
  }
  return db.transaction(async (tx) => {
    const space = await lockSpace(tx, ownerId, true)
    const folder = await ownFolder(tx, space.id, id)
    if (patch.parentId) {
      await ownFolder(tx, space.id, patch.parentId)
      const ancestors = await tx.execute(sql`WITH RECURSIVE ancestors AS (
        SELECT id, parent_id FROM folder WHERE id = ${patch.parentId} AND space_id = ${space.id}
        UNION SELECT f.id, f.parent_id FROM folder f JOIN ancestors a ON f.id = a.parent_id WHERE f.space_id = ${space.id}
      ) SELECT id FROM ancestors WHERE id = ${folder.id}`)
      if (ancestors.rows.length) throw new ApiError(409, 'Folder move would create a cycle')
    }
    return (
      await tx
        .update(folders)
        .set(patch)
        .where(and(eq(folders.id, folder.id), eq(folders.spaceId, space.id)))
        .returning()
    )[0]
  })
}
export async function deleteFolder(ownerId: string, id: string, db: Database = getDb()) {
  return db.transaction(async (tx) => {
    const space = await lockSpace(tx, ownerId, true)
    const folder = await ownFolder(tx, space.id, id)
    await tx.delete(folders).where(and(eq(folders.id, folder.id), eq(folders.spaceId, space.id)))
  })
}
export async function getPage(ownerId: string, id: string, db: Database = getDb()) {
  return db.transaction(async (tx) => ownPage(tx, (await lockSpace(tx, ownerId, false)).id, id))
}
export async function createPage(ownerId: string, input: unknown, db: Database = getDb()) {
  const body = fields(input, ['title', 'folderId', 'markdown'])
  const title = name(body.title),
    folderId = parent(body.folderId),
    text = markdown(body.markdown === undefined ? '' : body.markdown)
  return db.transaction(async (tx) => {
    const space = await lockSpace(tx, ownerId, true)
    if (folderId) await ownFolder(tx, space.id, folderId)
    return (
      await tx
        .insert(pages)
        .values({ spaceId: space.id, title, folderId, markdown: text })
        .returning()
    )[0]
  })
}
export async function updatePage(
  ownerId: string,
  id: string,
  input: unknown,
  db: Database = getDb(),
) {
  const body = fields(input, ['title', 'folderId', 'markdown', 'expectedUpdatedAt'])
  if (!Object.keys(body).some((key) => key !== 'expectedUpdatedAt'))
    throw new ApiError(400, 'Provide title, folderId or markdown')
  if (
    typeof body.expectedUpdatedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(body.expectedUpdatedAt) ||
    !Number.isFinite(Date.parse(body.expectedUpdatedAt))
  )
    throw new ApiError(400, 'Provide expectedUpdatedAt from the page response')
  const expected = body.expectedUpdatedAt
  const patch = {
    ...(Object.hasOwn(body, 'title') ? { title: name(body.title) } : {}),
    ...(Object.hasOwn(body, 'folderId') ? { folderId: parent(body.folderId) } : {}),
    ...(Object.hasOwn(body, 'markdown') ? { markdown: markdown(body.markdown) } : {}),
    // Advance at least one serialized millisecond so even rapid successive writes have distinct preconditions.
    updatedAt: sql`greatest(clock_timestamp(), date_trunc('milliseconds', ${pages.updatedAt}) + interval '1 millisecond')`,
  }
  return db.transaction(async (tx) => {
    const space = await lockSpace(tx, ownerId, true)
    const page = await ownPage(tx, space.id, id)
    if (page.updatedAt.toISOString() !== expected)
      throw new ApiError(409, 'Page changed; reload before updating')
    if (patch.folderId) await ownFolder(tx, space.id, patch.folderId)
    return (
      await tx
        .update(pages)
        .set(patch)
        .where(and(eq(pages.id, page.id), eq(pages.spaceId, space.id)))
        .returning()
    )[0]
  })
}
export async function deletePage(ownerId: string, id: string, db: Database = getDb()) {
  return db.transaction(async (tx) => {
    const space = await lockSpace(tx, ownerId, true)
    const page = await ownPage(tx, space.id, id)
    await tx.delete(pages).where(and(eq(pages.id, page.id), eq(pages.spaceId, space.id)))
  })
}
