import type { ScheduleCourseDraft, ScheduleSessionDraft, SessionKind } from "@notkocu/shared";
import { parseHHmm } from "@notkocu/shared";
import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DAY_LABELS } from "./ScheduleGrid";

const KINDS: { value: SessionKind; label: string }[] = [
  { value: "teori", label: "Teori" },
  { value: "lab", label: "Lab" },
  { value: "uygulama", label: "Uygulama" },
];

const isTime = (v: string) => {
  try {
    parseHHmm(v);
    return /^\d{2}:\d{2}$/.test(v);
  } catch {
    return false;
  }
};

/** Returns a Turkish message for the first problem, or null when the course can be saved. */
export function validateCourse(c: ScheduleCourseDraft): string | null {
  if (!c.name.trim()) return "Ders adı gerekli";
  if (c.sessions.length === 0) return "En az bir ders saati ekle";
  for (const s of c.sessions) {
    if (!isTime(s.start) || !isTime(s.end)) return "Saatleri SS:DD biçiminde yaz (ör. 09:00)";
    if (parseHHmm(s.end) <= parseHHmm(s.start)) return "Bitiş saati başlangıçtan sonra olmalı";
  }
  return null;
}

export const emptySession = (): ScheduleSessionDraft => ({ day: 0, start: "09:00", end: "10:50", kind: "teori" });
export const emptyCourse = (): ScheduleCourseDraft => ({
  code: "",
  name: "",
  sessions: [emptySession()],
  confidence: 1,
});

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className={`min-h-touch min-w-touch items-center justify-center rounded-xl border px-3 ${
        active ? "border-primary bg-primary-soft" : "border-line bg-card"
      }`}
    >
      <Text className={`font-body-medium text-sm ${active ? "text-primary-dark" : "text-ink"}`}>{label}</Text>
    </Pressable>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="gap-1">
      <Text className="font-body text-sm text-muted">{label}</Text>
      {children}
    </View>
  );
}

const inputClass = "min-h-touch rounded-xl border border-line bg-card px-4 font-body text-base text-ink";

interface Props {
  visible: boolean;
  title: string;
  initial: ScheduleCourseDraft;
  onSave: (course: ScheduleCourseDraft) => void;
  onDelete?: () => void;
  onClose: () => void;
}

export function CourseEditor({ visible, title, initial, onSave, onDelete, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [course, setCourse] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const setSession = (i: number, patch: Partial<ScheduleSessionDraft>) =>
    setCourse((c) => ({ ...c, sessions: c.sessions.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) }));

  function save() {
    const trimmed: ScheduleCourseDraft = {
      ...course,
      code: course.code.trim(),
      name: course.name.trim(),
      instructor: course.instructor?.trim() || undefined,
      // The user has looked at this course, so it no longer needs the warning style.
      confidence: Math.max(course.confidence, 0.9),
      sessions: course.sessions.map((s) => ({ ...s, room: s.room?.trim() || undefined, alternatives: undefined })),
    };
    const problem = validateCourse(trimmed);
    if (problem) return setError(problem);
    onSave(trimmed);
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} className="flex-1 bg-bg">
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingTop: insets.top + 16, paddingHorizontal: 20, paddingBottom: 24, gap: 16 }}
        >
          <Text className="font-heading text-3xl text-ink">{title}</Text>
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Field label="Ders kodu (ops.)">
                <TextInput
                  className={inputClass}
                  value={course.code}
                  onChangeText={(code) => setCourse((c) => ({ ...c, code }))}
                  autoCapitalize="characters"
                />
              </Field>
            </View>
            <View className="flex-[2]">
              <Field label="Ders adı">
                <TextInput
                  className={inputClass}
                  value={course.name}
                  onChangeText={(name) => setCourse((c) => ({ ...c, name }))}
                />
              </Field>
            </View>
          </View>
          <Field label="Öğretim elemanı (isteğe bağlı)">
            <TextInput
              className={inputClass}
              value={course.instructor ?? ""}
              onChangeText={(instructor) => setCourse((c) => ({ ...c, instructor }))}
            />
          </Field>

          {course.sessions.map((s, i) => (
            <View key={i} className="gap-3 rounded-2xl border border-line bg-card p-4">
              <View className="flex-row items-center justify-between">
                <Text className="font-body-semibold text-base text-ink">Ders saati {i + 1}</Text>
                {course.sessions.length > 1 ? (
                  <Pressable
                    onPress={() => setCourse((c) => ({ ...c, sessions: c.sessions.filter((_, idx) => idx !== i) }))}
                    className="min-h-touch justify-center px-2"
                  >
                    <Text className="font-body-medium text-sm text-red-700">Sil</Text>
                  </Pressable>
                ) : null}
              </View>
              <View className="flex-row flex-wrap gap-2">
                {DAY_LABELS.map((label, d) => (
                  <Chip key={label} label={label} active={s.day === d} onPress={() => setSession(i, { day: d })} />
                ))}
              </View>
              <View className="flex-row gap-3">
                <View className="flex-1">
                  <Field label="Başlangıç">
                    <TextInput
                      className={inputClass}
                      value={s.start}
                      onChangeText={(start) => setSession(i, { start })}
                      keyboardType="numbers-and-punctuation"
                      maxLength={5}
                    />
                  </Field>
                </View>
                <View className="flex-1">
                  <Field label="Bitiş">
                    <TextInput
                      className={inputClass}
                      value={s.end}
                      onChangeText={(end) => setSession(i, { end })}
                      keyboardType="numbers-and-punctuation"
                      maxLength={5}
                    />
                  </Field>
                </View>
                <View className="flex-1">
                  <Field label="Salon">
                    <TextInput
                      className={inputClass}
                      value={s.room ?? ""}
                      onChangeText={(room) => setSession(i, { room })}
                    />
                  </Field>
                </View>
              </View>
              <View className="flex-row gap-2">
                {KINDS.map((k) => (
                  <Chip key={k.value} label={k.label} active={s.kind === k.value} onPress={() => setSession(i, { kind: k.value })} />
                ))}
              </View>
            </View>
          ))}

          <Pressable
            onPress={() => setCourse((c) => ({ ...c, sessions: [...c.sessions, emptySession()] }))}
            className="min-h-touch items-center justify-center rounded-2xl border border-dashed border-line"
          >
            <Text className="font-body-medium text-base text-primary">+ Ders saati ekle</Text>
          </Pressable>

          {error ? <Text className="text-center font-body text-sm text-red-700">{error}</Text> : null}
        </ScrollView>

        <View className="gap-3 px-5" style={{ paddingBottom: insets.bottom + 16 }}>
          <Pressable onPress={save} className="min-h-[56px] items-center justify-center rounded-2xl bg-primary active:opacity-80">
            <Text className="font-body-semibold text-base text-white">Kaydet</Text>
          </Pressable>
          <View className="flex-row gap-3">
            <Pressable onPress={onClose} className="min-h-touch flex-1 items-center justify-center rounded-2xl border border-line bg-card">
              <Text className="font-body-medium text-base text-ink">Vazgeç</Text>
            </Pressable>
            {onDelete ? (
              <Pressable onPress={onDelete} className="min-h-touch flex-1 items-center justify-center rounded-2xl border border-line bg-card">
                <Text className="font-body-medium text-base text-red-700">Dersi sil</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
