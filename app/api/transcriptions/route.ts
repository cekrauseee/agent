import { requireOwner } from "@/lib/auth";
import { api, ApiError, json } from "@/lib/server/http";
import { getOpenAI, withPaidRequest } from "@/lib/server/openai";
import { readAudio, transcribe } from "@/lib/transcription";

export const runtime = "nodejs";

export function POST(request: Request) {
  return api(async () => {
    const ownerId = await requireOwner(request);
    const file = await readAudio(request);
    let client;
    try { client = getOpenAI(); }
    catch { throw new ApiError(503, "Transcription service unavailable"); }
    return json(await withPaidRequest(ownerId, "transcription", () => transcribe(file, client, request.signal)));
  });
}
