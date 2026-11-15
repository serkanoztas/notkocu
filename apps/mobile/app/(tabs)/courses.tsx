import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { Placeholder, Screen } from "../../src/components/Screen";
import { useActiveSemester } from "../../src/hooks/useActiveSemester";
import { DAY_SHORT } from "../../src/lib/format";

export default function CoursesScreen() {
  const router = useRouter();
  const { data, isPending } = useActiveSemester(true);
  const courses = data?.courses ?? [];

  return (
    <Screen title="Dersler" subtitle={data?.semester?.name}>
      {courses.length === 0 ? (
        <Placeholder text={isPending ? "Yükleniyor…" : "Henüz ders yok."} />
      ) : (
        courses.map((c) => (
          <Pressable
            key={c._id}
            onPress={() => router.push(`/course/${c._id}`)}
            accessibilityRole="button"
            className="flex-row items-center gap-4 rounded-2xl border border-line bg-card p-4 active:opacity-80"
          >
            <View className="h-12 w-1.5 rounded-full" style={{ backgroundColor: c.color ?? "#6366F1" }} />
            <View className="flex-1">
              <Text numberOfLines={2} className="font-body-semibold text-lg text-ink">
                {c.name || c.code || "Adsız ders"}
              </Text>
              <Text numberOfLines={1} className="font-body text-sm text-muted">
                {[c.code, c.instructor].filter(Boolean).join(" · ")}
              </Text>
              <Text className="mt-1 font-body text-sm text-muted">
                {c.sessions.map((s) => `${DAY_SHORT[s.day]} ${s.start}`).join(" · ")}
              </Text>
            </View>
          </Pressable>
        ))
      )}
    </Screen>
  );
}
