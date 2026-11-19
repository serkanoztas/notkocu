import { Type, type Schema } from "@google/genai";
import { z } from "zod";
import { OcrError, toAiError } from "./errors";
import { generateContent, geminiTask } from "./gemini";

// Weekly summary: the model only sees short per-note summaries (and the start of the text for notes
// without one), never audio or whole documents. Log only the HTTP status, never the text.

export const MAX_INPUT_CHARS = 40_000;
const MAX_TEXT_CHARS = 1500;

const SYSTEM_PROMPT = `Sen bir üniversite öğrencisinin haftalık ders notlarını özetleyen bir asistansın. Sana bir dersin bir haftasındaki notların kısa özetleri verilir (Türkçe ya da İngilizce).

Kurallar:
- "summary": haftanın ana konularını, varsa duyuruları (sınav, ödev, tarih) 3-5 cümlelik akıcı bir Türkçe özetle anlat.
- Yalnızca verilen notlarda olanı kullan, uydurma. Not başlıklarını sıralama; konuyu anlat.`;

const responseSchema: Schema = {
  type: Type.OBJECT,
  properties: { summary: { type: Type.STRING } },
  required: ["summary"],
};

const resultZ = z.object({ summary: z.string() });

export interface WeekNoteInput {
  id: string;
  type: string;
  title: string;
  aiSummary?: string | null;
  extractedText?: string | null;
}

/**
 * Prompt text and the notes that made it in (the sources are decided here, not by the model).
 * Audio always contributes its own summary, never the raw transcript.
 */
export function buildWeekInput(notes: WeekNoteInput[]): { text: string; noteIds: string[] } {
  const parts: string[] = [];
  const noteIds: string[] = [];
  let size = 0;
  for (const n of notes) {
    const body = (n.aiSummary?.trim() || (n.type === "audio" ? "" : (n.extractedText ?? "").trim().slice(0, MAX_TEXT_CHARS))).trim();
    if (!body) continue;
    const part = `### ${n.type}: ${n.title}\n${body}`;
    if (size + part.length > MAX_INPUT_CHARS) break;
    parts.push(part);
    noteIds.push(n.id);
    size += part.length;
  }
  return { text: parts.join("\n\n"), noteIds };
}

export async function summarizeWeek(text: string): Promise<string> {
  let raw: string | undefined;
  try {
    const { model, thinkingConfig } = geminiTask();
    const res = await generateContent({
      model,
      contents: [{ role: "user", parts: [{ text }] }],
      config: { systemInstruction: SYSTEM_PROMPT, responseMimeType: "application/json", responseSchema, temperature: 0, thinkingConfig },
    });
    raw = res.text;
  } catch (err) {
    throw toAiError(err, "week summary");
  }
  try {
    const summary = resultZ.parse(JSON.parse(raw ?? "")).summary.trim();
    if (!summary) throw new Error("empty");
    return summary;
  } catch {
    throw new OcrError("AI_BAD_OUTPUT");
  }
}
