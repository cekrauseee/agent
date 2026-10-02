import "server-only";
import OpenAI from "openai";
import type { Response as ModelResponse, ResponseCreateParamsStreaming, ResponseStreamEvent } from "openai/resources/responses/responses";
import { toResponseInputItems, type ResponseInputItemLike } from "openai/lib/responses/ResponseInputItems";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, type Database } from "../db";
import { conversations, generationJobs, messages, paidRequests } from "../db/schema";
import { lockConversation, publicMessage } from "../organization";
import { ApiError } from "../server/http";
import { getOpenAI, releasePaid } from "../server/openai";
import { active, addEvent, type Message } from "./index";

type Job = typeof generationJobs.$inferSelect;
const terminal = (status: string | null | undefined) => ["completed", "failed", "cancelled", "incomplete"].includes(status ?? "");
function statusCode(error: unknown) { return error instanceof OpenAI.APIError ? error.status : undefined; }
function expiredReference(error: unknown) {
  return error instanceof OpenAI.APIError && (error.status === 404 || error.status === 400) &&
    (error.param === "previous_response_id" || error.code === "previous_response_not_found");
}
/** Only valid completed context is saved here; opaque compaction items are never inspected. */
export function replayContext(items: unknown[]) {
  const last = items.findLastIndex(item => !!item && typeof item === "object" && (item as { type?: string }).type === "compaction");
  return toResponseInputItems((last < 0 ? items : items.slice(last)) as ResponseInputItemLike[]);
}
export function responseParameters(row: Message, text: string, usePrevious = true): ResponseCreateParamsStreaming & { max_tool_calls: number } {
  const input = { role: "user" as const, content: text };
  return { model: row.model!, reasoning: { effort: row.effort as NonNullable<ResponseCreateParamsStreaming["reasoning"]>["effort"] },
    instructions: "you are a helpful assistant", tools: [{ type: "web_search" }], tool_choice: "auto",
    background: true, stream: true, store: true, include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
    context_management: [{ type: "compaction", compact_threshold: 100_000 }], max_output_tokens: 16_384,
    // Documented API field omitted by SDK 7.27's HTTP parameter type; sent unchanged on the wire.
    max_tool_calls: 5,
    metadata: { generation_id: row.generationId! },
    ...(usePrevious && row.responseIdBefore ? { previous_response_id: row.responseIdBefore, input: [input] } : { input: [...replayContext(row.contextBefore ?? []), input] }) };
}
async function current(tx: Parameters<Parameters<Database["transaction"]>[0]>[0], generationId: string) {
  const [candidate] = await tx.select({ ownerId: conversations.ownerId, conversationId: conversations.id }).from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id)).where(eq(messages.generationId, generationId));
  if (!candidate) return null;
  let conversation;
  try { conversation = await lockConversation(tx, candidate.ownerId, candidate.conversationId); } catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
  const [row] = await tx.select().from(messages).where(eq(messages.generationId, generationId));
  return row && conversation.currentGenerationId === generationId && conversation.generationVersion === row.generationVersion && active(row.status) ? row : null;
}
export async function failGeneration(generationId: string, code: string, db: Database = getDb()) {
  await db.transaction(async tx => {
    const row = await current(tx, generationId);
    if (row) {
      await tx.update(messages).set({ status: "failed", error: code, updatedAt: new Date() }).where(eq(messages.id, row.id));
      await addEvent(tx, row, "error", { status: "failed", code });
    }
    await releasePaid(generationId, tx);
  });
}
async function saveProviderId(generationId: string, responseId: string, db: Database) {
  // Save even after local deletion/cancel; the independent job can clean up the remote response.
  await db.update(generationJobs).set({ providerResponseId: responseId, state: "monitoring", updatedAt: new Date() }).where(eq(generationJobs.id, generationId));
  await db.transaction(async tx => {
    const row = await current(tx, generationId);
    if (row) await tx.update(messages).set({ providerResponseId: responseId, status: "running", updatedAt: new Date() }).where(eq(messages.id, row.id));
    else await tx.update(generationJobs).set({ cleanup: true }).where(eq(generationJobs.id, generationId));
  });
}
export async function saveEvent(generationId: string, event: ResponseStreamEvent, db: Database = getDb()) {
  if (event.type === "response.created") await saveProviderId(generationId, event.response.id, db);
  await db.transaction(async tx => {
    const row = await current(tx, generationId);
    if (!row || event.sequence_number <= row.streamCursor) return;
    let text = row.text;
    let citations = Array.isArray(row.citations) ? row.citations : [];
    if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
      text += event.delta;
      await addEvent(tx, row, "text_delta", { delta: event.delta, outputIndex: event.output_index, contentIndex: event.content_index });
    } else if (event.type === "response.output_text.annotation.added" && event.annotation?.type === "url_citation") {
      citations = [...citations, event.annotation];
      const safe = publicMessage({ ...row, citations }).citations;
      await addEvent(tx, row, "citations", { citations: safe });
    } else if (event.type === "response.created" || event.type === "response.in_progress" || event.type === "response.queued") {
      await addEvent(tx, row, "status", { status: "running" });
    }
    // Cursor advances on every provider event, including opaque output items; no raw event leaks to clients.
    await tx.update(messages).set({ text, citations, streamCursor: event.sequence_number, updatedAt: new Date() }).where(eq(messages.id, row.id));
  });
  if (event.type === "response.completed" || event.type === "response.failed" || event.type === "response.incomplete") await saveResponse(generationId, event.response, db);
  if (event.type === "error") await failGeneration(generationId, "provider_error", db);
}
export async function saveResponse(generationId: string, response: ModelResponse, db: Database = getDb()) {
  if (!terminal(response.status)) return;
  await db.transaction(async tx => {
    const row = await current(tx, generationId);
    if (row) {
      const output = response.output;
      const content = output.flatMap(item => item.type === "message" ? item.content : []);
      const text = content.map(part => part.type === "output_text" ? part.text : part.type === "refusal" ? part.refusal : "").join("");
      const citations = content.flatMap(part => part.type === "output_text" ? part.annotations.filter(annotation => annotation.type === "url_citation") : []);
      const status = response.status === "completed" ? "completed" : response.status === "cancelled" ? "cancelled" : "failed";
      const error = status === "completed" ? null : response.status === "incomplete" ? "incomplete_response" : status === "cancelled" ? "cancelled" : "provider_failed";
      const [updated] = await tx.update(messages).set({ text, citations, status, error, providerResponseId: response.id,
        providerOutput: output, usage: response.usage, updatedAt: new Date() }).where(eq(messages.id, row.id)).returning();
      if (status === "completed") {
        const [userMessage] = await tx.select().from(messages).where(and(eq(messages.conversationId, row.conversationId), eq(messages.turn, row.turn), eq(messages.role, "user")));
        const context = replayContext([...(row.contextBefore ?? []), { role: "user", content: userMessage.text }, ...output]);
        await tx.update(conversations).set({ providerResponseId: response.id, context, updatedAt: new Date() }).where(eq(conversations.id, row.conversationId));
      }
      await addEvent(tx, row, status === "completed" ? "completed" : "error", { status, ...(error ? { code: error } : {}), message: publicMessage(updated) });
      await releasePaid(generationId, tx);
    }
    await tx.update(generationJobs).set({ state: "done", leaseUntil: null, updatedAt: new Date() }).where(eq(generationJobs.id, generationId));
  });
}
async function cleanRemote(job: Job, client: OpenAI, db: Database) {
  if (job.providerResponseId) {
    try { await client.responses.cancel(job.providerResponseId); }
    catch (error) { if (![400, 404].includes(statusCode(error) ?? 0)) throw error; }
    try { await client.responses.delete(job.providerResponseId); }
    catch (error) { if (statusCode(error) !== 404) throw error; }
  }
  await db.delete(generationJobs).where(eq(generationJobs.id, job.id));
  await releasePaid(job.id, db);
}
async function processJob(job: Job, client: OpenAI, db: Database) {
  try {
    if (job.state === "creating" && !job.providerResponseId) {
      // An expired create lease has no safe provider reference. Never pay for a blind duplicate.
      await failGeneration(job.id, "ambiguous_creation", db);
      await db.update(generationJobs).set({ state: "ambiguous", leaseUntil: null }).where(eq(generationJobs.id, job.id));
      return;
    }
    if (job.cleanup) { await cleanRemote(job, client, db); return; }
    const [row] = await db.select().from(messages).where(eq(messages.generationId, job.id));
    if (!row || !active(row.status)) {
      await db.update(generationJobs).set({ cleanup: true, leaseUntil: null }).where(eq(generationJobs.id, job.id));
      return;
    }
    await db.update(paidRequests).set({ activeUntil: sql`now() + interval '30 minutes'` }).where(eq(paidRequests.id, job.id));
    if (!job.providerResponseId) {
      const [userMessage] = await db.select().from(messages).where(and(eq(messages.conversationId, row.conversationId), eq(messages.turn, row.turn), eq(messages.role, "user")));
      let stream;
      try { stream = await client.responses.create(responseParameters(row, userMessage.text)); }
      catch (error) {
        if (!row.responseIdBefore || !expiredReference(error)) throw error;
        stream = await client.responses.create(responseParameters(row, userMessage.text, false));
      }
      let created = false;
      for await (const event of stream) {
        await saveEvent(job.id, event, db);
        if (event.type === "response.created") { created = true; break; }
      }
      // Breaking the SDK iterator closes this HTTP stream only; native background inference continues.
      if (!created) throw new Error("Missing provider response ID");
    } else {
      const response = await client.responses.retrieve(job.providerResponseId, { include: ["reasoning.encrypted_content", "web_search_call.action.sources"] });
      if (terminal(response.status)) await saveResponse(job.id, response, db);
      else {
        const stream = await client.responses.retrieve(job.providerResponseId, { stream: true, starting_after: row.streamCursor,
          include: ["reasoning.encrypted_content", "web_search_call.action.sources"] }, { signal: AbortSignal.timeout(10_000) });
        for await (const event of stream) await saveEvent(job.id, event, db);
      }
    }
  } catch (error) {
    const [saved] = await db.select().from(generationJobs).where(eq(generationJobs.id, job.id));
    if (!saved) return;
    if (!saved.providerResponseId && !saved.cleanup) {
      const definitive = error instanceof OpenAI.APIError && !!error.status && error.status >= 400 && error.status < 500 && error.status !== 408;
      await failGeneration(job.id, definitive ? "provider_rejected" : "ambiguous_creation", db);
      await db.update(generationJobs).set({ state: definitive ? "done" : "ambiguous" }).where(eq(generationJobs.id, job.id));
    } else if (!saved.cleanup && statusCode(error) === 404) {
      await failGeneration(job.id, "provider_response_unavailable", db);
      await db.update(generationJobs).set({ state: "done" }).where(eq(generationJobs.id, job.id));
    }
    // Network/timeouts with a saved ID keep monitoring the same native background response.
  } finally {
    await db.update(generationJobs).set({ leaseUntil: null }).where(eq(generationJobs.id, job.id));
  }
}
/** One bounded pass, also used by controlled transport + real-PostgreSQL checks. */
export async function reconcile(client: OpenAI = getOpenAI(), db: Database = getDb()) {
  const jobs = await db.transaction(async tx => {
    const rows = await tx.select().from(generationJobs).where(and(or(inArray(generationJobs.state, ["pending", "creating", "monitoring"]), eq(generationJobs.cleanup, true)),
      or(isNull(generationJobs.leaseUntil), lt(generationJobs.leaseUntil, sql`now()`)))).orderBy(asc(generationJobs.createdAt)).limit(10).for("update", { skipLocked: true });
    for (const row of rows) {
      await tx.update(generationJobs).set({ state: row.state === "pending" ? "creating" : row.state, leaseUntil: sql`now() + interval '90 seconds'`, updatedAt: new Date() }).where(eq(generationJobs.id, row.id));
    }
    return rows;
  });
  const results = await Promise.allSettled(jobs.map(job => processJob(job, client, db)));
  for (const result of results) if (result.status === "rejected") console.error("Generation reconciliation failed", result.reason instanceof Error ? result.reason.name : "UnknownError");
  return jobs.length;
}
