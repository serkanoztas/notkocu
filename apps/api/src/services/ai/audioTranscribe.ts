import { Type, type Schema } from "@google/genai";
import { z } from "zod";
import { parseClock } from "@notkocu/shared";
import { OcrError, toAiError } from "./errors";
import { generateContent, geminiTask } from "./gemini";

// Lecture recordings: each ~10 min piece goes to Gemini as audio (inline: pieces are far below the
// request size limit, so the Files API is not needed), then chapters + summary come from the transcript
// TEXT alone (the audio is never sent twice). Same model / schema / log-privacy rules as the other
// services: log only the HTTP status, never audio, text or the key.

export interface Segment {
  /** Seconds from the start of the piece (local time). */
  startSec: number;
  text: string;
}

export interface Chapter {
  /** Global seconds. */
  startSec: number;
  title: string;
}

const MAX_TRANSCRIPT_CHARS = 300_000;

const TRANSCRIBE_PROMPT = `Sen bir üniversite dersinin ses kaydını yazıya döken bir asistansın. Konuşma Türkçe, arada İngilizce terimler olabilir.

Kurallar:
- Duyduğun konuşmayı sırayla, yaklaşık 15-30 saniyelik doğal parçalara bölerek "segments" dizisine yaz.
- Her parça için "start": parçanın bu ses dosyasının başına göre başlangıcı, "MM:SS" biçiminde; "text": o kısımda söylenenler.
- Yalnızca gerçekten duyduğunu yaz; tamamlama, uydurma, düzeltme yapma. Anlaşılmayan yeri [anlaşılmadı] diye işaretle.
- Sessizlik, gürültü ve öksürük gibi sesleri yazma. Hiç konuşma yoksa "segments" boş dizi olsun.`;

const segmentsSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { start: { type: Type.STRING }, text: { type: Type.STRING } },
        required: ["start", "text"],
      },
    },
  },
  required: ["segments"],
};

const segmentsZ = z.object({ segments: z.array(z.object({ start: z.string(), text: z.string() })) });

/** One piece of audio -> timed text, times local to the piece, clamped to its length and sorted. */
export async function transcribeChunk(data: Buffer, mimeType: string, durationSec: number): Promise<Segment[]> {
  let raw: string | undefined;
  try {
    const { model, thinkingConfig } = geminiTask("audio");
    const res = await generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType, data: data.toString("base64") } },
            { text: `Bu ses dosyası yaklaşık ${Math.round(durationSec)} saniye. Konuşmayı yazıya dök.` },
          ],
        },
      ],
      config: {
        systemInstruction: TRANSCRIBE_PROMPT,
        responseMimeType: "application/json",
        responseSchema: segmentsSchema,
        temperature: 0,
        thinkingConfig,
      },
    });
    raw = res.text;
  } catch (err) {
    throw toAiError(err, "audio transcript");
  }
  try {
    const parsed = segmentsZ.parse(JSON.parse(raw ?? ""));
    const out: Segment[] = [];
    for (const s of parsed.segments) {
      const text = s.text.trim();
      const at = parseClock(s.start);
      if (!text || at === null) continue;
      out.push({ startSec: Math.min(at, Math.max(0, durationSec)), text });
    }
    return out.sort((a, b) => a.startSec - b.startSec);
  } catch {
    throw new OcrError("AI_BAD_OUTPUT");
  }
}

const CHAPTERS_PROMPT = `Sen bir üniversite dersinin transkriptini inceleyen bir asistansın. Transkript satırları "[MM:SS] metin" biçimindedir (Türkçe, arada İngilizce terimler).

Kurallar:
- "chapters": dersin konu akışına göre 3-12 bölüm; her biri için "start" ("MM:SS" ya da "H:MM:SS", transkriptteki bir zamanla uyumlu) ve en fazla 60 karakterlik kısa bir Türkçe "title". İlk bölüm kaydın başında başlasın.
- "summary": dersin ana konularını ve varsa duyuruları (sınav, ödev, tarih) 3-4 cümlelik Türkçe bir özetle anlat.
- Yalnızca transkriptte olanı kullan, uydurma.`;

const chaptersSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    chapters: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { start: { type: Type.STRING }, title: { type: Type.STRING } },
        required: ["start", "title"],
      },
    },
    summary: { type: Type.STRING },
  },
  required: ["chapters", "summary"],
};

const chaptersZ = z.object({
  chapters: z.array(z.object({ start: z.string(), title: z.string() })),
  summary: z.string(),
});

export const clock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/** Transcript text with global time stamps, capped; what the chapter/summary call reads. */
export function transcriptForModel(transcript: { startSec: number; text: string }[]): string {
  return transcript
    .map((t) => `[${clock(t.startSec)}] ${t.text}`)
    .join("\n")
    .slice(0, MAX_TRANSCRIPT_CHARS);
}

/** Chapters (global seconds, sorted, inside the recording) and a short summary, from the transcript text only. */
export async function chaptersAndSummary(
  transcript: { startSec: number; text: string }[],
  durationSec: number,
): Promise<{ chapters: Chapter[]; summary: string }> {
  let raw: string | undefined;
  try {
    const { model, thinkingConfig } = geminiTask("audio");
    const res = await generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: transcriptForModel(transcript) }] }],
      config: {
        systemInstruction: CHAPTERS_PROMPT,
        responseMimeType: "application/json",
        responseSchema: chaptersSchema,
        temperature: 0,
        thinkingConfig,
      },
    });
    raw = res.text;
  } catch (err) {
    throw toAiError(err, "audio chapters");
  }
  try {
    const parsed = chaptersZ.parse(JSON.parse(raw ?? ""));
    const summary = parsed.summary.trim();
    if (!summary) throw new Error("empty");
    const chapters: Chapter[] = [];
    for (const c of parsed.chapters) {
      const at = parseClock(c.start);
      const title = c.title.trim().slice(0, 80);
      if (at === null || !title || at > durationSec + 1) continue;
      chapters.push({ startSec: at, title });
    }
    chapters.sort((a, b) => a.startSec - b.startSec);
    // One chapter per start time, at most 12.
    const unique = chapters.filter((c, i) => i === 0 || c.startSec !== chapters[i - 1]!.startSec).slice(0, 12);
    return { chapters: unique, summary };
  } catch {
    throw new OcrError("AI_BAD_OUTPUT");
  }
}
