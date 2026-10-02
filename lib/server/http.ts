import "server-only";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function api(operation: () => Promise<Response>): Promise<Response> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    console.error("API request failed", error instanceof Error ? error.name : "UnknownError");
    return json({ error: "Internal server error" }, 500);
  }
}

/** Limit the actual bytes read; Content-Length alone is client controlled. */
export async function readJson(request: Request, limit = 4096): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new ApiError(415, "Use application/json");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "Provide a JSON body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ApiError(413, "Request body too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ApiError(400, "Invalid JSON"); }
}
