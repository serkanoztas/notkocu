import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { minutesOfDay, parseHHmm } from "@notkocu/shared";
import { ConnectionStatus } from "../../src/components/ConnectionStatus";
import { Screen } from "../../src/components/Screen";
import { useToday } from "../../src/hooks/queries";
import { useActiveSemester } from "../../src/hooks/useActiveSemester";
import { useNow, useTimeZone } from "../../src/hooks/useNow";
import { useScheduleNow, type TodaySession } from "../../src/hooks/useSchedule";
import { formatToday } from "../../src/lib/format";

const KIND_LABEL = { teori: "Teori", lab: "Lab", uygulama: "Uygulama" } as const;

function sessionMeta(s: TodaySession): string {
  return [s.session.room, KIND_LABEL[s.session.kind]].filter(Boolean).join(" · ");
}

export default function TodayScreen() {
  const router = useRouter();
  const now = useNow();
  const timeZone = useTimeZone();
  const semesterQuery = useActiveSemester(true);
  const schedule = useScheduleNow(now);
  const today = useToday();

  const { ongoing, upcoming, weekNo } = schedule;
  const inboxCount = today.data?.inboxCount ?? 0;
  // Only meaningful while the server's answer is for the course on screen.
  const weekNoteCount =
    ongoing && today.data?.ongoing?.course._id === ongoing.course._id ? today.data.ongoing.weekNoteCount : null;

  let progress = 0;
  if (ongoing) {
    const start = parseHHmm(ongoing.session.start);
    const end = parseHHmm(ongoing.session.end);
    progress = Math.min(1, Math.max(0, (minutesOfDay(now, timeZone) - start) / (end - start)));
  }

  return (
    <Screen
      title="Bugün"
      subtitle={formatToday(now, timeZone)}
      right={
        weekNo ? (
          <View className="rounded-full border border-line bg-card px-4 py-2">
            <Text className="font-body-medium text-base text-ink">{weekNo}. hafta</Text>
          </View>
        ) : undefined
      }
    >

      {semesterQuery.isError && !semesterQuery.data ? (
        <View className="rounded-2xl border border-amber-300 bg-amber-100 p-4">
          <Text className="font-body-semibold text-base text-amber-900">Program yüklenemedi</Text>
          <Pressable
            onPress={() => semesterQuery.refetch()}
            disabled={semesterQuery.isFetching}
            className="mt-3 min-h-touch items-center justify-center self-start rounded-xl border border-amber-300 bg-white px-4"
          >
            <Text className="font-body-medium text-amber-900">
              {semesterQuery.isFetching ? "Deneniyor…" : "Tekrar dene"}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {ongoing ? (
        <View className="rounded-3xl bg-primary p-5">
          <View className="flex-row items-center justify-between gap-3">
            <View className="flex-row items-center gap-2">
              <View className="h-2.5 w-2.5 rounded-full bg-green-300" />
              <Text className="font-body-semibold text-sm text-white">
                Şu an · {ongoing.session.start}–{ongoing.session.end}
              </Text>
            </View>
            <Text numberOfLines={1} className="shrink font-body text-sm text-indigo-100">
              {sessionMeta(ongoing)}
            </Text>
          </View>
          <Text className="mt-3 font-heading text-2xl text-white">{ongoing.course.name || ongoing.course.code}</Text>
          <Text className="mt-1 font-body text-base text-indigo-100">
            {[ongoing.course.code, weekNoteCount !== null ? `Bu hafta ${weekNoteCount} not` : null]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          <View className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/25">
            <View className="h-full rounded-full bg-white" style={{ width: `${Math.round(progress * 100)}%` }} />
          </View>
          <View className="mt-4 flex-row gap-3">
            <Pressable
              onPress={() =>
                router.push({
                  pathname: "/capture",
                  params: { courseId: ongoing.course._id, weekNo: String(weekNo ?? 1) },
                })
              }
              className="min-h-[52px] flex-1 items-center justify-center rounded-2xl bg-white active:opacity-80"
            >
              <Text className="font-body-semibold text-base text-ink">+ Not al</Text>
            </Pressable>
            <Pressable
              onPress={() => router.push(`/course/${ongoing.course._id}`)}
              className="min-h-[52px] flex-1 items-center justify-center rounded-2xl bg-white/20 active:opacity-80"
            >
              <Text className="font-body-semibold text-base text-white">Derse git</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View className="rounded-3xl border border-line bg-card p-5">
          <Text className="font-body-semibold text-lg text-ink">Şu an ders yok</Text>
          <Text className="mt-1 font-body text-base text-muted">
            {schedule.semester ? "Not almak için + butonuna dokun." : "Henüz bir programın yok."}
          </Text>
        </View>
      )}

      <Text className="mt-2 font-heading-medium text-xl text-ink">Sonraki dersler</Text>
      {upcoming.length > 0 ? (
        <View className="overflow-hidden rounded-2xl border border-line bg-card">
          {upcoming.map((u, i) => (
            <Pressable
              key={u.session._id}
              onPress={() => router.push(`/course/${u.course._id}`)}
              className={`min-h-[64px] flex-row items-center gap-4 px-4 py-3 ${i > 0 ? "border-t border-line" : ""}`}
            >
              <Text className="w-14 font-body-semibold text-lg text-ink">{u.session.start}</Text>
              <View className="h-10 w-1.5 rounded-full" style={{ backgroundColor: u.course.color ?? "#6366F1" }} />
              <View className="flex-1">
                <Text numberOfLines={1} className="font-body-medium text-base text-ink">
                  {u.course.name || u.course.code}
                </Text>
                <Text className="font-body text-sm text-muted">{sessionMeta(u)}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      ) : (
        <View className="rounded-2xl border border-line bg-card p-4">
          <Text className="font-body text-base text-muted">Bugün başka ders yok.</Text>
        </View>
      )}

      <Text className="mt-2 font-heading-medium text-xl text-ink">Bu haftanın görevleri</Text>
      <View className="rounded-2xl border border-line bg-card p-4">
        <Text className="font-body text-base text-muted">Henüz görev yok.</Text>
      </View>

      {inboxCount > 0 ? (
        <View className="flex-row items-center gap-3 rounded-2xl bg-primary-soft p-4">
          <Text className="flex-1 font-body text-base text-primary-dark">
            Gelen kutusunda {inboxCount} not ders bekliyor
          </Text>
          <Pressable
            onPress={() => router.push("/inbox")}
            className="min-h-touch items-center justify-center rounded-xl bg-primary-dark px-5"
          >
            <Text className="font-body-semibold text-base text-white">Ata</Text>
          </Pressable>
        </View>
      ) : null}

      {__DEV__ ? <ConnectionStatus /> : null}
    </Screen>
  );
}
