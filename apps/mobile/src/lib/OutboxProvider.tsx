import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { invalidateNoteViews } from "../hooks/queries";
import { ApiError } from "./api";
import { useAuth } from "./auth";
import {
  clearOutbox,
  errorMessage,
  isTransient,
  loadEntries,
  newClientId,
  removeEntry,
  sendEntry,
  updateEntry,
  writeNewEntry,
  type OutboxEntry,
  type OutboxKind,
  type OutboxTarget,
} from "./outbox";

const RETRY_EVERY_MS = 30_000;

export interface NewOutboxNote {
  kind: OutboxKind;
  target?: OutboxTarget;
  title?: string;
  markdown?: string;
  url?: string;
  file?: { uri: string; name: string };
  source?: "app" | "share-intent";
}

interface OutboxValue {
  /** Notes written to the device and not confirmed by the server yet (oldest first). */
  entries: OutboxEntry[];
  /** Saves a note on the device and starts sending it; resolves once it is safely on disk. */
  add: (note: NewOutboxNote) => Promise<void>;
  /** Reads the device again (the recorder writes entries itself) and tries to send. */
  reload: () => Promise<void>;
  /** Tries to send everything now (also runs on app start, on coming to the foreground and every 30 s). */
  flush: () => Promise<void>;
  /** A note the server refused: clear the error and try again. */
  retry: (clientId: string) => Promise<void>;
  discard: (clientId: string) => void;
  /** Deletes everything (sign-out after the user confirmed). */
  clearAll: () => void;
}

const OutboxContext = createContext<OutboxValue | null>(null);

export function OutboxProvider({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const queryClient = useQueryClient();
  const userId = status === "signedIn" ? (user?._id ?? null) : null;
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const entriesRef = useRef<OutboxEntry[]>([]);
  const flushing = useRef(false);
  const userIdRef = useRef<string | null>(null);

  const setAll = useCallback((next: OutboxEntry[]) => {
    entriesRef.current = next;
    setEntries(next);
  }, []);

  const patch = useCallback(
    (clientId: string, fn: (e: OutboxEntry) => OutboxEntry) => {
      setAll(entriesRef.current.map((e) => (e.clientId === clientId ? fn(e) : e)));
    },
    [setAll],
  );

  const flush = useCallback(async () => {
    const uid = userIdRef.current;
    if (!uid || flushing.current) return;
    flushing.current = true;
    try {
      for (const entry of entriesRef.current.filter((e) => e.userId === uid && !e.error && !e.recording)) {
        let current = entry;
        for (let tries = 0; tries < 2; tries++) {
          try {
            await sendEntry(current);
            removeEntry(current.clientId);
            await invalidateNoteViews(queryClient); // refetch first, so the note never disappears from the list
            setAll(entriesRef.current.filter((e) => e.clientId !== current.clientId));
            break;
          } catch (err) {
            if (isTransient(err)) return; // no connection / server trouble: keep everything, try later
            const api = err as ApiError;
            if (api.status === 404 && current.target?.courseId && tries === 0) {
              // The course was deleted meanwhile: the note must not be lost, it goes to the inbox.
              current = { ...current, target: { courseId: null } };
              await updateEntry(current);
              patch(current.clientId, () => current);
              continue;
            }
            current = { ...current, error: { code: api.code ?? "ERROR", message: errorMessage(api) } };
            await updateEntry(current);
            patch(current.clientId, () => current);
            break;
          }
        }
      }
    } finally {
      flushing.current = false;
    }
  }, [patch, queryClient, setAll]);

  // Load what is on disk when a user is signed in; other accounts' leftovers are dropped.
  useEffect(() => {
    userIdRef.current = userId;
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      const onDisk = await loadEntries();
      for (const e of onDisk) if (e.userId !== userId) removeEntry(e.clientId);
      if (cancelled) return;
      setAll(onDisk.filter((e) => e.userId === userId && !e.recording)); // a recording in progress is the recorder's
      void flush();
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, flush, setAll]);

  // Back in the foreground: try again.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void flush();
    });
    return () => sub.remove();
  }, [flush]);

  // Periodic retry while something is waiting.
  const waiting = entries.some((e) => !e.error);
  useEffect(() => {
    if (!waiting || !userId) return;
    const id = setInterval(() => void flush(), RETRY_EVERY_MS);
    return () => clearInterval(id);
  }, [waiting, userId, flush]);

  const reload = useCallback(async () => {
    const uid = userIdRef.current;
    if (!uid) return;
    const onDisk = await loadEntries();
    setAll(onDisk.filter((e) => e.userId === uid && !e.recording));
    void flush();
  }, [flush, setAll]);

  const add = useCallback(
    async (note: NewOutboxNote) => {
      const uid = userIdRef.current;
      if (!uid) throw new Error("NOT_SIGNED_IN");
      const entry: OutboxEntry = {
        clientId: newClientId(),
        userId: uid,
        kind: note.kind,
        capturedAt: new Date().toISOString(),
        source: note.source ?? "app",
        target: note.target,
        title: note.title,
        markdown: note.markdown,
        url: note.url,
      };
      const saved = await writeNewEntry(entry, note.file);
      setAll([...entriesRef.current, saved]);
      void flush();
    },
    [flush, setAll],
  );

  const retry = useCallback(
    async (clientId: string) => {
      const e = entriesRef.current.find((x) => x.clientId === clientId);
      if (!e) return;
      const cleared = { ...e, error: undefined };
      await updateEntry(cleared);
      patch(clientId, () => cleared);
      void flush();
    },
    [flush, patch],
  );

  const discard = useCallback(
    (clientId: string) => {
      removeEntry(clientId);
      setAll(entriesRef.current.filter((e) => e.clientId !== clientId));
    },
    [setAll],
  );

  const clearAll = useCallback(() => {
    clearOutbox();
    setAll([]);
  }, [setAll]);

  const value = useMemo(() => ({ entries, add, flush, reload, retry, discard, clearAll }), [entries, add, flush, reload, retry, discard, clearAll]);
  return <OutboxContext.Provider value={value}>{children}</OutboxContext.Provider>;
}

export function useOutbox(): OutboxValue {
  const ctx = useContext(OutboxContext);
  if (!ctx) throw new Error("useOutbox must be used inside OutboxProvider");
  return ctx;
}
