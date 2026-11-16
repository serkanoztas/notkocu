import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import type { NoteItem } from "@notkocu/shared";
import { useTimeZone } from "../hooks/useNow";
import { formatClock } from "../lib/format";
import { AuthImage } from "./AuthImage";
import { NoteTypeBadge } from "./NoteTypeBadge";

/** One note in a list; opens the note detail. */
export function NoteRow({ note, divider }: { note: NoteItem; divider?: boolean }) {
  const router = useRouter();
  const timeZone = useTimeZone();
  return (
    <Pressable
      onPress={() => router.push(`/note/${note._id}`)}
      accessibilityRole="button"
      className={`min-h-[64px] flex-row items-center gap-3 px-4 py-3 active:opacity-80 ${divider ? "border-t border-line" : ""}`}
    >
      {note.type === "image" ? (
        <AuthImage fileId={note.content.thumbKey ?? note.content.fileKey} className="h-11 w-11 rounded-lg bg-line" />
      ) : (
        <NoteTypeBadge type={note.type} />
      )}
      <View className="flex-1">
        <Text numberOfLines={1} className="font-body-medium text-base text-ink">
          {note.title || "Adsız not"}
        </Text>
        {note.status === "pending" || note.status === "processing" ? (
          <Text className="font-body text-sm text-muted">İşleniyor…</Text>
        ) : note.status === "failed" ? (
          <Text className="font-body text-sm text-red-700">İşlenemedi</Text>
        ) : note.extractedText ? (
          <Text numberOfLines={1} className="font-body text-sm text-muted">
            {note.extractedText.replace(/\s+/g, " ")}
          </Text>
        ) : null}
      </View>
      <Text className="font-body text-sm text-muted">{formatClock(note.createdAt, timeZone)}</Text>
    </Pressable>
  );
}
