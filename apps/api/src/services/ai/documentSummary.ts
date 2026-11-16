import { ThinkingLevel, Type, type Schema } from "@google/genai";
import { z } from "zod";
import { OcrError, toAiError } from "./errors";
import { geminiModel, geminiThinkingLevel, getGemini } from "./gemini";

// Text-only summary for documents (cheap): the model never sees the file, only extracted text.

const MAX_INPUT_CHARS = 30_000;

const SYSTEM_PROMPT = `Sen bir üniversite öğrencisinin ders belgelerini özetleyen bir asistansın. Sana bir belgenin çıkarılmış metni verilir (Türkçe ya da İngilizce).

Kurallar:
- "summary": belgenin ne hakkında olduğunu ve ana konularını 2-3 cümlelik Türkçe bir özetle anlat.
- Yalnızca metinde olanı kullan, uydurma.`;

const responseSchema: Schema = {
  type: Type.OBJECT,
  properties: { summary: { type: Type.STRING } },
  required: ["summary"],
};

const resultZ = z.object({ summary: z.string() });

export async function summarizeDocumentText(text: string): Promise<string> {
  let raw: string | undefined;
  try {
    const res = await getGemini().models.generateContent({
      model: geminiModel(),
      contents: [{ role: "user", parts: [{ text: text.slice(0, MAX_INPUT_CHARS) }] }],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema,
        temperature: 0,
        thinkingConfig: { thinkingLevel: ThinkingLevel[geminiThinkingLevel()] },
      },
    });
    raw = res.text;
  } catch (err) {
    throw toAiError(err, "document summary");
  }
  try {
    const summary = resultZ.parse(JSON.parse(raw ?? "")).summary.trim();
    if (!summary) throw new Error("empty");
    return summary;
  } catch {
    throw new OcrError("AI_BAD_OUTPUT");
  }
}
