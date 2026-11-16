import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BackHeader } from "../../../../src/components/BackHeader";
import { NoteRow } from "../../../../src/components/NoteRow";
import { OutboxRow } from "../../../../src/components/OutboxRow";
import { useCourseDetail, useWeek } from "../../../../src/hooks/queries";
import { weekRangeLabel } from "../../../../src/lib/format";
import { useOutbox } from "../../../../src/lib/OutboxProvider";

export default function WeekScreen() {
  const { id, no } = useLocalSearchParams<{ id: string; no: string }>();
  const weekNo = Number(no);
  const insets = useSafeAreaInsets();
  const week = useWeek(id, weekNo);
  const course = useCourseDetail(id); // already cached when coming from the course page
  const unsent = useOutbox().entries.filter((e) => e.target?.courseId === id && e.target.weekNo === weekNo);

  const range = course.data ? weekRangeLabel(course.data.semester.startDate, weekNo) : "";
  const courseName = week.data?.course.name || week.data?.course.code || "";

  return (
    <View className="flex-1 bg-bg">
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 12, paddingHorizontal: 20, paddingBottom: 32, gap: 16 }}>
        <BackHeader title={`${weekNo}. hafta`} subtitle={[courseName, range].filter(Boolean).join(" · ")} />

        {week.isPending ? <Text className="font-body text-base text-muted">Yükleniyor…</Text> : null}
        {week.isError && !week.data ? (
          <View className="rounded-2xl border border-amber-300 bg-amber-100 p-4">
            <Text className="font-body-semibold text-base text-amber-900">Notlar yüklenemedi</Text>
            <Pressable onPress={() => week.refetch()} className="mt-3 min-h-touch justify-center self-start rounded-xl border border-amber-300 bg-white px-4">
              <Text className="font-body-medium text-amber-900">Tekrar dene</Text>
            </Pressable>
          </View>
        ) : null}

        {week.data ? (
          <>
            <View className="rounded-3xl bg-primary-soft p-5">
              <View className="flex-row items-center gap-2">
                <Ionicons name="sparkles-outline" size={18} color="#3730A3" />
                <Text className="font-body-semibold text-base text-primary-dark">Haftanın özeti</Text>
              </View>
              <Text className="mt-2 font-body text-base text-primary-dark">Özet 5. aşamada</Text>
            </View>

            {week.data.notes.length + unsent.length > 0 ? (
              <View className="overflow-hidden rounded-2xl border border-line bg-card">
                {week.data.notes.map((n, i) => (
                  <NoteRow key={n._id} note={n} divider={i > 0} />
                ))}
                {unsent.map((e, i) => (
                  <OutboxRow key={e.clientId} entry={e} divider={week.data.notes.length + i > 0} />
                ))}
              </View>
            ) : (
              <View className="rounded-2xl border border-line bg-card p-5">
                <Text className="font-body text-base text-muted">Bu haftada henüz not yok.</Text>
              </View>
            )}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
