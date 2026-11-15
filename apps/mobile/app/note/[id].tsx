import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NoteItem } from "@notkocu/shared";
import { BackHeader } from "../../src/components/BackHeader";
import { TargetPicker, type PickedTarget } from "../../src/components/TargetPicker";
import { useDeleteNote, useNote, useUpdateNote } from "../../src/hooks/queries";
import { useActiveSemester } from "../../src/hooks/useActiveSemester";
import { useScheduleNow } from "../../src/hooks/useSchedule";
import { useNow, useTimeZone } from "../../src/hooks/useNow";
import { ApiError } from "../../src/lib/api";
import { formatStamp } from "../../src/lib/format";

const TYPE_EYEBROW = { text: "Metin notu" } as const;

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.code === "NETWORK" || err.code === "TIMEOUT" ? "Bağlantı yok, işlem yapılamadı" : err.message;
  return "İşlem yapılamadı, tekrar dene";
}

export default function NoteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const timeZone = useTimeZone();
  const { data, isPending, isError, refetch } = useNote(id);
  const semester = useActiveSemester(true);
  const schedule = useScheduleNow(useNow());
  const update = useUpdateNote(id);
  const remove = useDeleteNote(id);

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const note = data?.note;
  const course = note?.courseId ? semester.data?.courses.find((c) => c._id === note.courseId) : undefined;
  const markdown = note && note.type === "text" ? note.content.markdown : "";

  function startEdit(n: NoteItem) {
    setTitle(n.title);
    setBody(n.type === "text" ? n.content.markdown : "");
    setError(null);
    setEditing(true);
  }

  function save() {
    if (!body.trim()) {
      setError("Not boş olamaz");
      return;
    }
    update.mutate(
      { title: title.trim(), markdown: body },
      { onSuccess: () => setEditing(false), onError: (e) => setError(errorText(e)) },
    );
  }

  function confirmDelete() {
    Alert.alert("Notu sil", "Bu not kalıcı olarak silinecek.", [
      { text: "Vazgeç", style: "cancel" },
      {
        text: "Sil",
        style: "destructive",
        onPress: () => remove.mutate(undefined, { onSuccess: () => router.back(), onError: (e) => setError(errorText(e)) }),
      },
    ]);
  }

  function move(target: PickedTarget) {
    setPicking(false);
    update.mutate(
      target.courseId ? { courseId: target.courseId, weekNo: target.weekNo } : { courseId: null },
      { onError: (e) => setError(errorText(e)) },
    );
  }

  const where = note
    ? note.courseId
      ? [course?.name || course?.code || "Ders", note.weekNo ? `${note.weekNo}. hafta` : null, formatStamp(note.createdAt, timeZone)]
      : ["Gelen kutusu", formatStamp(note.createdAt, timeZone)]
    : [];

  return (
    <KeyboardAvoidingView className="flex-1 bg-bg" behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: insets.top + 12, paddingHorizontal: 20, paddingBottom: insets.bottom + 32, gap: 16 }}
      >
        <BackHeader eyebrow={note ? TYPE_EYEBROW[note.type as "text"] ?? "Not" : undefined} title={editing ? "Notu düzenle" : note?.title || "Not"} />

        {isPending ? <Text className="font-body text-base text-muted">Yükleniyor…</Text> : null}
        {isError && !note ? (
          <View className="rounded-2xl border border-amber-300 bg-amber-100 p-4">
            <Text className="font-body-semibold text-base text-amber-900">Not yüklenemedi</Text>
            <Pressable onPress={() => refetch()} className="mt-3 min-h-touch justify-center self-start rounded-xl border border-amber-300 bg-white px-4">
              <Text className="font-body-medium text-amber-900">Tekrar dene</Text>
            </Pressable>
          </View>
        ) : null}

        {note ? (
          <>
            <Text className="font-body text-sm text-muted">{where.filter(Boolean).join(" · ")}</Text>

            {editing ? (
              <View className="gap-3">
                <TextInput
                  value={title}
                  onChangeText={setTitle}
                  placeholder="Başlık (boşsa ilk satırdan)"
                  maxLength={120}
                  className="min-h-[52px] rounded-2xl border border-line bg-card px-4 font-body text-lg text-ink"
                />
                <TextInput
                  value={body}
                  onChangeText={setBody}
                  multiline
                  textAlignVertical="top"
                  maxLength={20000}
                  className="min-h-[220px] rounded-2xl border border-line bg-card p-4 font-body text-base text-ink"
                />
                <View className="flex-row gap-3">
                  <Pressable
                    onPress={() => setEditing(false)}
                    className="min-h-[52px] flex-1 items-center justify-center rounded-2xl border border-line bg-card"
                  >
                    <Text className="font-body-medium text-base text-ink">Vazgeç</Text>
                  </Pressable>
                  <Pressable
                    onPress={save}
                    disabled={update.isPending}
                    className="min-h-[52px] flex-1 items-center justify-center rounded-2xl bg-primary active:opacity-80"
                  >
                    <Text className="font-body-semibold text-base text-white">{update.isPending ? "Kaydediliyor…" : "Kaydet"}</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <>
                <View className="rounded-2xl border border-line bg-card p-4">
                  <Text selectable className="font-body text-base leading-6 text-ink">
                    {markdown}
                  </Text>
                </View>
                <View className="flex-row flex-wrap gap-3">
                  <Pressable onPress={() => startEdit(note)} className="min-h-touch justify-center rounded-xl border border-line bg-card px-5">
                    <Text className="font-body-medium text-base text-ink">Düzenle</Text>
                  </Pressable>
                  <Pressable onPress={() => setPicking(true)} className="min-h-touch justify-center rounded-xl border border-line bg-card px-5">
                    <Text className="font-body-medium text-base text-ink">Yerini değiştir</Text>
                  </Pressable>
                  <Pressable
                    onPress={confirmDelete}
                    disabled={remove.isPending}
                    className="min-h-touch justify-center rounded-xl border border-red-200 bg-card px-5"
                  >
                    <Text className="font-body-medium text-base text-red-700">Sil</Text>
                  </Pressable>
                </View>
              </>
            )}

            {error ? <Text className="font-body text-sm text-red-700">{error}</Text> : null}
          </>
        ) : null}
      </ScrollView>

      {picking && note && schedule.semester ? (
        <TargetPicker
          visible
          courses={schedule.courses}
          weekCount={schedule.semester.weekCount}
          currentWeekNo={schedule.weekNo}
          value={note.courseId ? { courseId: note.courseId, weekNo: note.weekNo } : null}
          allowInbox
          onSelect={move}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}
