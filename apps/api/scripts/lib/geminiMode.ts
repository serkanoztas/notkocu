// Gemini mode for the check scripts. By default NO real request is made: a fake client answers with
// canned, schema-shaped JSON. Real requests (and real cost / quota use) only with CHECK_REAL_GEMINI=1.
import { setGeminiOverride } from "../../src/services/ai/gemini";

export const REAL_GEMINI = process.env.CHECK_REAL_GEMINI === "1";

export interface FakeGemini {
  /** Number of fake generateContent calls so far. */
  calls: () => number;
  /** Next generateContent call fails with this HTTP status (e.g. 429) once. */
  failNextWith: (status: number) => void;
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

  const answer = (p: Params): unknown => {
    const props = p.config?.responseSchema?.properties ?? {};
    const prompt = p.contents.flatMap((c) => c.parts.map((x) => x.text ?? "")).join("\n");
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
      generateContent: async (p: Params) => {
        calls += 1;
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
  return { calls: () => calls, failNextWith: (s) => (failWith = s), setSuggestConfidence: (c) => (suggestConfidence = c) };
}
