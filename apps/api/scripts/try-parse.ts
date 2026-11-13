// Usage: npm run try-parse -- <image file>
// Runs the schedule parser on a local image. No DB, no server. Prints raw model output too.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseScheduleImage } from "../src/services/ai/scheduleParser";

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
};

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run try-parse -- <image file>");
  process.exit(1);
}
const mimeType = MIME[path.extname(file).toLowerCase()];
if (!mimeType) {
  console.error(`Unsupported extension: ${path.extname(file)}`);
  process.exit(1);
}

const data = await readFile(file);
if (data.length === 0) {
  console.error("Empty file");
  process.exit(1);
}
const started = Date.now();
const result = await parseScheduleImage({ data, mimeType }, {
  onRaw: (text) => console.log("--- raw model output ---\n" + text + "\n"),
});
console.log(`--- parsed (${Date.now() - started} ms) ---`);
console.log(JSON.stringify(result, null, 2));

const low = result.courses.filter((c) => c.confidence < 0.8);
console.log(`\n${result.courses.length} courses, ${low.length} below 0.8 confidence`);
for (const c of low) console.log(`  - ${c.code || "(no code)"} ${c.name || "(no name)"}: ${c.confidence}`);
