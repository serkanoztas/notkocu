import { Text, View } from "react-native";
import type { NoteType } from "@notkocu/shared";

// Class names are written out in full so NativeWind can see them at build time.
const STYLES: Record<NoteType, { label: string; box: string; text: string }> = {
  text: { label: "Metin", box: "bg-note-text-bg", text: "text-note-text-fg" },
  document: { label: "Belge", box: "bg-note-document-bg", text: "text-note-document-fg" },
  image: { label: "Görsel", box: "bg-note-image-bg", text: "text-note-image-fg" },
  audio: { label: "Ses", box: "bg-note-audio-bg", text: "text-note-audio-fg" },
  task: { label: "Görev", box: "bg-note-task-bg", text: "text-note-task-fg" },
  link: { label: "Link", box: "bg-primary-soft", text: "text-primary-dark" },
  code: { label: "Kod", box: "bg-line", text: "text-ink" },
};

export function NoteTypeBadge({ type }: { type: NoteType }) {
  const s = STYLES[type];
  return (
    <View className={`rounded-lg px-2.5 py-1 ${s.box}`}>
      <Text className={`font-body-semibold text-sm ${s.text}`}>{s.label}</Text>
    </View>
  );
}
