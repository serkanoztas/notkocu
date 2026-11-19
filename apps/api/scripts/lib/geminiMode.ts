// Gemini mode for the check scripts. By default NO real request is made: a fake client answers with
// canned, schema-shaped JSON. Real requests (and real cost / quota use) only with CHECK_REAL_GEMINI=1.
import { setGeminiOverride } from "../../src/services/ai/gemini";

export const REAL_GEMINI = process.env.CHECK_REAL_GEMINI === "1";

export interface FakeGemini {
  /** Number of fake generateContent calls so far. */
  calls: () => number;
  /** Next generateContent call fails with this HTTP status (e.g. 429) once. */
  failNextWith: (status: number) => void;
  /** Calls to `model` fail with `status` until cleared (undefined). */
  failModel: (model: string, status: number | undefined) => void;
  /** The n-th generateContent call from now (1 = the next one) fails with this status, once. */
  failOnCall: (n: number, status: number) => void;
  /** Model of every fake call so far, in order. */
  models: () => string[];
  /** Confidence the fake reports for course suggestions (default 0.9). */
  setSuggestConfidence: (c: number) => void;
}

interface Params {
  contents: { parts: { text?: string }[] }[];
  config?: { responseSchema?: { properties?: Record<string, { enum?: string[] }> } };
}

export function setupGemini(): FakeGemini | null {
  if (REAL_GEMINI) {
    console.log("Gemini: REAL (CHECK_REAL_GEMINI=1), real requests will be made\n");
    return null;
  }
  console.log("Gemini: FAKE (no real requests; set CHECK_REAL_GEMINI=1 for real ones)\n");

  let calls = 0;
  let failWith: number | undefined;
  let suggestConfidence = 0.9;
  const failing = new Map<string, number>();
  const used: string[] = [];
  let failAtCall: { call: number; status: number } | undefined;

  const answer = (p: Params): unknown => {
    const props = p.config?.responseSchema?.properties ?? {};
    const prompt = p.contents.flatMap((c) => c.parts.map((x) => x.text ?? "")).join("\n");
    if ("segments" in props) {
      // Audio piece: two lines inside the piece length given in the prompt ("N saniye").
      const secs = Number(/(\d+) saniye/.exec(prompt)?.[1] ?? 60);
      const segments = [{ start: "00:05", text: "Birinci normal form için her hücrede tek değer olmalı." }];
      if (secs > 40) segments.push({ start: "00:40", text: "İkinci normal form için kısmi bağımlılıkları ayırıyoruz." });
      return { segments };
    }
    if ("chapters" in props) {
      return {
        chapters: [
          { start: "00:00", title: "Giriş" },
          { start: "10:00", title: "Normal formlar" },
        ],
        summary: "Sahte ders özeti: normal formlar anlatıldı.",
      };
    }
    if ("pages" in props) {
      const n = Number(/(\d+) sayfa/.exec(prompt)?.[1] ?? 1);
      return { pages: Array.from({ length: n }, () => "# Sistem Analizi\n\nUse case diyagrami") };
    }
    if ("markdown" in props) {
      return {
        markdown: "# Veritabani Yonetimi\n\n1. Normalizasyon\n2. Indeksleme",
        title: "Veritabani Yonetimi Notu",
        summary: "Normalizasyon ve indeksleme maddelerinden oluşan kısa bir not listesi.",
      };
    }
    if ("courseId" in props) {
      // Course suggestion: pick the first real course id offered in the enum, confident.
      const ids = (props.courseId?.enum ?? []).filter((id) => id !== "none");
      return { courseId: ids[0] ?? "none", confidence: suggestConfidence };
    }
    if ("summary" in props) return { summary: "Sahte özet: belge kısa bir ders içeriğini anlatır." };
    return {};
  };

  const fake = {
    models: {
      generateContent: async (p: Params & { model?: string }) => {
        calls += 1;
        used.push(p.model ?? "");
        const modelFail = failing.get(p.model ?? "");
        if (modelFail !== undefined) throw Object.assign(new Error("fake model failure"), { status: modelFail });
        if (failAtCall && failAtCall.call === calls) {
          const status = failAtCall.status;
          failAtCall = undefined;
          throw Object.assign(new Error("fake failure"), { status });
        }
        if (failWith !== undefined) {
          const status = failWith;
          failWith = undefined;
          throw Object.assign(new Error(status === 429 ? "RESOURCE_EXHAUSTED" : "fake failure"), { status });
        }
        return { text: JSON.stringify(answer(p)) };
      },
    },
    files: {
      upload: async () => ({ name: "files/fake", uri: "fake://files/fake", state: "ACTIVE" }),
      get: async () => ({ name: "files/fake", uri: "fake://files/fake", state: "ACTIVE" }),
      delete: async () => ({}),
    },
  };
  setGeminiOverride(fake);
  return {
    calls: () => calls,
    models: () => used,
    failOnCall: (n, status) => (failAtCall = { call: calls + n, status }),
    failModel: (m, s) => (s === undefined ? failing.delete(m) : failing.set(m, s)),
    failNextWith: (s) => (failWith = s), setSuggestConfidence: (c) => (suggestConfidence = c) };
}
