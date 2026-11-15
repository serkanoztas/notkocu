import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CourseWithSessions } from "@notkocu/shared";

export interface PickedTarget {
  /** null = inbox */
  courseId: string | null;
  weekNo?: number;
}

interface Props {
  visible: boolean;
  courses: CourseWithSessions[];
  /** Semester week count; the week chips follow it (never a fixed 14). */
  weekCount: number;
  currentWeekNo: number | null;
  value: PickedTarget | null;
  allowInbox: boolean;
  onSelect: (target: PickedTarget) => void;
  onClose: () => void;
}

/** Bottom sheet: pick a course and a week (or the inbox). Used by quick capture, inbox and note detail. */
export function TargetPicker({ visible, courses, weekCount, currentWeekNo, value, allowInbox, onSelect, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [courseId, setCourseId] = useState<string | null>(value?.courseId ?? null);
  const [weekNo, setWeekNo] = useState<number>(value?.weekNo ?? currentWeekNo ?? 1);

  const weeks = Array.from({ length: weekCount }, (_, i) => i + 1);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-black/40" onPress={onClose} accessibilityLabel="Kapat" />
      <View
        className="max-h-[80%] rounded-t-3xl bg-card px-5 pt-5"
        style={{ paddingBottom: insets.bottom + 16 }}
      >
        <Text className="font-heading text-2xl text-ink">Kaydedileceği yer</Text>
        <ScrollView className="mt-4" contentContainerStyle={{ gap: 8, paddingBottom: 8 }}>
          {allowInbox ? (
            <Pressable
              onPress={() => onSelect({ courseId: null })}
              className="min-h-touch justify-center rounded-2xl border border-line bg-bg px-4"
            >
              <Text className="font-body-medium text-base text-ink">Gelen kutusu</Text>
              <Text className="font-body text-sm text-muted">Ders ve hafta sonra seçilir</Text>
            </Pressable>
          ) : null}

          <Text className="mt-2 font-body-medium text-sm text-muted">Ders</Text>
          {courses.map((c) => {
            const selected = c._id === courseId;
            return (
              <Pressable
                key={c._id}
                onPress={() => setCourseId(c._id)}
                accessibilityState={{ selected }}
                className={`min-h-touch flex-row items-center gap-3 rounded-2xl border px-4 py-2 ${
                  selected ? "border-primary bg-primary-soft" : "border-line bg-card"
                }`}
              >
                <View className="h-8 w-1.5 rounded-full" style={{ backgroundColor: c.color ?? "#6366F1" }} />
                <View className="flex-1">
                  <Text numberOfLines={1} className="font-body-medium text-base text-ink">
                    {c.name || c.code || "Adsız ders"}
                  </Text>
                  {c.code && c.name ? <Text className="font-body text-sm text-muted">{c.code}</Text> : null}
                </View>
              </Pressable>
            );
          })}

          {courseId ? (
            <>
              <Text className="mt-2 font-body-medium text-sm text-muted">Hafta</Text>
              <View className="flex-row flex-wrap gap-2">
                {weeks.map((w) => {
                  const selected = w === weekNo;
                  return (
                    <Pressable
                      key={w}
                      onPress={() => setWeekNo(w)}
                      accessibilityState={{ selected }}
                      className={`h-11 min-w-[48px] items-center justify-center rounded-xl border px-2 ${
                        selected ? "border-primary bg-primary" : w === currentWeekNo ? "border-primary bg-card" : "border-line bg-card"
                      }`}
                    >
                      <Text className={`font-body-semibold text-base ${selected ? "text-white" : "text-ink"}`}>{w}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}
        </ScrollView>

        <Pressable
          disabled={!courseId}
          onPress={() => courseId && onSelect({ courseId, weekNo })}
          className={`mt-3 min-h-[52px] items-center justify-center rounded-2xl ${courseId ? "bg-primary active:opacity-80" : "bg-line"}`}
        >
          <Text className={`font-body-semibold text-base ${courseId ? "text-white" : "text-muted"}`}>Tamam</Text>
        </Pressable>
      </View>
    </Modal>
  );
}
