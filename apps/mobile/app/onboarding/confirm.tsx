import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ScheduleCourseDraft } from "@notkocu/shared";
import { CourseEditor, emptyCourse, validateCourse } from "../../src/components/CourseEditor";
import { DAY_LABELS, ScheduleGrid, type BlockRef } from "../../src/components/ScheduleGrid";
import { StepHeader } from "../../src/components/StepHeader";
import { activeSemesterKey } from "../../src/hooks/useActiveSemester";
import { api, ApiError } from "../../src/lib/api";
import { COURSE_COLORS, useScheduleDraft, type DraftCourse } from "../../src/lib/scheduleDraft";

const LOW_CONFIDENCE = 0.8;

type Editing = { mode: "edit"; course: DraftCourse } | { mode: "add" } | null;

export default function ScheduleConfirmScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const draft = useScheduleDraft();

  const [selected, setSelected] = useState<BlockRef | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { courses } = draft;
  const lowCount = courses.filter((c) => c.confidence < LOW_CONFIDENCE).length;
  const selectedCourse = selected ? courses.find((c) => c.id === selected.courseId) : undefined;
  const selectedSession = selectedCourse && selected ? selectedCourse.sessions[selected.sessionIndex] : undefined;
  const selectedColor = selectedCourse
    ? COURSE_COLORS[courses.indexOf(selectedCourse) % COURSE_COLORS.length]!
    : undefined;

  const invalid = courses.find((c) => validateCourse(c) !== null);
  const canConfirm = courses.length > 0 && !saving;

  function chooseAlternative(alt: { day: number; start: string; end: string }) {
    if (!selectedCourse || !selected) return;
    draft.updateCourse(selectedCourse.id, {
      ...selectedCourse,
      confidence: Math.max(selectedCourse.confidence, 0.9), // the user resolved the doubt
      sessions: selectedCourse.sessions.map((s, i) =>
        i === selected.sessionIndex ? { ...s, ...alt, alternatives: undefined } : s,
      ),
    });
  }

  async function submit(replaceActive: boolean) {
    setSaving(true);
    setError(null);
    try {
      const body = await api.confirmSchedule({
        semester: { name: draft.name.trim(), startDate: draft.startDate, weekCount: draft.weekCount },
        courses: courses.map((c) => ({
          code: c.code,
          name: c.name,
          instructor: c.instructor,
          sessions: c.sessions.map((s) => ({
            day: s.day,
            start: s.start,
            end: s.end,
            room: s.room,
            kind: s.kind,
          })),
        })),
        replaceActive,
      });
      // The root layout switches to the tabs once there is an active semester.
      queryClient.setQueryData(activeSemesterKey, body);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === "ACTIVE_SEMESTER_EXISTS") {
        Alert.alert("Aktif dönem var", "Yeni dönem eskisinin yerine geçsin mi? Eski dönemin notları silinmez.", [
          { text: "Vazgeç", style: "cancel" },
          { text: "Değiştir", onPress: () => void submit(true) },
        ]);
      } else {
        setError(err instanceof ApiError ? err.message : "Kaydedilemedi, tekrar dene");
      }
    } finally {
      setSaving(false);
    }
  }

  function confirm() {
    if (invalid) {
      setError("Eksik bilgisi olan ders var, düzenleyip tamamla");
      setEditing({ mode: "edit", course: invalid });
      return;
    }
    void submit(false);
  }

  const title = courses.length === 0 ? "Dersleri ekle" : "Programını kontrol et";
  const subtitle =
    courses.length === 0
      ? "Henüz ders yok. Ders ekleyerek başla."
      : `${courses.length} ders bulundu${lowCount ? ` · ${lowCount} tanesini kontrol et` : ""}`;

  return (
    <View className="flex-1 bg-bg">
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 20, paddingHorizontal: 20, paddingBottom: 24, gap: 16 }}>
        <StepHeader step={2} onBack={() => router.back()} />
        <View>
          <Text className="font-heading text-4xl text-ink">{title}</Text>
          <Text className={`mt-2 font-body text-base ${lowCount ? "text-amber-800" : "text-muted"}`}>{subtitle}</Text>
        </View>

        {courses.length > 0 ? <ScheduleGrid courses={courses} selected={selected} onSelect={setSelected} /> : null}

        {selectedCourse && selectedSession ? (
          <View className="rounded-3xl border border-line bg-card p-4">
            <View className="flex-row items-start gap-3">
              <View className="mt-1 h-10 w-1.5 rounded-full" style={{ backgroundColor: selectedColor }} />
              <View className="flex-1">
                <Text className="font-body-semibold text-lg text-ink">{selectedCourse.name || "Adsız ders"}</Text>
                <Text className="font-body text-sm text-muted">
                  {selectedCourse.code || "Kod yok"} · {DAY_LABELS[selectedSession.day]} {selectedSession.start}
                  {selectedSession.room ? ` ${selectedSession.room}` : ""}
                </Text>
              </View>
              <Pressable
                onPress={() => setEditing({ mode: "edit", course: selectedCourse })}
                className="min-h-touch justify-center rounded-xl border border-line px-4"
              >
                <Text className="font-body-medium text-base text-ink">Düzenle</Text>
              </Pressable>
            </View>
            {selectedCourse.confidence < LOW_CONFIDENCE ? (
              <View className="mt-3 rounded-2xl bg-amber-100 p-3">
                <Text className="font-body text-base text-amber-900">
                  {selectedSession.alternatives?.length
                    ? "Saat net okunamadı. Hangisi doğru?"
                    : "Bu ders net okunamadı. Bilgileri kontrol et."}
                </Text>
                {selectedSession.alternatives?.length ? (
                  <View className="mt-2 flex-row flex-wrap gap-2">
                    {[selectedSession, ...selectedSession.alternatives].map((slot, i) => (
                      <Pressable
                        key={i}
                        onPress={() => chooseAlternative(slot)}
                        className="min-h-touch justify-center rounded-xl border border-amber-300 bg-white px-4"
                      >
                        <Text className="font-body-medium text-base text-amber-900">
                          {DAY_LABELS[slot.day]} {slot.start}–{slot.end}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}

        <Pressable
          onPress={() => setEditing({ mode: "add" })}
          className="min-h-touch items-center justify-center rounded-2xl border border-dashed border-line"
        >
          <Text className="font-body-medium text-base text-primary">+ Ders ekle</Text>
        </Pressable>

        {error ? <Text className="text-center font-body text-sm text-red-700">{error}</Text> : null}
      </ScrollView>

      <View className="px-5" style={{ paddingBottom: insets.bottom + 16 }}>
        <Pressable
          onPress={confirm}
          disabled={!canConfirm}
          className={`min-h-[56px] items-center justify-center rounded-2xl ${
            !canConfirm ? "bg-line" : lowCount ? "border border-line bg-card active:opacity-80" : "bg-primary active:opacity-80"
          }`}
        >
          <Text
            className={`font-body-semibold text-base ${
              !canConfirm ? "text-muted" : lowCount ? "text-ink" : "text-white"
            }`}
          >
            {saving ? "Kaydediliyor…" : lowCount ? "Yine de onayla" : "Onayla"}
          </Text>
        </Pressable>
      </View>

      {editing ? (
        <CourseEditor
          visible
          title={editing.mode === "add" ? "Ders ekle" : "Dersi düzenle"}
          initial={editing.mode === "edit" ? editing.course : emptyCourse()}
          onClose={() => setEditing(null)}
          onSave={(course: ScheduleCourseDraft) => {
            if (editing.mode === "edit") draft.updateCourse(editing.course.id, { ...course, id: editing.course.id });
            else draft.addCourse(course);
            setEditing(null);
            setError(null);
          }}
          onDelete={
            editing.mode === "edit"
              ? () => {
                  draft.removeCourse(editing.course.id);
                  setSelected(null);
                  setEditing(null);
                }
              : undefined
          }
        />
      ) : null}
    </View>
  );
}
