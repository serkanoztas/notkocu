import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TargetPicker, type PickedTarget } from "../src/components/TargetPicker";
import { useCreateNote } from "../src/hooks/queries";
import { useNow, useTimeZone } from "../src/hooks/useNow";
import { findAutoTarget, useScheduleNow } from "../src/hooks/useSchedule";
import { ApiError } from "../src/lib/api";

type IconName = keyof typeof Ionicons.glyphMap;

const TYPES: { key: string; label: string; icon: IconName; active: boolean }[] = [
  { key: "text", label: "Metin", icon: "reorder-three-outline", active: true },
  { key: "image", label: "Fotoğraf", icon: "camera-outline", active: false },
  { key: "audio", label: "Ses kaydı", icon: "mic-outline", active: false },
  { key: "document", label: "Dosya", icon: "document-outline", active: false },
  { key: "link", label: "Link", icon: "link-outline", active: false },
  { key: "task", label: "Görev", icon: "checkbox-outline", active: false },
];

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    return err.code === "NETWORK" || err.code === "TIMEOUT" ? "Bağlantı yok, not kaydedilemedi" : err.message;
  }
  return "Not kaydedilemedi, tekrar dene";
}

export default function CaptureScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ courseId?: string; weekNo?: string }>();
  const timeZone = useTimeZone();
  const now = useNow(); // the shown target refreshes once a minute while this sheet is open
  const schedule = useScheduleNow(now);
  const create = useCreateNote();

  // A target the user chose by hand (or via "Not al" on a course) stays fixed; otherwise it follows the clock.
  const [manual, setManual] = useState<PickedTarget | null>(
    params.courseId ? { courseId: params.courseId, weekNo: Number(params.weekNo) || undefined } : null,
  );
  const [picking, setPicking] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const manualCourse = manual?.courseId ? schedule.courses.find((c) => c._id === manual.courseId) : undefined;
  const target = manual
    ? manual.courseId
      ? { course: manualCourse, weekNo: manual.weekNo ?? schedule.weekNo ?? 1 }
      : null // inbox chosen by hand
    : schedule.autoTarget;

  const label = target?.course ? `${target.course.name || target.course.code} · ${target.weekNo}. hafta` : "Gelen kutusu";
  const caption = manual
    ? "Elle seçildi"
    : schedule.autoTarget
      ? "Şu an derstesin, otomatik seçildi"
      : "Ders saati dışında, gelen kutusuna gider";

  function save() {
    if (!text.trim() || create.isPending) return;
    setError(null);
    // Recomputed at save time, not at open time: opened at 08:45, saved at 09:05 -> the course.
    const resolved = manual
      ? manual.courseId
        ? { courseId: manual.courseId, weekNo: manual.weekNo ?? schedule.weekNo ?? 1 }
        : { courseId: null }
      : (() => {
          const auto = findAutoTarget(schedule.semester, schedule.courses, new Date(), timeZone);
          return auto ? { courseId: auto.course._id, weekNo: auto.weekNo } : { courseId: null };
        })();
    create.mutate(
      { type: "text", markdown: text.trim(), ...resolved },
      { onSuccess: () => router.back(), onError: (e) => setError(errorText(e)) },
    );
  }

  const canSave = text.trim().length > 0 && !create.isPending;

  return (
    <KeyboardAvoidingView className="flex-1 bg-bg" behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: insets.top + 16, paddingHorizontal: 20, paddingBottom: 24, gap: 16 }}
      >
        <View className="flex-row items-center justify-between">
          <Text className="font-heading text-3xl text-ink">Hızlı not</Text>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Kapat"
            className="h-11 w-11 items-center justify-center rounded-xl bg-line/60"
          >
            <Ionicons name="close" size={22} color="#18181B" />
          </Pressable>
        </View>

        <View className="flex-row items-center gap-3 rounded-2xl bg-line/50 p-4">
          <View
            className="h-12 w-1.5 rounded-full"
            style={{ backgroundColor: target?.course?.color ?? "#A1A19B" }}
          />
          <View className="flex-1">
            <Text className="font-body text-sm text-muted">Kaydedileceği yer</Text>
            <Text numberOfLines={2} className="font-body-semibold text-lg text-ink">
              {label}
            </Text>
            <Text className={`font-body text-sm ${!manual && schedule.autoTarget ? "text-green-700" : "text-muted"}`}>{caption}</Text>
          </View>
          <View className="items-end gap-1">
            <Pressable
              onPress={() => setPicking(true)}
              disabled={!schedule.semester}
              className="min-h-touch items-center justify-center rounded-xl border border-line bg-card px-4"
            >
              <Text className="font-body-semibold text-base text-ink">Değiştir</Text>
            </Pressable>
            {manual ? (
              <Pressable onPress={() => setManual(null)} className="min-h-touch justify-center px-1">
                <Text className="font-body-medium text-sm text-primary">Otomatik seç</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <View className="flex-row flex-wrap gap-3">
          {TYPES.map((t) => (
            <View
              key={t.key}
              accessibilityState={{ disabled: !t.active, selected: t.active }}
              className={`min-h-[76px] items-center justify-center rounded-2xl border-2 px-2 ${
                t.active ? "border-primary bg-primary-soft" : "border-transparent bg-line/50 opacity-60"
              }`}
              style={{ width: "31%" }}
            >
              <Ionicons name={t.icon} size={24} color={t.active ? "#3730A3" : "#6B6B66"} />
              <Text className={`mt-1 font-body-medium text-sm ${t.active ? "text-primary-dark" : "text-muted"}`}>{t.label}</Text>
              {!t.active ? <Text className="font-body text-xs text-muted">yakında</Text> : null}
            </View>
          ))}
        </View>

        <View>
          <Text className="mb-1 font-body-medium text-base text-ink">Not</Text>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            autoFocus
            textAlignVertical="top"
            maxLength={20000}
            placeholder="Derste ne konuşuldu?"
            placeholderTextColor="#A1A19B"
            className="min-h-[180px] rounded-2xl border border-line bg-card p-4 font-body text-base text-ink"
          />
        </View>

        {error ? <Text className="font-body text-sm text-red-700">{error}</Text> : null}
      </ScrollView>

      <View className="px-5" style={{ paddingBottom: insets.bottom + 16 }}>
        <Pressable
          onPress={save}
          disabled={!canSave}
          className={`min-h-[56px] items-center justify-center rounded-2xl ${canSave ? "bg-primary active:opacity-80" : "bg-line"}`}
        >
          <Text className={`font-body-semibold text-base ${canSave ? "text-white" : "text-muted"}`}>
            {create.isPending ? "Kaydediliyor…" : "Kaydet"}
          </Text>
        </Pressable>
      </View>

      {picking && schedule.semester ? (
        <TargetPicker
          visible
          courses={schedule.courses}
          weekCount={schedule.semester.weekCount}
          currentWeekNo={schedule.weekNo}
          value={manual ?? (schedule.autoTarget ? { courseId: schedule.autoTarget.course._id, weekNo: schedule.autoTarget.weekNo } : null)}
          allowInbox
          onSelect={(t) => {
            setManual(t);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}
