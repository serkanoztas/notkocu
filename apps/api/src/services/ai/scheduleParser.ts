import { Type, type Schema } from "@google/genai";
import { z } from "zod";
import {
  DAY_CODES,
  dayCodeToIndex,
  parseHHmm,
  type ParseScheduleResponse,
  type ScheduleCourseDraft,
  type ScheduleSessionDraft,
  type ScheduleTimeSlot,
} from "@notkocu/shared";
import { AppError } from "../../utils/AppError";
import { geminiModel, getGemini } from "./gemini";

const KINDS = ["teori", "lab", "uygulama"] as const;

const SYSTEM_PROMPT = `Sen bir üniversite ders programı okuyucusun. Verilen ekran görüntüsü ya da fotoğraf bir haftalık ders programıdır (Türkçe, genelde OBS çıktısı). Görseldeki dersleri JSON olarak çıkar.

Kurallar:
- Bitişik saat hücrelerindeki aynı ders tek oturumdur: tek bir "start" ve "end" ver (ör. 09:00-09:50 ve 10:00-10:50 hücreleri tek oturum 09:00-10:50 olur).
- Aynı ders kodunun teori ve lab/uygulama oturumları tek dersin "sessions" listesinde toplanır; her oturumun "kind" alanı teori, lab ya da uygulama olur.
- Okunamayan ya da emin olmadığın alanı boş string ("") bırak, tahmin etme; bu durumda dersin "confidence" değerini düşür (0.8'in altı).
- Sadece ders kodu görünüyorsa "name" boş string olur.
- Saatleri 24 saatlik "HH:mm" biçiminde yaz. Günler: MON, TUE, WED, THU, FRI, SAT, SUN.
- Bir oturumun saati iki farklı şekilde okunabiliyorsa en olası olanı "start"/"end" yap, diğerini "alternatives" listesine koy. Aksi halde "alternatives" boş liste olsun.
- Programda olmayan ders uydurma. Görselde ders program tablosu yoksa "courses" boş liste olsun.
- "confidence" 0 ile 1 arasındadır: her şey net okunuyorsa 0.9 ve üstü, bir alan belirsizse 0.8'in altı.`;

const slotSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    day: { type: Type.STRING, enum: [...DAY_CODES] },
    start: { type: Type.STRING },
    end: { type: Type.STRING },
  },
  required: ["day", "start", "end"],
};

const responseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    courses: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          code: { type: Type.STRING },
          name: { type: Type.STRING },
          instructor: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
          sessions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                ...slotSchema.properties,
                room: { type: Type.STRING },
                kind: { type: Type.STRING, enum: [...KINDS] },
                alternatives: { type: Type.ARRAY, items: slotSchema },
              },
              required: ["day", "start", "end", "room", "kind", "alternatives"],
            },
          },
        },
        required: ["code", "name", "instructor", "confidence", "sessions"],
      },
    },
  },
  required: ["courses"],
};

const slotZ = z.object({ day: z.string(), start: z.string(), end: z.string() });
const rawZ = z.object({
  courses: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      instructor: z.string().optional().default(""),
      confidence: z.number(),
      sessions: z.array(
        slotZ.extend({
          room: z.string().optional().default(""),
          kind: z.enum(KINDS).catch("teori"),
          alternatives: z.array(slotZ).optional().default([]),
        }),
      ),
    }),
  ),
});

/** Returns a normalized slot or null when day/time can't be used. */
function toSlot(raw: z.infer<typeof slotZ>): ScheduleTimeSlot | null {
  try {
    const day = dayCodeToIndex(raw.day);
    const start = parseHHmm(raw.start);
    const end = parseHHmm(raw.end);
    if (end <= start) return null;
    const pad = (n: number) => String(n).padStart(2, "0");
    return {
      day,
      start: `${pad(Math.floor(start / 60))}:${pad(start % 60)}`,
      end: `${pad(Math.floor(end / 60))}:${pad(end % 60)}`,
    };
  } catch {
    return null;
  }
}

function normalize(raw: z.infer<typeof rawZ>): ParseScheduleResponse {
  const courses: ScheduleCourseDraft[] = [];
  for (const c of raw.courses) {
    let confidence = Math.min(1, Math.max(0, c.confidence));
    const sessions: ScheduleSessionDraft[] = [];
    for (const s of c.sessions) {
      const slot = toSlot(s);
      if (!slot) {
        confidence = Math.min(confidence, 0.5); // unreadable session dropped: needs review
        continue;
      }
      const alternatives = s.alternatives
        .map(toSlot)
        .filter((a): a is ScheduleTimeSlot => a !== null);
      sessions.push({
        ...slot,
        room: s.room.trim() || undefined,
        kind: s.kind,
        ...(alternatives.length ? { alternatives } : {}),
      });
    }
    const code = c.code.trim();
    const name = c.name.trim();
    if (!code && !name && sessions.length === 0) continue;
    if (!code || sessions.length === 0) confidence = Math.min(confidence, 0.5);
    courses.push({
      code,
      name,
      instructor: c.instructor.trim() || undefined,
      sessions,
      confidence,
    });
  }
  return { courses };
}

export interface ParseImageInput {
  data: Buffer;
  mimeType: string;
}

export interface ParseOptions {
  /** Only for the try-parse script; the server never passes this. */
  onRaw?: (text: string | undefined) => void;
}

/**
 * Reads a schedule image with Gemini. Invalid or empty output is retried once;
 * a second failure throws 422. Provider errors throw 502 without retry.
 */
export async function parseScheduleImage(
  image: ParseImageInput,
  options: ParseOptions = {},
): Promise<ParseScheduleResponse> {
  const base64 = image.data.toString("base64");

  for (let attempt = 1; attempt <= 2; attempt++) {
    let text: string | undefined;
    try {
      const res = await getGemini().models.generateContent({
        model: geminiModel(),
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: image.mimeType, data: base64 } },
              { text: "Bu görseldeki ders programını çıkar." },
            ],
          },
        ],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: "application/json",
          responseSchema,
          temperature: 0,
        },
      });
      text = res.text;
    } catch (err) {
      // Log only the status, never the request or response body.
      const status = (err as { status?: number }).status;
      console.error(`Gemini request failed (status ${status ?? "unknown"})`);
      throw new AppError(502, "AI servisine ulaşılamadı", "AI_UNAVAILABLE");
    }
    options.onRaw?.(text);

    try {
      const parsed = normalize(rawZ.parse(JSON.parse(text ?? "")));
      if (parsed.courses.length > 0) return parsed;
    } catch {
      // fall through to retry
    }
  }
  throw new AppError(422, "Program okunamadı", "SCHEDULE_UNREADABLE");
}
