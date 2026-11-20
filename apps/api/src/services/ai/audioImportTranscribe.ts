import { Type, type Schema } from "@google/genai";
import { z } from "zod";
import { parseClock } from "@notkocu/shared";
import { clock, type Segment } from "./audioTranscribe";
import { OcrError, toAiError } from "./errors";
import { generateContent, geminiMaxOutputTokens, geminiTask } from "./gemini";

// Imported files: one (long) file, uploaded once to the Files API, transcribed in ONE request. Gemini audio
// cannot be clipped (videoMetadata offsets are rejected for audio) and asking for a time range would bill the
// whole file again on every request, so a long answer that hits the output limit (finishReason MAX_TOKENS) is
// continued from the last time stamp it reached instead of re-reading the audio for fixed windows.
// Never log audio, text or the key.

/** Safety net: continuations per recording (a 2 h lecture normally needs a handful). */
export const IMPORT_MAX_CONTINUATIONS = 40;

/** Saved in job.progress after every request, so a retry continues where the last request stopped. */
export interface ImportedProgress {
  /** Seconds from the start of the file (an imported file is one piece, so this is global time). */
  segments: Segment[];
  /** Start of the last segment received: the next request continues after it. */
  doneUntilSec: number;
  complete: boolean;
}

const IMPORT_PROMPT = `Sen bir üniversite dersinin ses kaydını yazıya döken bir asistansın. Konuşma Türkçe, arada İngilizce terimler olabilir.

Kurallar:
- Duyduğun konuşmayı sırayla, yaklaşık 15-30 saniyelik doğal parçalara bölerek "segments" dizisine yaz.
- Her parça için "start": parçanın bu ses dosyasının BAŞINA göre başlangıcı; bir saatin altında "MM:SS", bir saati geçince "H:MM:SS"; "text": o kısımda söylenenler.
- Yalnızca gerçekten duyduğunu yaz; tamamlama, uydurma, düzeltme yapma. Anlaşılmayan yeri [anlaşılmadı] diye işaretle.
- Sessizlik, gürültü ve öksürük gibi sesleri yazma. Hiç konuşma yoksa "segments" boş dizi olsun.
- Devam istenirse: belirtilen zamandan SONRAKİ konuşmadan başla, önceki parçaları tekrar yazma; zamanlar yine dosyanın başına göre olsun.`;

const importSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { start: { type: Type.STRING }, text: { type: Type.STRING } },
        required: ["start", "text"],
        propertyOrdering: ["start", "text"],
      },
    },
  },
  required: ["segments"],
};

const segmentsZ = z.object({ segments: z.array(z.object({ start: z.string(), text: z.string() })) });

const SEGMENT_OBJECT = /\{\s*"start"\s*:\s*"([^"\\]*)"\s*,\s*"text"\s*:\s*("(?:[^"\\]|\\.)*")\s*\}/g;

/** The complete segment objects of a JSON answer that was cut off in the middle (the unfinished last one is dropped). */
export function salvageSegments(raw: string): { start: string; text: string }[] {
  const out: { start: string; text: string }[] = [];
  for (const m of raw.matchAll(SEGMENT_OBJECT)) {
    try {
      out.push({ start: m[1]!, text: JSON.parse(m[2]!) as string });
    } catch {
      // a broken escape: skip this one object
    }
  }
  return out;
}

/** Whole answer when it parses, else (cut off) the complete objects before the cut. */
function readSegments(raw: string, truncated: boolean, durationSec: number): Segment[] {
  let items: { start: string; text: string }[];
  try {
    items = segmentsZ.parse(JSON.parse(raw)).segments;
  } catch {
    if (!truncated) throw new OcrError("AI_BAD_OUTPUT");
    items = salvageSegments(raw);
  }
  const out: Segment[] = [];
  for (const s of items) {
    const text = s.text.trim();
    const at = parseClock(s.start);
    if (!text || at === null) continue;
    out.push({ startSec: Math.min(at, Math.max(0, durationSec)), text });
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

export async function transcribeImported(opts: {
  file: { uri: string; mimeType: string };
  durationSec: number;
  resume?: ImportedProgress;
  /** Called before every request (the worker extends its lease). */
  beforeRequest: () => Promise<void>;
  /** Called after every request with everything so far (the worker stores it as progress). */
  onProgress: (progress: ImportedProgress) => Promise<void>;
}): Promise<Segment[]> {
  const { file, durationSec } = opts;
  if (opts.resume?.complete) return opts.resume.segments;
  let segments = opts.resume?.segments ?? [];
  let after = opts.resume ? opts.resume.doneUntilSec : -1; // -1: nothing transcribed yet
  // The model's own maximum, so most recordings finish in ONE request (every continuation bills the audio again).
  const maxOutputTokens = await geminiMaxOutputTokens("audio");

  for (let i = 0; i < IMPORT_MAX_CONTINUATIONS; i++) {
    await opts.beforeRequest();
    const total = `Bu ses dosyası yaklaşık ${Math.round(durationSec)} saniye (${clock(durationSec)}).`;
    const text =
      after < 0
        ? `${total} Konuşmayı baştan sona yazıya dök.`
        : `${total} Daha önce ${clock(after)} noktasına kadar olan kısmı yazdın. Şimdi ${clock(after)} noktasından SONRASINDAKİ konuşmadan başlayarak devam et.`;
    let raw: string | undefined;
    let truncated = false;
    try {
      const { model, thinkingConfig } = geminiTask("audio");
      const res = await generateContent({
        model,
        contents: [{ role: "user", parts: [{ fileData: { fileUri: file.uri, mimeType: file.mimeType } }, { text }] }],
        config: {
          systemInstruction: IMPORT_PROMPT,
          responseMimeType: "application/json",
          responseSchema: importSchema,
          maxOutputTokens,
          temperature: 0,
          thinkingConfig,
        },
      });
      raw = res.text;
      truncated = res.candidates?.[0]?.finishReason === "MAX_TOKENS";
    } catch (err) {
      throw toAiError(err, "audio transcript");
    }

    const received = readSegments(raw ?? "", truncated, durationSec);
    const fresh = after < 0 ? received : received.filter((s) => s.startSec > after);
    if (fresh.length === 0 && truncated) throw new OcrError("AI_BAD_OUTPUT"); // cut off without moving forward
    segments = [...segments, ...fresh];
    if (fresh.length > 0) after = fresh[fresh.length - 1]!.startSec;
    else if (after < 0) after = 0;
    await opts.onProgress({ segments, doneUntilSec: after, complete: !truncated });
    if (!truncated) return segments;
  }
  throw new OcrError("AI_BAD_OUTPUT");
}
