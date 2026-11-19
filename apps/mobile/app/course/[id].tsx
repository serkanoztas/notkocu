import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BackHeader } from "../../src/components/BackHeader";
import { useCourseDetail } from "../../src/hooks/queries";
import { DAY_SHORT, weekRangeLabel } from "../../src/lib/format";

const KIND_LABEL = { teori: "Teori", lab: "Lab", uygulama: "Uygulama" } as const;
const GAP = 8;
const COLUMNS = 7;
const STATUS_LABEL = { holiday: "Tatil", midterm: "Vize", final: "Final" } as const;

export default function CourseScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data, isPending, isError, refetch } = useCourseDetail(id);
  const [selected, setSelected] = useState<number | null>(null);
  const [width, setWidth] = useState(0);

  const cell = width > 0 ? (width - GAP * (COLUMNS - 1)) / COLUMNS : 0;

  return (
    <View className="flex-1 bg-bg">
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 12, paddingHorizontal: 20, paddingBottom: 32, gap: 16 }}>
        <BackHeader subtitle={data?.semester.name} />

        {isPending ? <Text className="font-body text-base text-muted">Yükleniyor…</Text> : null}
        {isError && !data ? (
          <View className="rounded-2xl border border-amber-300 bg-amber-100 p-4">
            <Text className="font-body-semibold text-base text-amber-900">Ders yüklenemedi</Text>
            <Pressable onPress={() => refetch()} className="mt-3 min-h-touch justify-center self-start rounded-xl border border-amber-300 bg-white px-4">
              <Text className="font-body-medium text-amber-900">Tekrar dene</Text>
            </Pressable>
          </View>
        ) : null}

        {data ? (
          <>
            <View>
              {data.course.code ? <Text className="font-body-semibold text-base text-primary">{data.course.code}</Text> : null}
              <Text className="font-heading text-3xl text-ink">{data.course.name || data.course.code || "Adsız ders"}</Text>
              {data.course.instructor ? (
                <Text className="mt-1 font-body text-base text-muted">{data.course.instructor}</Text>
              ) : null}
            </View>

            <View className="flex-row flex-wrap gap-2">
              {data.sessions.map((s) => (
                <View key={s._id} className="rounded-xl border border-line bg-card px-3 py-2">
                  <Text className="font-body text-sm text-ink">
                    {[`${DAY_SHORT[s.day]} ${s.start}`, s.room, KIND_LABEL[s.kind]].filter(Boolean).join(" · ")}
                  </Text>
                </View>
              ))}
            </View>

            <View className="flex-row items-baseline justify-between">
              <Text className="font-heading-medium text-xl text-ink">Haftalar</Text>
              <Text className="font-body text-sm text-muted">Dokun ve seç</Text>
            </View>

            <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} className="flex-row flex-wrap" style={{ gap: GAP }}>
              {Array.from({ length: data.semester.weekCount }, (_, i) => i + 1).map((w) => {
                const count = data.weekNoteCounts.find((c) => c.weekNo === w)?.count ?? 0;
                const status = data.semester.weekStatuses.find((s) => s.weekNo === w)?.status;
                const special = status && status !== "normal" ? STATUS_LABEL[status] : null;
                const isCurrent = w === data.currentWeekNo;
                const isFuture = data.currentWeekNo === null ? false : w > data.currentWeekNo;
                const isSelected = w === (selected ?? data.currentWeekNo ?? 1);
                const box = isCurrent
                  ? "border-primary bg-primary"
                  : special
                    ? "border-amber-300 bg-amber-100"
                    : isFuture
                      ? "border-dashed border-line bg-bg"
                      : "border-line bg-card";
                const text = isCurrent ? "text-white" : isFuture && !special ? "text-muted" : "text-ink";
                return (
                  <Pressable
                    key={w}
                    onPress={() => setSelected(w)}
                    accessibilityRole="button"
                    accessibilityLabel={`${w}. hafta, ${count} not`}
                    className={`items-center justify-center rounded-xl border ${box} ${isSelected ? "border-2 border-ink" : ""}`}
                    style={{ width: cell || undefined, height: 60 }}
                  >
                    <Text className={`font-heading-medium text-lg ${text}`}>{w}</Text>
                    <Text className={`font-body text-xs ${isCurrent ? "text-white" : "text-muted"}`}>
                      {special ?? (count > 0 ? `${count} not` : "—")}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View className="flex-row flex-wrap items-center gap-4">
              <Legend swatch="bg-primary" label="Bu hafta" />
              <Legend swatch="bg-amber-200" label="Vize / Final / Tatil" />
              <Legend swatch="border border-dashed border-muted" label="Gelecek" />
            </View>

            <WeekCard
              courseId={data.course._id}
              weekNo={selected ?? data.currentWeekNo ?? 1}
              semesterStart={data.semester.startDate}
              count={data.weekNoteCounts.find((c) => c.weekNo === (selected ?? data.currentWeekNo ?? 1))?.count ?? 0}
              onOpen={(w) => router.push(`/course/${data.course._id}/week/${w}`)}
            />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <View className="flex-row items-center gap-2">
      <View className={`h-3.5 w-3.5 rounded ${swatch}`} />
      <Text className="font-body text-sm text-muted">{label}</Text>
    </View>
  );
}

function WeekCard(props: {
  courseId: string;
  weekNo: number;
  semesterStart: string;
  count: number;
  onOpen: (weekNo: number) => void;
}) {
  return (
    <View className="rounded-3xl border border-line bg-card p-5">
      <View className="flex-row items-baseline justify-between">
        <Text className="font-heading text-2xl text-ink">{props.weekNo}. hafta</Text>
        <Text className="font-body text-sm text-muted">{weekRangeLabel(props.semesterStart, props.weekNo)}</Text>
      </View>
      <Text className="mt-3 font-body text-base text-muted">
        {props.count > 0 ? `${props.count} not` : "Bu haftada henüz not yok."}
      </Text>
      <Pressable onPress={() => props.onOpen(props.weekNo)} className="mt-4 min-h-touch justify-center self-start">
        <Text className="font-body-semibold text-base text-primary">Haftayı aç →</Text>
      </Pressable>
    </View>
  );
}
