import { createAudioPlaylist, setAudioModeAsync, type AudioPlaylist } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { useCallback, useEffect, useRef, useState } from "react";
import { locateChunk, toGlobal, totalDuration, type AudioChunk } from "@notkocu/shared";
import { api, authHeaders } from "./api";

// Player for a recording stored as ~10 minute pieces. Everything the UI sees is GLOBAL time (seconds from
// the start of the whole recording); the pieces and the conversion live here and in shared/audio.ts.
//
// The pieces are downloaded (with the Authorization header) into the cache first, then handed to a native
// playlist: the native player loads the next piece while the current one plays, so the gap at a piece
// boundary is as small as the platform allows. Seeking to a time in another piece skips to that piece and
// seeks inside it; a time exactly on a boundary opens the next piece at 0.

export const RATES = [1, 1.5, 2] as const;

export interface ChunkPlayer {
  /** Pieces downloaded so far / in total, and whether the player can play. */
  prepared: { done: number; total: number; ready: boolean; error: string | null };
  playing: boolean;
  /** Global position, seconds. */
  position: number;
  duration: number;
  rate: number;
  toggle: () => void;
  /** Jump to a global time; `play` starts playback there (chapter / transcript taps). */
  seekTo: (globalSec: number, play?: boolean) => Promise<void>;
  skip: (deltaSec: number) => Promise<void>;
  cycleRate: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function download(fileId: string, dest: File): Promise<void> {
  const run = async () => File.downloadFileAsync(api.fileUrl(fileId), dest, { headers: await authHeaders(), idempotent: true });
  try {
    await run();
  } catch {
    await api.me(); // the access token lives 15 minutes; any call refreshes it
    await run();
  }
}

export function useChunkPlayer(noteId: string, chunks: AudioChunk[], title: string, enabled: boolean): ChunkPlayer {
  const [prepared, setPrepared] = useState({ done: 0, total: chunks.length, ready: false, error: null as string | null });
  const [status, setStatus] = useState({ index: 0, localSec: 0, playing: false, rate: 1 });
  const playlist = useRef<AudioPlaylist | null>(null);
  const chunksRef = useRef(chunks);
  chunksRef.current = chunks;
  // A new `chunks` array every render must not restart the download: only these keys matter.
  const key = chunks.map((c) => `${c.fileKey ?? "-"}:${c.size}`).join("|");

  useEffect(() => {
    if (!enabled || chunks.length === 0 || chunks.some((c) => !c.fileKey)) return;
    let cancelled = false;
    let created: AudioPlaylist | null = null;
    let listener: { remove: () => void } | null = null;

    void (async () => {
      try {
        const uris: string[] = [];
        for (const [i, c] of chunks.entries()) {
          const file = new File(Paths.cache, `audio-${noteId}-${i}.aac`);
          if (!file.exists || file.size !== c.size) await download(c.fileKey!, file);
          if (cancelled) return;
          uris.push(file.uri);
          setPrepared({ done: i + 1, total: chunks.length, ready: false, error: null });
        }
        await setAudioModeAsync({ shouldPlayInBackground: true, interruptionMode: "doNotMix", playsInSilentMode: true, allowsRecording: false });
        if (cancelled) return;
        created = createAudioPlaylist({ sources: uris, updateInterval: 250, loop: "none" });
        listener = created.addListener("playlistStatusUpdate", (s) =>
          setStatus({ index: s.currentIndex, localSec: s.currentTime, playing: s.playing, rate: s.playbackRate || 1 }),
        );
        playlist.current = created;
        setPrepared({ done: chunks.length, total: chunks.length, ready: true, error: null });
      } catch {
        if (!cancelled) setPrepared((p) => ({ ...p, ready: false, error: "Ses indirilemedi. Bağlantını kontrol edip tekrar aç." }));
      }
    })();

    return () => {
      cancelled = true;
      listener?.remove();
      try {
        created?.clearLockScreenControls();
        created?.destroy();
      } catch {
        // already released
      }
      playlist.current = null;
    };
    // `key` stands for the chunk list (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, key, enabled]);

  const seekTo = useCallback(
    async (globalSec: number, play = false) => {
      const p = playlist.current;
      const loc = locateChunk(chunksRef.current, globalSec);
      if (!p || !loc) return;
      if (loc.index !== p.currentIndex) {
        p.skipTo(loc.index);
        await sleep(120); // let the native player switch pieces before seeking inside the new one
      }
      await p.seekTo(loc.localSec);
      if (p.currentIndex !== loc.index) {
        // The switch had not finished: once more.
        p.skipTo(loc.index);
        await sleep(200);
        await p.seekTo(loc.localSec);
      }
      if (play) p.play();
    },
    [],
  );

  const toggle = useCallback(() => {
    const p = playlist.current;
    if (!p) return;
    if (p.playing) {
      p.pause();
    } else {
      p.play();
      try {
        p.setActiveForLockScreen(true, { title, artist: "NotKoçu" }); // lock screen + notification controls, keeps background playback alive
      } catch {
        // not supported on this device: playback still works in the foreground
      }
    }
  }, [title]);

  const position = chunks[status.index] ? toGlobal(chunks[status.index]!, status.localSec) : 0;

  const skip = useCallback(
    async (delta: number) => {
      const list = chunksRef.current;
      const current = list[status.index] ? toGlobal(list[status.index]!, status.localSec) : 0;
      await seekTo(Math.min(Math.max(0, current + delta), Math.max(0, totalDuration(list) - 0.5)));
    },
    [seekTo, status.index, status.localSec],
  );

  const cycleRate = useCallback(() => {
    const p = playlist.current;
    if (!p) return;
    const next = RATES[(RATES.indexOf(status.rate as (typeof RATES)[number]) + 1) % RATES.length] ?? 1;
    p.playbackRate = next; // applies to every piece of the playlist
    setStatus((s) => ({ ...s, rate: next }));
  }, [status.rate]);

  return {
    prepared,
    playing: status.playing,
    position,
    duration: totalDuration(chunks),
    rate: status.rate,
    toggle,
    seekTo,
    skip,
    cycleRate,
  };
}
