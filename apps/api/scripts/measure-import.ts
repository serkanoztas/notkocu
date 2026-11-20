// Measures how many requests a real recording needs for the imported-audio transcript (see
// services/ai/audioImportTranscribe.ts: one request, continued only when the answer hits the output limit).
//
//   npm run measure-import -- "C:\path\to\recording.m4a"                      (FAKE Gemini: no cost, only checks the plumbing)
//   $env:CHECK_REAL_GEMINI="1"; npm run measure-import -- "C:\path\to\recording.m4a"   (REAL: bills the audio per request)
//
// Real mode uploads the file to the Gemini Files API, transcribes it exactly like the worker does and deletes the
// upload at the end. Nothing is stored in the database and no note is created. Each request bills the whole audio
// again as input, so the table shows the real cost driver (prompt tokens x requests).
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { transcribeImported } from "../src/services/ai/audioImportTranscribe";
import { deleteFromFilesApi, uploadToFilesApi } from "../src/services/ai/filesApi";
import { geminiMaxOutputTokens, geminiModel } from "../src/services/ai/gemini";
import { readAudioDuration } from "../src/services/audioDuration";
import { isAmr, sniffImportedAudio } from "../src/services/audioSniff";
import { REAL_GEMINI, setupGemini } from "./lib/geminiMode";

const gemini = setupGemini();

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: npm run measure-import -- "<audio file>"');
  const data = await readFile(path);
  if (isAmr(data)) throw new Error("AMR is not supported");
  const kind = sniffImportedAudio(data);
  if (!kind) throw new Error("Not a supported audio file (m4a, mp3, wav, ogg/opus, flac, aac)");
  const durationSec = await readAudioDuration(data, kind.mime);
  if (durationSec === null) throw new Error("Could not read the length of this file");

  const model = geminiModel("audio");
  const maxOutputTokens = await geminiMaxOutputTokens("audio");
  console.log(`file: ${basename(path)}  ${kind.mime}  ${(data.length / 1048576).toFixed(1)} MB  ${Math.round(durationSec)} s (${(durationSec / 60).toFixed(1)} min)`);
  console.log(`model: ${model}  maxOutputTokens per request: ${maxOutputTokens}  (${REAL_GEMINI ? "REAL Gemini" : "FAKE Gemini"})`);
  if (gemini) {
    // The fake answers 150 segments per response by default; FAKE_PER_RESPONSE changes it.
    gemini.setImportScript({ durationSec: Math.round(durationSec), perResponse: Number(process.env.FAKE_PER_RESPONSE ?? 150), cutJson: true });
  }

  const started = Date.now();
  const uploaded = await uploadToFilesApi(data, kind.mime, 120);
  const rows: { index: number; after: number; segments: number; truncated: boolean; promptTokens?: number; outputTokens?: number }[] = [];
  try {
    const segments = await transcribeImported({
      file: uploaded,
      durationSec,
      beforeRequest: async () => undefined,
      onProgress: async () => undefined,
      onRequest: (info) => {
        rows.push(info);
        console.log(
          `  request ${info.index + 1}: continues after ${info.after < 0 ? "start" : info.after + " s"}, ${info.segments} segments, ${info.truncated ? "CUT OFF (MAX_TOKENS)" : "finished"}, prompt ${info.promptTokens ?? "?"} tok, output ${info.outputTokens ?? "?"} tok`,
        );
      },
    });
    const prompt = rows.reduce((n, r) => n + (r.promptTokens ?? 0), 0);
    const output = rows.reduce((n, r) => n + (r.outputTokens ?? 0), 0);
    console.log("");
    console.log(`requests: ${rows.length}  (continuations: ${Math.max(0, rows.length - 1)})`);
    console.log(`segments: ${segments.length}  last starts at ${segments[segments.length - 1]?.startSec ?? 0} s of ${Math.round(durationSec)} s`);
    console.log(`tokens: prompt ${prompt || "?"} (audio billed ${rows.length}x), output ${output || "?"}`);
    console.log(`time: ${((Date.now() - started) / 1000).toFixed(0)} s`);
  } finally {
    await deleteFromFilesApi(uploaded.name);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
