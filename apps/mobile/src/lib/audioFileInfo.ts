import { createAudioPlayer } from "expo-audio";

/**
 * Length of a local audio file in seconds, read by loading it into a (silent, never started) native player.
 * null when it cannot be read in time; the server then measures it itself (it is authoritative anyway).
 */
export function readAudioFileDuration(uri: string, timeoutMs = 8000): Promise<number | null> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sub: { remove: () => void } | undefined;
    let player: ReturnType<typeof createAudioPlayer> | undefined;
    const finish = (value: number | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try {
        sub?.remove();
        player?.remove();
      } catch {
        // already released
      }
      resolve(value);
    };
    try {
      player = createAudioPlayer({ uri }, { updateInterval: 200 });
      sub = player.addListener("playbackStatusUpdate", (s) => {
        if (s.isLoaded && s.duration > 0) finish(Math.round(s.duration));
      });
      timer = setTimeout(() => finish(player && player.duration > 0 ? Math.round(player.duration) : null), timeoutMs);
    } catch {
      finish(null);
    }
  });
}
