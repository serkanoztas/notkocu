import { Type, type Schema } from "@google/genai";
import { z } from "zod";
import { OcrError, toAiError } from "./errors";
import { geminiTask, getGemini } from "./gemini";

// "Which of the student's courses does this inbox note belong to?" Only the course is asked: the week
// is computed from the note's own date, never by the model. Never log the note text or the response.

const MAX_TEXT_CHARS = 2000;
const NONE = "none";

export interface CourseOption {
  id: string;
  code: string;
  name: string;
  instructor?: string;
}

const SYSTEM_PROMPT = `Sen bir üniversite öğrencisinin notlarını derslerine ayıran bir asistansın. Sana öğrencinin bu dönemki ders listesi ve bir notun başlığı ile metninin ilk kısmı verilir.

Kurallar:
- "courseId": notun ait olduğu dersin id'si. Hiçbir derse net olarak uymuyorsa "none" yaz.
- "confidence": 0 ile 1 arası. Ders adı, ders kodu, hoca adı ya da konu açıkça eşleşiyorsa 0.8 ve üstü; tahmin ise 0.5'in altı.
- Yalnızca verilen id'lerden birini ya da "none" yaz. Tahmin yürütme, emin değilsen "none" ve düşük confidence ver.`;

const buildSchema = (ids: string[]): Schema => ({
  type: Type.OBJECT,
  properties: {
    courseId: { type: Type.STRING, enum: [...ids, NONE] },
    confidence: { type: Type.NUMBER },
  },
  required: ["courseId", "confidence"],
});

const resultZ = z.object({
  courseId: z.string(),
  confidence: z.number().transform((n) => Math.min(1, Math.max(0, n))),
});

export interface CourseGuess {
  courseId: string | null;
  confidence: number;
}

export async function suggestCourse(input: { title: string; text: string; courses: CourseOption[] }): Promise<CourseGuess> {
  if (input.courses.length === 0) return { courseId: null, confidence: 0 };

  const list = input.courses
    .map((c) => `- id: ${c.id} | kod: ${c.code || "-"} | ad: ${c.name || "-"} | hoca: ${c.instructor || "-"}`)
    .join("\n");
  const prompt = `Dersler:\n${list}\n\nNot başlığı: ${input.title || "-"}\nNot metni:\n${input.text.slice(0, MAX_TEXT_CHARS)}`;

  let raw: string | undefined;
  try {
    const { model, thinkingConfig } = geminiTask();
    const res = await getGemini().models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: buildSchema(input.courses.map((c) => c.id)),
        temperature: 0,
        thinkingConfig,
      },
    });
    raw = res.text;
  } catch (err) {
    throw toAiError(err, "course suggestion");
  }

  let parsed: z.infer<typeof resultZ>;
  try {
    parsed = resultZ.parse(JSON.parse(raw ?? ""));
  } catch {
    throw new OcrError("AI_BAD_OUTPUT");
  }
  // The model must pick one of our ids; anything else counts as "no suggestion".
  const known = input.courses.some((c) => c.id === parsed.courseId);
  return known ? { courseId: parsed.courseId, confidence: parsed.confidence } : { courseId: null, confidence: 0 };
}
