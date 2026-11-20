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
  /**
   * Imported audio (a request with a fileData part): the fake "recording" is `durationSec` long with one segment
   * every `everySec`; a response holds at most `perResponse` of them and, when more remain, reports MAX_TOKENS
   * (with the JSON cut in the middle of a segment when `cutJson`). Continuations ("... noktasından SONRASINDAKİ")
   * resume after the given time like the real model.
   */
  setImportScript: (script: { durationSec: number; everySec?: number; perResponse: number; cutJson?: boolean } | undefined) => void;
  /** Every imported-audio request so far: where it continued from and the maxOutputTokens it asked for. */
  importRequests: () => { after: number; maxOutputTokens?: number }[];
  /** outputTokenLimit that models.get reports (default 65536). */
  setOutputLimit: (limit: number) => void;
  /** Files API calls so far, by kind. */
  filesCalls: () => { upload: number; get: number; delete: number };
}

interface Params {
  contents: { parts: { text?: string; fileData?: unknown }[] }[];
  config?: { responseSchema?: { properties?: Record<string, { enum?: string[] }> }; maxOutputTokens?: number };
}

const clockOf = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(h > 0 ? 2 : 2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
const clockSeconds = (v: string) => v.split(":").reduce((n, x) => n * 60 + Number(x), 0);

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
  let importScript: { durationSec: number; everySec?: number; perResponse: number; cutJson?: boolean } | undefined;
  const importReqs: { after: number; maxOutputTokens?: number }[] = [];
  let outputLimit = 65536;
  const files = { upload: 0, get: 0, delete: 0 };

  /** One imported-audio request: the segments after the continuation point, cut by perResponse. */
  const importAnswer = (p: Params): { text: string; finishReason: string } => {
    const script = importScript ?? { durationSec: 600, perResponse: 1000 };
    const prompt = p.contents.flatMap((c) => c.parts.map((x) => x.text ?? "")).join(" ");
    const cont = /(\d+(?::\d\d){1,2}) noktasından SONRASINDAKİ/.exec(prompt)?.[1];
    const after = cont ? clockSeconds(cont) : -1;
    importReqs.push({ after, maxOutputTokens: p.config?.maxOutputTokens });
    const every = script.everySec ?? 30;
    const all: { start: string; text: string }[] = [];
    for (let t = 5; t < script.durationSec; t += every) all.push({ start: clockOf(t), text: `Konu ${t}. saniyede anlatıldı.` });
    const todo = all.filter((s) => clockSeconds(s.start) > after);
    const part = todo.slice(0, script.perResponse);
    const more = todo.length > part.length;
    let text = JSON.stringify({ segments: part });
    if (more && script.cutJson) text = text.slice(0, text.length - 12); // cut inside the last segment
    return { text, finishReason: more ? "MAX_TOKENS" : "STOP" };
  };

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
        if (p.contents.some((c) => c.parts.some((x) => x.fileData)) && "segments" in (p.config?.responseSchema?.properties ?? {})) {
          const r = importAnswer(p);
          return { text: r.text, candidates: [{ finishReason: r.finishReason }] };
        }
        return { text: JSON.stringify(answer(p)), candidates: [{ finishReason: "STOP" }] };
      },
      get: async () => ({ outputTokenLimit: outputLimit, inputTokenLimit: 1048576 }),
    },
    files: {
      upload: async () => {
        files.upload += 1;
        return { name: "files/fake", uri: "fake://files/fake", state: "ACTIVE" };
      },
      get: async () => {
        files.get += 1;
        return { name: "files/fake", uri: "fake://files/fake", state: "ACTIVE" };
      },
      delete: async () => {
        files.delete += 1;
        return {};
      },
    },
  };
  setGeminiOverride(fake);
  return {
    calls: () => calls,
    models: () => used,
    failOnCall: (n, status) => (failAtCall = { call: calls + n, status }),
    failModel: (m, s) => (s === undefined ? failing.delete(m) : failing.set(m, s)),
    failNextWith: (s) => (failWith = s),
    setSuggestConfidence: (c) => (suggestConfidence = c),
    setImportScript: (script) => {
      importScript = script;
      importReqs.length = 0;
    },
    importRequests: () => importReqs,
    setOutputLimit: (limit) => (outputLimit = limit),
    filesCalls: () => ({ ...files }),
  };
}
