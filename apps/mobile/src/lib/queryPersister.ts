import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";
import { File, Paths } from "expo-file-system";

// TanStack Query cache on disk (expo-file-system, no extra native module), so the last known
// semester, courses, notes and inbox are visible when the app opens without a connection.
// Every failure here is swallowed: the app must work, just without a cache.

const cacheFile = () => new File(Paths.document, "query-cache.json");
const THROTTLE_MS = 1500;

let pending: PersistedClient | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush() {
  timer = null;
  const client = pending;
  pending = null;
  if (!client) return;
  try {
    const file = cacheFile();
    if (!file.exists) file.create();
    await file.write(JSON.stringify(client));
  } catch (err) {
    if (__DEV__) console.warn("[cache] could not write the query cache:", err);
  }
}

export const queryPersister: Persister = {
  persistClient(client) {
    pending = client; // trailing throttle: only the latest state is written
    timer ??= setTimeout(() => void flush(), THROTTLE_MS);
  },
  async restoreClient() {
    try {
      const file = cacheFile();
      if (!file.exists) return undefined;
      return JSON.parse(await file.text()) as PersistedClient;
    } catch (err) {
      if (__DEV__) console.warn("[cache] could not read the query cache:", err);
      await queryPersister.removeClient();
      return undefined;
    }
  },
  async removeClient() {
    try {
      const file = cacheFile();
      if (file.exists) file.delete();
    } catch {
      // nothing to clean up
    }
  },
};

/** Sign-out / auth loss: drop anything still waiting to be written and delete the file. */
export async function clearPersistedCache(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  pending = null;
  await queryPersister.removeClient();
}
