import "server-only";
import OpenAI from "openai";
import { ApiError } from "./server/http";

// Includes multipart overhead; stays below common 4.5 MB deployment limits and OpenAI's 25 MB cap.
export const AUDIO_BODY_LIMIT = 4_000_000;

export async function readAudio(request: Request): Promise<File> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new ApiError(415, "Use multipart/form-data");
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > AUDIO_BODY_LIMIT)) throw new ApiError(413, "Audio upload too large");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "Provide an audio file");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 30_000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new ApiError(408, "Audio upload timed out");
      if (done) break;
      size += value.byteLength;
      if (size > AUDIO_BODY_LIMIT) { await reader.cancel(); throw new ApiError(413, "Audio upload too large"); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "Invalid audio upload");
  } finally { clearTimeout(timer); reader.releaseLock(); }
  let form: FormData;
  try { form = await new Response(Buffer.concat(chunks), { headers: { "content-type": contentType } }).formData(); }
  catch { throw new ApiError(400, "Invalid multipart upload"); }
  const entries = [...form.entries()];
  const file = form.get("file");
  if (entries.length !== 1 || entries[0][0] !== "file" || !(file instanceof File) || file.size < 12) throw new ApiError(400, "Provide one nonempty audio file named file");
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  if (!extension || !["mp3", "mp4", "mpeg", "mpga", "m4a", "wav", "webm"].includes(extension)) throw new ApiError(415, "Unsupported audio format");
  if (file.type && !["audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/wave", "audio/x-wav", "audio/webm", "video/mp4", "video/mpeg", "video/webm", "application/octet-stream"].includes(file.type)) throw new ApiError(415, "Unsupported audio content type");
  const header = Buffer.from(await file.slice(0, 12).arrayBuffer());
  // Reject obvious non-audio before paid work; the provider validates container contents and decodes audio.
  const recognized = extension === "wav" ? header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WAVE"
    : extension === "webm" ? header.readUInt32BE(0) === 0x1a45dfa3
    : ["mp4", "m4a"].includes(extension) ? header.toString("ascii", 4, 8) === "ftyp"
    : header.toString("ascii", 0, 3) === "ID3" || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0) || (extension === "mpeg" && header.readUInt32BE(0) === 0x000001ba);
  if (!recognized) throw new ApiError(400, "Invalid audio file");
  return file;
}

export async function transcribe(file: File, client: OpenAI, signal?: AbortSignal) {
  try {
    const result = await client.audio.transcriptions.create({ file, model: "gpt-transcribe", prompt: "Transcribe the speech in its original language.", response_format: "json" }, { timeout: 60_000, maxRetries: 0, signal });
    if (typeof result.text !== "string") throw new ApiError(502, "Invalid transcription response");
    return { text: result.text };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof OpenAI.APIConnectionTimeoutError) throw new ApiError(504, "Transcription timed out");
    if (error instanceof OpenAI.APIError && [400, 413, 422].includes(error.status ?? 0)) throw new ApiError(400, "Audio could not be transcribed");
    if (error instanceof OpenAI.APIError && [401, 403, 404, 429].includes(error.status ?? 0)) throw new ApiError(503, "Transcription service unavailable");
    throw new ApiError(502, "Transcription service failed");
  }
}
