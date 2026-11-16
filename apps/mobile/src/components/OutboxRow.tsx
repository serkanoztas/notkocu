import { Alert, Pressable, Text, View } from "react-native";
import type { NoteType } from "@notkocu/shared";
import { useTimeZone } from "../hooks/useNow";
import { formatClock } from "../lib/format";
import { useOutbox } from "../lib/OutboxProvider";
import type { OutboxEntry } from "../lib/outbox";
import { NoteTypeBadge } from "./NoteTypeBadge";

const TYPE: Record<OutboxEntry["kind"], NoteType> = { text: "text", image: "image", document: "document", link: "link" };

/** First line of what the note will say, from what is on the device. */
function preview(e: OutboxEntry): string {
  if (e.title) return e.title;
  if (e.kind === "text") return (e.markdown ?? "").split("\n").find((l) => l.trim())?.slice(0, 80) ?? "Not";
  if (e.kind === "link") return e.url ?? "Bağlantı";
  return e.displayName ?? (e.kind === "image" ? "Fotoğraf" : "Belge");
}

/** A note that is saved on the device but not on the server yet ("Gönderilmedi"). */
export function OutboxRow({ entry, divider }: { entry: OutboxEntry; divider?: boolean }) {
  const outbox = useOutbox();
  const timeZone = useTimeZone();
  const failed = !!entry.error;

  function openActions() {
    Alert.alert(preview(entry), failed ? entry.error?.message : "Bu not henüz sunucuya gönderilmedi. Bağlantı gelince kendiliğinden gönderilir.", [
      { text: "Vazgeç", style: "cancel" },
      { text: "Şimdi gönder", onPress: () => void (failed ? outbox.retry(entry.clientId) : outbox.flush()) },
      {
        text: "Sil",
        style: "destructive",
        onPress: () =>
          Alert.alert("Notu sil", "Bu not gönderilmeden silinecek.", [
            { text: "Vazgeç", style: "cancel" },
            { text: "Sil", style: "destructive", onPress: () => outbox.discard(entry.clientId) },
          ]),
      },
    ]);
  }

  return (
    <Pressable
      onPress={openActions}
      accessibilityRole="button"
      className={`min-h-[64px] flex-row items-center gap-3 px-4 py-3 active:opacity-80 ${divider ? "border-t border-line" : ""}`}
    >
      <NoteTypeBadge type={TYPE[entry.kind]} />
      <View className="flex-1">
        <Text numberOfLines={1} className="font-body-medium text-base text-ink">
          {preview(entry)}
        </Text>
        <Text numberOfLines={1} className={`font-body text-sm ${failed ? "text-red-700" : "text-amber-800"}`}>
          {failed ? `Gönderilemedi · ${entry.error?.message}` : "Gönderilmedi"}
        </Text>
      </View>
      <Text className="font-body text-sm text-muted">{formatClock(entry.capturedAt, timeZone)}</Text>
    </Pressable>
  );
}
