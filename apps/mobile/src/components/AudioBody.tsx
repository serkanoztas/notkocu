import { Ionicons } from "@expo/vector-icons";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { NoteItem } from "@notkocu/shared";
import { useChunkPlayer } from "../lib/chunkPlayer";
import { formatDuration } from "../lib/format";

type AudioNote = Extract<NoteItem, { type: "audio" }>;

const DAY_MS = 24 * 3600 * 1000;
const WINDOW = 300; // transcript lines rendered at once (a 90 min lecture has more than the screen needs)

/** The last item that starts at or before `t` (items are sorted by startSec); -1 before the first. */
function activeIndex(items: { startSec: number }[], t: number): number {
  let found = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.startSec <= t + 0.25) found = i;
    else break;
  }
  return found;
}

interface Props {
  note: AudioNote;
  onRetry: () => void;
  retrying: boolean;
  onPin: (pinned: boolean) => void;
  pinning: boolean;
}

/** Player, chapters and transcript of a recording (mockup 09). Every time shown or tapped is global. */
export function AudioBody({ note, onRetry, retrying, onPin, pinning }: Props) {
  const content = note.content;
  const chunks = content.chunks ?? [];
  const deleted = !!content.audioDeleted;
  const hasAudio = !deleted && chunks.length > 0 && chunks.every((c) => !!c.fileKey);
  const player = useChunkPlayer(note._id, chunks, note.title, hasAudio);
  const [barWidth, setBarWidth] = useState(0);
  const [showAll, setShowAll] = useState(false);

  const transcript = useMemo(() => content.transcript ?? [], [content.transcript]);
  const chapters = useMemo(() => content.chapters ?? [], [content.chapters]);
  const activeLine = activeIndex(transcript, player.position);
  const activeChapter = activeIndex(chapters, player.position);
  const processing = note.status === "pending" || note.status === "processing";

  const expires = content.audioExpiresAt ? new Date(content.audioExpiresAt).getTime() : null;
  const daysLeft = expires === null ? null : Math.max(0, Math.ceil((expires - Date.now()) / DAY_MS));

  let from = 0;
  let to = transcript.length;
  if (!showAll && transcript.length > WINDOW) {
    from = Math.max(0, Math.min(activeLine < 0 ? 0 : activeLine - 100, transcript.length - WINDOW));
    to = from + WINDOW;
  }

  const progress = player.duration > 0 ? Math.min(1, player.position / player.duration) : 0;

  return (
    <View className="gap-4">
      {hasAudio ? (
        <View className="gap-4 rounded-2xl border border-line bg-card p-4">
          <Pressable
            onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}
            onPress={(e) => barWidth > 0 && player.prepared.ready && void player.seekTo((e.nativeEvent.locationX / barWidth) * player.duration)}
            accessibilityRole="adjustable"
            accessibilityLabel="Kayıt konumu"
            className="h-11 justify-center"
          >
            <View className="h-2 overflow-hidden rounded-full bg-line">
              <View className="h-2 rounded-full bg-primary" style={{ width: `${progress * 100}%` }} />
            </View>
          </Pressable>

          <View className="flex-row items-center gap-3">
            <Pressable
              onPress={player.toggle}
              disabled={!player.prepared.ready}
              accessibilityRole="button"
              accessibilityLabel={player.playing ? "Duraklat" : "Oynat"}
              className={`h-16 w-16 items-center justify-center rounded-full ${player.prepared.ready ? "bg-primary active:opacity-80" : "bg-line"}`}
            >
              <Ionicons name={player.playing ? "pause" : "play"} size={28} color={player.prepared.ready ? "#FFFFFF" : "#6B6B66"} />
            </Pressable>
            <View className="flex-1">
              <Text numberOfLines={1} className="font-body-semibold text-lg text-ink">
                {activeChapter >= 0 ? chapters[activeChapter]!.title : note.title}
              </Text>
              <Text className="font-body text-base text-muted">
                {formatDuration(player.position)} / {formatDuration(player.duration)}
              </Text>
            </View>
            <Pressable
              onPress={() => void player.skip(-15)}
              disabled={!player.prepared.ready}
              accessibilityRole="button"
              accessibilityLabel="15 saniye geri"
              className="h-11 w-11 items-center justify-center rounded-xl"
            >
              <Ionicons name="play-back" size={22} color="#18181B" />
            </Pressable>
            <Pressable
              onPress={() => void player.skip(15)}
              disabled={!player.prepared.ready}
              accessibilityRole="button"
              accessibilityLabel="15 saniye ileri"
              className="h-11 w-11 items-center justify-center rounded-xl"
            >
              <Ionicons name="play-forward" size={22} color="#18181B" />
            </Pressable>
            <Pressable
              onPress={player.cycleRate}
              disabled={!player.prepared.ready}
              accessibilityRole="button"
              accessibilityLabel={`Hız ${player.rate} kat`}
              className="min-h-touch min-w-[52px] items-center justify-center rounded-xl border border-line bg-bg px-3"
            >
              <Text className="font-body-semibold text-base text-ink">{player.rate}×</Text>
            </Pressable>
          </View>

          {!player.prepared.ready ? (
            <Text className="font-body text-sm text-muted">
              {player.prepared.error ?? `Ses hazırlanıyor… ${player.prepared.done}/${player.prepared.total}`}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View className="gap-1 rounded-2xl border border-line bg-card px-4 py-3">
        {deleted ? (
          <Text className="font-body text-base text-muted">Ses dosyası silindi, transkript duruyor.</Text>
        ) : content.pinned ? (
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="font-body text-base text-muted">Kalıcı yapıldı, ses silinmeyecek.</Text>
            <Pressable
              onPress={() => onPin(false)}
              disabled={pinning}
              accessibilityRole="button"
              className="min-h-touch justify-center"
            >
              <Text className="font-body-semibold text-base text-primary">Kalıcılığı kaldır</Text>
            </Pressable>
          </View>
        ) : (
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="font-body text-base text-muted">
              {daysLeft === 0 ? "Ses bugün silinecek" : `Ses ${daysLeft ?? 30} gün sonra silinecek`} ·
            </Text>
            <Pressable onPress={() => onPin(true)} disabled={pinning} accessibilityRole="button" className="min-h-touch justify-center">
              <Text className="font-body-semibold text-base text-primary">{pinning ? "Kaydediliyor…" : "Kalıcı yap"}</Text>
            </Pressable>
          </View>
        )}
        {!deleted && !content.pinned ? (
          <Text className="font-body text-sm text-muted">Transkript, bölümler ve özet silinmez.</Text>
        ) : null}
      </View>

      {processing ? (
        <View className="rounded-2xl border border-line bg-card p-4">
          <Text className="font-body text-base text-muted">Yazıya çevriliyor… Uzun kayıtlar birkaç dakika sürebilir; bu sırada kaydı dinleyebilirsin.</Text>
        </View>
      ) : note.status === "failed" ? (
        <View className="rounded-2xl border border-red-200 bg-card p-4">
          <Text className="font-body-semibold text-base text-red-700">Kayıt yazıya çevrilemedi</Text>
          <Pressable
            onPress={onRetry}
            disabled={retrying}
            accessibilityRole="button"
            className="mt-3 min-h-touch justify-center self-start rounded-xl border border-line bg-white px-4"
          >
            <Text className="font-body-medium text-base text-ink">{retrying ? "Gönderiliyor…" : "Tekrar dene"}</Text>
          </Pressable>
        </View>
      ) : (
        <>
          {note.aiSummary ? (
            <View className="rounded-2xl border border-line bg-card p-4">
              <Text selectable className="font-body-medium text-base leading-6 text-ink">
                {note.aiSummary}
              </Text>
            </View>
          ) : null}

          {chapters.length > 0 ? (
            <View className="gap-2">
              <View className="flex-row items-center gap-2">
                <Ionicons name="sparkles-outline" size={18} color="#4338CA" />
                <Text className="font-heading text-xl text-ink">Bölümler</Text>
              </View>
              <View className="overflow-hidden rounded-2xl border border-line bg-card">
                {chapters.map((c, i) => (
                  <Pressable
                    key={`${c.startSec}-${i}`}
                    onPress={() => void player.seekTo(c.startSec, true)}
                    disabled={!player.prepared.ready}
                    accessibilityRole="button"
                    accessibilityLabel={`${formatDuration(c.startSec)} ${c.title}`}
                    className={`min-h-[52px] flex-row items-center gap-4 px-4 py-3 active:opacity-80 ${i > 0 ? "border-t border-line" : ""} ${
                      i === activeChapter ? "bg-primary-soft" : ""
                    }`}
                  >
                    <Text className={`w-16 font-body-semibold text-base ${i === activeChapter ? "text-primary-dark" : "text-ink"}`}>
                      {formatDuration(c.startSec)}
                    </Text>
                    <Text className={`flex-1 font-body text-base ${i === activeChapter ? "text-primary-dark" : "text-ink"}`}>{c.title}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}

          <View className="gap-2">
            <View className="flex-row items-end justify-between">
              <Text className="font-heading text-xl text-ink">Transkript</Text>
              {transcript.length > 0 && hasAudio ? <Text className="font-body text-sm text-muted">Satıra dokun, kayıt oraya atlar</Text> : null}
            </View>
            {transcript.length === 0 ? (
              <View className="rounded-2xl border border-line bg-card p-4">
                <Text className="font-body text-base text-muted">Kayıtta konuşma algılanmadı.</Text>
              </View>
            ) : (
              <View className="rounded-2xl border border-line bg-card p-2">
                {from > 0 ? <Text className="px-2 py-1 font-body text-sm text-muted">… önceki {from} satır gizli</Text> : null}
                {transcript.slice(from, to).map((t, k) => {
                  const i = from + k;
                  return (
                    <Pressable
                      key={`${t.startSec}-${i}`}
                      onPress={() => void player.seekTo(t.startSec, true)}
                      disabled={!player.prepared.ready}
                      accessibilityRole="button"
                      className="min-h-touch flex-row gap-3 rounded-xl px-2 py-2 active:opacity-80"
                    >
                      <Text className="w-14 font-body-semibold text-base text-primary">{formatDuration(t.startSec)}</Text>
                      <Text className={`flex-1 font-body text-base leading-6 ${i === activeLine ? "text-ink" : "text-muted"}`}>{t.text}</Text>
                    </Pressable>
                  );
                })}
                {to < transcript.length ? <Text className="px-2 py-1 font-body text-sm text-muted">… sonraki {transcript.length - to} satır gizli</Text> : null}
                {transcript.length > WINDOW ? (
                  <Pressable onPress={() => setShowAll((v) => !v)} accessibilityRole="button" className="min-h-touch justify-center px-2">
                    <Text className="font-body-semibold text-base text-primary">{showAll ? "Yalnızca çevresini göster" : "Tümünü göster"}</Text>
                  </Pressable>
                ) : null}
              </View>
            )}
          </View>
        </>
      )}
    </View>
  );
}
